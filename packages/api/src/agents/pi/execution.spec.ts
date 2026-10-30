import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import type { PiGenerationExecutorInput } from './execution';
import type { HostPiSession } from './session';
import { createPiGenerationExecutor } from './execution';

function createSession(
  runPrompt: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
  options: { dispose?: () => void | Promise<void> } = {},
) {
  let listener: AgentSessionEventListener | undefined;
  let disposeCount = 0;
  const session: HostPiSession = {
    sessionFile: undefined,
    activeToolNames: [],
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    prompt() {
      return runPrompt((event) => listener?.(event));
    },
    steer() {
      throw new Error('steer is not used by the generation executor');
    },
    followUp() {
      throw new Error('followUp is not used by the generation executor');
    },
    async abort() {},
    async dispose() {
      disposeCount += 1;
      await options.dispose?.();
    },
  };

  return {
    session,
    get disposeCount() {
      return disposeCount;
    },
  };
}

function createInput(
  overrides: Partial<PiGenerationExecutorInput> = {},
): PiGenerationExecutorInput {
  return {
    createModelBinding: async () => {
      throw new Error('the test session does not create model bindings');
    },
    systemPrompt: 'system',
    tools: [],
    prompt: 'hello',
    translateEvent: () => [],
    handleHostEvent: () => undefined,
    ...overrides,
  };
}

describe('createPiGenerationExecutor', () => {
  it('creates one session and disposes it after a successful turn', async () => {
    const harness = createSession(async (emit) => {
      emit({ type: 'agent_settled', aborted: false });
    });
    const createSessionDependency = jest.fn(async () => harness.session);
    const execute = createPiGenerationExecutor({ createSession: createSessionDependency });

    await expect(execute(createInput())).resolves.toEqual({ status: 'completed' });
    expect(createSessionDependency).toHaveBeenCalledTimes(1);
    expect(harness.disposeCount).toBe(1);
  });

  it('does not create a Pi session when the generation is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const createSessionDependency = jest.fn(async () => {
      throw new Error('must not create a session');
    });
    const execute = createPiGenerationExecutor({ createSession: createSessionDependency });

    await expect(execute(createInput({ signal: controller.signal }))).resolves.toEqual({
      status: 'cancelled',
    });
    expect(createSessionDependency).not.toHaveBeenCalled();
  });

  it('treats session initialization cancellation as cancellation', async () => {
    const controller = new AbortController();
    const createSessionDependency = jest.fn(async () => {
      controller.abort();
      const abortError = new Error('initialization aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const execute = createPiGenerationExecutor({ createSession: createSessionDependency });

    await expect(execute(createInput({ signal: controller.signal }))).resolves.toEqual({
      status: 'cancelled',
    });
    expect(createSessionDependency).toHaveBeenCalledTimes(1);
  });

  it('preserves execution and cleanup failures together', async () => {
    const executionFailure = new Error('event translation failed');
    const cleanupFailure = new Error('session disposal failed');
    const harness = createSession(
      async (emit) => {
        emit({ type: 'agent_end', messages: [], willRetry: false });
      },
      { dispose: () => Promise.reject(cleanupFailure) },
    );
    const execute = createPiGenerationExecutor({
      createSession: async () => harness.session,
    });

    await expect(
      execute(
        createInput({
          translateEvent: () => {
            throw executionFailure;
          },
        }),
      ),
    ).rejects.toMatchObject({
      errors: [executionFailure, cleanupFailure],
    });
    expect(harness.disposeCount).toBe(1);
  });

  it('surfaces cleanup failure after an otherwise successful turn', async () => {
    const cleanupFailure = new Error('session disposal failed');
    const harness = createSession(async () => undefined, {
      dispose: () => Promise.reject(cleanupFailure),
    });
    const execute = createPiGenerationExecutor({
      createSession: async () => harness.session,
    });

    await expect(execute(createInput())).rejects.toBe(cleanupFailure);
    expect(harness.disposeCount).toBe(1);
  });
});
