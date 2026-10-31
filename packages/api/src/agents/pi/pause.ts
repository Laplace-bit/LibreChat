import type { Agents } from 'librechat-data-provider';
import type { PiProviderEventFailure } from './providerEvents';
import type { PiHostToolExecutionInput } from './tools';
import type { PiMessageStepIdentity } from './events';
import { validatePiToolExecutionInput } from './tools';

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
  hostExecution: PiPauseHostExecution;
  review: PiPauseReview;
};

export type PiPauseSignal =
  | { readonly kind: 'tool_approval'; readonly toolCall: PiPauseToolCall }
  | {
      readonly kind: 'unsupported_tool_batch';
      readonly toolCallIds: readonly [string, string, ...string[]];
    }
  | {
      readonly kind: 'unsupported_provider_event';
      readonly failure: PiProviderEventFailure;
    };

export interface PiPauseController {
  readonly signal: PiPauseSignal | undefined;
  request(toolCall: PiPauseToolCall): PiPauseSignal;
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
export function createPiPauseController(): PiPauseController {
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
      );
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
          previousCall.hostExecution.toolCallId !== toolCall.hostExecution.toolCallId ||
          previousCall.hostExecution.toolTurn !== toolCall.hostExecution.toolTurn ||
          JSON.stringify(previousCall.hostExecution.stepIdentity) !==
            JSON.stringify(toolCall.hostExecution.stepIdentity) ||
          previousCall.hostExecution.createdAt !== toolCall.hostExecution.createdAt ||
          JSON.stringify(previousCall.review) !== JSON.stringify(toolCall.review)
        ) {
          throw new Error('A Pi tool call ID cannot refer to two different host actions');
        }
        if (signal == null) throw new Error('A Pi pause signal is missing its recorded tool call');
        return signal;
      }

      const nextCall: PiPauseToolCall = {
        ...validatedCall,
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
      } else {
        signal = {
          kind: 'unsupported_tool_batch',
          toolCallIds: [...signal.toolCallIds, nextCall.toolCallId],
        };
      }
      return signal;
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
