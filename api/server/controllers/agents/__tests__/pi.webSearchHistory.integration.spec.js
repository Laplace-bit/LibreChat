const mockHistoryRows = new Map();

jest.mock('~/models', () => ({
  saveMessage: jest.fn(async (_context, message) => {
    const { databasePromise: _databasePromise, ...persisted } = message;
    const row = structuredClone(persisted);
    mockHistoryRows.set(row.messageId, row);
    return row;
  }),
  getConvoOwnership: jest.fn(async (userId, conversationId) =>
    userId === 'pi-history-user' && conversationId === 'pi-history-conversation'
      ? { conversationId, user: userId }
      : null,
  ),
  getMessages: jest.fn(async ({ conversationId, messageId, user }) => {
    if (user !== 'pi-history-user' || conversationId !== 'pi-history-conversation') {
      return [];
    }
    const row = mockHistoryRows.get(messageId);
    if (row == null) {
      return [];
    }
    const { user: _user, privateText: _privateText, contextMeta: _contextMeta, ...publicRow } = row;
    return [structuredClone(publicRow)];
  }),
  stampConvoLastResponse: jest.fn(async () => undefined),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    prepareToolCallPreviews: () => async (messages) => messages,
    resolveMessagesPageSize: async () => 25,
    awaitPageSize: async (pageSize) => pageSize,
  };
});

jest.mock('~/server/middleware', () => {
  const actual = jest.requireActual('~/server/middleware');
  return {
    ...actual,
    requireJwtAuth: (req, _res, next) => next(),
    canReadActiveJobConversation: async () => false,
  };
});

