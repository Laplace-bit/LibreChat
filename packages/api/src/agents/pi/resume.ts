import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { Agents } from 'librechat-data-provider';
import type { PiHostToolExecutionInput, PiToolArguments } from './tools';
import type { PiHistoryConversion, PiHistoryMessage } from './history';
import type { PiCodeSessionSnapshot } from './codeSession';
import type { PiMessageStepIdentity } from './events';
import type { PiPauseToolCall } from './pause';
import { isPiCodeExecutionToolName, isPiSupportedHostToolName } from './toolNames';
import { parsePiCodeSessionSnapshot } from './codeSession';
import { validatePiToolExecutionInput } from './tools';

export const PI_RESUME_CONTINUATION_VERSION = 1 as const;
export const PI_RESUMABLE_TOOL_DECISIONS: readonly Agents.ToolApprovalDecisionType[] = [
  'approve',
  'reject',
  'edit',
  'respond',
];

export interface PiApprovalContinuation {
  readonly version: typeof PI_RESUME_CONTINUATION_VERSION;
  readonly actionId: string;
  readonly piToolCallId: string;
  readonly hostToolCallId: string;
  readonly toolTurn: number;
  readonly toolName: PiHostToolExecutionInput['name'];
  readonly args: PiToolArguments;
  readonly allowedDecisions: readonly Agents.ToolApprovalDecisionType[];
  readonly description?: string;
  readonly codeSessionContext?: PiCodeSessionSnapshot;
  readonly stepIdentity: PiMessageStepIdentity;
  readonly stepCreatedAt: number;
}

export interface PiApprovalInterruptInput {
  readonly hostToolCallId: string;
  readonly toolName: PiApprovalContinuation['toolName'];
  readonly args: PiToolArguments;
  readonly allowedDecisions: readonly Agents.ToolApprovalDecisionType[];
  readonly description?: string;
}

