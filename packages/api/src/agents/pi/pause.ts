import type { Agents } from 'librechat-data-provider';
import type { PiAskUserQuestionArguments, PiHostToolExecutionInput } from './tools';
import type { PiActionToolSchemaRegistry } from './actionSchema';
import type { PiProviderEventFailure } from './providerEvents';
import type { PiCodeSessionSnapshot } from './codeSession';
import type { PiMcpToolSchemaRegistry } from './mcpSchema';
import type { PiMessageStepIdentity } from './events';
import { validatePiAskUserQuestionArguments, validatePiToolExecutionInput } from './tools';
import { parsePiCodeSessionSnapshot } from './codeSession';

/** Host identity required to settle the in-progress step after an approval resume. */
export interface PiPauseHostExecution {
  readonly toolCallId: string;
  readonly toolTurn: number;
  readonly stepIdentity: PiMessageStepIdentity;
  readonly createdAt: number;
}

export interface PiPauseReview {
  readonly allowedDecisions: readonly Agents.ToolApprovalDecisionType[];
  readonly description?: string;
}

/** Exact, schema-validated call and host step stopped before any tool side effect. */
export type PiPauseToolCall = PiHostToolExecutionInput & {
  codeSessionContext?: PiCodeSessionSnapshot;
  hostExecution: PiPauseHostExecution;
  review: PiPauseReview;
};

export interface PiPauseAskUserQuestionCall {
  readonly toolCallId: string;
  readonly name: 'ask_user_question';
  readonly args: PiAskUserQuestionArguments;
  readonly hostExecution: PiPauseHostExecution;
}

export type PiPauseSignal =
  | { readonly kind: 'tool_approval'; readonly toolCall: PiPauseToolCall }
  | { readonly kind: 'ask_user_question'; readonly toolCall: PiPauseAskUserQuestionCall }
  | {
      readonly kind: 'unsupported_tool_batch';
      readonly toolCallIds: readonly [string, string, ...string[]];
    }
  | {
      readonly kind: 'unsupported_provider_event';
      readonly failure: PiProviderEventFailure;
    };

export type PiResumablePauseSignal = Extract<
  PiPauseSignal,
  { kind: 'tool_approval' | 'ask_user_question' }
>;

export interface PiPauseController {
  readonly signal: PiPauseSignal | undefined;
  request(toolCall: PiPauseToolCall): PiPauseSignal;
  requestAskUserQuestion(toolCall: PiPauseAskUserQuestionCall): PiPauseSignal;
  rejectBatch(toolCallIds: readonly string[]): PiPauseSignal;
  rejectProviderEvent(failure: PiProviderEventFailure): PiPauseSignal;
}

const SUPPORTED_DECISIONS = new Set<Agents.ToolApprovalDecisionType>([
  'approve',
  'reject',
  'edit',
  'respond',
]);

