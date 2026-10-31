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
import { Tools } from 'librechat-data-provider';

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

const USER_ID = 'pi-resume-user';
const TENANT_ID = 'pi-resume-tenant';
const AGENT_ID = 'pi-resume-agent';
const USER_MESSAGE_ID = 'pi-resume-user-message';
const RESPONSE_MESSAGE_ID = 'pi-resume-response';
const THREAD_PARENT_ID = 'pi-resume-parent';
const USER_PROMPT = 'Find the maintenance manual.';
const TOOL_RESULT = 'Found two maintenance manuals.';
const FINAL_TEXT = 'I found two maintenance manuals.';

const FILE_SEARCH = {
  name: Tools.file_search,
  description: 'Search agent files.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function createRedisClient(keyPrefix) {
  const url = new URL(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
  return new IoRedis(url.href, {
    keyPrefix,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
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
    // ioredis.disconnect() half-closes the socket with stream.end(), which can
    // leave a pending ShutdownWrap in a short-lived integration process.
    redis.manuallyClosing = true;
    stream.destroy();
  } else {
    redis.disconnect();
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

async function createFakeModelBinding(baseUrl, onDispose) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-cross-replica-test', {
    name: 'Pi cross-replica integration provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'pi-cross-replica-test-key',
    models: [
      {
        id: 'resume-echo',
        name: 'Resume echo model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-cross-replica-test', 'resume-echo');
  assert.ok(model, 'the fake provider model is registered');
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
      const model = requestBodies.at(-1)?.model ?? 'resume-echo';
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({
        id: `pi-resume-${requestNumber}`,
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      if (requestNumber === 1) {
        send({
          id: `pi-resume-${requestNumber}`,
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
                    id: 'pi-provider-call-1',
                    type: 'function',
                    function: {
                      name: Tools.file_search,
                      arguments: JSON.stringify({ query: 'maintenance manual' }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          id: `pi-resume-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        });
      } else {
        send({
          id: `pi-resume-${requestNumber}`,
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { content: FINAL_TEXT }, finish_reason: null }],
        });
        send({
          id: `pi-resume-${requestNumber}`,
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
    return withCacheSweepDisabled(() =>
      require(resolve(apiRoot, 'server/controllers/agents/resume.js')),
    );
  } finally {
    Module._load = originalLoad;
  }
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Timed out waiting for the resumed generation to finish');
}

test('replica B resumes a Pi approval persisted on replica A through POST /resume', async (t) => {
  const testPrefix = `ResumePiCrossReplica:${Date.now()}:`;
  const redisA = createRedisClient(testPrefix);
  const redisB = createRedisClient(testPrefix);
  let managerA;
  let provider;
  let piDispatcher;
  const originalApi = {
    checkAccess: librechatApi.checkAccess,
    checkAndIncrementPendingRequest: librechatApi.checkAndIncrementPendingRequest,
    decrementPendingRequest: librechatApi.decrementPendingRequest,
    captureAgentCheckpointGeneration: librechatApi.captureAgentCheckpointGeneration,
    deleteAgentCheckpoint: librechatApi.deleteAgentCheckpoint,
  };

  try {
    await Promise.all([redisA.connect(), redisB.connect()]);
    await redisA.ping();
    await redisB.ping();
  } catch (error) {
    await Promise.all([closeRedisClient(redisA), closeRedisClient(redisB)]);
    stopRouteCacheIntervals();
    t.skip(`Redis is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const savedMessages = [];
  const providerStarts = [];
  const hostToolEffects = [];
  const modelBindingDisposals = [];
  let initializeClientCalls = 0;
  const agent = {
    _id: 'mongo-pi-resume-agent',
    id: AGENT_ID,
    provider: 'openai',
    model: 'resume-echo',
    instructions: 'Search the approved agent files.',
    model_parameters: { model: 'resume-echo' },
    tools: [Tools.file_search],
    toolDefinitions: [FILE_SEARCH],
    edges: [],
  };

  try {
    provider = await createFakeChatProvider();
    // Pi's configureHttpDispatcher installs this nested Undici dispatcher globally.
    piDispatcher = piUndici.getGlobalDispatcher();
    librechatApi.checkAccess = async () => true;
    librechatApi.checkAndIncrementPendingRequest = async () => ({ allowed: true });
    librechatApi.decrementPendingRequest = async () => undefined;
    librechatApi.captureAgentCheckpointGeneration = async (conversationId) => ({
      threadId: conversationId,
      checkpointIds: [],
    });
    librechatApi.deleteAgentCheckpoint = async () => undefined;

    const storeA = new librechatApi.RedisJobStore(redisA);
    const storeB = new librechatApi.RedisJobStore(redisB);
    managerA = new librechatApi.GenerationJobManagerClass({
      jobStore: storeA,
      eventTransport: new librechatApi.InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    librechatApi.GenerationJobManager.configure({
      jobStore: storeB,
      eventTransport: new librechatApi.InMemoryEventTransport(),
      isRedis: true,
      cleanupOnComplete: false,
    });
    managerA.initialize();
    librechatApi.GenerationJobManager.initialize();

    const ResumeAgentController = createRouteModule({ agent, savedMessages });

    const streamId = `pi-cross-replica-${Date.now()}`;
    const job = await tenantStorage.run({ tenantId: TENANT_ID, userId: USER_ID }, async () =>
      managerA.createJob(streamId, USER_ID, streamId, {
        initialMetadata: {
          agentRuntime: librechatApi.PINNED_PI_AGENT_RUNTIME,
          agent_id: AGENT_ID,
          endpoint: 'agents',
          responseMessageId: RESPONSE_MESSAGE_ID,
          sender: 'Pi integration agent',
          model: 'resume-echo',
          userMessage: {
            messageId: USER_MESSAGE_ID,
            parentMessageId: THREAD_PARENT_ID,
            text: USER_PROMPT,
          },
        },
      }),
    );

    const initialEvents = [];
    const initial = await librechatApi.executePiGeneration({
      messages: [new SystemMessage('Use the local test provider.'), new HumanMessage(USER_PROMPT)],
      createModelBinding: () =>
        createFakeModelBinding(provider.baseUrl, () => modelBindingDisposals.push('pause')),
      toolDefinitions: [FILE_SEARCH],
      executeHostToolCall: async (call) => {
        hostToolEffects.push({ phase: 'pause', call });
        return { toolCallId: call.id, status: 'success', content: 'unexpected early result' };
      },
      createToolStepIdentity: () => ({
        id: 'pi-pending-step',
        index: 0,
        messageId: RESPONSE_MESSAGE_ID,
        runId: RESPONSE_MESSAGE_ID,
        agentId: AGENT_ID,
      }),
      createToolCallId: () => 'host-pi-call-1',
      toolExecutionGate: async () => ({ kind: 'pause', allowedDecisions: ['approve', 'reject'] }),
      createStepIdentity: () => ({
        id: 'pi-content-step',
        index: 0,
        messageId: RESPONSE_MESSAGE_ID,
        runId: RESPONSE_MESSAGE_ID,
        agentId: AGENT_ID,
      }),
      handleHostEvent: (event) => initialEvents.push(event),
    });
    assert.equal(initial.status, 'paused');
    assert.equal(initial.signal.kind, 'tool_approval');
    assert.equal(provider.requestBodies.length, 1);
    assert.deepEqual(hostToolEffects, [], 'Pi pauses before the host tool can have side effects');

    const initialContent = createContentAggregator();
    const emittedEvents = [];
    const initialHandlers = getDefaultHandlers({
      res: {
        writableEnded: false,
        write: (chunk) => emittedEvents.push(chunk),
      },
      aggregateContent: initialContent.aggregateContent,
      contentParts: initialContent.contentParts,
      stepMap: initialContent.stepMap,
      toolEndCallback: async () => undefined,
      collectedUsage: [],
    });
    for (const event of initialEvents) {
      if (event.event === GraphEvents.ON_RUN_STEP) {
        await initialHandlers[event.event].handle(event.event, event.data, {
          last_agent_id: AGENT_ID,
          langgraph_node: `agent=${AGENT_ID}`,
        });
        const emitted = emittedEvents.pop();
        assert.ok(emitted, 'the real ON_RUN_STEP handler emits its event envelope');
        const payload = emitted.split('data: ')[1]?.trim();
        assert.ok(payload, 'the real ON_RUN_STEP handler emits JSON event data');
        const persistedEnvelope = JSON.parse(payload);
        assert.equal(persistedEnvelope.event, GraphEvents.ON_RUN_STEP);
        assert.equal(
          await storeA.appendChunk(streamId, persistedEnvelope, job.createdAt),
          true,
          'replica A persists the exact event envelope emitted by the real callback handler',
        );
      } else {
        await storeA.appendChunk(streamId, { event: event.event, data: event.data }, job.createdAt);
      }
    }
    const initialRunSteps = initialEvents
      .filter((event) => event.event === GraphEvents.ON_RUN_STEP)
      .map((event) => event.data);
    assert.ok(
      initialRunSteps.some(
        (step) => step.id === initial.signal.toolCall.hostExecution.stepIdentity.id,
      ),
    );
    await storeA.saveRunSteps(streamId, initialRunSteps, job.createdAt);

    const pendingAction = librechatApi.buildPendingAction(
      librechatApi.buildPiApprovalInterruptPayload({
        hostToolCallId: initial.signal.toolCall.hostExecution.toolCallId,
        toolName: initial.signal.toolCall.name,
        args: initial.signal.toolCall.args,
        allowedDecisions: initial.signal.toolCall.review.allowedDecisions,
      }),
      {
        streamId,
        conversationId: streamId,
        runId: RESPONSE_MESSAGE_ID,
        responseMessageId: RESPONSE_MESSAGE_ID,
        ttlMs: 60_000,
      },
    );
    const continuation = librechatApi.createPiApprovalContinuation(
      pendingAction.actionId,
      initial.signal.toolCall,
    );
    assert.equal(
      await managerA.approvals.pause(streamId, pendingAction, {
        expectedCreatedAt: job.createdAt,
        piResumeContinuation: continuation,
      }),
      true,
    );

    const persistedByB = await librechatApi.GenerationJobManager.getJob(streamId);
    assert.equal(persistedByB?.status, 'requires_action');
    assert.deepEqual(persistedByB?.metadata?.piResumeContinuation, continuation);
    const chunkEntries = await redisA.xrange(`stream:{${streamId}}:chunks`, '-', '+');
    const persistedEvents = chunkEntries.map(([, fields]) => {
      const eventIndex = fields.indexOf('event');
      assert.notEqual(eventIndex, -1, 'the Redis chunk has its event envelope');
      return JSON.parse(fields[eventIndex + 1]);
    });
    const persistedPiRunStep = persistedEvents.find(
      (event) => event.event === GraphEvents.ON_RUN_STEP,
    );
    assert.ok(persistedPiRunStep, 'replica A persisted the Pi ON_RUN_STEP event');
    assert.deepEqual(persistedPiRunStep.data, initialRunSteps[0]);
    const resumeStateOnB = await librechatApi.GenerationJobManager.getResumeState(
      streamId,
      job.createdAt,
    );
    assert.equal(resumeStateOnB?.pendingAction?.actionId, pendingAction.actionId);
    const piHostState = {
      continuation,
      runSteps: resumeStateOnB?.runSteps ?? [],
      aggregatedContent: resumeStateOnB?.aggregatedContent ?? [],
      responseMessageId: RESPONSE_MESSAGE_ID,
      agentId: AGENT_ID,
    };
    assert.equal(
      librechatApi.matchesPiApprovalHostState(piHostState),
      true,
      `replica B must reconstruct the exact Pi approval host state: ${JSON.stringify({
        continuation,
        runSteps: piHostState.runSteps,
        aggregatedContent: piHostState.aggregatedContent,
      })}`,
    );
    assert.ok(
      resumeStateOnB?.runSteps.some((step) => step.id === continuation.stepIdentity.id),
      'replica B reads the pending Pi host step persisted by replica A',
    );

    const contentAggregator = createContentAggregator();
    const resumedClient = {
      sender: 'Pi integration agent',
      contentParts: [],
      artifactPromises: [],
      pendingApproval: false,
      options: { agent, agentRuntime: librechatApi.PINNED_PI_AGENT_RUNTIME },
      agentConfigs: new Map(),
      buildResponseMetadata: () => null,
      seedContextMeta: () => undefined,
      async resumeCompletion(input) {
        providerStarts.push('replica-b');
        const outcome = await librechatApi.executePiGeneration({
          messages: [
            new SystemMessage('Use the local test provider.'),
            new HumanMessage(USER_PROMPT),
          ],
          createModelBinding: () =>
            createFakeModelBinding(provider.baseUrl, () => modelBindingDisposals.push('resume')),
          toolDefinitions: [FILE_SEARCH],
          executeHostToolCall: async (call) => {
            hostToolEffects.push({ phase: 'resume', call });
            return { toolCallId: call.id, status: 'success', content: TOOL_RESULT };
          },
          createToolStepIdentity: () => ({
            id: 'pi-resume-followup-step',
            index: 1,
            messageId: RESPONSE_MESSAGE_ID,
            runId: RESPONSE_MESSAGE_ID,
            agentId: AGENT_ID,
          }),
          createToolCallId: () => 'host-pi-followup-call',
          createStepIdentity: () => ({
            id: 'pi-resume-content-step',
            index: 1,
            messageId: RESPONSE_MESSAGE_ID,
            runId: RESPONSE_MESSAGE_ID,
            agentId: AGENT_ID,
          }),
          resumeToolResult: {
            continuation: input.piApprovalContinuation,
            toolArguments: input.piApprovalDecision.args,
            execute: async () => {
              const call = {
                id: input.piApprovalContinuation.hostToolCallId,
                name: input.piApprovalContinuation.toolName,
                args: input.piApprovalDecision.args,
                stepId: input.piApprovalContinuation.stepIdentity.id,
              };
              hostToolEffects.push({ phase: 'approved', call });
              return {
                content: [{ type: 'text', text: TOOL_RESULT }],
                isError: false,
              };
            },
          },
          handleHostEvent: (event) => {
            contentAggregator.aggregateContent(event);
          },
        });
        assert.equal(outcome.status, 'completed');
        this.contentParts = [...input.seedContent, ...contentAggregator.contentParts];
      },
    };

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
            toolApproval: { enabled: true, ask: [Tools.file_search] },
          },
        },
        interfaceConfig: {},
      };
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) => {
      return ResumeAgentController(
        req,
        res,
        next,
        async () => {
          initializeClientCalls += 1;
          return { client: resumedClient, userMCPAuthMap: {} };
        },
        async () => undefined,
      );
    });

    const body = {
      conversationId: streamId,
      generationCreatedAt: job.createdAt,
      actionId: pendingAction.actionId,
      agent_id: AGENT_ID,
      endpoint: 'agents',
      decisions: [
        {
          tool_call_id: continuation.hostToolCallId,
          decision: 'approve',
        },
      ],
    };
    const wrongOwner = await tenantStorage.run(
      { tenantId: TENANT_ID, userId: 'another-user' },
      () =>
        request(app).post('/api/agents/chat/resume').set('x-test-user', 'another-user').send(body),
    );
    const wrongTenant = await tenantStorage.run(
      { tenantId: 'another-tenant', userId: USER_ID },
      () =>
        request(app)
          .post('/api/agents/chat/resume')
          .set('x-test-tenant', 'another-tenant')
          .send(body),
    );
    const staleGeneration = await tenantStorage.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
      request(app)
        .post('/api/agents/chat/resume')
        .send({ ...body, generationCreatedAt: job.createdAt + 1 }),
    );
    assert.equal(wrongOwner.status, 403);
    assert.equal(wrongTenant.status, 403);
    assert.equal(staleGeneration.status, 409);
    assert.equal(initializeClientCalls, 0);
    assert.equal(
      (await librechatApi.GenerationJobManager.getJob(streamId))?.status,
      'requires_action',
    );

    const responses = await tenantStorage.run({ tenantId: TENANT_ID, userId: USER_ID }, () =>
      Promise.all([
        request(app).post('/api/agents/chat/resume').send(body),
        request(app).post('/api/agents/chat/resume').send(body),
      ]),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
      `the shared Redis approval CAS admits one of the duplicate route requests: ${JSON.stringify(
        responses.map((response) => ({ status: response.status, body: response.body })),
      )}`,
    );

    await waitFor(
      async () => (await librechatApi.GenerationJobManager.getJob(streamId))?.status === 'complete',
    );

    assert.equal(initializeClientCalls, 1);
    assert.deepEqual(providerStarts, ['replica-b']);
    assert.deepEqual(modelBindingDisposals, ['pause', 'resume']);
    assert.equal(hostToolEffects.filter((effect) => effect.phase === 'approved').length, 1);
    assert.equal(hostToolEffects.filter((effect) => effect.phase === 'pause').length, 0);
    assert.equal(hostToolEffects.filter((effect) => effect.phase === 'resume').length, 0);
    assert.equal(provider.requestBodies.length, 2, 'resume starts a new Pi provider session once');
    assert.ok(
      provider.requestBodies[1].messages.filter(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes(USER_PROMPT),
      ).length === 1,
      'the continuation request carries the original prompt exactly once in history',
    );
    assert.deepEqual(
      provider.requestBodies[1].messages.map((message) => message.role),
      ['user', 'assistant', 'tool'],
      'Pi sends the persisted tool call and its approved result as a continuation exchange',
    );
    assert.deepEqual(provider.authorization, [
      'Bearer pi-cross-replica-test-key',
      'Bearer pi-cross-replica-test-key',
    ]);
    assert.equal(savedMessages.length, 1);
    assert.equal(savedMessages[0].unfinished, false);
    assert.ok(
      JSON.stringify(savedMessages[0].content).includes(FINAL_TEXT),
      'the final persisted message contains the fake provider response',
    );
    const terminal = await librechatApi.GenerationJobManager.getJob(streamId);
    assert.equal(terminal?.status, 'complete');
    assert.equal(terminal?.metadata?.pendingAction, undefined);
    assert.equal(terminal?.metadata?.piResumeContinuation, undefined);
  } finally {
    const managerCleanup = Promise.allSettled([
      managerA?.destroy({ settlementBudgetMs: 0 }),
      librechatApi.GenerationJobManager.destroy({ settlementBudgetMs: 0 }),
    ]).then((results) => results.every((result) => result.status === 'fulfilled'));
    const providerCleanup = provider?.close();
    const providerClosed = await settleWithin(providerCleanup, 500);
    const managersDrainedBeforeDisconnect = await settleWithin(managerCleanup, 250);
    let dispatcherClosed = true;
    if (piDispatcher != null) {
      dispatcherClosed =
        typeof piDispatcher.destroy === 'function' &&
        (await settleWithin(piDispatcher.destroy(), 500));
    }
    const redisDataCleared = await settleWithin(clearRedisPrefix(redisA, testPrefix), 250);
    await Promise.all([closeRedisClient(redisA), closeRedisClient(redisB)]);
    const managersSettled =
      managersDrainedBeforeDisconnect || (await settleWithin(managerCleanup, 250));
    forceDisconnectRedisClient(redisA);
    forceDisconnectRedisClient(redisB);
    stopRouteCacheIntervals();
    if (!providerClosed || !dispatcherClosed || !managersSettled || !redisDataCleared) {
      console.warn(
        'resumeCrossReplica cleanup exceeded its bounded close window',
        JSON.stringify({ providerClosed, dispatcherClosed, managersSettled, redisDataCleared }),
      );
    }
    Object.assign(librechatApi, originalApi);
  }
});
