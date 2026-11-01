const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const { Constants, GraphEvents } = require('@librechat/agents');
const { SystemMessage } = require('@librechat/agents/langchain/messages');
const { StepEvents, UsageEvents } = require('librechat-data-provider');
const {
  AgentRuntimeUnavailableError,
  GenerationJobManager,
  PINNED_PI_AGENT_RUNTIME,
  PI_SUPPORTED_HOST_TOOLS,
  ASK_USER_QUESTION_TOOL_NAME,
  assertPiCompatible,
  buildPiSystemPrompt,
  compilePiActionToolSchemaRegistry,
  compilePiMcpToolSchemaRegistry,
  createAgentRuntimeDispatcher,
  createPiCodeSessionBridge,
  createPiHostToolBatchExecutor,
  createPiToolApprovalGate,
  getAgentPiModelBindingFactory,
  getPluginHookSource,
  isPiActionToolName,
  isPiCodeExecutionToolName,
  isPiManagedCodeExecutionCompatible,
  isPiMcpToolName,
  isHITLEnabled,
  resolveRunToolApprovalAllows,
  resolveToolApprovalPolicy,
  buildToolApprovalHooks,
  resolveRequestTenantId,
  PiToolCompatibilityError,
} = require('@librechat/api');

const agentRuntimeDispatcher = createAgentRuntimeDispatcher();
const INTERNAL_TOOL_NAMES = new Set([Constants.SUBAGENT, 'conditional_transfer']);
const IGNORED_HOST_EVENTS = new Set([
  GraphEvents.ON_RUN_STEP_CLOSED,
  GraphEvents.ON_RUN_STEP_COMPLETED,
  StepEvents.ON_TOOL_CALLS_DISPATCHED,
  UsageEvents.ON_TOKEN_USAGE,
  UsageEvents.ON_CONTEXT_USAGE,
]);

function getRemotePiToolPlan({ agent, agents, callableToolNames, clientToolNames = new Set() }) {
  const names = callableToolNames.filter(
    (name) => !INTERNAL_TOOL_NAMES.has(name) && !clientToolNames.has(name),
  );
  const loadedAgents = new Map();
  const pendingAgents = [...agents];
  for (let index = 0; index < pendingAgents.length; index++) {
    const candidate = pendingAgents[index];
    if (!candidate?.id || loadedAgents.has(candidate.id)) {
      continue;
    }
    loadedAgents.set(candidate.id, candidate);
    for (const subagent of candidate.subagentAgentConfigs?.values?.() ?? []) {
      pendingAgents.push(subagent);
    }
    for (const graph of candidate.subagentGraphConfigs ?? []) {
      pendingAgents.push(...(graph.memberConfigs ?? []));
    }
  }
  const toolDefinitions = Array.isArray(agent?.toolDefinitions) ? agent.toolDefinitions : [];
  const supportedToolDefinitions = toolDefinitions.filter(
    (definition) =>
      (PI_SUPPORTED_HOST_TOOLS.includes(definition?.name) ||
        isPiMcpToolName(definition?.name) ||
        isPiActionToolName(definition?.name)) &&
      names.includes(definition.name) &&
      definition.name !== ASK_USER_QUESTION_TOOL_NAME,
  );

  try {
    assertPiCompatible({
      rootAgentId: agent?.id,
      loadedAgentIds: [...loadedAgents.keys()],
      callableToolNames: names,
      supportedToolNames: supportedToolDefinitions.map((definition) => definition.name),
      unsupportedModes: [],
    });
  } catch (error) {
    if (error instanceof AgentRuntimeUnavailableError) {
      throw error;
    }
    throw new AgentRuntimeUnavailableError();
  }

  if (
    supportedToolDefinitions.some(({ name }) => isPiCodeExecutionToolName(name)) &&
    !isPiManagedCodeExecutionCompatible(agent)
  ) {
    throw new AgentRuntimeUnavailableError();
  }

  return supportedToolDefinitions;
}

