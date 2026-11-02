import { createHash } from 'crypto';
import { reasoningOverrideSchema } from 'librechat-data-provider';
import type { TReasoningOverride } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import { validateChatMessageIds } from '../../middleware/messageIds';
import { resolveRequestTenantId } from '../../middleware/tenant';

type RegenerationBody = Record<string, unknown>;

export interface PiRegenerationSnapshot {
  user: string;
  tenantId: string | null;
  conversationId: string;
  messageId: string;
  parentMessageId: string;
  text: string;
  fileIds: string[];
  rowDigest: string;
  manualSkills: string[];
  alwaysAppliedSkills: string[];
  quotes: string[];
  reasoningOverride: TReasoningOverride | null;
}

export type PiRegenerationAdmission =
  | { kind: 'not_applicable' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; body: RegenerationBody; snapshot: PiRegenerationSnapshot };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** A normal regeneration replays an existing user message, not an edit or continuation. */
export function isPiRegenerationRequest(body: unknown): boolean {
  return (
    isRecord(body) &&
    body.isRegenerate === true &&
    body.compact !== true &&
    (body.isContinued == null || body.isContinued === false) &&
    (body.isEdited == null || body.isEdited === false) &&
    body.editedContent == null &&
    body.overrideUserMessageId == null &&
    body.overrideConvoId == null &&
    typeof body.overrideParentMessageId === 'string' &&
    body.overrideParentMessageId.length > 0
  );
}

function stringList(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return [...value];
}

const admittedSnapshots = new WeakMap<object, PiRegenerationSnapshot>();

/** Compares a fresh server-owned row with the values used at admission. */
export function matchesPiRegenerationSnapshot(request: object, row: unknown): boolean {
  const previous = admittedSnapshots.get(request);
  const current = snapshotPiRegenerationUser(row);
  return (
    previous != null && current != null && JSON.stringify(previous) === JSON.stringify(current)
  );
}

/** Snapshot only the persisted values that determine the replayed turn. */
export function snapshotPiRegenerationUser(row: unknown): PiRegenerationSnapshot | undefined {
  if (
    !isRecord(row) ||
    typeof row.user !== 'string' ||
    typeof row.conversationId !== 'string' ||
    (row.tenantId != null && typeof row.tenantId !== 'string') ||
    row.isCreatedByUser !== true ||
    typeof row.messageId !== 'string' ||
    typeof row.parentMessageId !== 'string'
  ) {
    return undefined;
  }
  if (row.text != null && typeof row.text !== 'string') return undefined;
  if (row.files != null && !Array.isArray(row.files)) return undefined;
  const files = row.files ?? [];
  if (!Array.isArray(files)) return undefined;
  const fileIds: string[] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.file_id !== 'string' || file.file_id.length === 0) {
      return undefined;
    }
    fileIds.push(file.file_id);
  }
  let rowDigest: string;
  try {
    const serialized = JSON.stringify(row);
    if (typeof serialized !== 'string') return undefined;
    rowDigest = createHash('sha256').update(serialized).digest('hex');
  } catch {
    return undefined;
  }
  const manualSkills = stringList(row.manualSkills);
  const alwaysAppliedSkills = stringList(row.alwaysAppliedSkills);
  const quotes = stringList(row.quotes);
  if (manualSkills == null || alwaysAppliedSkills == null || quotes == null) return undefined;
  const reasoning =
    row.reasoningOverride == null ? null : reasoningOverrideSchema.safeParse(row.reasoningOverride);
  if (reasoning != null && !reasoning.success) return undefined;
  return {
    user: row.user,
    tenantId: row.tenantId ?? null,
    conversationId: row.conversationId,
    messageId: row.messageId,
    parentMessageId: row.parentMessageId,
    text: row.text ?? '',
    fileIds,
    rowDigest,
    manualSkills,
    alwaysAppliedSkills,
    quotes,
    reasoningOverride: reasoning?.data ?? null,
  };
}

const CHAT_CONTROL_PATHS = new Set([
  'abort',
  'active',
  'queued-turns',
  'resume',
  'status',
  'steer',
  'stream',
]);

