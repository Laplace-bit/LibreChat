/**
 * 等待 G1 实现，禁止在此分支改生产代码。
 *
 * Waiting for the G1 trusted-history implementation described in
 * docs/agent-platform/pi-trusted-history.md. Do not change production request,
 * history-loading, or agent-initialization code on this branch to make these
 * tests pass. A red result is the expected signal until that contract exists.
 */
const express = require('express');
const request = require('supertest');
const { Constants } = require('librechat-data-provider');
const { createPiRegenerationAdmission } = require('@librechat/api');

jest.mock('~/models', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
  updateMessage: jest.fn(),
  saveConvo: jest.fn(),
  getConvo: jest.fn(),
}));

const { getMessages: getHistoryMessages } = require('~/models');
const BaseClient = require('../../../../app/clients/BaseClient');

const SAVED_TEXT = 'authorized history text';
const FORGED_TEXT = 'forged client text';
const CHANGED_TEXT = 'changed during history read';
const OTHER_TENANT_TEXT = 'other tenant secret text';

function savedRow(overrides = {}) {
  return {
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    messageId: 'user-message',
    parentMessageId: 'parent-message',
    isCreatedByUser: true,
    text: SAVED_TEXT,
    files: [{ file_id: 'saved-file', filename: 'saved.txt' }],
    manualSkills: ['saved-skill'],
    alwaysAppliedSkills: ['pinned-skill'],
    quotes: ['saved quote'],
    reasoningOverride: { key: 'reasoning_effort', value: 'high' },
    updatedAt: '2026-01-01T00:00:00.000Z',
    __v: 4,
    ...overrides,
  };
}

function regenerateBody(overrides = {}) {
  return {
    isRegenerate: true,
    conversationId: 'conversation-1',
    parentMessageId: 'parent-message',
    overrideParentMessageId: 'user-message',
    text: FORGED_TEXT,
    files: [{ file_id: 'forged-file', filename: 'forged.txt' }],
    manualSkills: ['forged-skill'],
    alwaysAppliedSkills: ['forged-pinned'],
    quotes: ['forged quote'],
    reasoningOverride: { key: 'reasoning_effort', value: 'low' },
    ...overrides,
  };
}

const LEAKED_VALUES = [
  SAVED_TEXT,
  FORGED_TEXT,
  CHANGED_TEXT,
  OTHER_TENANT_TEXT,
  'saved-file',
  'forged-file',
  'saved-skill',
  'forged-skill',
  'pinned-skill',
  'forged-pinned',
  'saved quote',
  'forged quote',
];

function containsLeak(value) {
  const serialized = JSON.stringify(value ?? null);
  return LEAKED_VALUES.some((secret) => serialized.includes(secret));
}

function createApp({ getMessages, recordAuditEntry, user, onAgentInit }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user !== null) {
      req.user = user ?? { id: 'user-1', tenantId: 'tenant-1' };
    }
    next();
  });
  app.use(
    '/chat',
    createPiRegenerationAdmission({
      getMessages,
      recordAuditEntry,
    }),
  );
  app.post('/chat', async (req, res) => {
    try {
      if (onAgentInit) {
        await onAgentInit(req, res);
        return;
      }
      res.status(200).json({ started: true });
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
      });
    }
  });
  return app;
}

function createHistoryClient(req) {
  return Object.assign(Object.create(BaseClient.prototype), {
    user: 'user-1',
    sender: 'User',
    options: { req, attachments: [{ file_id: 'forged-file', filename: 'forged.txt' }] },
    getMessageMapMethod: null,
    getSaveOptions: () => ({}),
    shouldSummarize: false,
    addPreviousAttachments: async (messages) => messages,
    onHistoryLoaded: jest.fn(),
  });
}

