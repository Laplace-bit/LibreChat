import { GraphEvents } from '@librechat/agents';
import { StepTypes, Tools } from 'librechat-data-provider';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import type { PiHostContentEvent } from './events';
import type { HostPiSession } from './session';
import type { PiPauseSignal } from './pause';
import { createPiHostEventSequencer, executePiHostSession } from './bridge';
import { createPiPauseController } from './pause';

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
    continueFromToolResult() {
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
  const pauseSignal = {
    kind: 'tool_approval',
    toolCall: {
      toolCallId: 'pi-call-1',
      name: Tools.file_search,
      args: { query: 'maintenance manual' },
      hostExecution: {
        toolCallId: 'host-call-1',
        toolTurn: 0,
        stepIdentity: {
          id: 'host-step-1',
          index: 0,
          messageId: 'message-1',
          runId: 'run-1',
          agentId: 'agent-1',
        },
        createdAt: 1,
      },
      review: { allowedDecisions: ['approve', 'reject'] },
    },
  } satisfies PiPauseSignal;

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
      operation: { kind: 'prompt', text: 'hello' },
      translateEvent: (event) => [createHostEvent(event.type)],
      handleHostEvent: async (event) => {
        if (event.event !== GraphEvents.ON_RUN_STEP_CLOSED) {
          throw new Error('Expected a run-step close event');
        }
        const { data } = event;
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

  it('continues a restored tool result without appending another user prompt', async () => {
    let listener: AgentSessionEventListener | undefined;
    let promptCalls = 0;
    const continuationCalls: string[] = [];
    const session: HostPiSession = {
      sessionFile: undefined,
      activeToolNames: [],
      subscribe(nextListener) {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        promptCalls += 1;
      },
      async continueFromToolResult(toolCallId) {
        continuationCalls.push(toolCallId);
        listener?.({ type: 'agent_end', messages: [], willRetry: false });
      },
      steer() {
        throw new Error('steer is not used by tool-result continuation');
      },
      followUp() {
        throw new Error('followUp is not used by tool-result continuation');
      },
      async abort() {},
      async dispose() {},
    };

    await expect(
      executePiHostSession({
        session,
        operation: { kind: 'continue_tool_result', toolCallId: 'reviewed-call' },
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(promptCalls).toBe(0);
    expect(continuationCalls).toEqual(['reviewed-call']);
  });

  it('fails closed when a low-level continuation would need AgentSession retry handling', async () => {
    let listener: AgentSessionEventListener | undefined;
    let abortCalls = 0;
    const session: HostPiSession = {
      sessionFile: undefined,
      activeToolNames: [],
      subscribe(nextListener) {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {},
      async continueFromToolResult() {
        listener?.({ type: 'agent_end', messages: [], willRetry: true });
      },
      steer() {
        throw new Error('steer is not used by tool-result continuation');
      },
      followUp() {
        throw new Error('followUp is not used by tool-result continuation');
      },
      async abort() {
        abortCalls += 1;
      },
      async dispose() {},
    };

    await expect(
      executePiHostSession({
        session,
        operation: { kind: 'continue_tool_result', toolCallId: 'reviewed-call' },
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).rejects.toThrow('cannot use AgentSession retry handling');
    expect(abortCalls).toBe(1);
  });

  it('serializes Pi stream events and direct host-tool events through one shared FIFO', async () => {
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const delivered: string[] = [];
    const eventSequencer = createPiHostEventSequencer(async (event) => {
      if (event.event !== GraphEvents.ON_RUN_STEP_CLOSED) {
        throw new Error('Expected a run-step close event');
      }
      delivered.push(`start:${event.data.id}`);
      if (event.data.id === 'stream') {
        handlerStarted.resolve(undefined);
        await releaseHandler.promise;
      }
      delivered.push(`end:${event.data.id}`);
    });
    const harness = createSession(async (emit) => {
      emit(sessionEvent('agent_end'));
      await eventSequencer.enqueue(createHostEvent('tool'));
      emit(sessionEvent('agent_settled'));
    });

    const execution = executePiHostSession({
      session: harness.session,
      operation: { kind: 'prompt', text: 'hello' },
      eventSequencer,
      translateEvent: (event) => [
        createHostEvent(event.type === 'agent_end' ? 'stream' : 'settled'),
      ],
      handleHostEvent: () => {
        throw new Error('The shared sequencer must own event delivery');
      },
    });

    await handlerStarted.promise;
    expect(delivered).toEqual(['start:stream']);
    releaseHandler.resolve(undefined);

    await expect(execution).resolves.toEqual({ status: 'completed' });
    expect(delivered).toEqual([
      'start:stream',
      'end:stream',
      'start:tool',
      'end:tool',
      'start:settled',
      'end:settled',
    ]);
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
      operation: { kind: 'prompt', text: 'hello' },
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
        operation: { kind: 'prompt', text: 'hello' },
        signal: controller.signal,
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(harness.unsubscribeCount).toBe(1);
  });

  it('returns a typed pause only after Pi has settled and the event FIFO drains', async () => {
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const delivered: string[] = [];
    const pauseController = createPiPauseController();
    const harness = createSession(async (emit) => {
      pauseController.request(pauseSignal.toolCall);
      emit(sessionEvent('agent_end'));
      emit({ type: 'agent_settled', aborted: true });
    });
    const execution = executePiHostSession({
      session: harness.session,
      operation: { kind: 'prompt', text: 'hello' },
      pauseController,
      translateEvent: (event) => [createHostEvent(event.type)],
      handleHostEvent: async (event) => {
        if (event.event !== GraphEvents.ON_RUN_STEP_CLOSED) {
          throw new Error('Expected a run-step close event');
        }
        delivered.push(`start:${event.data.id}`);
        if (event.data.id === 'agent_end') {
          handlerStarted.resolve(undefined);
          await releaseHandler.promise;
        }
        delivered.push(`end:${event.data.id}`);
      },
    });
    let settled = false;
    void execution.then(() => {
      settled = true;
    });

    await handlerStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseHandler.resolve(undefined);

    await expect(execution).resolves.toEqual({ status: 'paused', signal: pauseSignal });
    expect(harness.abortCount).toBe(1);
    expect(delivered).toEqual([
      'start:agent_end',
      'end:agent_end',
      'start:agent_settled',
      'end:agent_settled',
    ]);
  });

  it('treats a duplicate pause request for the same tool call as idempotent', () => {
    const pauseController = createPiPauseController();

    pauseController.request(pauseSignal.toolCall);
    pauseController.request(pauseSignal.toolCall);

    expect(pauseController.signal).toEqual(pauseSignal);
  });

  it('lets an external abort override a pause requested while host events drain', async () => {
    const controller = new AbortController();
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const pauseController = createPiPauseController();
    const harness = createSession(async (emit) => {
      pauseController.request(pauseSignal.toolCall);
      emit(sessionEvent('agent_end'));
      emit({ type: 'agent_settled', aborted: true });
    });
    const execution = executePiHostSession({
      session: harness.session,
      operation: { kind: 'prompt', text: 'hello' },
      signal: controller.signal,
      pauseController,
      translateEvent: () => [createHostEvent('pending-event')],
      handleHostEvent: async () => {
        handlerStarted.resolve(undefined);
        await releaseHandler.promise;
      },
    });

    await handlerStarted.promise;
    controller.abort();
    releaseHandler.resolve(undefined);

    await expect(execution).resolves.toEqual({ status: 'cancelled' });
  });

  it('does not subscribe when the host signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createSession(async () => undefined);

    await expect(
      executePiHostSession({
        session: harness.session,
        operation: { kind: 'prompt', text: 'hello' },
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
      operation: { kind: 'prompt', text: 'hello' },
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
        operation: { kind: 'prompt', text: 'hello' },
        translateEvent: () => [],
        handleHostEvent: () => undefined,
      }),
    ).resolves.toEqual({ status: 'completed' });
    expect(harness.unsubscribeCount).toBe(1);
  });
});