jest.mock('~/server/services/Config', () => ({
  getAppConfig: async () => ({}),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

const express = require('express');
const http = require('node:http');
const request = require('supertest');
const {
  EModelEndpoint,
  SearchProviders,
  ScraperProviders,
  RerankerTypes,
  Tools,
} = require('librechat-data-provider');
const { createSearchTool, WebSearchToolDefinition } = require('@librechat/agents');
const {
  createPiHostToolBatchExecutor,
  createPiHostToolExecutor,
  createPiTools,
  createToolExecuteHandler,
} = require('@librechat/api');
const BaseClient = require('~/app/clients/BaseClient');
const messagesRouter = require('~/server/routes/messages');
const { createToolEndCallback } = require('~/server/controllers/agents/callbacks');

const USER_ID = 'pi-history-user';
const TENANT_ID = 'pi-history-tenant';
const CONVERSATION_ID = 'pi-history-conversation';
const RESPONSE_MESSAGE_ID = 'pi-history-response';
const AGENT_ID = 'pi-history-agent';
const TOOL_CALL_ID = 'pi-history-tool-call';
const STEP_ID = 'pi-history-step';
const SOURCE_URL = 'https://example.test/pump-standard';

describe('Pi web_search persisted history integration', () => {
  let app;
  let server;

  beforeEach(() => {
    mockHistoryRows.clear();
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
  });

  it('persists the Pi host citation and restores it through the history route', async () => {
    const receivedPaths = [];
    server = http.createServer((req, res) => {
      receivedPaths.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.startsWith('/v1/search')) {
          res.end(
            JSON.stringify({
              results: [
                {
                  title: 'Pump vibration standard',
                  url: SOURCE_URL,
                  snippet: 'The standard covers pump vibration severity.',
                },
              ],
            }),
          );
          return;
        }
        if (req.url?.startsWith('/v1/fetch')) {
          res.end(
            JSON.stringify({
              url: SOURCE_URL,
              title: 'Pump vibration standard',
              content: 'The standard covers pump vibration severity.',
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Unexpected test request.' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const searchBaseUrl = `http://127.0.0.1:${port}`;

    const req = {
      user: { id: USER_ID, tenantId: TENANT_ID },
      body: { conversationId: CONVERSATION_ID },
      config: { endpoints: { agents: {} } },
    };
    const artifactPromises = [];
    const searchTool = createSearchTool({
      searchProvider: SearchProviders.KEENABLE,
      keenableApiUrl: `${searchBaseUrl}/v1/search`,
      keenableSearchOptions: { timeout: 2_000 },
      scraperProvider: ScraperProviders.KEENABLE,
      keenableScraperOptions: { apiUrl: `${searchBaseUrl}/v1/fetch`, timeout: 2_000 },
      rerankerType: RerankerTypes.NONE,
      topResults: 1,
    });
    const toolEndCallback = createToolEndCallback({
      req,
      res: { headersSent: false, write: jest.fn() },
      artifactPromises,
    });
    const hostToolHandler = createToolExecuteHandler({
      loadTools: async (toolNames) => {
        expect(toolNames).toEqual([Tools.web_search]);
        return { loadedTools: [searchTool] };
      },
      toolEndCallback,
    });
    const metadata = {
      thread_id: CONVERSATION_ID,
      run_id: RESPONSE_MESSAGE_ID,
      agent_id: AGENT_ID,
      agentId: AGENT_ID,
      last_agent_id: AGENT_ID,
      langgraph_node: `agent=${AGENT_ID}`,
    };
    const executeHostToolCall = createPiHostToolBatchExecutor({
      handler: hostToolHandler,
      userId: USER_ID,
      agentId: AGENT_ID,
      request: req,
      threadId: CONVERSATION_ID,
      runId: RESPONSE_MESSAGE_ID,
      metadata,
      authorize: async () => true,
      authorizedToolNames: [Tools.web_search],
    });
    const executePiTool = createPiHostToolExecutor({
      createStepIdentity: () => ({
        id: STEP_ID,
        index: 0,
        messageId: RESPONSE_MESSAGE_ID,
        runId: RESPONSE_MESSAGE_ID,
        agentId: AGENT_ID,
      }),
      createToolCallId: () => TOOL_CALL_ID,
      executeHostToolCall,
      initialToolUsageCounts: { [Tools.web_search]: 2 },
      handleHostEvent: async () => undefined,
    });
    const [piWebSearchTool] = createPiTools({
      definitions: [
        {
          name: Tools.web_search,
          description: WebSearchToolDefinition.description,
          parameters: WebSearchToolDefinition.schema,
        },
      ],
      execute: executePiTool,
    });

    const client = Object.create(BaseClient.prototype);
    Object.assign(client, {
      options: {
        req,
        res: {},
        endpoint: EModelEndpoint.agents,
        agent: { id: AGENT_ID },
        resendFiles: false,
      },
      clientName: EModelEndpoint.agents,
      sender: 'AI',
      user: USER_ID,
      conversationId: CONVERSATION_ID,
      responseMessageId: RESPONSE_MESSAGE_ID,
      currentMessages: [],
      artifactPromises,
      savedMessageIds: new Set(),
      skipSaveConvo: true,
      skipSaveUserMessage: true,
      model: 'gpt-4o',
      handleStartMethods: async () => ({
        user: USER_ID,
        head: 'pi-history-parent',
        isEdited: false,
        conversationId: CONVERSATION_ID,
        responseMessageId: RESPONSE_MESSAGE_ID,
        saveOptions: {},
        userMessage: {
          messageId: 'pi-history-user-message',
          conversationId: CONVERSATION_ID,
          parentMessageId: 'pi-history-parent',
          isCreatedByUser: true,
          text: 'Find the pump vibration standard.',
        },
      }),
      getModelBoundStoredMessages: () => [],
      setModelBoundStoredMessages: () => undefined,
      assertStoredModelBoundContent: () => undefined,
      getBuildMessagesOptions: () => ({}),
      buildMessages: async () => ({ prompt: [], promptTokens: 0 }),
      assertBuiltModelBoundContent: () => undefined,
      sendCompletion: async () => {
        const result = await piWebSearchTool.execute('pi-provider-search-call', {
          query: 'pump vibration standard',
          date: 'y',
        });
        expect(result.details).toMatchObject({ status: 'success' });
        return {
          completion: [{ type: 'text', text: 'The pump standard defines vibration severity.' }],
        };
      },
    });

    const terminalMessage = await BaseClient.prototype.sendReservedMessage.call(
      client,
      'Find the pump vibration standard.',
      {},
      { release: async () => undefined },
    );
    await terminalMessage.databasePromise;

    const persistedRow = mockHistoryRows.get(RESPONSE_MESSAGE_ID);
    expect(receivedPaths).toEqual([
      expect.stringContaining('/v1/search'),
      expect.stringContaining('/v1/fetch'),
    ]);
    expect(persistedRow).toMatchObject({
      messageId: RESPONSE_MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      content: [{ type: 'text', text: 'The pump standard defines vibration severity.' }],
      attachments: [
        {
          type: Tools.web_search,
          messageId: RESPONSE_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          toolCallId: TOOL_CALL_ID,
          agentId: AGENT_ID,
          stepId: STEP_ID,
          web_search: {
            turn: 2,
            organic: [{ link: SOURCE_URL }],
          },
        },
      ],
    });

    app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      request.user = {
        id: request.get('x-test-user') ?? USER_ID,
        tenantId: TENANT_ID,
      };
      next();
    });
    app.use('/api/messages', messagesRouter);

    const history = await request(app)
      .get('/api/messages')
      .query({ conversationId: CONVERSATION_ID, messageId: RESPONSE_MESSAGE_ID })
      .expect(200);

    expect(history.body.messages[0]).toMatchObject({
      messageId: RESPONSE_MESSAGE_ID,
      attachments: JSON.parse(JSON.stringify(persistedRow.attachments)),
    });

    await request(app)
      .get('/api/messages')
      .set('x-test-user', 'another-user')
      .query({ conversationId: CONVERSATION_ID, messageId: RESPONSE_MESSAGE_ID })
      .expect(404);
  });
});