/** Restore the saved turn before privacy inspection and model initialization. */
export function createPiRegenerationAdmission(deps: {
  getMessages: Parameters<typeof preparePiRegenerationRequest>[0]['getMessages'];
}): RequestHandler {
  return (req, res, next) => {
    const child = req.path.replace(/^\/+|\/+$/g, '');
    if (
      req.method !== 'POST' ||
      child.includes('/') ||
      CHAT_CONTROL_PATHS.has(child.toLowerCase()) ||
      !isPiRegenerationRequest(req.body)
    ) {
      next();
      return;
    }
    validateChatMessageIds(req, res, () => {
      void preparePiRegenerationRequest({
        body: req.body,
        userId: isRecord(req.user) ? req.user.id : undefined,
        tenantId: resolveRequestTenantId(req),
        getMessages: deps.getMessages,
      }).then((result) => {
        if (result.kind !== 'ready') {
          res.status(404).json({
            code: 'MESSAGE_NOT_FOUND',
            error: 'The original user message is unavailable for regeneration.',
          });
          return;
        }
        admittedSnapshots.set(req, result.snapshot);
        Object.assign(req.body, result.body);
        next();
      }, next);
    });
  };
}

/** Restore request inputs before PII inspection, model selection and agent initialization. */
export async function preparePiRegenerationRequest(input: {
  body: unknown;
  userId: unknown;
  tenantId: unknown;
  getMessages: (filter: {
    user: string;
    tenantId: string | null;
    conversationId: string;
    messageId: string;
  }) => Promise<readonly unknown[]>;
}): Promise<PiRegenerationAdmission> {
  if (!isPiRegenerationRequest(input.body)) return { kind: 'not_applicable' };
  if (!isRecord(input.body)) return { kind: 'unavailable' };
  const { conversationId, parentMessageId, overrideParentMessageId } = input.body;
  if (
    typeof input.userId !== 'string' ||
    input.userId.length === 0 ||
    typeof conversationId !== 'string' ||
    conversationId.length === 0 ||
    conversationId === 'new' ||
    typeof parentMessageId !== 'string' ||
    parentMessageId.length === 0 ||
    typeof overrideParentMessageId !== 'string'
  ) {
    return { kind: 'unavailable' };
  }
  const tenantId =
    typeof input.tenantId === 'string' && input.tenantId.length > 0 ? input.tenantId : null;
  const rows = await input.getMessages({
    user: input.userId,
    tenantId,
    conversationId,
    messageId: overrideParentMessageId,
  });
  if (rows.length !== 1 || !isRecord(rows[0])) return { kind: 'unavailable' };
  const row = rows[0];
  const snapshot = snapshotPiRegenerationUser(row);
  if (
    row.user !== input.userId ||
    (row.tenantId ?? null) !== tenantId ||
    row.conversationId !== conversationId ||
    row.isCreatedByUser !== true ||
    snapshot == null ||
    snapshot.messageId !== overrideParentMessageId ||
    snapshot.parentMessageId !== parentMessageId
  ) {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'ready',
    snapshot,
    body: {
      text: snapshot.text,
      files: row.files == null ? undefined : structuredClone(row.files),
      manualSkills: snapshot.manualSkills.length ? [...snapshot.manualSkills] : undefined,
      alwaysAppliedSkills: snapshot.alwaysAppliedSkills.length
        ? [...snapshot.alwaysAppliedSkills]
        : undefined,
      quotes: snapshot.quotes.length ? [...snapshot.quotes] : undefined,
      reasoningOverride: structuredClone(snapshot.reasoningOverride),
    },
  };
}

/** Reuse the authorized persisted user row as the branch point of a regeneration. */
export function resolvePiRegenerationUser<
  T extends {
    messageId?: unknown;
    parentMessageId?: unknown;
    isCreatedByUser?: unknown;
  },
>(messages: readonly T[], userMessageId: string, parentMessageId: string): T {
  const message = messages[messages.length - 1];
  if (
    message == null ||
    message.messageId !== userMessageId ||
    message.parentMessageId !== parentMessageId ||
    message.isCreatedByUser !== true
  ) {
    throw new Error('The original user message is unavailable for regeneration.');
  }
  return message;
}
