import express from 'express';
import request from 'supertest';
import {
  createPiRegenerationAdmission,
  isPiRegenerationRequest,
  matchesPiRegenerationSnapshot,
  preparePiRegenerationRequest,
  resolvePiRegenerationUser,
} from './regeneration';

describe('resolvePiRegenerationUser', () => {
  const user = { messageId: 'user-1', parentMessageId: 'parent-1', isCreatedByUser: true };

  it('returns the persisted branch head only when its identity and lineage match', () => {
    expect(resolvePiRegenerationUser([user], 'user-1', 'parent-1')).toBe(user);
    expect(() => resolvePiRegenerationUser([], 'user-1', 'parent-1')).toThrow();
    expect(() => resolvePiRegenerationUser([user], 'other-user', 'parent-1')).toThrow();
    expect(() => resolvePiRegenerationUser([user], 'user-1', 'other-parent')).toThrow();
    expect(() =>
      resolvePiRegenerationUser([{ ...user, isCreatedByUser: false }], 'user-1', 'parent-1'),
    ).toThrow();
  });
});

describe('Pi regeneration admission', () => {
  const row = {
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    messageId: 'user-message',
    parentMessageId: 'parent-message',
    isCreatedByUser: true,
    text: 'saved input',
    files: [{ file_id: 'saved-file', filename: 'saved.txt' }],
    manualSkills: ['saved-skill'],
    alwaysAppliedSkills: ['pinned-skill'],
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

  it('restores saved content before privacy inspection and verifies the subsequent row', async () => {
    const getMessages = jest.fn().mockResolvedValue([row]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'user-1', tenantId: 'tenant-1' } });
      next();
    });
    app.use('/chat', createPiRegenerationAdmission({ getMessages }));
    app.use('/chat', (req, res) => {
      res.json({
        body: req.body,
        snapshotMatches: matchesPiRegenerationSnapshot(req, row),
        changedMatches: matchesPiRegenerationSnapshot(req, {
          ...row,
          text: 'changed concurrently',
        }),
        changedFileMatches: matchesPiRegenerationSnapshot(req, {
          ...row,
          files: [{ file_id: 'saved-file', filename: 'changed.txt' }],
        }),
        changedRoleMatches: matchesPiRegenerationSnapshot(req, {
          ...row,
          role: 'assistant',
        }),
        changedContentMatches: matchesPiRegenerationSnapshot(req, {
          ...row,
          content: [{ type: 'text', text: 'changed content' }],
        }),
      });
    });

    const response = await request(app).post('/chat').send(body);
    expect(response.status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith({
      user: 'user-1',
      tenantId: 'tenant-1',
      conversationId: row.conversationId,
      messageId: row.messageId,
    });
    expect(response.body.body).toMatchObject({
      text: row.text,
      files: row.files,
      manualSkills: row.manualSkills,
      alwaysAppliedSkills: row.alwaysAppliedSkills,
      quotes: row.quotes,
      reasoningOverride: row.reasoningOverride,
    });
    expect(response.body.snapshotMatches).toBe(true);
    expect(response.body.changedMatches).toBe(false);
    expect(response.body.changedFileMatches).toBe(false);
    expect(response.body.changedContentMatches).toBe(false);
    expect(response.body.changedRoleMatches).toBe(false);
  });

  it.each([
    ['another user', { user: 'other' }],
    ['another tenant', { tenantId: 'other' }],
    ['another conversation', { conversationId: 'other' }],
    ['wrong parent', { parentMessageId: 'other' }],
    ['assistant message', { isCreatedByUser: false }],
  ])('rejects %s even if the database returns it', async (_name, changes) => {
    const result = await preparePiRegenerationRequest({
      body,
      userId: row.user,
      tenantId: row.tenantId,
      getMessages: async () => [{ ...row, ...changes }],
    });
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('clears omitted saved fields instead of using request values', async () => {
    const result = await preparePiRegenerationRequest({
      body,
      userId: row.user,
      tenantId: row.tenantId,
      getMessages: async () => [
        {
          ...row,
          files: undefined,
          manualSkills: undefined,
          quotes: undefined,
          reasoningOverride: undefined,
        },
      ],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected admission');
    expect(result.body).toMatchObject({
      files: undefined,
      manualSkills: undefined,
      quotes: undefined,
      reasoningOverride: null,
    });
  });

  it('does not inspect resume or continued requests', async () => {
    const getMessages = jest.fn();
    const app = express();
    app.use(express.json());
    app.use('/chat', createPiRegenerationAdmission({ getMessages }));
    app.use('/chat', (_req, res) => {
      res.sendStatus(204);
    });
    expect((await request(app).post('/chat/resume').send(body)).status).toBe(204);
    expect(
      (
        await request(app)
          .post('/chat')
          .send({ ...body, isContinued: true })
      ).status,
    ).toBe(204);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it.each(['isContinued', 'isEdited'])('does not admit a non-boolean %s', async (field) => {
    const getMessages = jest.fn();
    const result = await preparePiRegenerationRequest({
      body: { ...body, [field]: 'true' },
      userId: row.user,
      tenantId: row.tenantId,
      getMessages,
    });
    expect(result.kind).toBe('not_applicable');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it.each(['isContinued', 'isEdited'])(
    'does not classify a non-boolean %s as regeneration',
    (field) => {
      expect(isPiRegenerationRequest({ ...body, [field]: 'true' })).toBe(false);
      expect(isPiRegenerationRequest({ ...body, [field]: 1 })).toBe(false);
    },
  );
});
