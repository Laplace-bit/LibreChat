import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createContentAggregator, GraphEvents } from '@librechat/agents';
import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';
import { ApprovalEvents } from 'librechat-data-provider';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const apiRoot = resolve(repoRoot, 'api');
require('module-alias').addAlias('~', apiRoot);

const express = require('express');
const request = require('supertest');
const Module = require('node:module');
const IoRedis = require('ioredis');
const { tenantStorage } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const librechatApi = require('@librechat/api');
const piUndici = require(
  resolve(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/node_modules/undici'),
);

function withCacheSweepDisabled(loadModule) {
  const originalCi = librechatApi.cacheConfig.CI;
  librechatApi.cacheConfig.CI = true;
  try {
    return loadModule();
  } finally {
    librechatApi.cacheConfig.CI = originalCi;
  }
}

const { getDefaultHandlers } = withCacheSweepDisabled(() =>
  require(resolve(apiRoot, 'server/controllers/agents/callbacks.js')),
);

function stopRouteCacheIntervals() {
  const getLogStores = withCacheSweepDisabled(() =>
    require(resolve(apiRoot, 'cache/getLogStores.js')),
  );
  for (const key of [CacheKeys.OPENID_SESSION, CacheKeys.SAML_SESSION]) {
    getLogStores(key).stopInterval?.();
  }
}

const USER_ID = 'pi-ask-user-user';
const TENANT_ID = 'pi-ask-user-tenant';
const AGENT_ID = 'pi-ask-user-agent';
const USER_MESSAGE_ID = 'pi-ask-user-user-message';
const RESPONSE_MESSAGE_ID = 'pi-ask-user-response';
const THREAD_PARENT_ID = 'pi-ask-user-parent';
const USER_PROMPT = 'Summarize downtime for the relevant plant.';
const FINAL_TEXT = 'North plant had 4,200 minutes of downtime in the last 7 days.';
const ASK_USER_QUESTION = 'ask_user_question';
const QUESTIONS = [
  { id: 'plant_code', question: 'Which plant should I inspect?' },
  { id: 'time_window', question: 'Which time window should I use?' },
];
const ANSWERS = { plant_code: 'North', time_window: 'last 7 days' };

function createRedisClient(keyPrefix) {
  const url = new URL(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
  return new IoRedis(url.href, {
    keyPrefix,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
}

function forceDisconnectRedisClient(redis) {
  if (redis.reconnectTimeout != null) {
    clearTimeout(redis.reconnectTimeout);
    redis.reconnectTimeout = null;
  }
  const connector = redis.connector;
  if (connector != null) {
    connector.connecting = false;
  }
  const stream = redis.connector?.stream;
  if (stream != null) {
    // Destroy the socket; ioredis.disconnect() can leave a pending ShutdownWrap.
    redis.manuallyClosing = true;
    stream.destroy();
  } else {
    redis.disconnect();
  }
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
    forceDisconnectRedisClient(redis);
  }
}

async function settleWithin(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(task).then(
        () => true,
        () => false,
      ),
      new Promise((resolveSettled) => {
        timer = setTimeout(() => resolveSettled(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Timed out waiting for the Pi ask-user continuation to finish');
}

async function createFakeModelBinding(baseUrl, onDispose) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-ask-user-integration', {
    name: 'Pi ask-user integration provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'pi-ask-user-integration-key',
    models: [
      {
        id: 'ask-user-echo',
        name: 'Ask-user echo model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-ask-user-integration', 'ask-user-echo');
  assert.ok(model, 'the local fake-provider model is registered');
  return { model, modelRuntime, dispose: onDispose };
}

async function createFakeChatProvider() {
  const requestBodies = [];
  const authorization = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requestBodies.push(JSON.parse(raw));
      authorization.push(req.headers.authorization);
      const requestNumber = requestBodies.length;
      const model = requestBodies.at(-1)?.model ?? 'ask-user-echo';
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({
        id: `pi-ask-user-${requestNumber}`,
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      if (requestNumber === 1) {
        send({
          id: `pi-ask-user-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'pi-provider-ask-call',
                    type: 'function',
                    function: {
                      name: ASK_USER_QUESTION,
                      arguments: JSON.stringify({ questions: QUESTIONS }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: `pi-ask-user-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        send({
          id: `pi-ask-user-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }],
        });
        send({
          id: `pi-ask-user-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    authorization,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

function createAgentEventHandlers({ content, streamId, jobCreatedAt, sseFrames }) {
  const handlers = getDefaultHandlers({
    res: {
      writableEnded: false,
      write: (chunk) => sseFrames.push(chunk),
    },
    aggregateContent: content.aggregateContent,
    contentParts: content.contentParts,
    stepMap: content.stepMap,
    toolEndCallback: async () => undefined,
    collectedUsage: [],
    streamId,
    jobCreatedAt,
  });
  // AgentClient requires the host executor seam when constructing its Pi tool
  // adapter. This ask-only scenario must never execute a host side effect.
  handlers[GraphEvents.ON_TOOL_EXECUTE] = {
    handle: async () => {
      throw new Error('The ask-user continuation must not execute a host tool');
    },
  };
  return handlers;
}

function createRouteModule({ agent, savedMessages }) {
  const modelMocks = {
    saveMessage: async (_req, message) => {
      savedMessages.push(message);
      return message;
    },
    stampForcedRetention: async () => undefined,
    getConvo: async () => null,
    getChatProject: async () => null,
    getMessages: async () => [],
    getFiles: async () => [],
    getProjectFiles: async () => [],
    getAgent: async () => agent,
    getActions: async () => [],
    getUserMemories: async () => [],
    getRoleByName: async () => null,
    getAgentTriggerDelivery: async () => undefined,
    isSubagentOwnerAdmissible: async () => true,
    addConvoToolApprovalAllows: async () => undefined,
    appendConvoMessageReference: async () => undefined,
    stampConvoLastResponse: async () => undefined,
    completeAgentEventActorLegacyTurn: async () => true,
    getAgentEventActorSnapshot: async () => undefined,
    commitAgentEventActorState: async () => ({ status: 'committed' }),
    storeAgentEventActorSuspension: async () => ({ status: 'stored' }),
    claimAgentEventActorSuspension: async () => ({ status: 'claimed' }),
    settleAgentEventActorSuspension: async () => ({ status: 'settled' }),
    recordAgentEventActorReconciliation: async () => true,
    reserveAgentEventActorDetachedAction: async () => undefined,
    markAgentEventActorDetachedActionRunning: async () => undefined,
    settleAgentEventActorDetachedAction: async () => undefined,
  };
  const services = {
    '~/models': modelMocks,
    '~/server/cleanup': { disposeClient: async () => undefined },
    '~/server/services/ActionService': { decryptMetadata: async (value) => value },
    '~/server/services/PermissionService': { checkPermission: async () => true },
    '~/server/services/MCPRequestContext': {
      getMCPRequestContext: () => null,
      cleanupMCPRequestContextForReq: async () => undefined,
    },
    '~/server/services/Endpoints/agents/eventChildLease': {
      acquireEventChildGenerationLease: async () => async () => undefined,
    },
    '~/server/services/Schedules': {
      recordScheduleOutcome: async () => true,
      claimScheduleResume: async () => ({ capacitySlot: 0, claimToken: 'unused' }),
      releaseScheduleResumeClaim: async () => true,
      finalizeScheduleResumeClaim: async () => true,
      releaseScheduleResumeFence: async () => undefined,
      isScheduleLive: async () => true,
    },
  };
  const originalLoad = Module._load;
  Module._load = function loadWithRouteServices(requestName, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(services, requestName)) {
      return services[requestName];
    }
    return originalLoad.call(this, requestName, parent, isMain);
  };
  try {
    return {
      controller: withCacheSweepDisabled(() =>
        require(resolve(apiRoot, 'server/controllers/agents/resume.js')),
      ),
      modelMocks,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function loadAgentClientWithFakeModelBinding({ modelMocks, createModelBinding, capturedErrors }) {
  const previousModelBindingFactory = librechatApi.getAgentPiModelBindingFactory;
  const previousTerminalRunErrorObserver = librechatApi.createTerminalRunErrorObserver;
  const originalLoad = Module._load;
  librechatApi.getAgentPiModelBindingFactory = () => createModelBinding;
  librechatApi.createTerminalRunErrorObserver = (options) => {
    const observer = previousTerminalRunErrorObserver(options);
    return {
      ...observer,
      log(error, signal) {
        capturedErrors.push({ code: error?.code, stack: error?.stack });
        return observer.log(error, signal);
      },
    };
  };
  Module._load = function loadWithHostBoundary(requestName, parent, isMain) {
    if (requestName === '~/models') {
      return modelMocks;
    }
    if (requestName === '~/server/services/MCPRequestContext') {
      return {
        getMCPRequestContext: () => null,
        cleanupMCPRequestContextForReq: async () => undefined,
      };
    }
    return originalLoad.call(this, requestName, parent, isMain);
  };
  try {
    return withCacheSweepDisabled(() =>
      require(resolve(apiRoot, 'server/controllers/agents/client.js')),
    );
  } finally {
    Module._load = originalLoad;
    librechatApi.getAgentPiModelBindingFactory = previousModelBindingFactory;
    librechatApi.createTerminalRunErrorObserver = previousTerminalRunErrorObserver;
  }
}

function createAgentClient({
  AgentClient,
  agent,
  req,
  agentRuntime,
  content,
  streamId,
  jobCreatedAt,
  sseFrames,
  parentMessageId = THREAD_PARENT_ID,
}) {
  const eventHandlers = createAgentEventHandlers({ content, streamId, jobCreatedAt, sseFrames });
  const client = new AgentClient({
    agent,
    req,
    endpoint: 'agents',
    agentRuntime,
    eventHandlers,
    sender: 'Pi ask-user integration agent',
    contentParts: content.contentParts,
    stepMap: content.stepMap,
    collectedUsage: [],
    artifactPromises: [],
    maxContextTokens: 8192,
  });
  client.user = req.user.id;
  client.conversationId = streamId;
  client.responseMessageId = RESPONSE_MESSAGE_ID;
  client.parentMessageId = parentMessageId;
  client.jobCreatedAt = jobCreatedAt;
  return client;
}

function createRequestContext({ streamId, body = {} } = {}) {
  return {
    user: { id: USER_ID, tenantId: TENANT_ID, role: 'USER' },
    config: {
      endpoints: {
        agents: {
          toolApproval: { enabled: true },
        },
      },
      interfaceConfig: {},
    },
    body,
    resolvedConversation: {},
    _resumableStreamId: streamId,
  };
}

test('Pi ask-user pauses over SSE and resumes through POST /api/agents/chat/resume', async (t) => {
  const testPrefix = `ResumePiAskUser:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
  const redis = createRedisClient(testPrefix);
  let provider;
  let piDispatcher;
  let subscription;
  let AgentClient;
  const capturedErrors = [];
  const originalApi = {
    checkAccess: librechatApi.checkAccess,
    checkAndIncrementPendingRequest: librechatApi.checkAndIncrementPendingRequest,
    decrementPendingRequest: librechatApi.decrementPendingRequest,
    captureAgentCheckpointGeneration: librechatApi.captureAgentCheckpointGeneration,
    deleteAgentCheckpoint: librechatApi.deleteAgentCheckpoint,
  };

  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    await closeRedisClient(redis);
    stopRouteCacheIntervals();
    t.skip(`Redis is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const savedMessages = [];
  const bindingDisposals = [];
  let initializeClientCalls = 0;
  const agent = {
    _id: 'mongo-pi-ask-user-agent',
    id: AGENT_ID,
    provider: 'openai',
    model: 'ask-user-echo',
    instructions: 'Ask for missing plant and time range details before answering.',
    model_parameters: { model: 'ask-user-echo' },
    tools: [{ name: ASK_USER_QUESTION }],
    toolDefinitions: [{ name: ASK_USER_QUESTION, description: 'Ask the user for missing details.' }],
    edges: [],
  };
  const content = createContentAggregator();
  const sseFrames = [];
  const route = createRouteModule({ agent, savedMessages });
  const container = new librechatApi.RedisJobStore(redis);

  try {
    // The real resume route preflight asks for the shared LangGraph checkpointer.
    // This isolated Pi test intentionally has no Mongo connection; getAgentCheckpointer
    // returns before creating a saver or issuing a database operation, while Pi's
    // continuation and pause ownership are covered by the Redis job store below.
    provider = await createFakeChatProvider();
    piDispatcher = piUndici.getGlobalDispatcher();
    librechatApi.checkAccess = async () => true;
    librechatApi.checkAndIncrementPendingRequest = async () => ({ allowed: true });
    librechatApi.decrementPendingRequest = async () => undefined;
    librechatApi.captureAgentCheckpointGeneration = async (conversationId) => ({
      threadId: conversationId,
      checkpointIds: [],
    });
    librechatApi.deleteAgentCheckpoint = async () => undefined;

    librechatApi.GenerationJobManager.configure({
      jobStore: container,
      eventTransport: new librechatApi.InMemoryEventTransport(),
      isRedis: true,
      cleanupOnComplete: false,
    });
    librechatApi.GenerationJobManager.initialize();

    AgentClient = loadAgentClientWithFakeModelBinding({
      modelMocks: route.modelMocks,
      createModelBinding: () =>
        createFakeModelBinding(provider.baseUrl, () => bindingDisposals.push('resume')),
      capturedErrors,
    });

    const streamId = `pi-ask-user-${Date.now()}`;
    const job = await tenantStorage.run({ tenantId: TENANT_ID, userId: USER_ID }, async () =>
      librechatApi.GenerationJobManager.createJob(streamId, USER_ID, streamId, {
        initialMetadata: {
          agentRuntime: librechatApi.PINNED_PI_AGENT_RUNTIME,
          agent_id: AGENT_ID,
          endpoint: 'agents',
          responseMessageId: RESPONSE_MESSAGE_ID,
          sender: 'Pi ask-user integration agent',
          model: 'ask-user-echo',
          userMessage: {
            messageId: USER_MESSAGE_ID,
            parentMessageId: THREAD_PARENT_ID,
            text: USER_PROMPT,
          },
        },
      }),
    );

    const liveEvents = [];
    subscription = await librechatApi.GenerationJobManager.subscribe(
      streamId,
      (event) => liveEvents.push(event),
      () => undefined,
      (error) => {
        throw error;
      },
      { skipBufferReplay: true, expectedCreatedAt: job.createdAt },
    );
    assert.ok(subscription, 'the live SSE stream can subscribe to the running generation');
    await subscription.ready;

    const initialHandlers = createAgentEventHandlers({
      content,
      streamId,
      jobCreatedAt: job.createdAt,
      sseFrames,
    });
    const initialClient = createAgentClient({
      AgentClient,
      agent,
      req: createRequestContext({ streamId, body: { endpoint: 'agents', agent_id: AGENT_ID } }),
      agentRuntime: librechatApi.PINNED_PI_AGENT_RUNTIME,
      content,
      streamId,
      jobCreatedAt: job.createdAt,
      sseFrames,
    });
    const initialEvents = [];
    const initial = await librechatApi.executePiGeneration({
      messages: [new SystemMessage('Use the local test provider.'), new HumanMessage(USER_PROMPT)],
      createModelBinding: () =>
        createFakeModelBinding(provider.baseUrl, () => bindingDisposals.push('pause')),
      toolDefinitions: agent.toolDefinitions,
      executeHostToolCall: async () => {
        throw new Error('ask_user_question must not execute as a host side effect');
      },
      askUserQuestionEnabled: true,
      createToolStepIdentity: () => ({
        id: 'pi-ask-user-tool-step',
        index: 0,
        messageId: RESPONSE_MESSAGE_ID,
        runId: RESPONSE_MESSAGE_ID,
        agentId: AGENT_ID,
      }),
      createToolCallId: () => 'host-pi-ask-call',
      createStepIdentity: () => ({
        id: 'pi-ask-user-content-step',
        index: 0,
        messageId: RESPONSE_MESSAGE_ID,
        runId: RESPONSE_MESSAGE_ID,
        agentId: AGENT_ID,
      }),
      handleHostEvent: async (event) => {
        initialEvents.push(event);
        const handler = initialHandlers[event.event];
        assert.ok(handler?.handle, `the existing stream handler handles ${event.event}`);
        await handler.handle(event.event, event.data, {
          last_agent_id: AGENT_ID,
          langgraph_node: `agent=${AGENT_ID}`,
          thread_id: streamId,
          run_id: RESPONSE_MESSAGE_ID,
          agent_id: AGENT_ID,
          agentId: AGENT_ID,
        });
      },
    });

    assert.equal(initial.status, 'paused');
    assert.equal(initial.signal.kind, 'ask_user_question');
    assert.deepEqual(initial.signal.toolCall.args.questions, QUESTIONS);
    assert.equal(provider.requestBodies.length, 1);
    assert.ok(
      initialEvents.some(
        (event) =>
          event.event === GraphEvents.ON_RUN_STEP &&
          event.data.id === initial.signal.toolCall.hostExecution.stepIdentity.id,
      ),
      'Pi emits the in-progress host tool step used to bind the continuation',
    );
    assert.deepEqual(content.contentParts.map((part) => part.type), ['tool_call']);

    await container.saveRunSteps(
      streamId,
      initialEvents
        .filter((event) => event.event === GraphEvents.ON_RUN_STEP)
        .map((event) => event.data),
      job.createdAt,
    );
    await initialClient.handlePiPauseInterrupt(initial.signal, streamId);
    const paused = await librechatApi.GenerationJobManager.getJob(streamId);
    assert.equal(paused?.status, 'requires_action');
    const pendingAction = paused?.metadata?.pendingAction;
    const continuation = paused?.metadata?.piResumeContinuation;
    assert.equal(pendingAction?.payload?.type, ASK_USER_QUESTION);
    assert.deepEqual(pendingAction?.payload?.questions, QUESTIONS);
    assert.equal(continuation?.kind, 'ask_user_question');
    assert.equal(continuation?.actionId, pendingAction?.actionId);
    assert.equal(
      await librechatApi.GenerationJobManager.approvals.ownsPausePersistence(
        streamId,
        pendingAction.actionId,
        job.createdAt,
      ),
      true,
      'the real approval lifecycle holds the pause until the unfinished response is saved',
    );

    await route.modelMocks.saveMessage(createRequestContext({ streamId }), {
      messageId: RESPONSE_MESSAGE_ID,
      conversationId: streamId,
      parentMessageId: USER_MESSAGE_ID,
      isCreatedByUser: false,
      sender: 'Pi ask-user integration agent',
      content: initialClient.contentParts,
      unfinished: true,
    });
    assert.equal(await initialClient.exposePendingApproval(), true);
    assert.equal(
      await librechatApi.GenerationJobManager.approvals.finishPausePersistence(
        streamId,
        pendingAction.actionId,
        job.createdAt,
      ),
      true,
    );
    await waitFor(() =>
      liveEvents.some((event) => event.event === ApprovalEvents.ON_PENDING_ACTION),
    );

    const persistedChunks = await redis.xrange(`stream:{${streamId}}:chunks`, '-', '+');
    const persistedEvents = persistedChunks.map(([, fields]) => {
      const eventIndex = fields.indexOf('event');
      assert.notEqual(eventIndex, -1, 'Redis stores each SSE event envelope');
      return JSON.parse(fields[eventIndex + 1]);
    });
    assert.ok(
      persistedEvents.some((event) => event.event === GraphEvents.ON_RUN_STEP),
      'the Pi question step is durably visible to replay subscribers',
    );
    const pendingSse = persistedEvents.find(
      (event) => event.event === ApprovalEvents.ON_PENDING_ACTION,
    );
    assert.equal(pendingSse?.data?.actionId, pendingAction.actionId);
    assert.equal(
      liveEvents.find((event) => event.event === ApprovalEvents.ON_PENDING_ACTION)?.data?.actionId,
      pendingAction.actionId,
      'the existing SSE stream carries the client-safe pending-action envelope',
    );

    const resumedClients = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: req.get('x-test-user') ?? USER_ID,
        tenantId: req.get('x-test-tenant') ?? TENANT_ID,
        role: 'USER',
      };
      req.config = {
        endpoints: {
          agents: {
            toolApproval: { enabled: true },
          },
        },
        interfaceConfig: {},
      };
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) =>
      route.controller(
        req,
        res,
        next,
        async (initializeInput) => {
          initializeClientCalls += 1;
          const resumedContent = createContentAggregator();
          const client = createAgentClient({
            AgentClient,
            agent,
            req: initializeInput.req,
            agentRuntime: initializeInput.agentRuntime,
            content: resumedContent,
            streamId: initializeInput.req._resumableStreamId,
            jobCreatedAt: initializeInput.jobCreatedAt,
            sseFrames,
            parentMessageId: THREAD_PARENT_ID,
          });
          client.loadHistory = async () => [
            {
              messageId: USER_MESSAGE_ID,
              conversationId: streamId,
              parentMessageId: THREAD_PARENT_ID,
              isCreatedByUser: true,
              text: USER_PROMPT,
              content: USER_PROMPT,
              role: 'user',
              user: USER_ID,
            },
          ];
          client.buildMessages = async () => ({
            prompt: [{ role: 'user', content: USER_PROMPT }],
          });
          client.recordCollectedUsage = async () => undefined;
          client.publishRunContextMeta = async () => undefined;
          const actualResumePiCompletion = client.resumePiCompletion.bind(client);
          client.resumePiCompletion = async (input) => {
            resumedPiInputs.push(input);
            return actualResumePiCompletion(input);
          };
          resumedClients.push(client);
          return { client, userMCPAuthMap: {} };
        },
        async () => undefined,
      ),
    );

    const answersBody = {
      conversationId: streamId,
      generationCreatedAt: job.createdAt,
      actionId: pendingAction.actionId,
      agent_id: AGENT_ID,
      endpoint: 'agents',
      answers: ANSWERS,
    };
    const resumedPiInputs = [];
    const responses = await tenantStorage.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
      Promise.all([
        request(app).post('/api/agents/chat/resume').send(answersBody),
        request(app).post('/api/agents/chat/resume').send(answersBody),
      ]),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
      `Redis CAS admits one of the duplicate answers: ${JSON.stringify(
        responses.map((response) => ({ status: response.status, body: response.body })),
      )}`,
    );

    await waitFor(
      async () => (await librechatApi.GenerationJobManager.getJob(streamId))?.status === 'complete',
    );

    assert.equal(initializeClientCalls, 1);
    assert.equal(resumedClients.length, 1);
    assert.equal(resumedPiInputs.length, 1);
    assert.equal(
      JSON.stringify(resumedPiInputs[0].piAskUserQuestionAnswer),
      JSON.stringify({ answers: ANSWERS }),
    );
    assert.deepEqual(resumedPiInputs[0].piAskUserQuestionContinuation.args.questions, QUESTIONS);
    assert.equal(Object.hasOwn(resumedPiInputs[0], 'prompt'), false);
    assert.equal(Object.hasOwn(resumedPiInputs[0], 'messages'), false);
    assert.equal(
      provider.requestBodies.length,
      2,
      `the real Pi dispatcher starts one continuation; saved=${JSON.stringify(savedMessages.at(-1))}; errors=${JSON.stringify(capturedErrors)}`,
    );
    assert.deepEqual(
      provider.requestBodies[1].messages.map((message) => message.role),
      ['user', 'assistant', 'tool'],
      'Pi continues from the original prompt and the exact pending ask tool call/result exchange',
    );
    assert.equal(
      provider.requestBodies[1].messages.filter(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes(USER_PROMPT),
      ).length,
      1,
      'the original user prompt occurs once in the continuation history and is not replayed as a new prompt',
    );
    assert.equal(
      provider.requestBodies[1].messages[2].content,
      JSON.stringify({ answers: ANSWERS }),
      'the second provider request contains the exact answer JSON as the Pi ask-user tool result',
    );
    assert.equal(
      provider.requestBodies[1].messages[2].tool_call_id,
      continuation.piToolCallId,
      'the tool result is associated with the exact Pi tool-call id that paused',
    );
    assert.deepEqual(provider.authorization, [
      'Bearer pi-ask-user-integration-key',
      'Bearer pi-ask-user-integration-key',
    ]);
    assert.equal(savedMessages.length, 2);
    assert.equal(savedMessages[0].unfinished, true);
    assert.equal(savedMessages[1].unfinished, false);
    assert.ok(
      JSON.stringify(savedMessages[1].content).includes(FINAL_TEXT),
      'the final saved assistant message contains the second provider response',
    );
    assert.deepEqual(bindingDisposals, ['pause', 'resume']);
    assert.deepEqual(capturedErrors, [], 'AgentClient.resumePiCompletion completed without errors');
    const terminal = await librechatApi.GenerationJobManager.getJob(streamId);
    assert.equal(terminal?.status, 'complete');
    assert.equal(terminal?.metadata?.pendingAction, undefined);
    assert.equal(terminal?.metadata?.piResumeContinuation, undefined);
  } finally {
    const managerCleanup = Promise.resolve(
      librechatApi.GenerationJobManager.destroy({ settlementBudgetMs: 0 }),
    ).then(
      () => true,
      () => false,
    );
    subscription?.unsubscribe();
    const providerClosed = provider == null ? true : await settleWithin(provider.close(), 500);
    let dispatcherClosed = true;
    if (piDispatcher != null) {
      dispatcherClosed =
        typeof piDispatcher.destroy === 'function' &&
        (await settleWithin(piDispatcher.destroy(), 500));
    }
    const redisDataCleared = await settleWithin(clearRedisPrefix(redis, testPrefix), 250);
    await closeRedisClient(redis);
    const managersSettled = await settleWithin(managerCleanup, 500);
    forceDisconnectRedisClient(redis);
    stopRouteCacheIntervals();
    if (!providerClosed || !dispatcherClosed || !managersSettled || !redisDataCleared) {
      console.warn(
        'resumeAskUserQuestion cleanup exceeded its bounded close window',
        JSON.stringify({ providerClosed, dispatcherClosed, managersSettled, redisDataCleared }),
      );
    }
    Object.assign(librechatApi, originalApi);
  }
});
