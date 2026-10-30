import type { AgentSessionEvent, PromptOptions } from '@earendil-works/pi-coding-agent';
import type { HostPiSession, HostPiSessionOptions } from './session';
import type { PiHostSessionOutcome } from './bridge';
import type { PiHostContentEvent } from './events';
import { executePiHostSession } from './bridge';
import { createHostPiSession } from './session';

export interface PiGenerationExecutorInput extends HostPiSessionOptions {
  prompt: string;
  promptOptions?: PromptOptions;
  translateEvent(event: AgentSessionEvent): readonly PiHostContentEvent[];
  handleHostEvent(event: PiHostContentEvent): void | Promise<void>;
}

export interface PiGenerationExecutorDependencies {
  /** The host supplies a fresh, authorized model binding and execution context. */
  createSession(options: HostPiSessionOptions): Promise<HostPiSession>;
}

export function createPiGenerationExecutor(
  dependencies: PiGenerationExecutorDependencies = { createSession: createHostPiSession },
): (input: PiGenerationExecutorInput) => Promise<PiHostSessionOutcome> {
  return async (input) => {
    if (input.signal?.aborted) {
      return { status: 'cancelled' };
    }

    const { prompt, promptOptions, translateEvent, handleHostEvent, ...sessionOptions } = input;
    let session: HostPiSession;
    try {
      session = await dependencies.createSession(sessionOptions);
    } catch (error) {
      if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        return { status: 'cancelled' };
      }
      throw error;
    }

    let executionResult:
      | { ok: true; outcome: PiHostSessionOutcome }
      | { ok: false; error: unknown };
    try {
      const outcome = await executePiHostSession({
        session,
        prompt,
        promptOptions,
        signal: input.signal,
        translateEvent,
        handleHostEvent,
      });
      executionResult = { ok: true, outcome };
    } catch (error) {
      executionResult = { ok: false, error };
    }

    let cleanupFailure: { error: unknown } | undefined;
    try {
      await session.dispose();
    } catch (error) {
      cleanupFailure = { error };
    }

    if (!executionResult.ok) {
      if (cleanupFailure != null) {
        throw new AggregateError(
          [executionResult.error, cleanupFailure.error],
          'Pi generation failed and its session could not be disposed cleanly',
        );
      }
      throw executionResult.error;
    }

    if (cleanupFailure != null) {
      throw cleanupFailure.error;
    }
    return executionResult.outcome;
  };
}