/** Run a validated remote Agent request through one isolated Pi session. */
async function executeRemotePiGeneration({
  execution,
  req,
  agent,
  agents,
  callableToolNames,
  messages,
  summary,
  conversationId,
  userId,
  handlers,
  toolExecuteHandler,
  initialSessions,
  usageAttribution,
  onModelProviderError,
  clientToolNames,
  clientToolDefinitions,
  toolDefinitions: admittedToolDefinitions,
}) {
  const toolDefinitions =
    admittedToolDefinitions ??
    getRemotePiToolPlan({ agent, agents, callableToolNames, clientToolNames });
  let mcpToolSchemas;
  let actionToolSchemas;
  try {
    mcpToolSchemas = compilePiMcpToolSchemaRegistry(toolDefinitions);
    actionToolSchemas = compilePiActionToolSchemaRegistry(toolDefinitions);
  } catch (error) {
    if (error instanceof PiToolCompatibilityError) {
      throw new AgentRuntimeUnavailableError();
    }
    throw error;
  }

  const createModelBinding = getAgentPiModelBindingFactory(agent);
  if (createModelBinding == null) {
    throw new AgentRuntimeUnavailableError();
  }

  let nextStepIndex = 0;
  const createStepIdentity = () => {
    const index = nextStepIndex++;
    return {
      id: `pi-${execution.runId}-${nanoid()}`,
      index,
      messageId: execution.runId,
      runId: execution.runId,
      agentId: agent.id,
    };
  };
  const metadata = {
    thread_id: conversationId,
    user_id: userId,
    run_id: execution.runId,
    agent_id: agent.id,
    agentId: agent.id,
    last_agent_id: agent.id,
    langgraph_node: `agent=${agent.id}`,
    hide_sequential_outputs: false,
  };
  const handleHostEvent = async (event) => {
    const handler = handlers?.[event.event];
    if (handler != null && typeof handler.handle === 'function') {
      await handler.handle(event.event, event.data, metadata);
      return;
    }

    /** OpenAI's public tool projection consumes accepted model responses. Pi host
     * tools enter LibreChat's host step boundary directly, so project them as
     * SDK-owned calls; the existing projection omits them from caller output. */
    if (
      event.event === GraphEvents.ON_RUN_STEP &&
      typeof handlers?.on_model_response?.handle === 'function' &&
      event.data?.stepDetails?.type === 'tool_calls'
    ) {
      const toolCalls = event.data.stepDetails.tool_calls ?? [];
      await handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: event.data.id,
        agentId: agent.id,
        messageId: execution.runId,
        toolCalls: toolCalls.map(({ id, name, args }) => ({ id, name, args })),
        toolCallDispositions: toolCalls.map(() => 'sdk'),
        invalidToolCalls: [],
      });
      return;
    }

    if (!IGNORED_HOST_EVENTS.has(event.event)) {
      throw new AgentRuntimeUnavailableError();
    }
  };

  let executeHostToolCall;
  let codeSessionBridge;
  if (toolDefinitions.length > 0) {
    if (toolExecuteHandler == null || typeof toolExecuteHandler.handle !== 'function') {
      throw new AgentRuntimeUnavailableError();
    }
    const codeSessionKey = agent.codeSessionKey ?? Constants.EXECUTE_CODE;
    codeSessionBridge = toolDefinitions.some(({ name }) => isPiCodeExecutionToolName(name))
      ? createPiCodeSessionBridge(initialSessions?.get(codeSessionKey))
      : undefined;
    const executeHostToolBatch = createPiHostToolBatchExecutor({
      handler: toolExecuteHandler,
      userId,
      agentId: agent.id,
      request: req,
      threadId: conversationId,
      runId: execution.runId,
      metadata,
      authorizedToolNames: toolDefinitions.map(({ name }) => name),
      authorize: (signal) =>
        GenerationJobManager.assertPiProviderOwner(execution.runId, execution.createdAt, signal),
      ...(codeSessionBridge == null ? {} : { codeSessionBridge }),
    });
    executeHostToolCall = async (call, signal) => {
      const admitted = await GenerationJobManager.admitPiToolInvocation(
        execution.runId,
        execution.createdAt,
        call.id,
      );
      if (!admitted) {
        const error = new Error('This run no longer owns permission to execute tools.');
        error.code = 'PROVIDER_OWNER_FENCED';
        throw error;
      }
      return executeHostToolBatch(call, signal);
    };
  }

  const appConfig = req.config;
  const agentsConfig = appConfig?.endpoints?.agents;
  const toolApprovalPolicy = resolveToolApprovalPolicy({
    endpoint: agentsConfig?.toolApproval,
    attachedCodeEnvironment: toolDefinitions.some(({ name }) => isPiCodeExecutionToolName(name)),
  });
  const resolvedToolApprovalHooks = isHITLEnabled(toolApprovalPolicy)
    ? buildToolApprovalHooks({
        userId,
        conversationId,
        tenantId: resolveRequestTenantId(req),
        appConfig,
      })
    : undefined;
  const toolExecutionGate = createPiToolApprovalGate({
    policy: toolApprovalPolicy,
    allowedTools: resolveRunToolApprovalAllows(
      agentsConfig?.toolApproval,
      req.resolvedConversation,
      conversationId,
    ),
    logger,
    pluginHookSource: getPluginHookSource(),
    resolvedHooks: resolvedToolApprovalHooks,
    hookContext: { userId, conversationId, tenantId: resolveRequestTenantId(req), appConfig },
    runId: execution.runId,
    threadId: conversationId,
    agentId: agent.id,
    mcpToolSchemas,
    actionToolSchemas,
    model: agent.model_parameters?.model ?? agent.model,
  });

  const systemPrompt = buildPiSystemPrompt({ agent, summary });
  const piMessages =
    systemPrompt.length > 0 ? [new SystemMessage(systemPrompt), ...messages] : messages;
  const outcome = await agentRuntimeDispatcher.executeTurn({
    engine: 'pi',
    selection: PINNED_PI_AGENT_RUNTIME,
    input: {
      messages: piMessages,
      createModelBinding,
      toolDefinitions,
      mcpToolSchemas,
      actionToolSchemas,
      ...(executeHostToolCall == null ? {} : { executeHostToolCall }),
      ...(toolDefinitions.length === 0 ? {} : { toolExecutionGate }),
      ...(codeSessionBridge == null
        ? {}
        : { getCodeSessionContext: () => codeSessionBridge.snapshot() }),
      ...(clientToolNames?.size ? { clientToolDefinitions } : {}),
      createToolStepIdentity: createStepIdentity,
      createToolCallId: () => `pi-host-${execution.runId}-${nanoid()}`,
      signal: execution.signal,
      usageAttribution: {
        ...usageAttribution,
        agentId: agent.id,
        runId: execution.runId,
      },
      ...(onModelProviderError == null ? {} : { onModelProviderError }),
      createStepIdentity,
      handleHostEvent,
      onSessionCreated: () => undefined,
    },
  });
  if (outcome.status === 'unsupported' || outcome.status === 'paused') {
    throw new AgentRuntimeUnavailableError();
  }
  return outcome;
}

module.exports = { executeRemotePiGeneration, getRemotePiToolPlan };
