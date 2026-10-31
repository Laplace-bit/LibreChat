import type { AgentSessionEvent, PromptOptions } from '@earendil-works/pi-coding-agent';
import type { PiPauseController, PiResumablePauseSignal } from './pause';
import type { PiProviderEventFailure } from './providerEvents';
import type { HostPiSession } from './session';
import type { PiHostEvent } from './events';

export interface PiHostEventBridgeOptions {
  session: HostPiSession;
  operation:
    | { kind: 'prompt'; text: string; options?: PromptOptions }
    | { kind: 'continue_tool_result'; toolCallId: string };
  signal?: AbortSignal;
  pauseController?: PiPauseController;
  translateEvent(event: AgentSessionEvent): readonly PiHostEvent[];
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
  /** Shared with direct host tool events so the full run has one FIFO. */
  eventSequencer?: PiHostEventSequencer;
}

export interface PiHostEventSequencer {
  enqueue(event: PiHostEvent): Promise<void>;
  drain(): Promise<void>;
  onFailure(listener: (error: unknown) => void): () => void;
}

/** Serializes all host-visible events for one Pi generation and latches failures. */
export function createPiHostEventSequencer(
  handleHostEvent: (event: PiHostEvent) => void | Promise<void>,
): PiHostEventSequencer {
  let tail: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const failureListeners = new Set<(error: unknown) => void>();

  const reportFailure = (error: unknown) => {
    if (failure != null) {
      return;
    }
    failure = { error };
    for (const listener of failureListeners) {
      try {
        listener(error);
      } catch {
        // A failure observer cannot mask the host event failure.
      }
    }
  };

  const enqueue = (event: PiHostEvent): Promise<void> => {
    const current = tail.then(async () => {
      if (failure != null) {
        throw failure.error;
      }
      await handleHostEvent(event);
    });
    tail = current.catch((error: unknown) => {
      reportFailure(error);
    });
    return current;
  };

  return {
    enqueue,
    async drain() {
      await tail;
      if (failure != null) {
        throw failure.error;
      }
    },
    onFailure(listener) {
      failureListeners.add(listener);
      if (failure != null) {
        listener(failure.error);
      }
      return () => failureListeners.delete(listener);
    },
  };
}

export type PiHostSessionOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'paused'; signal: PiResumablePauseSignal }
  | { status: 'unsupported'; reason: 'multiple_tool_calls' }
  | { status: 'unsupported'; reason: 'provider_event'; failure: PiProviderEventFailure };

/**
 * Delivers translated Pi events to the host in order. The caller supplies the host event
 * handlers so this package stays independent of Express and the server's CJS controllers.
 * Job ownership, persistence, and terminal state remain with the caller.
 */
export async function executePiHostSession(
  options: PiHostEventBridgeOptions,
): Promise<PiHostSessionOutcome> {
  if (options.signal?.aborted) {
    return { status: 'cancelled' };
  }

  let handlerFailure: { error: unknown } | undefined;
  let promptFailure: { error: unknown } | undefined;
  let promptWasCancelled = false;
  let sessionAborted = false;
  let active = true;
  let unsubscribed = false;

  const eventSequencer =
    options.eventSequencer ?? createPiHostEventSequencer(options.handleHostEvent);
  const abortAfterHandlerFailure = () => {
    void options.session.abort().catch(() => undefined);
  };
  const unsubscribeFailure = eventSequencer.onFailure(abortAfterHandlerFailure);

  const enqueueHostEvent = (event: PiHostEvent) => {
    void eventSequencer.enqueue(event).catch((error: unknown) => {
      if (handlerFailure == null) {
        handlerFailure = { error };
      }
    });
  };

  const unsubscribe = options.session.subscribe((event) => {
    if (!active) {
      return;
    }
    if (event.type === 'agent_settled' && event.aborted) {
      sessionAborted = true;
    }
    if (handlerFailure != null) {
      return;
    }

    let hostEvents: readonly PiHostEvent[];
    try {
      hostEvents = options.translateEvent(event);
    } catch (error) {
      handlerFailure = { error };
      abortAfterHandlerFailure();
      return;
    }
    for (const hostEvent of hostEvents) {
      enqueueHostEvent(hostEvent);
    }
    if (event.type === 'agent_end' && options.pauseController?.signal != null) {
      // The tool result has already entered Pi's transcript at agent_end. Abort
      // only now to stop AgentSession's outer auto-continue without racing it.
      void options.session.abort().catch(() => undefined);
    }
    if (
      event.type === 'agent_end' &&
      options.operation.kind === 'continue_tool_result' &&
      event.willRetry === true
    ) {
      /** AgentSession normally owns retry/compaction continuation after agent_end. */
      handlerFailure ??= {
        error: new Error('Pi tool-result continuation cannot use AgentSession retry handling'),
      };
      void options.session.abort().catch(() => undefined);
    }
  });

  const stopListening = () => {
    active = false;
    if (!unsubscribed) {
      unsubscribed = true;
      unsubscribe();
      unsubscribeFailure();
    }
  };

  try {
    try {
      switch (options.operation.kind) {
        case 'prompt':
          await options.session.prompt(options.operation.text, options.operation.options);
          break;
        case 'continue_tool_result':
          await options.session.continueFromToolResult(options.operation.toolCallId);
          break;
        default: {
          const exhaustive: never = options.operation;
          throw exhaustive;
        }
      }
    } catch (error) {
      promptFailure = { error };
      promptWasCancelled = options.signal?.aborted === true || sessionAborted;
    }
    stopListening();
    try {
      await eventSequencer.drain();
    } catch (error) {
      handlerFailure ??= { error };
    }

    if (handlerFailure != null) {
      throw handlerFailure.error;
    }
    const requestedPause = options.pauseController?.signal;
    if (promptFailure != null) {
      if (promptWasCancelled) {
        if (options.signal?.aborted) {
          return { status: 'cancelled' };
        }
        if (
          requestedPause?.kind === 'tool_approval' ||
          requestedPause?.kind === 'ask_user_question'
        ) {
          return { status: 'paused', signal: requestedPause };
        }
        if (requestedPause?.kind === 'unsupported_tool_batch') {
          return { status: 'unsupported', reason: 'multiple_tool_calls' };
        }
        if (requestedPause?.kind === 'unsupported_provider_event') {
          return {
            status: 'unsupported',
            reason: 'provider_event',
            failure: requestedPause.failure,
          };
        }
        return { status: 'cancelled' };
      }
      throw promptFailure.error;
    }
    // An external Stop wins if it races a pending pause while host events drain.
    if (options.signal?.aborted) {
      return { status: 'cancelled' };
    }
    if (requestedPause?.kind === 'tool_approval' || requestedPause?.kind === 'ask_user_question') {
      return { status: 'paused', signal: requestedPause };
    }
    if (requestedPause?.kind === 'unsupported_tool_batch') {
      return { status: 'unsupported', reason: 'multiple_tool_calls' };
    }
    if (requestedPause?.kind === 'unsupported_provider_event') {
      return { status: 'unsupported', reason: 'provider_event', failure: requestedPause.failure };
    }
    if (sessionAborted) {
      return { status: 'cancelled' };
    }
    return { status: 'completed' };
  } finally {
    stopListening();
  }
}
