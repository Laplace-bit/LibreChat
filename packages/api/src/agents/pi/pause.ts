import type { PiProviderEventFailure } from './providerEvents';
import type { PiHostToolExecutionInput } from './tools';
import { validatePiToolExecutionInput } from './tools';

/** Exact, schema-validated host call stopped before dispatch. */
export type PiPauseToolCall = PiHostToolExecutionInput;

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
      const previousCall = requestedCalls.get(toolCall.toolCallId);
      if (previousCall != null) {
        if (
          previousCall.name !== toolCall.name ||
          JSON.stringify(previousCall.args) !== JSON.stringify(validatedCall.args)
        ) {
          throw new Error('A Pi tool call ID cannot refer to two different host actions');
        }
        if (signal == null) throw new Error('A Pi pause signal is missing its recorded tool call');
        return signal;
      }

      const nextCall = validatedCall;
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
