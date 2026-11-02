const express = require('express');
const request = require('supertest');

const mockGetMessages = jest.fn();
const mockPrivateIngress = jest.fn((req, _res, next) => next());

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: () => false,
  createPrivateTextIngress: () => mockPrivateIngress,
}));
jest.mock('~/models', () => ({ getMessages: (...args) => mockGetMessages(...args) }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1' };
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = {};
    next();
  },
  checkBan: (_req, _res, next) => next(),
  uaParser: (_req, _res, next) => next(),
  moderateText: (_req, _res, next) => next(),
}));
jest.mock('~/server/routes/agents/chat', () => {
  const router = require('express').Router();
  router.post('/', (req, res) => res.json(req.body));
  router.post('/resume', (_req, res) => res.sendStatus(204));
  return router;
});
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/skills', () => require('express').Router());
jest.mock('~/server/routes/agents/management', () => require('express').Router());
jest.mock('~/server/controllers/agents/steer', () =>
  Object.assign(jest.fn(), {
    SteerDeliveryController: jest.fn(),
    SteerCancelController: jest.fn(),
    SteerArmController: jest.fn(),
  }),
);
jest.mock('~/server/controllers/agents/queuedTurns', () => ({
  AgentQueuedTurnEnqueueController: jest.fn(),
  AgentQueuedTurnEnqueueV2Controller: jest.fn(),
  AgentQueuedTurnListController: jest.fn(),
  AgentQueuedTurnCancelController: jest.fn(),
}));
jest.mock('~/server/services/Schedules', () => ({
  recordScheduleOutcome: jest.fn(),
  beginScheduledStop: jest.fn(),
  acknowledgeScheduledStopPersistence: jest.fn(),
}));

const router = require('../index');
const app = express();
app.use(express.json());
app.use('/api/agents', router);

describe('Pi regeneration ingress', () => {
  const row = {
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    messageId: 'user-message',
    parentMessageId: 'parent-message',
    isCreatedByUser: true,
    text: 'saved input',
    files: [{ file_id: 'saved-file' }],
    manualSkills: ['saved-skill'],
    quotes: ['saved quote'],
    reasoningOverride: { key: 'reasoning_effort', value: 'high' },
  };
  const body = {
    isRegenerate: true,
    conversationId: row.conversationId,
    parentMessageId: row.parentMessageId,
    overrideParentMessageId: row.messageId,
    text: 'forged input',
    files: [{ file_id: 'forged-file' }],
    manualSkills: ['forged-skill'],
    quotes: ['forged quote'],
    reasoningOverride: { key: 'reasoning_effort', value: 'low' },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessages.mockResolvedValue([row]);
  });

  it('restores the authorized saved content before private-text ingress', async () => {
    const response = await request(app).post('/api/agents/chat').send(body);
    expect(response.status).toBe(200);
    expect(mockGetMessages).toHaveBeenCalledWith(
      {
        user: row.user,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        messageId: row.messageId,
      },
      expect.any(String),
      { limit: 2 },
    );
    expect(mockPrivateIngress).toHaveBeenCalledTimes(1);
    expect(mockPrivateIngress.mock.calls[0][0].body).toMatchObject({
      text: row.text,
      files: row.files,
      manualSkills: row.manualSkills,
      quotes: row.quotes,
      reasoningOverride: row.reasoningOverride,
    });
    expect(response.body.text).toBe(row.text);
  });

  it('rejects a foreign-tenant row before the private-text and chat paths', async () => {
    mockGetMessages.mockResolvedValue([{ ...row, tenantId: 'another-tenant' }]);
    const response = await request(app).post('/api/agents/chat').send(body);
    expect(response.status).toBe(404);
    expect(mockPrivateIngress).not.toHaveBeenCalled();
  });

  it('does not perform a regeneration lookup for a resume request', async () => {
    const response = await request(app).post('/api/agents/chat/resume').send(body);
    expect(response.status).toBe(204);
    expect(mockGetMessages).not.toHaveBeenCalled();
  });
});
