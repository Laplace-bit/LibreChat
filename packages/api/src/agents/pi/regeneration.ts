import { createHash } from 'crypto';
import { Constants, reasoningOverrideSchema } from 'librechat-data-provider';
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
  historyDigest: string;
  manualSkills: string[];
  alwaysAppliedSkills: string[];
  quotes: string[];
  reasoningOverride: TReasoningOverride | null;
}

export type PiRegenerationAdmission =
  | { kind: 'not_applicable' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      body: RegenerationBody;
      snapshot: PiRegenerationSnapshot;
      history: readonly unknown[];
    };

type PiRegenerationUserSnapshot = Omit<PiRegenerationSnapshot, 'historyDigest'>;
type PiRegenerationHistorySnapshot = {
  digest: string;
  messages: Record<string, unknown>[];
};

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
const admittedHistory = new WeakMap<object, readonly unknown[]>();

/** Compares a fresh server-owned row with the values used at admission. */
export function matchesPiRegenerationSnapshot(request: object, row: unknown): boolean {
  const previous = admittedSnapshots.get(request);
  const current = snapshotPiRegenerationUser(row);
  if (previous == null || current == null) {
    return false;
  }
  const { historyDigest: _historyDigest, ...previousUser } = previous;
  return JSON.stringify(previousUser) === JSON.stringify(current);
}

/** Hash only the parent chain that BaseClient walks into the regenerated prompt. */
export function snapshotPiRegenerationHistory(
  messages: readonly unknown[],
  headMessageId: string,
  scope: Pick<PiRegenerationSnapshot, 'user' | 'tenantId' | 'conversationId'>,
): PiRegenerationHistorySnapshot | undefined {
  const messagesById = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (isRecord(message) && typeof message.messageId === 'string') {
      if (messagesById.has(message.messageId)) {
        return undefined;
      }
      messagesById.set(message.messageId, message);
    }
  }

  let currentMessageId: string | null = headMessageId;
  const visitedMessageIds = new Set<string>();
  const lineage: Record<string, unknown>[] = [];
  while (currentMessageId != null && currentMessageId.length > 0) {
    if (visitedMessageIds.has(currentMessageId)) {
      return undefined;
    }
    const message = messagesById.get(currentMessageId);
    if (message == null) {
      return undefined;
    }
    if (
      message.user !== scope.user ||
      (message.tenantId ?? null) !== scope.tenantId ||
      message.conversationId !== scope.conversationId
    ) {
      return undefined;
    }
    visitedMessageIds.add(currentMessageId);
    lineage.push(message);
    const parentMessageId = message.parentMessageId;
    if (
      parentMessageId === Constants.NO_PARENT ||
      parentMessageId === null ||
      parentMessageId === undefined
    ) {
      currentMessageId = null;
    } else if (typeof parentMessageId === 'string' && parentMessageId.length > 0) {
      currentMessageId = parentMessageId;
    } else {
      return undefined;
    }
  }

  if (lineage.length === 0) {
    return undefined;
  }
  try {
    const orderedMessages = lineage.reverse();
    const serialized = JSON.stringify(orderedMessages);
    if (typeof serialized !== 'string') {
      return undefined;
    }
    return {
      digest: createHash('sha256').update(serialized).digest('hex'),
      messages: orderedMessages,
    };
  } catch {
    return undefined;
  }
}

/** Confirms the prompt's persisted ancestry against the admission snapshot. */
export function matchesPiRegenerationHistory(
  request: object,
  messages: readonly unknown[],
  headMessageId: string,
  conversationId: string,
  userId: string,
): boolean {
  const snapshot = admittedSnapshots.get(request);
  const history =
    snapshot == null || snapshot.conversationId !== conversationId || snapshot.user !== userId
      ? undefined
      : snapshotPiRegenerationHistory(messages, headMessageId, snapshot);
  return (
    snapshot != null &&
    snapshot.conversationId === conversationId &&
    snapshot.user === userId &&
    history?.digest === snapshot.historyDigest
  );
}

/** Consume the pre-admitted, tenant-scoped history without issuing a third read. */
export function consumePiRegenerationHistory(request: object): readonly unknown[] | undefined {
  const history = admittedHistory.get(request);
  admittedHistory.delete(request);
  return history;
}

/** Snapshot only the persisted values that determine the replayed turn. */
export function snapshotPiRegenerationUser(row: unknown): PiRegenerationUserSnapshot | undefined {
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

/** The chat submission paths eligible for original-message restoration. */
export function isPiRegenerationAdmissionCandidate(input: {
  method: string;
  path: string;
  body: unknown;
}): boolean {
  const child = input.path.replace(/^\/+|\/+$/g, '');
  return (
    input.method === 'POST' &&
    !child.includes('/') &&
    !CHAT_CONTROL_PATHS.has(child.toLowerCase()) &&
    isPiRegenerationRequest(input.body)
  );
}

/** Restore the saved turn before privacy inspection and model initialization. */
export function createPiRegenerationAdmission(deps: {
  getMessages: Parameters<typeof preparePiRegenerationRequest>[0]['getMessages'];
}): RequestHandler {
  return (req, res, next) => {
    if (!isPiRegenerationAdmissionCandidate(req)) {
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
        admittedHistory.set(req, result.history);
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
  const filter = {
    user: input.userId,
    tenantId,
    conversationId,
  };
  const rows = await input.getMessages(filter);
  const sourceRows = rows.filter(
    (message) => isRecord(message) && message.messageId === overrideParentMessageId,
  );
  if (sourceRows.length !== 1 || !isRecord(sourceRows[0])) return { kind: 'unavailable' };
  const row = sourceRows[0];
  const sourceSnapshot = snapshotPiRegenerationUser(row);
  if (
    !isAuthorizedRegenerationSource(sourceSnapshot, row, {
      user: input.userId,
      tenantId,
      conversationId,
      messageId: overrideParentMessageId,
      parentMessageId,
    })
  ) {
    return { kind: 'unavailable' };
  }
  const scope = { user: input.userId, tenantId, conversationId };
  const history = snapshotPiRegenerationHistory(rows, overrideParentMessageId, scope);
  if (history == null) return { kind: 'unavailable' };
  const snapshot: PiRegenerationSnapshot = { ...sourceSnapshot, historyDigest: history.digest };
  return {
    kind: 'ready',
    snapshot,
    history: history.messages,
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

function isAuthorizedRegenerationSource(
  snapshot: PiRegenerationUserSnapshot | undefined,
  row: Record<string, unknown>,
  expected: {
    user: string;
    tenantId: string | null;
    conversationId: string;
    messageId: string;
    parentMessageId: string;
  },
): snapshot is PiRegenerationUserSnapshot {
  return (
    row.user === expected.user &&
    (row.tenantId ?? null) === expected.tenantId &&
    row.conversationId === expected.conversationId &&
    row.isCreatedByUser === true &&
    snapshot != null &&
    snapshot.messageId === expected.messageId &&
    snapshot.parentMessageId === expected.parentMessageId
  );
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