/** Collects one ordered tool batch that must be reviewed before any call runs. */
export function createPiPauseController(
  options: {
    mcpToolSchemas?: PiMcpToolSchemaRegistry;
    actionToolSchemas?: PiActionToolSchemaRegistry;
  } = {},
): PiPauseController {
  let signal: PiPauseSignal | undefined;
  const requestedCalls = new Map<string, PiPauseToolCall>();

  return {
    get signal() {
      return signal;
    },
    request(toolCall) {
      if (signal?.kind === 'unsupported_provider_event') {
        return signal;
      }
      const validatedCall = validatePiToolExecutionInput(
        toolCall.name,
        toolCall.toolCallId,
        toolCall.args,
        {
          ...(options.mcpToolSchemas == null ? {} : { mcpToolSchemas: options.mcpToolSchemas }),
          ...(options.actionToolSchemas == null
            ? {}
            : { actionToolSchemas: options.actionToolSchemas }),
          ...('kind' in toolCall ? { expectedSchemaFingerprint: toolCall.schemaFingerprint } : {}),
        },
      );
      let codeSessionContext: PiCodeSessionSnapshot | undefined;
      try {
        codeSessionContext = parsePiCodeSessionSnapshot(toolCall.codeSessionContext);
      } catch {
        throw new Error('Pi approval continuation code session is invalid');
      }
      if (
        toolCall.hostExecution.toolCallId.length === 0 ||
        !Number.isSafeInteger(toolCall.hostExecution.toolTurn) ||
        toolCall.hostExecution.toolTurn < 0 ||
        !Number.isFinite(toolCall.hostExecution.createdAt) ||
        toolCall.hostExecution.createdAt < 0 ||
        toolCall.hostExecution.stepIdentity.id.length === 0 ||
        !Number.isSafeInteger(toolCall.hostExecution.stepIdentity.index) ||
        toolCall.hostExecution.stepIdentity.index < 0 ||
        toolCall.hostExecution.stepIdentity.messageId.length === 0 ||
        toolCall.hostExecution.stepIdentity.runId.length === 0 ||
        toolCall.hostExecution.stepIdentity.agentId.length === 0 ||
        toolCall.review.allowedDecisions.length === 0 ||
        toolCall.review.allowedDecisions.some((decision) => !SUPPORTED_DECISIONS.has(decision)) ||
        new Set(toolCall.review.allowedDecisions).size !==
          toolCall.review.allowedDecisions.length ||
        (toolCall.review.description !== undefined &&
          (toolCall.review.description.trim().length === 0 ||
            toolCall.review.description.length > 1_000))
      ) {
        throw new Error('Pi approval continuation metadata is invalid');
      }
      const previousCall = requestedCalls.get(toolCall.toolCallId);
      if (previousCall != null) {
        if (
          previousCall.name !== toolCall.name ||
          JSON.stringify(previousCall.args) !== JSON.stringify(validatedCall.args) ||
          ('kind' in previousCall ? previousCall.kind : undefined) !==
            ('kind' in validatedCall ? validatedCall.kind : undefined) ||
          ('schemaFingerprint' in previousCall ? previousCall.schemaFingerprint : undefined) !==
            ('schemaFingerprint' in validatedCall ? validatedCall.schemaFingerprint : undefined) ||
          previousCall.hostExecution.toolCallId !== toolCall.hostExecution.toolCallId ||
          previousCall.hostExecution.toolTurn !== toolCall.hostExecution.toolTurn ||
          JSON.stringify(previousCall.hostExecution.stepIdentity) !==
            JSON.stringify(toolCall.hostExecution.stepIdentity) ||
          previousCall.hostExecution.createdAt !== toolCall.hostExecution.createdAt ||
          JSON.stringify(previousCall.codeSessionContext) !== JSON.stringify(codeSessionContext) ||
          JSON.stringify(previousCall.review) !== JSON.stringify(toolCall.review)
        ) {
          throw new Error('A Pi tool call ID cannot refer to two different host actions');
        }
        if (signal == null) throw new Error('A Pi pause signal is missing its recorded tool call');
        return signal;
      }

      const nextCall: PiPauseToolCall = {
        ...validatedCall,
        ...(codeSessionContext == null ? {} : { codeSessionContext }),
        hostExecution: {
          ...toolCall.hostExecution,
          stepIdentity: { ...toolCall.hostExecution.stepIdentity },
        },
        review: {
          allowedDecisions: [...toolCall.review.allowedDecisions],
          ...(toolCall.review.description == null
            ? {}
            : { description: toolCall.review.description }),
        },
      };
      if (
        signal?.kind === 'unsupported_tool_batch' &&
        signal.toolCallIds.includes(nextCall.toolCallId)
      ) {
        requestedCalls.set(nextCall.toolCallId, nextCall);
        return signal;
      }
      requestedCalls.set(nextCall.toolCallId, nextCall);
      if (signal == null) {
        signal = { kind: 'tool_approval', toolCall: nextCall };
      } else if (signal.kind === 'tool_approval') {
        signal = {
          kind: 'unsupported_tool_batch',
          toolCallIds: [signal.toolCall.toolCallId, nextCall.toolCallId],
        };
      } else if (signal.kind === 'ask_user_question') {
        signal = {
          kind: 'unsupported_tool_batch',
          toolCallIds: [signal.toolCall.toolCallId, nextCall.toolCallId],
        };
      } else {
        signal = {
          kind: 'unsupported_tool_batch',
          toolCallIds: [...signal.toolCallIds, nextCall.toolCallId],
        };
      }
      return signal;
    },
    requestAskUserQuestion(toolCall) {
      if (signal?.kind === 'unsupported_provider_event') {
        return signal;
      }
      if (toolCall.toolCallId.length === 0) {
        throw new Error('A Pi ask-user pause has an invalid tool identity');
      }
      const args = validatePiAskUserQuestionArguments(toolCall.args);
      const { hostExecution } = toolCall;
      if (
        hostExecution.toolCallId.length === 0 ||
        !Number.isSafeInteger(hostExecution.toolTurn) ||
        hostExecution.toolTurn < 0 ||
        !Number.isFinite(hostExecution.createdAt) ||
        hostExecution.createdAt < 0 ||
        hostExecution.stepIdentity.id.length === 0 ||
        !Number.isSafeInteger(hostExecution.stepIdentity.index) ||
        hostExecution.stepIdentity.index < 0 ||
        hostExecution.stepIdentity.messageId.length === 0 ||
        hostExecution.stepIdentity.runId.length === 0 ||
        hostExecution.stepIdentity.agentId.length === 0
      ) {
        throw new Error('Pi ask-user continuation metadata is invalid');
      }
      if (signal?.kind === 'ask_user_question') {
        const previous = signal.toolCall;
        if (previous.toolCallId !== toolCall.toolCallId) {
          signal = {
            kind: 'unsupported_tool_batch',
            toolCallIds: [previous.toolCallId, toolCall.toolCallId],
          };
          return signal;
        }
        if (
          previous.hostExecution.toolCallId !== hostExecution.toolCallId ||
          previous.hostExecution.toolTurn !== hostExecution.toolTurn ||
          previous.hostExecution.createdAt !== hostExecution.createdAt ||
          JSON.stringify(previous.hostExecution.stepIdentity) !==
            JSON.stringify(hostExecution.stepIdentity) ||
          JSON.stringify(previous.args) !== JSON.stringify(args)
        ) {
          throw new Error('A Pi tool call ID cannot refer to two different host actions');
        }
        return signal;
      }
      if (signal != null) {
        if (signal.kind === 'tool_approval') {
          signal = {
            kind: 'unsupported_tool_batch',
            toolCallIds: [signal.toolCall.toolCallId, toolCall.toolCallId],
          };
        }
        return signal;
      }
      const askUserSignal: PiPauseSignal = {
        kind: 'ask_user_question',
        toolCall: {
          toolCallId: toolCall.toolCallId,
          name: 'ask_user_question',
          args,
          hostExecution: {
            ...hostExecution,
            stepIdentity: { ...hostExecution.stepIdentity },
          },
        },
      };
      signal = askUserSignal;
      return askUserSignal;
    },
    rejectBatch(toolCallIds) {
      if (signal?.kind === 'unsupported_provider_event') {
        return signal;
      }
      if (toolCallIds.length < 2) {
        throw new Error('An unsupported Pi tool batch requires at least two tool call IDs');
      }
      const batchIds = [...toolCallIds];

      if (signal?.kind === 'unsupported_tool_batch') {
        return signal;
      }
      if (signal?.kind === 'tool_approval' && !batchIds.includes(signal.toolCall.toolCallId)) {
        batchIds.unshift(signal.toolCall.toolCallId);
      }
      if (signal?.kind === 'ask_user_question' && !batchIds.includes(signal.toolCall.toolCallId)) {
        batchIds.unshift(signal.toolCall.toolCallId);
      }

      const [firstId, secondId] = batchIds;
      if (firstId == null || secondId == null) {
        throw new Error('An unsupported Pi tool batch requires at least two tool call IDs');
      }
      signal = {
        kind: 'unsupported_tool_batch',
        toolCallIds: [firstId, secondId, ...batchIds.slice(2)],
      };
      return signal;
    },
    rejectProviderEvent(failure) {
      if (signal?.kind === 'unsupported_provider_event') {
        return signal;
      }
      signal = { kind: 'unsupported_provider_event', failure };
      return signal;
    },
  };
}
