const mockExecutePiGeneration = jest.fn();
const mockGetAgentPiModelBindingFactory = jest.fn();
const mockRuntimeCounter = jest.fn((counter, encoding) =>
  jest.requireActual('@librechat/api').withRetainedAnswerTokenCounter(counter, encoding),
);
const mockCountFormattedMessageTokens = jest.fn(
  (message) => JSON.stringify(message?.content ?? '').length,
);
const mockFormatAgentMessages = jest.fn(() => ({
  messages: [],
  indexTokenCountMap: {},
  summary: undefined,
  boundaryTokenAdjustment: undefined,
}));
const mockFormatInstructions = jest.fn().mockResolvedValue('');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({ handleLLMEnd: jest.fn(), collected: [] }),
  formatAgentMessages: (...args) => mockFormatAgentMessages(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAccess: jest.fn(),
  withRetainedAnswerTokenCounter: (...args) => mockRuntimeCounter(...args),
  prepareRetainedAnswers: (input) =>
    jest.requireActual('@librechat/api').prepareRetainedAnswers({
      ...input,
      countTokens: (text) => mockCountFormattedMessageTokens({ role: 'user', content: text }),
    }),
  executePiGeneration: (...args) => mockExecutePiGeneration(...args),
  getAgentPiModelBindingFactory: (...args) => mockGetAgentPiModelBindingFactory(...args),
  countFormattedMessageTokens: (...args) => mockCountFormattedMessageTokens(...args),
  countTokens: jest.fn((text) => Math.ceil(String(text ?? '').length / 4)),
  createCachedTokenCounter: jest.fn(async () => mockCountFormattedMessageTokens),
  getAgentCheckpointer: jest.fn(),
  hasDurableAgentInterruptCheckpoint: jest.fn().mockResolvedValue(true),
  initializeAgent: jest.fn(),
  isHITLEnabled: jest.fn(() => false),
  loadAgent: jest.fn(),
  maybePrewarmCodeSandbox: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/models', () => ({
  bulkInsertTransactions: jest.fn(),
  getCacheMultiplier: jest.fn(),
  getAgent: jest.fn(),
  getMultiplier: jest.fn(),
  getFiles: jest.fn(),
  getMessages: jest.fn(),
  getRoleByName: jest.fn(),
  getUserMemories: jest.fn(),
  getFormattedMemories: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn().mockResolvedValue(true),
  spendStructuredTokens: jest.fn(),
  spendTokens: jest.fn(),
  updateBalance: jest.fn(),
}));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({ formatInstructionsForContext: mockFormatInstructions })),
}));

const { Constants, ContentTypes, EModelEndpoint, Tools } = require('librechat-data-provider');
const { GraphEvents } = require('@librechat/agents');
const { getMessages } = require('~/models');
const AgentClient = require('../client');
const { applyRetainedAnswers, GenerationJobManager, PINNED_PI_AGENT_RUNTIME } =
  jest.requireActual('@librechat/api');
const { formatAgentMessages } = jest.requireActual('@librechat/agents');

async function buildPrompt(client, rows, parent) {
  const built = await client.buildMessages(rows, parent, {});
  const formatted = formatAgentMessages(built.prompt, client.indexTokenCountMap);
  const applied = applyRetainedAnswers({
    block: client.retainedAnswers?.block,
    ...formatted,
    tokenCounter: mockCountFormattedMessageTokens,
  });
  return {
    ...built,
    prompt: applied.messages,
    counts: applied.indexTokenCountMap,
    memoryMessages: formatted.messages,
  };
}

const ANSWER_LINE = 'Q: Which environment should I deploy to?\nA: staging';
const LATEST_TEXT = 'what is next?';

function askPart(request, output, id) {
  return {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id,
      name: 'ask_user_question',
      args: JSON.stringify(request),
      output,
      progress: 1,
    },
  };
}

/** The text a formatted message carries, whether its content is a string or parts. */
function contentText(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  return (content ?? [])
    .filter((part) => part?.type === ContentTypes.TEXT)
    .map((part) => part.text)
    .join('\n');
}

function latestUserMessage() {
  return {
    messageId: 'u3',
    parentMessageId: 'a2',
    sender: 'User',
    text: LATEST_TEXT,
    isCreatedByUser: true,
  };
}

/**
 * A branch whose answered question sits BEFORE a checkpoint summary: the prompt
 * builder's history walk stops at the summary, so the model no longer sees the
 * message that carried the answer.
 */
