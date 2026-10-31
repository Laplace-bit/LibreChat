import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { GraphEvents } from '@librechat/agents';
import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';
import { Tools, UsageEvents } from 'librechat-data-provider';

const require = createRequire(import.meta.url);
const {
  GenerationJobManager,
  PINNED_PI_AGENT_RUNTIME,
  createPiHostToolBatchExecutor,
  createStreamServices,
  executePiGeneration,
} = require('../../../dist/index.cjs');

const FILE_SEARCH_DEFINITION = {
  name: Tools.file_search,
  description: 'Search the current agent files.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function createFakeModelBinding(baseUrl, onDispose = () => {}) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-concurrency-test', {
    name: 'Pi concurrency test provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'concurrency-test-key',
    models: [
      {
        id: 'concurrent-echo',
        name: 'Concurrent echo',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-concurrency-test', 'concurrent-echo');
  assert.ok(model, 'the generation has a request-scoped provider model');
  return { model, modelRuntime, dispose: onDispose };
}

async function createConcurrentFakeProvider() {
  const firstRequestsArrived = deferred();
  const releaseFirstResponses = deferred();
  const requestCountByAgent = new Map();
  const cancelledAgents = new Set();
  const initialRequestsInFlight = new Set();
  const requestBodies = [];
  let maxConcurrentInitialRequests = 0;

  const identifyAgent = (messages) => {
    const encoded = JSON.stringify(messages);
    if (encoded.includes('generation-agent-alpha')) return 'alpha';
    if (encoded.includes('generation-agent-beta')) return 'beta';
    throw new Error('Provider request did not include a known generation identity');
  };

  const sendEvent = (response, value) => {
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  };

  const sendToolCall = (response, agentId) => {
    const callId = `pi-call-${agentId}`;
    sendEvent(response, {
      id: `chatcmpl-${agentId}-tool`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    sendEvent(response, {
      id: `chatcmpl-${agentId}-tool`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: 'function',
                function: {
                  name: Tools.file_search,
                  arguments: JSON.stringify({ query: `${agentId} private query` }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sendEvent(response, {
      id: `chatcmpl-${agentId}-tool`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
    sendEvent(response, {
      id: `chatcmpl-${agentId}-tool-usage`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
    });
    response.end('data: [DONE]\n\n');
  };

  const sendFinalAnswer = (response, agentId) => {
    sendEvent(response, {
      id: `chatcmpl-${agentId}-final`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    for (const content of [`Only ${agentId} sees this`, ' final answer.']) {
      sendEvent(response, {
        id: `chatcmpl-${agentId}-final`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'concurrent-echo',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
    }
    sendEvent(response, {
      id: `chatcmpl-${agentId}-final`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    sendEvent(response, {
      id: `chatcmpl-${agentId}-final-usage`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'concurrent-echo',
      choices: [],
      usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
    });
    response.end('data: [DONE]\n\n');
  };

  const server = createServer((request, response) => {
    let body = '';
    let agentId;
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(body);
      agentId = identifyAgent(payload.messages);
      requestBodies.push({ agentId, payload });
      const requestCount = (requestCountByAgent.get(agentId) ?? 0) + 1;
      requestCountByAgent.set(agentId, requestCount);

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.once('close', () => {
        if (!response.writableEnded) {
          cancelledAgents.add(agentId);
        }
      });

      if (requestCount === 1) {
        initialRequestsInFlight.add(agentId);
        maxConcurrentInitialRequests = Math.max(
          maxConcurrentInitialRequests,
          initialRequestsInFlight.size,
        );
        if (initialRequestsInFlight.size === 2) {
          firstRequestsArrived.resolve();
        }
        void releaseFirstResponses.promise.then(() => {
          initialRequestsInFlight.delete(agentId);
          if (response.destroyed || response.writableEnded) {
            return;
          }
          sendToolCall(response, agentId);
        });
        return;
      }

      sendFinalAnswer(response, agentId);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    firstRequestsArrived: firstRequestsArrived.promise,
    releaseFirstResponses: () => releaseFirstResponses.resolve(),
    getMaxConcurrentInitialRequests: () => maxConcurrentInitialRequests,
    getCancelledAgents: () => [...cancelledAgents],
    getRequestBodies: () => requestBodies,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

function generationInput({
  agentId,
  streamId,
  responseMessageId,
  job,
  providerBaseUrl,
  hostToolCalls,
  hostEvents,
}) {
  const toolCallIds = new Map();
  let stepIndex = 0;
  const request = {
    user: { id: `user-${agentId}` },
    body: { conversationId: streamId },
    config: { endpoints: { agents: {} } },
  };
  const hostHandler = {
    handle(event, data) {
      if (event !== GraphEvents.ON_TOOL_EXECUTE) return;
      const call = data.toolCalls[0];
      if (call == null) throw new Error('Expected the generation host tool call');
      hostToolCalls.push({ agentId, responseMessageId, call });
      data.resolve([
        {
          toolCallId: call.id,
          status: 'success',
          content: `authorized result for ${agentId}`,
        },
      ]);
    },
  };
  const executeHostToolCall = createPiHostToolBatchExecutor({
    handler: hostHandler,
    userId: `user-${agentId}`,
    agentId,
    request,
    threadId: streamId,
    runId: responseMessageId,
    authorizedToolNames: [Tools.file_search],
    metadata: {
      thread_id: streamId,
      run_id: responseMessageId,
      user_id: `user-${agentId}`,
      agent_id: agentId,
    },
  });

  return {
    messages: [
      new SystemMessage(`This request belongs to generation-${agentId}.`),
      new HumanMessage(`generation-${agentId}: search the assigned document.`),
    ],
    createModelBinding: () => createFakeModelBinding(providerBaseUrl),
    toolDefinitions: [FILE_SEARCH_DEFINITION],
    executeHostToolCall,
    createToolStepIdentity: () => ({
      id: `pi-tool-step-${responseMessageId}-${stepIndex}`,
      index: stepIndex++,
      messageId: responseMessageId,
      runId: responseMessageId,
      agentId,
    }),
    createToolCallId: () => {
      const next = (toolCallIds.get(agentId) ?? 0) + 1;
      toolCallIds.set(agentId, next);
      return `host-call-${responseMessageId}-${next}`;
    },
    signal: job.abortController.signal,
    usageAttribution: { provider: 'openAI', agentId, runId: responseMessageId },
    contextUsage: {
      tokenCounter: () => 1,
      runId: responseMessageId,
      agentId,
      maxContextTokens: 8192,
      calibrationRatio: 1,
    },
    createStepIdentity: () => ({
      id: `pi-content-step-${responseMessageId}-${stepIndex}`,
      index: stepIndex++,
      messageId: responseMessageId,
      runId: responseMessageId,
      agentId,
    }),
    handleHostEvent: async (event) => {
      hostEvents.push({ agentId, responseMessageId, event });
      await GenerationJobManager.emitChunk(
        streamId,
        { event: event.event, data: event.data },
        job.createdAt,
      );
    },
  };
}

test('concurrent Pi generations keep host tools, usage, aborts, and terminal events within each job', async () => {
  const streamIds = {
    alpha: `pi-concurrency-alpha-${Date.now()}`,
    beta: `pi-concurrency-beta-${Date.now()}`,
  };
  const responseMessageIds = {
    alpha: `response-${streamIds.alpha}`,
    beta: `response-${streamIds.beta}`,
  };
  const agentIds = { alpha: 'generation-agent-alpha', beta: 'generation-agent-beta' };
  const provider = await createConcurrentFakeProvider();
  const streamEvents = { alpha: [], beta: [] };
  const hostToolCalls = [];
  const hostEvents = { alpha: [], beta: [] };
  const subscriptions = [];

  try {
    await GenerationJobManager.destroy();
    GenerationJobManager.configure({
      ...createStreamServices({ useRedis: false }),
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();

    const jobs = {};
    for (const key of ['alpha', 'beta']) {
      jobs[key] = await GenerationJobManager.createJob(
        streamIds[key],
        `user-${key}`,
        streamIds[key],
        {
          initialMetadata: {
            agentRuntime: PINNED_PI_AGENT_RUNTIME,
            agent_id: agentIds[key],
            responseMessageId: responseMessageIds[key],
          },
        },
      );
      const subscription = await GenerationJobManager.subscribe(
        streamIds[key],
        (event) => {
          streamEvents[key].push(event);
        },
        (event) => {
          streamEvents[key].push(event);
        },
      );
      assert.ok(subscription, `the ${key} stream is available to subscribers`);
      subscriptions.push(subscription);
      await GenerationJobManager.emitChunk(
        streamIds[key],
        {
          created: true,
          message: {
            messageId: `user-message-${key}`,
            parentMessageId: `parent-${key}`,
            conversationId: streamIds[key],
            text: `start ${key}`,
            sender: 'user',
            isCreatedByUser: true,
          },
          streamId: streamIds[key],
        },
        { expectedCreatedAt: jobs[key].createdAt },
      );
    }

    const providerExecutionIds = {
      alpha: jobs.alpha.metadata.providerExecutionId,
      beta: jobs.beta.metadata.providerExecutionId,
    };
    for (const key of ['alpha', 'beta']) {
      assert.equal(
        await GenerationJobManager.beginProviderExecution(
          streamIds[key],
          jobs[key].createdAt,
          providerExecutionIds[key],
        ),
        true,
      );
    }

    const startGeneration = (key) =>
      executePiGeneration(
        generationInput({
          agentId: agentIds[key],
          streamId: streamIds[key],
          responseMessageId: responseMessageIds[key],
          job: jobs[key],
          providerBaseUrl: provider.baseUrl,
          hostToolCalls,
          hostEvents: hostEvents[key],
        }),
      ).finally(() =>
        GenerationJobManager.markProviderExecutionDrained(
          streamIds[key],
          jobs[key].createdAt,
          providerExecutionIds[key],
        ),
      );

    const alphaGeneration = startGeneration('alpha');
    const betaGeneration = startGeneration('beta');
    await withTimeout(
      provider.firstRequestsArrived,
      5_000,
      'both independent Pi generations did not reach the provider concurrently',
    );

    const alphaAbortRequested = deferred();
    jobs.alpha.abortController.signal.addEventListener('abort', alphaAbortRequested.resolve, {
      once: true,
    });
    const abortAlpha = GenerationJobManager.abortJob(streamIds.alpha, {
      expectedCreatedAt: jobs.alpha.createdAt,
      awaitProviderDrain: true,
    });
    await withTimeout(
      alphaAbortRequested.promise,
      5_000,
      'GenerationJobManager did not deliver alpha’s job abort signal',
    );
    provider.releaseFirstResponses();

    const [alphaOutcome, betaOutcome] = await withTimeout(
      Promise.all([alphaGeneration, betaGeneration]),
      10_000,
      'concurrent Pi generations did not settle',
    );
    const alphaAbortResult = await withTimeout(
      abortAlpha,
      5_000,
      'the aborted Pi generation did not drain through GenerationJobManager',
    );
    assert.equal(alphaAbortResult.success, true);

    assert.equal(alphaOutcome.status, 'cancelled', 'alpha’s own job signal stopped its Pi run');
    assert.equal(betaOutcome.status, 'completed');
    assert.equal(provider.getMaxConcurrentInitialRequests(), 2);

    const betaClaim = await GenerationJobManager.claimTerminalJob(
      streamIds.beta,
      'complete',
      undefined,
      jobs.beta.createdAt,
      { persistencePending: true },
    );
    assert.ok(betaClaim, 'the completed Pi generation owns its terminal claim');
    const betaFinalEvent = {
      final: true,
      generationCreatedAt: jobs.beta.createdAt,
      conversation: { conversationId: streamIds.beta },
      responseMessage: {
        messageId: responseMessageIds.beta,
        text: 'Only beta sees this final answer.',
        unfinished: false,
      },
    };
    await GenerationJobManager.publishTerminalClaim(betaClaim, betaFinalEvent);
    await GenerationJobManager.finishTerminalJob(betaClaim);

    assert.deepEqual(
      hostToolCalls.map(({ agentId, responseMessageId, call }) => ({
        agentId,
        responseMessageId,
        name: call.name,
        args: call.args,
        runId: call.id,
      })),
      [
        {
          agentId: agentIds.beta,
          responseMessageId: responseMessageIds.beta,
          name: Tools.file_search,
          args: { query: 'beta private query' },
          runId: hostToolCalls[0]?.call.id,
        },
      ],
    );
    assert.ok(
      hostToolCalls[0]?.call.id.startsWith(`host-call-${responseMessageIds.beta}-`),
      'the host tool call id belongs to beta’s response',
    );

    const assertRunEventsBelongTo = (key) => {
      const expectedAgentId = agentIds[key];
      const expectedRunId = responseMessageIds[key];
      for (const { agentId, responseMessageId, event } of hostEvents[key]) {
        assert.equal(agentId, expectedAgentId);
        assert.equal(responseMessageId, expectedRunId);
        if (event.event === UsageEvents.ON_TOKEN_USAGE) {
          assert.equal(event.data.agentId, expectedAgentId);
          assert.equal(event.data.runId, expectedRunId);
        }
        if (event.event === UsageEvents.ON_CONTEXT_USAGE) {
          assert.equal(event.data.agentId, expectedAgentId);
          assert.equal(event.data.runId, expectedRunId);
        }
        if (event.event === GraphEvents.ON_RUN_STEP) {
          assert.equal(event.data.agentId, expectedAgentId);
          assert.equal(event.data.runId, expectedRunId);
        }
        if (event.event === GraphEvents.ON_RUN_STEP_CLOSED) {
          const stepPrefix =
            event.data.type === 'tool_calls'
              ? `pi-tool-step-${expectedRunId}-`
              : `pi-content-step-${expectedRunId}-`;
          assert.ok(event.data.id.startsWith(stepPrefix));
        }
      }
      for (const event of streamEvents[key]) {
        if (event.event === UsageEvents.ON_TOKEN_USAGE) {
          assert.equal(event.data.runId, expectedRunId);
          assert.equal(event.data.agentId, expectedAgentId);
        }
        if (event.event === UsageEvents.ON_CONTEXT_USAGE) {
          assert.equal(event.data.runId, expectedRunId);
          assert.equal(event.data.agentId, expectedAgentId);
        }
        if (event.data?.runId != null) assert.equal(event.data.runId, expectedRunId);
        if (event.data?.agentId != null) assert.equal(event.data.agentId, expectedAgentId);
      }
    };
    assertRunEventsBelongTo('alpha');
    assertRunEventsBelongTo('beta');

    const alphaToolEvents = hostEvents.alpha.filter(
      ({ event }) =>
        event.event === GraphEvents.ON_RUN_STEP ||
        event.event === GraphEvents.ON_RUN_STEP_COMPLETED ||
        (event.event === GraphEvents.ON_RUN_STEP_CLOSED && event.data.type === 'tool_calls'),
    );
    const betaToolCalls = hostEvents.beta.filter(
      ({ event }) =>
        event.event === GraphEvents.ON_RUN_STEP_COMPLETED &&
        event.data.result?.tool_call?.name === Tools.file_search,
    );
    assert.equal(
      alphaToolEvents.length,
      0,
      'alpha was aborted before any host tool was dispatched',
    );
    assert.equal(betaToolCalls.length, 1, 'only beta completed its host tool call');
    assert.ok(
      hostEvents.beta.some(
        ({ event }) =>
          event.event === UsageEvents.ON_TOKEN_USAGE &&
          event.data.runId === responseMessageIds.beta,
      ),
      'provider token usage is attributed to beta’s generation',
    );
    const alphaTerminalEvents = streamEvents.alpha.filter((event) => event.final === true);
    const betaTerminalEvents = streamEvents.beta.filter((event) => event.final === true);
    assert.equal(alphaTerminalEvents.length, 1, JSON.stringify(streamEvents.alpha));
    assert.equal(alphaTerminalEvents[0].aborted, true);
    assert.equal(alphaTerminalEvents[0].responseMessage.messageId, responseMessageIds.alpha);
    assert.equal(alphaTerminalEvents[0].conversation.conversationId, streamIds.alpha);
    assert.equal(betaTerminalEvents.length, 1);
    assert.equal(betaTerminalEvents[0].aborted, undefined);
    assert.equal(betaTerminalEvents[0].generationCreatedAt, jobs.beta.createdAt);
    assert.equal(betaTerminalEvents[0].responseMessage.messageId, responseMessageIds.beta);
    assert.equal(betaTerminalEvents[0].conversation.conversationId, streamIds.beta);
    assert.equal(await GenerationJobManager.getJobStatus(streamIds.alpha), 'aborted');
    assert.equal(await GenerationJobManager.getJobStatus(streamIds.beta), 'complete');
  } finally {
    for (const subscription of subscriptions) {
      subscription?.unsubscribe();
    }
    provider.releaseFirstResponses();
    await GenerationJobManager.destroy();
    await provider.close();
  }
});
