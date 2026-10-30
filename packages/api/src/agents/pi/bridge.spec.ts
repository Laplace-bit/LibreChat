import { GraphEvents } from '@librechat/agents';
import { StepTypes } from 'librechat-data-provider';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import type { PiHostContentEvent } from './events';
import type { HostPiSession } from './session';
import { executePiHostSession } from './bridge';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHostEvent(id: string): PiHostContentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_CLOSED,
    data: {
      id,
      index: 0,
      type: StepTypes.MESSAGE_CREATION,
      status: 'completed',
      created_at: 1,
      closed_at: 2,
      runId: 'run-id',
      agentId: 'agent-id',
    },
  };
}

function createSession(
  runPrompt: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
  onAbort: () => void = () => undefined,
) {
  let listener: AgentSessionEventListener | undefined;
  let abortCount = 0;
  let unsubscribeCount = 0;
  const session: HostPiSession = {
    sessionFile: undefined,
    activeToolNames: [],
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        unsubscribeCount += 1;
        listener = undefined;
      };
    },
    prompt() {
      return runPrompt((event) => listener?.(event));
    },
    steer() {
      throw new Error('steer is not used by the event bridge');
    },
    followUp() {
      throw new Error('followUp is not used by the event bridge');
    },
    async abort() {
      abortCount += 1;
      onAbort();
    },
    async dispose() {},
  };

  return {
    session,
    get abortCount() {
      return abortCount;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

function sessionEvent(type: 'agent_end' | 'agent_settled'): AgentSessionEvent {
  if (type === 'agent_end') {
    return { type, messages: [], willRetry: false };
  }
  return { type, aborted: false };
}

describe('executePiHostSession', () => {
  it('delivers translated host events serially and drains them before completing', async () => {
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const delivered: string[] = [];
    const harness = createSession(async (emit) => {
      emit(sessionEvent('agent_end'));
      emit(sessionEvent('agent_settled'));
    });

    const execution = executePiHostSession({
      session: harness.session,
      prompt: 'hello',
      translateEvent: (event) => [createHostEvent(event.type)],
      handleHostEvent: async ({ data }) => {
        delivered.push(`start:${data.id}`);
        if (data.id === 'agent_end') {
          handlerStarted.resolve(undefined);
          await releaseHandler.promise;
        }
        delivered.push(`end:${data.id}`);
      },
    });

    await handlerStarted.promise;
    expect(delivered).toEqual(['start:agent_end']);
    releaseHandler.resolve(undefined);

    await expect(execution).resolves.toEqual({ status: 'completed' });
    expect(delivered).toEqual([
      'start:agent_end',
      'end:agent_end',
      'start:agent_settled',
      'end:agent_settled',
    ]);
    expect(harness.unsubscribeCount).toBe(1);
  });

  it('aborts Pi and preserves the host handler error over the prompt abort error', async () => {
    const abortRequested = deferred<void>();
    const rootFailure = new Error('host persistence failed');
    const harness = createSession(
      async (emit) => {
        emit(sessionEvent('agent_end'));
        await abortRequested.promise;
        const abortError = new Error('Pi prompt aborted');
        abortError.name = 'AbortError';
        throw abortError;
      },
      () => abortRequested.resolve(undefined),
    );

    const execution = executePiHostSession({
      session: harness.session,
      prompt: 'hello',
      translateEvent: (event) => [createHostEvent(event.type)],
      handleHostEvent: async () => {
        throw rootFailure;
      },
    });
    await expect(execution).rejects.toBe(rootFailure);

    expect(harness.abortCount).toBe(1);
    expect(harness.unsubscribeCount).toBe(1);
  });

  it('reports cancellation when the host signal aborts the Pi prompt', async () => {
    const controller = new AbortController();
    const harness = createSession(async () => {
      controller.abort();
      const abortError = new Error('Pi prompt aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });

    await expect(
      executePiHostSession({
        session: harness.session,
        prompt: 'hello',
        signal: controller.signal,
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(harness.unsubscribeCount).toBe(1);
  });

  it('does not subscribe when the host signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createSession(async () => undefined);

    await expect(
      executePiHostSession({
        session: harness.session,
        prompt: 'hello',
        signal: controller.signal,
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(harness.unsubscribeCount).toBe(0);
  });

  it('does not mask a prompt failure when cancellation arrives while host events drain', async () => {
    const controller = new AbortController();
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const providerFailure = new Error('provider request failed');
    const harness = createSession(async (emit) => {
      emit(sessionEvent('agent_end'));
      throw providerFailure;
    });
    const execution = executePiHostSession({
      session: harness.session,
      prompt: 'hello',
      signal: controller.signal,
      translateEvent: (event) => [createHostEvent(event.type)],
      handleHostEvent: async () => {
        handlerStarted.resolve(undefined);
        await releaseHandler.promise;
      },
    });

    await handlerStarted.promise;
    controller.abort();
    releaseHandler.resolve(undefined);

    await expect(execution).rejects.toBe(providerFailure);
    expect(harness.unsubscribeCount).toBe(1);
  });

  it('reports normal prompt completion', async () => {
    const harness = createSession(async () => undefined);

    await expect(
      executePiHostSession({
        session: harness.session,
        prompt: 'hello',
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(harness.unsubscribeCount).toBe(1);
  });
});