const VALID_TOOL_DECISIONS = new Set<Agents.ToolApprovalDecisionType>(PI_RESUMABLE_TOOL_DECISIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDecision(value: unknown): value is Agents.ToolApprovalDecisionType {
  return value === 'approve' || value === 'reject' || value === 'edit' || value === 'respond';
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseStepIdentity(value: unknown): PiMessageStepIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const index = value.index;
  if (
    !hasExactKeys(value, ['id', 'index', 'messageId', 'runId', 'agentId']) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    typeof value.messageId !== 'string' ||
    value.messageId.length === 0 ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    typeof value.agentId !== 'string' ||
    value.agentId.length === 0
  ) {
    return undefined;
  }
  return {
    id: value.id,
    index,
    messageId: value.messageId,
    runId: value.runId,
    agentId: value.agentId,
  };
}

/** Build the existing client approval payload for a single, supported Pi host call. */
export function buildPiApprovalInterruptPayload(
  input: PiApprovalInterruptInput,
): Agents.ToolApprovalInterruptPayload {
  const validated = validatePiToolExecutionInput(input.toolName, input.hostToolCallId, input.args);
  if (
    input.allowedDecisions.length === 0 ||
    input.allowedDecisions.some((decision) => !VALID_TOOL_DECISIONS.has(decision)) ||
    new Set(input.allowedDecisions).size !== input.allowedDecisions.length ||
    (input.description !== undefined &&
      (input.description.trim().length === 0 || input.description.length > 1_000))
  ) {
    throw new Error('Pi approval review policy is malformed');
  }

  return {
    type: 'tool_approval',
    action_requests: [
      {
        name: validated.name,
        arguments: validated.args,
        tool_call_id: input.hostToolCallId,
        ...(input.description == null ? {} : { description: input.description }),
      },
    ],
    review_configs: [
      {
        action_name: validated.name,
        tool_call_id: input.hostToolCallId,
        allowed_decisions: [...input.allowedDecisions],
      },
    ],
  };
}

/** Convert the in-process Pi signal into a versioned server-side continuation envelope. */
export function createPiApprovalContinuation(
  actionId: string,
  toolCall: PiPauseToolCall,
): PiApprovalContinuation {
  if (actionId.length === 0) {
    throw new Error('Pi continuation requires a pending action identity');
  }
  const codeSessionContext = parsePiCodeSessionSnapshot(toolCall.codeSessionContext);
  return {
    version: PI_RESUME_CONTINUATION_VERSION,
    actionId,
    piToolCallId: toolCall.toolCallId,
    hostToolCallId: toolCall.hostExecution.toolCallId,
    toolTurn: toolCall.hostExecution.toolTurn,
    toolName: toolCall.name,
    args: toolCall.args,
    allowedDecisions: [...toolCall.review.allowedDecisions],
    ...(toolCall.review.description == null ? {} : { description: toolCall.review.description }),
    ...(codeSessionContext == null ? {} : { codeSessionContext }),
    stepIdentity: { ...toolCall.hostExecution.stepIdentity },
    stepCreatedAt: toolCall.hostExecution.createdAt,
  };
}

/**
 * Validate server-stored continuation data against the pending client action and
 * the immutable generation identities before the resume CAS is attempted.
 */
export function resolvePiApprovalContinuation(input: {
  value: unknown;
  pendingAction: Agents.PendingAction | undefined;
  responseMessageId: string;
  agentId: string;
}): PiApprovalContinuation | undefined {
  const { value, pendingAction, responseMessageId, agentId } = input;
  if (
    pendingAction == null ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'actionId',
      'piToolCallId',
      'hostToolCallId',
      'toolTurn',
      'toolName',
      'args',
      'allowedDecisions',
      'stepIdentity',
      'stepCreatedAt',
      ...(Object.prototype.hasOwnProperty.call(value, 'codeSessionContext')
        ? ['codeSessionContext']
        : []),
      ...(Object.prototype.hasOwnProperty.call(value, 'description') ? ['description'] : []),
    ]) ||
    typeof value.actionId !== 'string' ||
    value.actionId !== pendingAction.actionId ||
    value.version !== PI_RESUME_CONTINUATION_VERSION ||
    typeof value.piToolCallId !== 'string' ||
    value.piToolCallId.length === 0 ||
    typeof value.hostToolCallId !== 'string' ||
    value.hostToolCallId.length === 0 ||
    typeof value.toolTurn !== 'number' ||
    !Number.isSafeInteger(value.toolTurn) ||
    value.toolTurn < 0 ||
    typeof value.toolName !== 'string' ||
    !isPiSupportedHostToolName(value.toolName) ||
    (isPiCodeExecutionToolName(value.toolName) && pendingAction.codeExecutionBinding == null) ||
    !Array.isArray(value.allowedDecisions) ||
    value.allowedDecisions.length === 0 ||
    !value.allowedDecisions.every(isDecision) ||
    new Set(value.allowedDecisions).size !== value.allowedDecisions.length ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' ||
        value.description.trim().length === 0 ||
        value.description.length > 1_000)) ||
    typeof value.stepCreatedAt !== 'number' ||
    !Number.isSafeInteger(value.stepCreatedAt) ||
    value.stepCreatedAt < 0
  ) {
    return undefined;
  }

  let validatedCall;
  let stepIdentity;
  let codeSessionContext: PiCodeSessionSnapshot | undefined;
  try {
    validatedCall = validatePiToolExecutionInput(value.toolName, value.piToolCallId, value.args);
    stepIdentity = parseStepIdentity(value.stepIdentity);
    if (Object.prototype.hasOwnProperty.call(value, 'codeSessionContext')) {
      codeSessionContext = parsePiCodeSessionSnapshot(value.codeSessionContext);
      if (codeSessionContext == null || !isPiCodeExecutionToolName(value.toolName)) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  if (
    stepIdentity == null ||
    stepIdentity.messageId !== responseMessageId ||
    stepIdentity.runId !== responseMessageId ||
    stepIdentity.agentId !== agentId
  ) {
    return undefined;
  }

  const payload = pendingAction.payload;
  if (
    !isRecord(payload) ||
    payload.type !== 'tool_approval' ||
    !Array.isArray(payload.action_requests) ||
    payload.action_requests.length !== 1 ||
    !Array.isArray(payload.review_configs) ||
    payload.review_configs.length !== 1
  ) {
    return undefined;
  }
  const [actionRequest] = payload.action_requests;
  const [reviewConfig] = payload.review_configs;
  const allowedDecisions = value.allowedDecisions.filter(isDecision);
  if (
    !isRecord(actionRequest) ||
    !isRecord(reviewConfig) ||
    actionRequest.name !== validatedCall.name ||
    actionRequest.tool_call_id !== value.hostToolCallId ||
    !isRecord(actionRequest.arguments) ||
    !sameJson(actionRequest.arguments, validatedCall.args) ||
    actionRequest.description !== value.description ||
    reviewConfig.action_name !== validatedCall.name ||
    reviewConfig.tool_call_id !== value.hostToolCallId ||
    !sameJson(reviewConfig.allowed_decisions, value.allowedDecisions)
  ) {
    return undefined;
  }

  return {
    version: PI_RESUME_CONTINUATION_VERSION,
    actionId: value.actionId,
    piToolCallId: value.piToolCallId,
    hostToolCallId: value.hostToolCallId,
    toolTurn: value.toolTurn,
    toolName: validatedCall.name,
    args: validatedCall.args,
    allowedDecisions,
    ...(value.description == null ? {} : { description: value.description }),
    ...(codeSessionContext == null ? {} : { codeSessionContext }),
    stepIdentity,
    stepCreatedAt: value.stepCreatedAt,
  };
}

function decodeArguments(value: unknown): Record<string, unknown> | undefined {
  let decoded = value;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return undefined;
    }
  }
  return isRecord(decoded) ? decoded : undefined;
}

