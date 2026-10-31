const mockPause = jest.fn();
const mockEmitChunk = jest.fn();

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: {
      ...actual.GenerationJobManager,
      approvals: {
        ...actual.GenerationJobManager.approvals,
        pause: (...args) => mockPause(...args),
      },
      emitChunk: (...args) => mockEmitChunk(...args),
    },
  };
});

const { ApprovalEvents, EModelEndpoint, Tools } = require('librechat-data-provider');
const { ASK_USER_QUESTION_TOOL_NAME } = require('@librechat/api');
const AgentClient = require('../client');

const QUESTIONS = [
  { id: 'plant_code', question: 'Which plant should I use?' },
  { id: 'window_7d', question: 'Which time window should I check?' },
];

function makePauseSignal() {
  const args = { questions: QUESTIONS };
  return {
    kind: 'ask_user_question',
    toolCall: {
      toolCallId: 'pi-tool-call-1',
      name: ASK_USER_QUESTION_TOOL_NAME,
      args,
      hostExecution: {
        toolCallId: 'host-tool-call-1',
        toolTurn: 0,
        stepIdentity: {
          id: 'pi-step-1',
          index: 0,
          messageId: 'response-1',
          runId: 'response-1',
          agentId: 'agent-1',
        },
        createdAt: 10,
      },
    },
  };
}

function makeToolApprovalSignal() {
  return {
    kind: 'tool_approval',
    toolCall: {
      toolCallId: 'pi-file-search-1',
      name: Tools.file_search,
      args: { query: 'maintenance manual' },
      review: { allowedDecisions: ['approve', 'reject'] },
      hostExecution: {
        toolCallId: 'host-file-search-1',
        toolTurn: 0,
        stepIdentity: {
          id: 'pi-tool-step-1',
          index: 0,
          messageId: 'response-1',
          runId: 'response-1',
          agentId: 'agent-1',
        },
        createdAt: 10,
      },
    },
  };
}

function makeClient({ agentTools = [ASK_USER_QUESTION_TOOL_NAME], config = {} } = {}) {
  const client = Object.create(AgentClient.prototype);
  client.options = {
    req: {
      user: { id: 'user-1' },
      body: { endpoint: EModelEndpoint.agents },
      config: {
        endpoints: { [EModelEndpoint.agents]: {} },
        ...config,
      },
    },
    agent: {
      id: 'agent-1',
      model_parameters: { model: 'gpt-4o-mini' },
      toolDefinitions: agentTools.map((name) => ({ name })),
    },
    eventHandlers: {},
  };
  client.conversationId = 'conversation-1';
  client.responseMessageId = 'response-1';
  client.eventActorInvocationId = null;
  client.contentParts = [
    {
      type: 'tool_call',
      tool_call: {
        id: 'host-tool-call-1',
        name: ASK_USER_QUESTION_TOOL_NAME,
        args: JSON.stringify({ questions: QUESTIONS }),
        output: '',
      },
    },
  ];
  client.jobCreatedAt = null;
  client.pendingRequestReleased = true;
  client.pendingApproval = null;
  client.exposedApprovalActionId = null;
  client.getEncoding = () => undefined;
  return client;
}

describe('AgentClient Pi ask-user pause lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPause.mockResolvedValue(true);
    mockEmitChunk.mockResolvedValue(undefined);
  });

  it('publishes the existing pending-action SSE with the Pi question continuation', async () => {
    const client = makeClient();
    const executePiGeneration = jest.fn().mockResolvedValue({
      status: 'paused',
      signal: makePauseSignal(),
    });
    const outcome = await executePiGeneration();

    await client.handlePiPauseInterrupt(outcome.signal, 'stream-1');
    await client.exposePendingApproval();

    expect(executePiGeneration).toHaveBeenCalledTimes(1);
    expect(mockPause).toHaveBeenCalledTimes(1);
    const [streamId, pendingAction, projection] = mockPause.mock.calls[0];
    expect(streamId).toBe('stream-1');
    expect(pendingAction.payload).toEqual({
      type: ASK_USER_QUESTION_TOOL_NAME,
      question: { question: QUESTIONS[0].question },
      questions: QUESTIONS,
      tool_call_id: 'host-tool-call-1',
    });
    expect(projection.piResumeContinuation).toMatchObject({
      kind: 'ask_user_question',
      actionId: pendingAction.actionId,
      piToolCallId: 'pi-tool-call-1',
      hostToolCallId: 'host-tool-call-1',
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      args: { questions: QUESTIONS },
    });
    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-1',
      {
        event: ApprovalEvents.ON_PENDING_ACTION,
        data: expect.objectContaining({
          actionId: pendingAction.actionId,
          payload: pendingAction.payload,
        }),
      },
      { expectedCreatedAt: null },
    );
    expect(client.pendingApproval).toBe(pendingAction);
  });

  it('offers and persists the existing conversation-level allow-always approval', async () => {
    const client = makeClient({
      agentTools: [Tools.file_search],
      config: {
        endpoints: {
          [EModelEndpoint.agents]: {
            toolApproval: { enabled: true, allowAlways: true },
          },
        },
      },
    });

    await client.handlePiPauseInterrupt(makeToolApprovalSignal(), 'stream-1');

    const [streamId, pendingAction, projection] = mockPause.mock.calls[0];
    expect(streamId).toBe('stream-1');
    expect(pendingAction.payload.review_configs).toEqual([
      expect.objectContaining({
        tool_call_id: 'host-file-search-1',
        allow_always: true,
      }),
    ]);
    expect(pendingAction.toolApprovalAliases).toBeUndefined();
    expect(projection.piResumeContinuation).toMatchObject({
      toolName: Tools.file_search,
      args: { query: 'maintenance manual' },
    });
  });

  it.each([
    [
      'administrator-filtered',
      { filteredTools: [ASK_USER_QUESTION_TOOL_NAME] },
      [ASK_USER_QUESTION_TOOL_NAME],
    ],
    ['agent-capability-disabled', {}, []],
  ])(
    'fails closed before publishing when the %s gate is closed',
    async (_name, config, agentTools) => {
      const client = makeClient({ config, agentTools });

      await expect(
        client.handlePiPauseInterrupt(makePauseSignal(), 'stream-1'),
      ).rejects.toHaveProperty('name', 'AgentRuntimeUnavailableError');

      expect(mockPause).not.toHaveBeenCalled();
      expect(mockEmitChunk).not.toHaveBeenCalled();
    },
  );
});