function compactedBranch() {
  return [
    {
      messageId: 'u1',
      parentMessageId: Constants.NO_PARENT,
      sender: 'User',
      text: 'deploy the app',
      isCreatedByUser: true,
    },
    {
      messageId: 'a1',
      parentMessageId: 'u1',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [
        { type: ContentTypes.TEXT, text: 'Let me check.' },
        askPart(
          { questions: [{ id: 'environment', question: 'Which environment should I deploy to?' }] },
          JSON.stringify({ answers: { environment: 'staging' } }),
          'tc-1',
        ),
      ],
    },
    {
      messageId: 'u2',
      parentMessageId: 'a1',
      sender: 'User',
      text: 'go on',
      isCreatedByUser: true,
    },
    {
      messageId: 'a2',
      parentMessageId: 'u2',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [
        { type: ContentTypes.SUMMARY, text: 'Earlier context, compacted.', tokenCount: 5 },
        { type: ContentTypes.TEXT, text: 'Deployed.' },
      ],
    },
    latestUserMessage(),
  ];
}

function makeClient(agentsConfig = {}) {
  const client = new AgentClient({
    req: {
      user: { id: 'user-123' },
      body: { endpoint: EModelEndpoint.agents },
      config: { endpoints: { [EModelEndpoint.agents]: agentsConfig } },
    },
    res: {},
    agentRuntime: PINNED_PI_AGENT_RUNTIME,
    agent: {
      id: 'agent-123',
      endpoint: EModelEndpoint.openAI,
      provider: EModelEndpoint.openAI,
      instructions: 'Base agent instructions',
      model_parameters: { model: 'gpt-4' },
      tools: [],
    },
    endpoint: EModelEndpoint.agents,
    endpointTokenConfig: {},
    eventHandlers: {},
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
  });
  client.conversationId = 'convo-123';
  client.responseMessageId = 'response-123';
  client.shouldSummarize = true;
  client.maxContextTokens = 4096;
  client.recordCollectedUsage = jest.fn().mockResolvedValue();
  return client;
}