/** Bind the envelope to the exact unfinished host step and content recorded by this job. */
export function matchesPiApprovalHostState(input: {
  continuation: PiApprovalContinuation;
  runSteps: readonly unknown[];
  aggregatedContent: readonly unknown[];
  responseMessageId: string;
  agentId: string;
}): boolean {
  const { continuation } = input;
  const matches = input.runSteps.filter((candidate) => {
    if (!isRecord(candidate) || candidate.id !== continuation.stepIdentity.id) {
      return false;
    }
    const details = candidate.stepDetails;
    if (!isRecord(details) || !Array.isArray(details.tool_calls)) {
      return false;
    }
    const [toolCall] = details.tool_calls;
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      return false;
    }
    return (
      candidate.status === 'in_progress' &&
      candidate.type === 'tool_calls' &&
      details.type === 'tool_calls' &&
      candidate.index === continuation.stepIdentity.index &&
      candidate.created_at === continuation.stepCreatedAt &&
      candidate.runId === continuation.stepIdentity.runId &&
      candidate.agentId === continuation.stepIdentity.agentId &&
      candidate.runId === input.responseMessageId &&
      candidate.agentId === input.agentId &&
      details.tool_calls.length === 1 &&
      toolCall.id === continuation.hostToolCallId &&
      toolCall.function.name === continuation.toolName &&
      sameJson(decodeArguments(toolCall.function.arguments), continuation.args)
    );
  });
  if (matches.length !== 1) {
    return false;
  }

  const contentMatches = input.aggregatedContent.filter((candidate) => {
    if (!isRecord(candidate) || candidate.type !== 'tool_call' || !isRecord(candidate.tool_call)) {
      return false;
    }
    const toolCall = candidate.tool_call;
    return (
      toolCall.id === continuation.hostToolCallId &&
      toolCall.name === continuation.toolName &&
      sameJson(decodeArguments(toolCall.args), continuation.args) &&
      (toolCall.stepId === undefined || toolCall.stepId === continuation.stepIdentity.id)
    );
  });
  return contentMatches.length === 1;
}

export type PiApprovalDecision =
  | { readonly kind: 'execute'; readonly args: PiToolArguments }
  | { readonly kind: 'reject' }
  | { readonly kind: 'respond'; readonly text: string };

/** Decode exactly one reviewed decision and validate edited arguments with the host tool schema. */
export function resolvePiApprovalDecision(input: {
  continuation: PiApprovalContinuation;
  resolutions: readonly unknown[];
}): PiApprovalDecision | undefined {
  const { continuation, resolutions } = input;
  const candidate = resolutions[0];
  if (
    resolutions.length !== 1 ||
    !isRecord(candidate) ||
    candidate.tool_call_id !== continuation.hostToolCallId ||
    !isDecision(candidate.decision) ||
    !continuation.allowedDecisions.includes(candidate.decision)
  ) {
    return undefined;
  }
  switch (candidate.decision) {
    case 'approve':
      return { kind: 'execute', args: continuation.args };
    case 'reject':
      return { kind: 'reject' };
    case 'respond':
      return typeof candidate.responseText === 'string' && candidate.responseText.length > 0
        ? { kind: 'respond', text: candidate.responseText }
        : undefined;
    case 'edit': {
      try {
        const validated = validatePiToolExecutionInput(
          continuation.toolName,
          continuation.piToolCallId,
          candidate.editedArguments,
        );
        return { kind: 'execute', args: validated.args };
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Append the approved tool exchange to a fresh in-memory Pi history projection. */
export function appendPiToolResultContinuation(input: {
  conversion: PiHistoryConversion;
  continuation: PiApprovalContinuation;
  toolArguments: PiToolArguments;
  result: Pick<ToolResultMessage, 'content' | 'isError'>;
  model: { api: AssistantMessage['api']; provider: AssistantMessage['provider']; id: string };
  now?: () => number;
}): PiHistoryMessage[] {
  const now = input.now ?? Date.now;
  const promptContent = [
    ...(input.conversion.prompt.text.length === 0
      ? []
      : [{ type: 'text' as const, text: input.conversion.prompt.text }]),
    ...input.conversion.prompt.images,
  ];
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: input.continuation.piToolCallId,
        name: input.continuation.toolName,
        arguments: input.toolArguments,
      },
    ],
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: now(),
  };
  const result: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: input.continuation.piToolCallId,
    toolName: input.continuation.toolName,
    content: [...input.result.content],
    isError: input.result.isError,
    timestamp: now(),
  };
  const user = {
    role: 'user' as const,
    content: promptContent,
    timestamp: now(),
  };

  return [...input.conversion.history, user, assistant, result];
}