describe('G1 trusted regeneration history', () => {
  beforeEach(() => {
    getHistoryMessages.mockReset();
  });

  it('ignores retransmitted attachments, skills, and reasoning in the final turn input', async () => {
    const saved = savedRow();
    getHistoryMessages.mockResolvedValue([
      {
        messageId: 'parent-message',
        parentMessageId: Constants.NO_PARENT,
        text: 'earlier',
      },
      saved,
    ]);
    const app = createApp({
      getMessages: async () => [savedRow()],
      onAgentInit: async (req, res) => {
        const client = createHistoryClient(req);
        const started = await client.handleStartMethods(req.body.text, {
          user: 'user-1',
          isRegenerate: true,
          isPiRegenerate: true,
          conversationId: req.body.conversationId,
          parentMessageId: req.body.parentMessageId,
          preallocatedUserMessageId: saved.messageId,
        });
        res.status(200).json({
          files: req.body.files,
          manualSkills: req.body.manualSkills,
          alwaysAppliedSkills: req.body.alwaysAppliedSkills,
          reasoningOverride: req.body.reasoningOverride,
          userMessage: {
            text: started.userMessage.text,
            files: started.userMessage.files,
            manualSkills: started.userMessage.manualSkills,
            alwaysAppliedSkills: started.userMessage.alwaysAppliedSkills,
            reasoningOverride: started.userMessage.reasoningOverride,
          },
        });
      },
    });

    const response = await request(app).post('/chat').send(regenerateBody());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      files: saved.files,
      manualSkills: saved.manualSkills,
      alwaysAppliedSkills: saved.alwaysAppliedSkills,
      reasoningOverride: saved.reasoningOverride,
      userMessage: {
        text: saved.text,
        files: saved.files,
        manualSkills: saved.manualSkills,
        alwaysAppliedSkills: saved.alwaysAppliedSkills,
        reasoningOverride: saved.reasoningOverride,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('forged-file');
    expect(JSON.stringify(response.body)).not.toContain('forged-skill');
    expect(JSON.stringify(response.body)).not.toContain('forged-pinned');
    expect(JSON.stringify(response.body)).not.toContain(FORGED_TEXT);
    expect(JSON.stringify(response.body.userMessage.reasoningOverride)).not.toContain('low');
  });

  it('returns a retryable conflict and skips agent initialization when the version changes during the read', async () => {
    let reads = 0;
    const getMessages = jest.fn(async () => {
      reads += 1;
      const version = reads === 1 ? 4 : 5;
      return [
        savedRow({
          __v: version,
          text: version === 4 ? SAVED_TEXT : CHANGED_TEXT,
          updatedAt: version === 4 ? '2026-01-01T00:00:00.000Z' : '2026-01-01T00:00:01.000Z',
        }),
      ];
    });
    const agentInit = jest.fn((_req, res) => {
      res.status(200).json({ started: true });
    });
    const app = createApp({ getMessages, onAgentInit: agentInit });

    const response = await request(app).post('/chat').send(regenerateBody());
    const filters = getMessages.mock.calls.map((call) => call[0]);

    expect({
      status: response.status,
      code: response.body?.code,
      retryable: response.body?.retryable,
      agentInitialized: agentInit.mock.calls.length,
      confirmingRead: filters.some(
        (filter) => filter?.consistentSnapshot === true || filter?.expectedSnapshotVersion != null,
      ),
      leaked: containsLeak(response.body),
    }).toEqual({
      status: 409,
      code: 'PI_HISTORY_CONFLICT',
      retryable: true,
      agentInitialized: 0,
      confirmingRead: true,
      leaked: false,
    });
  });

  it('does not feed a history walk to the model when the admitted version changes', async () => {
    const admitted = savedRow();
    const req = {
      method: 'POST',
      path: '/',
      body: regenerateBody(),
      user: { id: 'user-1', tenantId: 'tenant-1' },
    };
    const admission = createPiRegenerationAdmission({
      getMessages: async () => [savedRow()],
    });
    await new Promise((resolve, reject) => {
      admission(req, { status: jest.fn().mockReturnThis(), json: jest.fn() }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    getHistoryMessages.mockResolvedValue([
      savedRow({
        __v: 5,
        text: CHANGED_TEXT,
        updatedAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);
    const client = createHistoryClient(req);
    const model = jest.fn();
    client.buildMessages = model;
    let error;
    try {
      await client.loadHistory(admitted.conversationId, admitted.messageId, {
        isPiRegenerate: true,
        request: req,
        userMessageId: admitted.messageId,
      });
    } catch (caught) {
      error = caught;
    }

    expect({
      code: error?.code,
      retryable: error?.retryable,
      statusCode: error?.statusCode,
      historyLoaded: client.onHistoryLoaded.mock.calls.length,
      modelCalls: model.mock.calls.length,
      leaked: containsLeak(error),
    }).toEqual({
      code: 'PI_HISTORY_CONFLICT',
      retryable: true,
      statusCode: 409,
      historyLoaded: 0,
      modelCalls: 0,
      leaked: false,
    });
  });

  it.each([
    ['an unauthorized regeneration', null, async () => [savedRow()]],
    [
      'a cross-tenant regeneration',
      { id: 'user-1', tenantId: 'tenant-1' },
      async () => [savedRow({ tenantId: 'tenant-2', text: OTHER_TENANT_TEXT })],
    ],
    ['a missing message', { id: 'user-1', tenantId: 'tenant-1' }, async () => []],
  ])('rejects %s without revealing message content', async (_name, user, getMessages) => {
    const agentInit = jest.fn((_req, res) => {
      res.status(200).json({ started: true });
    });
    const app = createApp({ getMessages, user, onAgentInit: agentInit });

    const response = await request(app).post('/chat').send(regenerateBody());

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'MESSAGE_NOT_FOUND',
      error: 'The original user message is unavailable for regeneration.',
    });
    expect(agentInit).not.toHaveBeenCalled();
    expect(containsLeak(response.body)).toBe(false);
  });

  it('audits an end-to-end regeneration from the original user message', async () => {
    const saved = savedRow();
    const recordAuditEntry = jest.fn();
    getHistoryMessages.mockResolvedValue([savedRow()]);
    const app = createApp({
      getMessages: async () => [savedRow()],
      recordAuditEntry,
      onAgentInit: async (req, res) => {
        const client = createHistoryClient(req);
        const started = await client.handleStartMethods(req.body.text, {
          user: 'user-1',
          isRegenerate: true,
          isPiRegenerate: true,
          conversationId: req.body.conversationId,
          parentMessageId: req.body.parentMessageId,
          preallocatedUserMessageId: saved.messageId,
        });
        res.status(200).json({
          messageId: started.userMessage.messageId,
          text: started.userMessage.text,
          files: started.userMessage.files,
          manualSkills: started.userMessage.manualSkills,
          reasoningOverride: started.userMessage.reasoningOverride,
        });
      },
    });

    const response = await request(app).post('/chat').send(regenerateBody());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      messageId: saved.messageId,
      text: saved.text,
      files: saved.files,
      manualSkills: saved.manualSkills,
      reasoningOverride: saved.reasoningOverride,
    });
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'message.regenerated',
        outcome: 'success',
        actor: { type: 'user', id: 'user-1' },
        target: { type: 'message', id: saved.messageId },
        metadata: expect.objectContaining({
          conversationId: saved.conversationId,
          snapshotVersion: expect.any(String),
        }),
      }),
    );
    expect(containsLeak(recordAuditEntry.mock.calls)).toBe(false);
  });
});
