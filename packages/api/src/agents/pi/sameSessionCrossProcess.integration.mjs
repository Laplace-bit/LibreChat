import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const apiDistPath = resolve(repoRoot, 'packages/api/dist/index.cjs');
const Redis = require('ioredis');
const {
  GenerationJobManagerClass,
  PINNED_PI_AGENT_RUNTIME,
  RedisEventTransport,
  RedisJobStore,
  executePiGeneration,
} = require(apiDistPath);

const AGENT_ID = 'pi-cross-process-owner-agent';
const USER_ID = 'pi-cross-process-owner-user';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  return new Redis(url.href, { keyPrefix, maxRetriesPerRequest: 2, lazyConnect: true });
}

async function closeRedisClient(redis) {
  if (!redis || redis.status === 'end') return;
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

function sendWorkerMessage(message) {
  if (typeof process.send === 'function' && process.connected) {
    process.send(message);
  }
}

function sendData(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendChatChunk(response, id, delta, finishReason = null) {
  sendData(response, {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'cross-process-echo',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function createOwnerProvider() {
  const firstRequest = deferred();
  const firstResponseClosed = deferred();
  const secondRequestCompleted = deferred();
  const releaseFirstResponse = deferred();
  const requestBodies = [];
  let requestCount = 0;
  const server = createServer((request, response) => {
    const ordinal = ++requestCount;
    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => requestBodies.push(rawBody));

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
      sendChatChunk(response, 'cross-process-old', { role: 'assistant' });
      sendChatChunk(response, 'cross-process-old', { content: 'old process stream is live' });
      firstRequest.resolve();
      void releaseFirstResponse.promise.then(() => {
        if (!response.destroyed) {
          sendChatChunk(response, 'cross-process-old', { content: 'old stream released' }, 'stop');
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

    sendChatChunk(response, 'cross-process-current', { role: 'assistant' });
    sendChatChunk(response, 'cross-process-current', { content: 'current process run completed' });
    sendChatChunk(response, 'cross-process-current', {}, 'stop');
    sendData(response, '[DONE]');
    response.end();
    secondRequestCompleted.resolve();
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('The process-local fake provider did not bind a TCP port'));
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
        getRequestBodies: () => requestBodies,
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
  modelRuntime.registerProvider('pi-cross-process-integration', {
    name: 'Pi cross-process integration provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'pi-cross-process-test-key',
    models: [
      {
        id: 'cross-process-echo',
        name: 'Cross-process echo',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-cross-process-integration', 'cross-process-echo');
  assert.ok(model, 'the Pi generation has a request-scoped provider model');
  return { model, modelRuntime, dispose: () => undefined };
}

function createPiGenerationInput({ manager, job, streamId, responseMessageId, providerBaseUrl }) {
  return {
    messages: [
      new SystemMessage('Run the assigned Pi generation and return its response.'),
      new HumanMessage(`Cross-process same-session generation: ${responseMessageId}`),
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
      id: `pi-cross-process-content-${responseMessageId}`,
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

async function initializeWorkerManager(keyPrefix) {
  const redisClients = [
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
  ];
  try {
    await Promise.all(redisClients.map((redis) => redis.connect()));
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new RedisJobStore(redisClients[0]),
      eventTransport: new RedisEventTransport(redisClients[1], redisClients[2]),
      isRedis: true,
      cleanupOnComplete: false,
    });
    manager.initialize();
    return { manager, redisClients };
  } catch (error) {
    await Promise.all(redisClients.map((redis) => closeRedisClient(redis)));
    throw error;
  }
}

let shutdownResolve;
const shutdownSignal = new Promise((resolveShutdown) => {
  shutdownResolve = resolveShutdown;
});
let startResolve;
const startSignal = new Promise((resolveStart) => {
  startResolve = resolveStart;
});
let activeManager;
let activeJob;
let activeProvider;
let activeRedisClients = [];
let activeGenerations = [];
let shutdownRequested = false;

function requestWorkerShutdown() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  activeJob?.abortController?.abort();
  activeProvider?.releaseFirstResponse?.();
  shutdownResolve();
}

if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message?.type === 'shutdown') {
      requestWorkerShutdown();
    } else if (message?.type === 'start') {
      startResolve(message);
    }
  });
  process.on('disconnect', requestWorkerShutdown);
}

async function cleanupWorker() {
  activeJob?.abortController?.abort();
  activeProvider?.releaseFirstResponse?.();
  await Promise.allSettled(
    activeGenerations.map((generation) =>
      withTimeout(generation, 1500, 'Pi generation did not settle during worker cleanup'),
    ),
  );
  if (activeManager != null) {
    const destroy = activeManager.destroy({ settlementBudgetMs: 0 });
    await withTimeout(destroy, 3000, 'GenerationJobManager did not clean up in the worker').catch(
      () => undefined,
    );
  }
  if (activeProvider != null) {
    await withTimeout(
      activeProvider.close(),
      3000,
      'Fake provider did not close in the worker',
    ).catch(() => undefined);
  }
  await Promise.all(activeRedisClients.map((redis) => closeRedisClient(redis)));
}

async function runOwnerWorker() {
  const keyPrefix = process.env.PI_CROSS_PROCESS_KEY_PREFIX;
  const streamId = process.env.PI_CROSS_PROCESS_STREAM_ID;
  if (typeof keyPrefix !== 'string' || typeof streamId !== 'string') {
    throw new Error('Owner worker is missing its isolated Redis key prefix or stream ID');
  }
  const initialized = await initializeWorkerManager(keyPrefix);
  activeManager = initialized.manager;
  activeRedisClients = initialized.redisClients;
  activeProvider = await createOwnerProvider();

  const responseMessageId = `response-old-${streamId}`;
  const job = await activeManager.createJob(streamId, USER_ID, streamId, {
    initialMetadata: {
      agentRuntime: PINNED_PI_AGENT_RUNTIME,
      agent_id: AGENT_ID,
      responseMessageId,
    },
  });
  activeJob = job;
  const providerExecutionId = job.metadata.providerExecutionId;
  if (!(await activeManager.beginProviderExecution(streamId, job.createdAt, providerExecutionId))) {
    throw new Error('Owner worker could not begin the original Pi provider execution');
  }
  const generation = executePiGeneration(
    createPiGenerationInput({
      manager: activeManager,
      job,
      streamId,
      responseMessageId,
      providerBaseUrl: activeProvider.baseUrl,
    }),
  ).finally(() =>
    activeManager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId),
  );
  activeGenerations.push(generation);
  await withTimeout(
    activeProvider.firstRequest,
    10_000,
    'Original Pi run did not reach its provider',
  );
  sendWorkerMessage({
    type: 'owner-ready',
    streamId,
    createdAt: job.createdAt,
    providerBaseUrl: activeProvider.baseUrl,
  });

  await withTimeout(
    new Promise((resolveAbort) => {
      if (job.abortController.signal.aborted) {
        resolveAbort();
        return;
      }
      job.abortController.signal.addEventListener('abort', resolveAbort, { once: true });
    }),
    20_000,
    'Owner process did not receive a replacement abort from Redis',
  );
  await withTimeout(
    activeProvider.firstResponseClosed,
    5_000,
    'Old Pi HTTP response did not close after cross-process cancellation',
  );
  const outcome = await withTimeout(generation, 5_000, 'Old Pi generation did not drain');
  const lateEvent = {
    event: 'on_message_delta',
    data: {
      id: `late-${streamId}`,
      delta: { content: { type: 'text', text: 'stale cross-process Pi event' } },
    },
  };
  const staleAppendAccepted = await activeManager.emitChunkFromAnyReplica(
    streamId,
    lateEvent,
    job.createdAt,
  );
  const staleTerminalClaim = await activeManager.claimTerminalJob(
    streamId,
    'complete',
    undefined,
    job.createdAt,
  );
  await withTimeout(
    activeProvider.secondRequestCompleted,
    5_000,
    'Replacement Pi request did not reach the owner process test provider',
  );
  sendWorkerMessage({
    type: 'owner-fenced',
    oldCreatedAt: job.createdAt,
    signalAborted: job.abortController.signal.aborted,
    providerStreamClosed: true,
    outcome: outcome.status,
    staleAppendAccepted,
    staleTerminalClaimPresent: staleTerminalClaim != null,
    staleTerminalClaim: staleTerminalClaim ?? null,
    providerRequestsSeen: activeProvider.getRequestCount(),
  });
  await shutdownSignal;
}

async function runReplacementWorker() {
  const keyPrefix = process.env.PI_CROSS_PROCESS_KEY_PREFIX;
  if (typeof keyPrefix !== 'string') {
    throw new Error('Replacement worker is missing its isolated Redis key prefix');
  }
  const command = await Promise.race([startSignal, shutdownSignal.then(() => undefined)]);
  if (command == null || shutdownRequested) return;
  const { streamId, oldCreatedAt, providerBaseUrl } = command;
  if (
    typeof streamId !== 'string' ||
    typeof oldCreatedAt !== 'number' ||
    typeof providerBaseUrl !== 'string'
  ) {
    throw new Error('Replacement worker received an invalid start command');
  }

  const initialized = await initializeWorkerManager(keyPrefix);
  activeManager = initialized.manager;
  activeRedisClients = initialized.redisClients;
  const transport = activeManager.eventTransport;
  const events = [];
  const subscription = transport.subscribe(
    streamId,
    {
      onChunk(event, generationId) {
        events.push({ kind: 'chunk', event, generationId });
      },
      onDone(event, generationId) {
        events.push({ kind: 'done', event, generationId });
      },
      onError(error, generationId) {
        events.push({ kind: 'error', error, generationId });
      },
    },
    { deferSequenceDelivery: true, captureSequenceFrontier: true },
  );
  await withTimeout(
    subscription.ready,
    5_000,
    'Replacement process did not subscribe to Redis events',
  );
  await withTimeout(
    Promise.resolve(subscription.syncReorderBuffer?.()),
    5_000,
    'Replacement process did not establish its Redis event frontier',
  );

  const responseMessageId = `response-current-${streamId}`;
  const job = await activeManager.createJob(streamId, USER_ID, streamId, {
    initialMetadata: {
      agentRuntime: PINNED_PI_AGENT_RUNTIME,
      agent_id: AGENT_ID,
      responseMessageId,
    },
  });
  activeJob = job;
  if (job.createdAt <= oldCreatedAt) {
    throw new Error('Replacement process did not advance the Redis generation epoch');
  }
  const providerExecutionId = job.metadata.providerExecutionId;
  if (!(await activeManager.beginProviderExecution(streamId, job.createdAt, providerExecutionId))) {
    throw new Error('Replacement process could not begin its Pi provider execution');
  }
  const generation = executePiGeneration(
    createPiGenerationInput({
      manager: activeManager,
      job,
      streamId,
      responseMessageId,
      providerBaseUrl,
    }),
  ).finally(() =>
    activeManager.markProviderExecutionDrained(streamId, job.createdAt, providerExecutionId),
  );
  activeGenerations.push(generation);
  const outcome = await withTimeout(generation, 10_000, 'Replacement Pi generation did not finish');
  await withTimeout(
    activeManager.eventTransport.flushPendingChunks?.(streamId),
    5_000,
    'Replacement Pi chunks did not flush before terminal publication',
  );
  if (outcome.status !== 'completed') {
    throw new Error(`Replacement Pi generation ended as ${outcome.status}`);
  }
  await withTimeout(
    new Promise((resolveRequest) => {
      const wait = () => {
        if (
          events.some((entry) => entry.kind === 'chunk' && entry.generationId === job.createdAt)
        ) {
          resolveRequest();
        } else {
          setTimeout(wait, 5);
        }
      };
      wait();
    }),
    5_000,
    'Replacement process did not observe its own streamed content event',
  );

  const claim = await activeManager.claimTerminalJob(
    streamId,
    'complete',
    undefined,
    job.createdAt,
    { persistencePending: true },
  );
  if (claim == null) {
    throw new Error('Replacement process did not win the current-generation terminal claim');
  }
  await activeManager.publishTerminalClaim(claim, {
    final: true,
    generationCreatedAt: job.createdAt,
    conversation: { conversationId: streamId },
    responseMessage: {
      messageId: responseMessageId,
      text: 'current process run completed',
      unfinished: false,
    },
  });
  await activeManager.finishTerminalJob(claim);

  await withTimeout(
    new Promise((resolveTerminal) => {
      const wait = () => {
        if (
          events.some(
            (entry) =>
              entry.kind === 'done' &&
              entry.generationId === job.createdAt &&
              entry.event?.final === true &&
              entry.event?.reconcile !== true,
          )
        ) {
          resolveTerminal();
        } else {
          setTimeout(wait, 5);
        }
      };
      wait();
    }),
    5_000,
    'Replacement process did not observe its current terminal event through Redis',
  );

  const durableJob = await activeManager.getJobStore().getJob(streamId);
  const oldReconcileEvents = events.filter(
    (entry) =>
      entry.kind === 'done' &&
      entry.generationId === oldCreatedAt &&
      entry.event?.reconcile === true,
  );
  const currentFinalEvents = events.filter(
    (entry) =>
      entry.kind === 'done' &&
      entry.generationId === job.createdAt &&
      entry.event?.final === true &&
      entry.event?.reconcile !== true,
  );
  const staleEventObservable = events.some(
    (entry) =>
      entry.kind === 'chunk' && JSON.stringify(entry).includes('stale cross-process Pi event'),
  );
  sendWorkerMessage({
    type: 'replacement-complete',
    oldCreatedAt,
    currentCreatedAt: job.createdAt,
    generationOutcome: outcome.status,
    durableCreatedAt: durableJob?.createdAt,
    durableStatus: durableJob?.status,
    oldReconcileCount: oldReconcileEvents.length,
    currentFinalCount: currentFinalEvents.length,
    currentMessageId: currentFinalEvents[0]?.event?.responseMessage?.messageId,
    staleEventObservable,
  });
  subscription.unsubscribe();
  await shutdownSignal;
}

async function runWorker(role) {
  let failure;
  try {
    if (role === 'owner') {
      await runOwnerWorker();
    } else if (role === 'replacement') {
      await runReplacementWorker();
    } else {
      throw new Error(`Unknown Pi cross-process worker role: ${role}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    sendWorkerMessage({
      type: 'worker-error',
      role,
      message: failure.message,
      stack: failure.stack,
    });
    process.exitCode = 1;
  } finally {
    await cleanupWorker();
    if (failure != null) {
      process.exitCode = 1;
    }
  }
}

function createWorkerController(role, keyPrefix, streamId) {
  const output = [];
  const messages = new Map();
  const waiters = new Map();
  const child = fork(fileURLToPath(import.meta.url), [`--worker-${role}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_CROSS_PROCESS_KEY_PREFIX: keyPrefix,
      PI_CROSS_PROCESS_STREAM_ID: streamId,
    },
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let exitInfo;
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolveExit(exitInfo);
      for (const [type, waiter] of waiters) {
        waiters.delete(type);
        waiter.reject(
          new Error(
            `Pi ${role} worker exited before ${type}: code=${code} signal=${signal}\n${output.join('')}`,
          ),
        );
      }
    });
  });
  const appendOutput = (chunk) => {
    output.push(chunk.toString());
    while (output.length > 80) output.shift();
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.on('error', (error) => {
    for (const [type, waiter] of waiters) {
      waiters.delete(type);
      waiter.reject(error);
    }
  });
  child.on('message', (message) => {
    if (message?.type === 'worker-error') {
      const error = new Error(
        `Pi ${message.role} worker failed: ${message.message}\n${message.stack ?? ''}\n${output.join('')}`,
      );
      for (const [type, waiter] of waiters) {
        waiters.delete(type);
        waiter.reject(error);
      }
      messages.set('worker-error', message);
      return;
    }
    if (message?.type == null) return;
    messages.set(message.type, message);
    const waiter = waiters.get(message.type);
    if (waiter != null) {
      waiters.delete(message.type);
      waiter.resolve(message);
    }
  });

  return {
    child,
    output,
    waitFor(type, timeoutMs = 20_000) {
      if (messages.has(type)) return Promise.resolve(messages.get(type));
      if (messages.has('worker-error')) {
        const failure = messages.get('worker-error');
        return Promise.reject(new Error(`Pi ${role} worker failed: ${failure.message}`));
      }
      if (exitInfo != null) {
        return Promise.reject(
          new Error(
            `Pi ${role} worker exited before ${type}: ${JSON.stringify(exitInfo)}\n${output.join('')}`,
          ),
        );
      }
      const pending = deferred();
      waiters.set(type, pending);
      return withTimeout(
        pending.promise,
        timeoutMs,
        `Timed out waiting for ${type} from Pi ${role} worker\n${output.join('')}`,
      ).finally(() => {
        if (waiters.get(type) === pending) waiters.delete(type);
      });
    },
    send(message) {
      return new Promise((resolveSend, rejectSend) => {
        if (!child.connected) {
          rejectSend(new Error(`Pi ${role} worker is not connected`));
          return;
        }
        child.send(message, (error) => (error ? rejectSend(error) : resolveSend()));
      });
    },
    async waitForExit(timeoutMs) {
      return withTimeout(exitPromise, timeoutMs, `Pi ${role} worker did not exit cleanly`);
    },
  };
}

async function stopWorkers(workers) {
  await Promise.allSettled(workers.map((worker) => worker?.send({ type: 'shutdown' })));
  const firstExit = await Promise.allSettled(workers.map((worker) => worker?.waitForExit(4_000)));
  for (let index = 0; index < workers.length; index += 1) {
    if (firstExit[index]?.status === 'rejected') {
      const child = workers[index]?.child;
      if (child?.exitCode == null && child?.signalCode == null) child.kill('SIGTERM');
    }
  }
  const secondExit = await Promise.allSettled(workers.map((worker) => worker?.waitForExit(2_000)));
  for (let index = 0; index < workers.length; index += 1) {
    if (secondExit[index]?.status === 'rejected') {
      const child = workers[index]?.child;
      if (child?.exitCode == null && child?.signalCode == null) child.kill('SIGKILL');
    }
  }
  await Promise.allSettled(workers.map((worker) => worker?.waitForExit(1_000)));
}

async function runCrossProcessTest() {
  const keyPrefix = `Pi-Same-Session-Cross-Process-${process.pid}-${Date.now()}:`;
  const streamId = `pi-cross-process-same-session-${Date.now()}`;
  const owner = createWorkerController('owner', keyPrefix, streamId);
  let replacement;
  const adminRedis = createRedisClient(keyPrefix);

  try {
    await adminRedis.connect();
    await clearRedisPrefix(adminRedis, keyPrefix);
    const ownerReady = await owner.waitFor('owner-ready', 20_000);
    replacement = createWorkerController('replacement', keyPrefix, streamId);
    assert.ok(owner.child.pid != null && replacement.child.pid != null);
    assert.notEqual(
      owner.child.pid,
      replacement.child.pid,
      'replicas run in separate OS processes',
    );
    assert.notEqual(owner.child.pid, process.pid, 'the owner is a child of the test process');
    assert.notEqual(
      replacement.child.pid,
      process.pid,
      'the replacement is a child of the test process',
    );
    await replacement.send({
      type: 'start',
      streamId,
      oldCreatedAt: ownerReady.createdAt,
      providerBaseUrl: ownerReady.providerBaseUrl,
    });
    const [ownerReport, replacementReport] = await Promise.all([
      owner.waitFor('owner-fenced', 20_000),
      replacement.waitFor('replacement-complete', 20_000),
    ]);

    assert.equal(
      ownerReport.signalAborted,
      true,
      'replica A observes B’s Redis abort across processes',
    );
    assert.equal(
      ownerReport.providerStreamClosed,
      true,
      'the old Pi HTTP stream closes across processes',
    );
    assert.equal(ownerReport.outcome, 'cancelled');
    assert.equal(ownerReport.staleAppendAccepted, false, 'Redis rejects A’s stale durable append');
    assert.equal(
      ownerReport.staleTerminalClaimPresent,
      false,
      'A cannot claim a terminal after replacement',
    );
    assert.equal(ownerReport.staleTerminalClaim, null);
    assert.equal(
      ownerReport.providerRequestsSeen,
      2,
      'B also used the owner process test provider',
    );

    assert.ok(replacementReport.currentCreatedAt > ownerReady.createdAt);
    assert.equal(replacementReport.oldCreatedAt, ownerReady.createdAt);
    assert.equal(replacementReport.generationOutcome, 'completed');
    assert.equal(replacementReport.durableCreatedAt, replacementReport.currentCreatedAt);
    assert.equal(replacementReport.durableStatus, 'complete');
    assert.equal(
      replacementReport.oldReconcileCount,
      1,
      'replacement delivers one old-epoch reconcile receipt',
    );
    assert.equal(
      replacementReport.currentFinalCount,
      1,
      'B publishes one current-generation final',
    );
    assert.equal(replacementReport.currentMessageId, `response-current-${streamId}`);
    assert.equal(replacementReport.staleEventObservable, false);
  } finally {
    await stopWorkers([replacement, owner]);
    await clearRedisPrefix(adminRedis, keyPrefix).catch(() => undefined);
    await closeRedisClient(adminRedis);
  }
}

if (process.argv[2] === '--worker-owner') {
  await runWorker('owner');
} else if (process.argv[2] === '--worker-replacement') {
  await runWorker('replacement');
} else {
  test(
    'cross-process Pi same-session replacement aborts and fences the old owner',
    runCrossProcessTest,
  );
}
