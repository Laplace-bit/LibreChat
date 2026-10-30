import type { AgentSessionEvent, PromptOptions } from '@earendil-works/pi-coding-agent';
import type { PiHostContentEvent } from './events';
import type { HostPiSession } from './session';

export interface PiHostEventBridgeOptions {
  session: HostPiSession;
  prompt: string;
  promptOptions?: PromptOptions;
  signal?: AbortSignal;
  translateEvent(event: AgentSessionEvent): readonly PiHostContentEvent[];
  handleHostEvent(event: PiHostContentEvent): void | Promise<void>;
}

export type PiHostSessionOutcome = { status: 'completed' } | { status: 'cancelled' };

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

  let eventQueue = Promise.resolve();
  let handlerFailure: { error: unknown } | undefined;
  let promptFailure: { error: unknown } | undefined;
  let promptWasCancelled = false;
  let sessionAborted = false;
  let active = true;
  let unsubscribed = false;

  const abortAfterHandlerFailure = () => {
    void options.session.abort().catch(() => undefined);
  };

  const enqueueHostEvent = (event: PiHostContentEvent) => {
    eventQueue = eventQueue
      .then(async () => {
        if (handlerFailure == null) {
          await options.handleHostEvent(event);
        }
      })
      .catch((error: unknown) => {
        handlerFailure ??= { error };
        abortAfterHandlerFailure();
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

    let hostEvents: readonly PiHostContentEvent[];
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
  });

  const stopListening = () => {
    active = false;
    if (!unsubscribed) {
      unsubscribed = true;
      unsubscribe();
    }
  };

  try {
    try {
      await options.session.prompt(options.prompt, options.promptOptions);
    } catch (error) {
      promptFailure = { error };
      promptWasCancelled = options.signal?.aborted === true || sessionAborted;
    }
    stopListening();
    await eventQueue;

    if (handlerFailure != null) {
      throw handlerFailure.error;
    }
    if (promptFailure != null) {
      if (promptWasCancelled) {
        return { status: 'cancelled' };
      }
      throw promptFailure.error;
    }
    if (options.signal?.aborted || sessionAborted) {
      return { status: 'cancelled' };
    }
    return { status: 'completed' };
  } finally {
    stopListening();
  }
}
