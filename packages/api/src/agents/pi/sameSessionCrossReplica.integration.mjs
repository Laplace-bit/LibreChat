import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const {
  GenerationJobManagerClass,
  PINNED_PI_AGENT_RUNTIME,
  RedisEventTransport,
  RedisJobStore,
  executePiGeneration,
} = require(resolve(repoRoot, 'packages/api/dist/index.cjs'));
const IoRedis = require('ioredis');

const AGENT_ID = 'pi-cross-replica-owner-agent';
const USER_ID = 'pi-cross-replica-owner-user';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createRedisClient(keyPrefix) {
  const url = new URL(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
  return new IoRedis(url.href, { keyPrefix, maxRetriesPerRequest: 2, lazyConnect: true });
}

async function closeRedisClient(redis) {
  let timer;
  try {
    await Promise.race([
      redis.quit().catch(() => undefined),
      new Promise((resolveClose) => {
        timer = setTimeout(resolveClose, 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (redis.reconnectTimeout != null) {
      clearTimeout(redis.reconnectTimeout);
      redis.reconnectTimeout = null;
    }
    const stream = redis.connector?.stream;
    if (stream != null) {
      redis.manuallyClosing = true;
      stream.destroy();
    } else {
      redis.disconnect();
    }
  }
}

async function clearRedisPrefix(redis, keyPrefix) {
  const physicalKeys = await redis.keys('*');
  const logicalKeys = physicalKeys
    .filter((key) => key.startsWith(keyPrefix))
    .map((key) => key.slice(keyPrefix.length));
  if (logicalKeys.length > 0) {
    await redis.del(...logicalKeys);
  }
}

function createControlledProvider() {
  const firstRequest = deferred();
  const firstResponseClosed = deferred();
  const secondRequestCompleted = deferred();
  const releaseFirstResponse = deferred();
  let requestCount = 0;
  const receivedBodies = [];

  const sendData = (response, value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const sendChunk = (response, requestId, delta, finishReason = null) => {
    sendData(response, {
      id: requestId,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'cross-replica-echo',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  };

  const server = createServer((request, response) => {
    const ordinal = ++requestCount;
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => receivedBodies.push(rawBody));

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.flushHeaders();

    if (ordinal === 1) {
      response.once('close', () => {
        if (!response.writableFinished) firstResponseClosed.resolve();
      });
      sendChunk(response, 'cross-replica-old', { role: 'assistant' });
      sendChunk(response, 'cross-replica-old', { content: 'old generation started' });
      firstRequest.resolve();
      void releaseFirstResponse.promise.then(() => {
        if (!response.destroyed) {
          sendChunk(response, 'cross-replica-old', { content: 'old generation released' }, 'stop');
          sendData(response, '[DONE]');
          response.end();
        }
      });
      return;
    }

    if (ordinal !== 2) {
      response.end();
      return;
    }

    sendChunk(response, 'cross-replica-current', { role: 'assistant' });
    sendChunk(response, 'cross-replica-current', { content: 'current generation completed' });
    sendChunk(response, 'cross-replica-current', {}, 'stop');
    sendData(response, '[DONE]');
    response.end();
    secondRequestCompleted.resolve();
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('The local provider did not bind to a TCP port'));
        return;
      }
      resolveListen({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        firstRequest: firstRequest.promise,
        firstResponseClosed: firstResponseClosed.promise,
        secondRequestCompleted: secondRequestCompleted.promise,
        releaseFirstResponse: () => releaseFirstResponse.resolve(),
        getRequestCount: () => requestCount,
        getReceivedBodies: () => receivedBodies,
        async close() {
          releaseFirstResponse.resolve();
          server.closeAllConnections?.();
          await new Promise((resolveClose) => server.close(resolveClose));
        },
      });
    });
  });
}

async function createFakeModelBinding(baseUrl) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-cross-replica-integration', {
    name: 'Pi cross-replica integration provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'pi-cross-replica-test-key',
    models: [
      {
        id: 'cross-replica-echo',
        name: 'Cross-replica echo',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-cross-replica-integration', 'cross-replica-echo');
  assert.ok(model, 'the Pi generation has a request-scoped provider model');
  return { model, modelRuntime, dispose: () => undefined };
}

function createPiGenerationInput({ manager, job, streamId, responseMessageId, providerBaseUrl }) {
  return {
    messages: [
      new SystemMessage('Run the assigned Pi generation and return its response.'),
      new HumanMessage(`Cross-replica same-session generation: ${responseMessageId}`),
    ],
    createModelBinding: () => createFakeModelBinding(providerBaseUrl),
    signal: job.abortController.signal,
    usageAttribution: { provider: 'openAI', agentId: AGENT_ID, runId: responseMessageId },
    contextUsage: {
      tokenCounter: () => 1,
      runId: responseMessageId,
      agentId: AGENT_ID,
      maxContextTokens: 8192,
      calibrationRatio: 1,
    },
    createStepIdentity: () => ({
      id: `pi-cross-replica-content-${responseMessageId}`,
      index: 0,
      messageId: responseMessageId,
      runId: responseMessageId,
      agentId: AGENT_ID,
    }),
    async handleHostEvent(event) {
      await manager.emitChunk(
        streamId,
        { event: event.event, data: event.data },
        { expectedCreatedAt: job.createdAt },
      );
    },
  };
}

test('cross-replica Pi same-session replacement aborts and fences the stale owner', async () => {
  const keyPrefix = `Pi-Same-Session-Cross-Replica-${process.pid}-${Date.now()}:`;
  const streamId = `pi-cross-replica-same-session-${Date.now()}`;
  const provider = await createControlledProvider();
  const redisClients = [
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
  ];
  const [storeRedisA, publisherA, subscriberA, storeRedisB, publisherB, subscriberB] = redisClients;
  let managerA;
  let managerB;
  let subscription;
  let oldGeneration;
  let currentGeneration;
  const events = [];

  try {
    await Promise.all(redisClients.map((redis) => redis.connect()));
    await clearRedisPrefix(storeRedisA, keyPrefix);

    const transportA = new RedisEventTransport(publisherA, subscriberA);
    const transportB = new RedisEventTransport(publisherB, subscriberB);
    managerA = new GenerationJobManagerClass();
    managerA.configure({
      jobStore: new RedisJobStore(storeRedisA),
      eventTransport: transportA,
      isRedis: true,
      cleanupOnComplete: false,
    });
    managerB = new GenerationJobManagerClass();
    managerB.configure({
      jobStore: new RedisJobStore(storeRedisB),
      eventTransport: transportB,
      isRedis: true,
      cleanupOnComplete: false,
    });
    managerA.initialize();
    managerB.initialize();

    const received = deferred();
    subscription = transportB.subscribe(streamId, {
      onChunk(event, generationId) {
        events.push({ kind: 'chunk', event, generationId });
      },
      onDone(event, generationId) {
        events.push({ kind: 'done', event, generationId });
        if (event?.reconcile === true && generationId != null) received.resolve(generationId);
      },
      onError(error, generationId) {
        events.push({ kind: 'error', error, generationId });
      },
    });
    await withTimeout(subscription.ready, 5_000, 'replica B did not subscribe to Redis events');

    const oldJob = await managerA.createJob(streamId, USER_ID, streamId, {
      initialMetadata: {
        agentRuntime: PINNED_PI_AGENT_RUNTIME,
        agent_id: AGENT_ID,
        responseMessageId: `response-old-${streamId}`,
      },
    });
    const oldProviderExecutionId = oldJob.metadata.providerExecutionId;
    assert.equal(
      await managerA.beginProviderExecution(streamId, oldJob.createdAt, oldProviderExecutionId),
      true,
    );
    oldGeneration = executePiGeneration(
      createPiGenerationInput({
        manager: managerA,
        job: oldJob,
        streamId,
        responseMessageId: `response-old-${streamId}`,
        providerBaseUrl: provider.baseUrl,
      }),
    ).finally(() =>
      managerA.markProviderExecutionDrained(streamId, oldJob.createdAt, oldProviderExecutionId),
    );
    await withTimeout(
      provider.firstRequest,
      5_000,
      'the old Pi generation did not reach the provider',
    );

    const lateEvent = {
      event: 'on_message_delta',
      data: {
        id: `late-${streamId}`,
        delta: { content: { type: 'text', text: 'stale old Pi event' } },
      },
    };
    const currentJob = await managerB.createJob(streamId, USER_ID, streamId, {
      initialMetadata: {
        agentRuntime: PINNED_PI_AGENT_RUNTIME,
        agent_id: AGENT_ID,
        responseMessageId: `response-current-${streamId}`,
      },
    });
    const currentProviderExecutionId = currentJob.metadata.providerExecutionId;
    assert.ok(currentJob.createdAt > oldJob.createdAt, 'the Redis generation epoch advanced');
    assert.equal(oldJob.abortController.signal.aborted, true, 'replica A received the owner abort');
    assert.equal(
      await withTimeout(
        received.promise,
        5_000,
        'replica B did not publish the replacement receipt',
      ),
      oldJob.createdAt,
    );
    await withTimeout(
      provider.firstResponseClosed,
      5_000,
      'the old provider response remained open after its owner was aborted',
    );

    assert.equal(
      await managerA.emitChunkFromAnyReplica(streamId, lateEvent, oldJob.createdAt),
      false,
      'the Redis append fence rejects a stale Pi event from replica A',
    );
    assert.equal(
      await managerA.claimTerminalJob(streamId, 'complete', undefined, oldJob.createdAt),
      null,
      'the old Pi generation cannot claim a terminal state after replacement',
    );

    assert.equal(
      await managerB.beginProviderExecution(
        streamId,
        currentJob.createdAt,
        currentProviderExecutionId,
      ),
      true,
    );
    currentGeneration = executePiGeneration(
      createPiGenerationInput({
        manager: managerB,
        job: currentJob,
        streamId,
        responseMessageId: `response-current-${streamId}`,
        providerBaseUrl: provider.baseUrl,
      }),
    ).finally(() =>
      managerB.markProviderExecutionDrained(
        streamId,
        currentJob.createdAt,
        currentProviderExecutionId,
      ),
    );
    const oldOutcome = await withTimeout(
      oldGeneration,
      5_000,
      'the old Pi execution did not drain',
    );
    assert.equal(oldOutcome.status, 'cancelled');
    assert.equal(
      await withTimeout(provider.secondRequestCompleted, 5_000, 'the new Pi run stalled'),
      undefined,
    );
    const currentOutcome = await withTimeout(
      currentGeneration,
      5_000,
      'the new Pi execution did not finish',
    );
    assert.equal(currentOutcome.status, 'completed');

    const staleTerminalClaim = await managerA.claimTerminalJob(
      streamId,
      'complete',
      undefined,
      oldJob.createdAt,
      { persistencePending: true },
    );
    assert.equal(staleTerminalClaim, null, 'the old owner cannot publish a late terminal');

    const currentClaim = await managerB.claimTerminalJob(
      streamId,
      'complete',
      undefined,
      currentJob.createdAt,
      { persistencePending: true },
    );
    assert.ok(currentClaim, 'the current owner wins the terminal claim');
    await managerB.publishTerminalClaim(currentClaim, {
      final: true,
      generationCreatedAt: currentJob.createdAt,
      conversation: { conversationId: streamId },
      responseMessage: {
        messageId: `response-current-${streamId}`,
        text: 'current generation completed',
        unfinished: false,
      },
    });
    await managerB.finishTerminalJob(currentClaim);

    await withTimeout(
      (async () => {
        while (
          !events.some(
            (entry) =>
              entry.kind === 'done' &&
              entry.generationId === currentJob.createdAt &&
              entry.event?.final === true &&
              entry.event?.reconcile !== true,
          )
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
        }
      })(),
      5_000,
      'replica B did not observe the current generation terminal event',
    );

    assert.equal(
      provider.getRequestCount(),
      2,
      'one old request was canceled and one new request ran',
    );
    assert.equal(
      await managerA
        .getJobStore()
        .getJob(streamId)
        .then((job) => job?.createdAt),
      currentJob.createdAt,
    );
    assert.equal(await managerB.getJobStatus(streamId), 'complete');
    assert.equal(
      events.filter(
        (entry) => entry.kind === 'chunk' && JSON.stringify(entry).includes('stale old Pi event'),
      ).length,
      0,
      'no stale event is observable on replica B',
    );
    const oldTerminals = events.filter(
      (entry) => entry.kind === 'done' && entry.generationId === oldJob.createdAt,
    );
    const currentTerminals = events.filter(
      (entry) => entry.kind === 'done' && entry.generationId === currentJob.createdAt,
    );
    assert.equal(oldTerminals.length, 1, 'the replacement receipt is the only old-epoch terminal');
    assert.equal(oldTerminals[0].event?.reconcile, true);
    assert.equal(currentTerminals.length, 1, 'the new owner publishes exactly one final event');
    assert.equal(currentTerminals[0].event?.reconcile, undefined);
    assert.equal(
      currentTerminals[0].event?.responseMessage?.messageId,
      `response-current-${streamId}`,
    );
    assert.equal(managerA.isRedis, true);
    assert.equal(managerB.isRedis, true);
    assert.equal(provider.getReceivedBodies().length, 2);
  } finally {
    provider.releaseFirstResponse();
    await Promise.allSettled([oldGeneration, currentGeneration].filter(Boolean));
    await Promise.allSettled(
      [managerA, managerB]
        .filter(Boolean)
        .map((manager) => manager.destroy({ settlementBudgetMs: 0 })),
    );
    await provider.close();
    await Promise.all(redisClients.map((redis) => closeRedisClient(redis)));
  }
});