describe('AgentClient retained answers', () => {
  afterAll(async () => {
    await GenerationJobManager.destroy();
  });

  const ROW_QUERY = [
    { conversationId: 'convo-123', user: 'user-123' },
    'messageId parentMessageId content isCreatedByUser isUserSubmitted userSubmittedPaths userSubmittedMessageFieldPaths',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAgentPiModelBindingFactory.mockReturnValue(jest.fn());
    mockExecutePiGeneration.mockResolvedValue({ status: 'completed', usage: [] });
    mockFormatInstructions.mockResolvedValue('');
    getMessages.mockResolvedValue([]);
  });

  it('completes the branch the history read cut at the summary and quotes the answer in the user turn', async () => {
    const client = makeClient();
    client.user = 'user-123';
    client.processMemory = jest.fn();
    const rows = compactedBranch();
    /** The stored count covers the whole response, including what preceded its summary. */
    const storedResponseTokens = 5000;
    const response = rows.find((row) => row.messageId === 'a2');
    response.tokenCount = storedResponseTokens;
    response.content.unshift({ type: ContentTypes.TEXT, text: 'Checking the pipeline.' });
    getMessages.mockResolvedValue(rows);
    /** The real loader: one read of the conversation, then the summary-bounded walk. */
    const cut = await client.loadHistory('convo-123', 'u3');
    expect(cut.map((message) => message.messageId)).toEqual(['a2', 'u3']);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(client.loadedHistoryRows).toBe(rows);

    const { prompt, tokenCountMap, counts, memoryMessages } = await buildPrompt(client, cut, 'u3');

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(client.loadedHistoryRows).toBeUndefined();
    expect(JSON.stringify(memoryMessages)).not.toContain(ANSWER_LINE);
    const text = prompt.map(contentText).join('\n');
    expect(text).toContain(ANSWER_LINE);
    expect(text.indexOf(ANSWER_LINE)).toBeLessThan(text.indexOf(LATEST_TEXT));
    expect(text.endsWith(LATEST_TEXT)).toBe(true);
    expect(client.options.agent.additional_instructions ?? '').not.toContain(ANSWER_LINE);
    expect(text).toContain('Deployed.');
    expect(text).not.toContain('Checking the pipeline.');
    expect(tokenCountMap.a2).toBeGreaterThan(0);
    expect(tokenCountMap.a2).toBeLessThan(storedResponseTokens);
    expect(cut[1].text).toBe(LATEST_TEXT);
    expect(cut[1].content).toBeUndefined();
    expect(counts[prompt.length - 1]).toBe(tokenCountMap.u3);
    expect(contentText(memoryMessages[memoryMessages.length - 1])).not.toContain(ANSWER_LINE);
  });

  it.each(['cold', 'warm'])(
    'dispatches %s retained answers to Pi while memory receives the original transcript',
    async (historyState) => {
      const client = makeClient();
      client.processMemory = jest.fn();
      client.runMemory = jest.fn().mockResolvedValue();
      client.user = 'user-123';
      getMessages.mockResolvedValue(compactedBranch());
      const built =
        historyState === 'cold'
          ? await client.buildMessages(await client.loadHistory('convo-123', 'u3'), 'u3', {})
          : await client.buildMessages([latestUserMessage()], 'u3', {});
      mockFormatAgentMessages.mockImplementationOnce(formatAgentMessages);

      await client.chatCompletion({ payload: built.prompt });

      expect(mockExecutePiGeneration).toHaveBeenCalledTimes(1);
      const [input] = mockExecutePiGeneration.mock.calls[0];
      expect(input.messages.map(contentText).join('\n')).toContain(ANSWER_LINE);
      expect(input.messages.map(contentText).join('\n')).toContain(LATEST_TEXT);
      expect(mockRuntimeCounter).toHaveBeenCalledTimes(1);
      expect(input.contextUsage.tokenCounter).toBe(mockRuntimeCounter.mock.results[0].value);
      expect(input.contextPruning.maxContextTokens).toBe(4096);
      expect(input.contextPruning.indexTokenCountMap).not.toHaveProperty('0');
      const retainedMessage = input.messages.find((message) =>
        message.additional_kwargs?.librechat_retained_answers?.includes(ANSWER_LINE),
      );
      expect(retainedMessage).toBeDefined();
      const retainedBlock = retainedMessage.additional_kwargs.librechat_retained_answers;
      const messageWithoutRetainedBlock = new retainedMessage.constructor({
        content: retainedMessage.content.replace(retainedBlock, ''),
        additional_kwargs: retainedMessage.additional_kwargs,
        id: retainedMessage.id,
      });
      expect(input.contextUsage.tokenCounter(retainedMessage)).toBeGreaterThan(
        input.contextUsage.tokenCounter(messageWithoutRetainedBlock),
      );
      expect(client.runMemory).toHaveBeenCalledTimes(1);
      const memoryMessages = client.runMemory.mock.calls[0][0];
      expect(memoryMessages.map(contentText).join('\n')).not.toContain(ANSWER_LINE);
      expect(contentText(memoryMessages.at(-1))).toContain(LATEST_TEXT);
      expect(client.memoryPayload).toBeNull();
      expect(client.run).toBeUndefined();
      if (historyState === 'warm') {
        expect(getMessages).toHaveBeenCalledWith(...ROW_QUERY);
      }
    },
  );

  it('passes the retained-aware token counter through a Pi approval resume', async () => {
    const client = makeClient();
    const job = await GenerationJobManager.createJob('convo-123', 'user-123', 'convo-123');
    client.jobCreatedAt = job.createdAt;
    const counter = jest.fn(() => 123);
    mockRuntimeCounter.mockReturnValueOnce(counter);
    mockExecutePiGeneration.mockImplementationOnce(async ({ onSessionCreated }) => {
      onSessionCreated?.();
      return { status: 'completed', usage: [] };
    });
    client.options.req._resumableStreamId = 'convo-123';
    client.options.req.body.agent_id = 'agent-123';
    client.options.agent.tools = [{ name: Tools.file_search }];
    client.options.agent.toolDefinitions = [
      {
        name: Tools.file_search,
        description: 'Search the agent files.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];
    client.options.eventHandlers = {
      [GraphEvents.ON_TOOL_EXECUTE]: { handle: jest.fn() },
    };
    client.parentMessageId = 'resume-user-message';
    const historyRows = [
      {
        messageId: 'resume-user-message',
        parentMessageId: Constants.NO_PARENT,
        sender: 'User',
        text: 'Continue the search.',
        isCreatedByUser: true,
      },
    ];
    client.loadHistory = jest.fn(async () => {
      client.onHistoryLoaded(historyRows);
      return historyRows;
    });
    client.buildMessages = jest.fn().mockResolvedValue({
      prompt: [{ role: 'user', content: 'Continue the search.' }],
    });
    client.getBuildMessagesOptions = jest.fn(() => ({}));
    client.isCompactionTurn = jest.fn(() => false);
    const continuation = {
      version: 1,
      actionId: 'action-retained-counter',
      piToolCallId: 'pi-tool-retained-counter',
      hostToolCallId: 'host-tool-retained-counter',
      toolTurn: 0,
      allowedDecisions: ['approve', 'reject'],
      stepIdentity: {
        id: 'step-retained-counter',
        index: 0,
        messageId: client.responseMessageId,
        runId: client.responseMessageId,
        agentId: client.options.agent.id,
      },
      stepCreatedAt: 100,
      toolName: Tools.file_search,
      args: { query: 'resume files' },
    };

    await client.resumeCompletion({
      piApprovalContinuation: continuation,
      piApprovalDecision: { kind: 'reject' },
      streamId: 'convo-123',
      checkpointNamespace: 'retained-counter',
    });

    expect(mockRuntimeCounter).toHaveBeenCalledTimes(1);
    expect(mockExecutePiGeneration).toHaveBeenCalledTimes(1);
    expect(mockExecutePiGeneration.mock.calls[0][0].contextUsage.tokenCounter).toBe(counter);
    expect(mockExecutePiGeneration.mock.calls[0][0].resumeToolResult.continuation).toEqual(
      continuation,
    );
    expect(client.runtimeProgress).toMatchObject({
      selection: { engine: 'pi', sdkVersion: '1.4.0' },
      started: true,
      status: 'completed',
    });
  });

  it('reads nothing when the rows in memory already reach the branch root', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];

    const { prompt } = await buildPrompt(client, rows, 'u3');

    expect(getMessages).not.toHaveBeenCalled();
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
  });

  it('leaves the turn alone when the operator turned retained answers off', async () => {
    const client = makeClient({ askUserQuestion: { retainedAnswers: { enabled: false } } });

    const { prompt } = await buildPrompt(client, compactedBranch(), 'u3');

    expect(getMessages).not.toHaveBeenCalled();
    expect(contentText(prompt[prompt.length - 1])).toBe(LATEST_TEXT);
    expect(client.memoryPayload).toBeNull();
  });

  it('reads the stored branch for a warm event-actor turn that skipped history', async () => {
    const client = makeClient();
    client.eventActorContinuation = 'warm';
    getMessages.mockResolvedValue(compactedBranch());

    const { prompt } = await buildPrompt(client, [latestUserMessage()], 'u3');

    expect(getMessages).toHaveBeenCalledWith(...ROW_QUERY);
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
  });

  it('leaves an array-form user row and its memory copy untouched', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    client.processMemory = jest.fn();
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    const shared = [{ type: ContentTypes.TEXT, text: LATEST_TEXT }];
    rows[4] = { ...rows[4], text: undefined, content: shared };

    const { prompt, memoryMessages } = await buildPrompt(client, rows, 'u3');

    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(shared).toEqual([{ type: ContentTypes.TEXT, text: LATEST_TEXT }]);
    expect(rows[4].content).toBe(shared);
    expect(contentText(memoryMessages[memoryMessages.length - 1])).toBe(LATEST_TEXT);
  });

  it('measures the block against a fresh count even when the stored count was calibrated', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    rows[4].tokenCount = 5000;

    const { prompt, tokenCountMap, counts } = await buildPrompt(client, rows, 'u3');

    expect(tokenCountMap.u3).toBe(5000);
    const blockOnly = mockCountFormattedMessageTokens({
      role: 'user',
      content: [{ type: ContentTypes.TEXT, text: ANSWER_LINE }],
    });
    expect(counts[prompt.length - 1]).toBe(5000);
    expect(
      counts[prompt.findIndex((message) => message.id === 'librechat:retained-answers')],
    ).toBeGreaterThanOrEqual(blockOnly);
  });

  it('builds no memory copy when memory processing is inactive', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];

    const { prompt } = await buildPrompt(client, rows, 'u3');

    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(client.memoryPayload).toBeNull();
  });

  it('quotes into the turn being continued when the leaf is the unfinished response', async () => {
    const client = makeClient();
    client.shouldSummarize = false;
    const rows = compactedBranch();
    rows[3].content = [{ type: ContentTypes.TEXT, text: 'Deployed.' }];
    rows.push({
      messageId: 'a3',
      parentMessageId: 'u3',
      sender: 'Agent',
      isCreatedByUser: false,
      content: [{ type: ContentTypes.TEXT, text: 'Next I will' }],
      unfinished: true,
    });

    const { prompt } = await buildPrompt(client, rows, 'a3');

    expect(prompt[prompt.length - 1].getType()).toBe('ai');
    expect(
      contentText(prompt.find((message) => message.id === 'librechat:retained-answers')),
    ).toContain(ANSWER_LINE);
    expect(contentText(prompt[prompt.length - 1])).not.toContain(ANSWER_LINE);
  });
});
