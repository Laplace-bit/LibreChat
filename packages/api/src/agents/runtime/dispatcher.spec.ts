import type { PiGenerationDispatchInput, PiGenerationDispatchResult } from '../pi/dispatch';
import type { PiExecuteTurnInput } from './dispatcher';
import type { createRun } from '../run';
import {
  AgentRuntimeUnavailableError,
  LEGACY_AGENT_RUNTIME,
  PINNED_PI_AGENT_RUNTIME,
} from './selection';
import { createAgentRuntimeDispatcher } from './dispatcher';

type LegacyRun = Awaited<ReturnType<typeof createRun>>;
type TestRun = Pick<LegacyRun, 'processStream' | 'resume'>;

function createRunHarness() {
  const order: string[] = [];
  const run = {
    processStream: jest.fn(async () => {
      order.push('processStream');
    }),
    resume: jest.fn(async () => {
      order.push('resume');
    }),
  } as unknown as TestRun;
  return { order, run };
}

describe('createAgentRuntimeDispatcher', () => {
  it('owns Legacy run creation and waits for checkpoint cleanup before exposing or streaming it', async () => {
    const { order, run } = createRunHarness();
    const createLegacyRun = jest.fn(async () => {
      order.push('createRun');
      return run as LegacyRun;
    });
    const createRunOptions = {} as Parameters<typeof createRun>[0];
    const config = {} as Parameters<TestRun['processStream']>[1];
    const processInput = { messages: [] } as Parameters<TestRun['processStream']>[0];
    const checkpointPrunePromise = Promise.resolve().then(() => {
      order.push('checkpointPruned');
    });
    const dispatcher = createAgentRuntimeDispatcher({ createLegacyRun });

    const result = await dispatcher.executeTurn({
      engine: 'legacy',
      selection: LEGACY_AGENT_RUNTIME,
      createRunOptions,
      checkpointPrunePromise,
      onRunBuilt: () => order.push('runBuilt'),
      onRunCreated: () => {
        expect(order).toContain('runBuilt');
        expect(order).toContain('checkpointPruned');
        order.push('runExposed');
      },
      beforeProcess: () => {
        order.push('beforeProcess');
      },
      prepareProcessInput: async () => {
        order.push('prepareInput');
        return processInput;
      },
      config,
      processOptions: { callbacks: {} },
    });

    expect(result).toEqual({ engine: 'legacy', run });
    expect(createLegacyRun).toHaveBeenCalledWith(createRunOptions);
    expect(run.processStream).toHaveBeenCalledWith(processInput, config, { callbacks: {} });
    expect(order).toContain('createRun');
    expect(order.indexOf('runExposed')).toBeGreaterThan(order.indexOf('runBuilt'));
    expect(order.indexOf('runExposed')).toBeGreaterThan(order.indexOf('checkpointPruned'));
    expect(order.slice(order.indexOf('runExposed'))).toEqual([
      'runExposed',
      'beforeProcess',
      'prepareInput',
      'processStream',
    ]);
  });

  it('keeps checkpoint-prune failures ahead of Legacy run exposure', async () => {
    const { order, run } = createRunHarness();
    const pruneError = new Error('checkpoint prune failed');
    const dispatcher = createAgentRuntimeDispatcher({
      createLegacyRun: async () => run as LegacyRun,
    });

    await expect(
      dispatcher.executeTurn({
        engine: 'legacy',
        selection: LEGACY_AGENT_RUNTIME,
        createRunOptions: {} as Parameters<typeof createRun>[0],
        checkpointPrunePromise: Promise.reject(pruneError),
        onRunCreated: () => {
          order.push('runExposed');
        },
        beforeProcess: () => {
          order.push('beforeProcess');
        },
        prepareProcessInput: async () => ({ messages: [] }),
        config: {} as Parameters<TestRun['processStream']>[1],
      }),
    ).rejects.toBe(pruneError);

    expect(order).not.toContain('runExposed');
    expect(run.processStream).not.toHaveBeenCalled();
  });

  it('completes Legacy reasoning labels when retained-input preparation fails', async () => {
    const { run } = createRunHarness();
    const inputError = new Error('retained input preparation failed');
    const afterProcess = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({
      createLegacyRun: async () => run as LegacyRun,
    });

    await expect(
      dispatcher.executeTurn({
        engine: 'legacy',
        selection: LEGACY_AGENT_RUNTIME,
        createRunOptions: {} as Parameters<typeof createRun>[0],
        checkpointPrunePromise: Promise.resolve(),
        onRunCreated: jest.fn(),
        beforeProcess: jest.fn(),
        prepareProcessInput: async () => {
          throw inputError;
        },
        afterProcess,
        config: {} as Parameters<TestRun['processStream']>[1],
      }),
    ).rejects.toBe(inputError);

    expect(run.processStream).not.toHaveBeenCalled();
    expect(afterProcess).toHaveBeenCalledWith(run);
  });

  it('owns the Legacy resume call and preserves its callback lifecycle ordering', async () => {
    const { order, run } = createRunHarness();
    const createLegacyRun = jest.fn(async () => run as LegacyRun);
    const dispatcher = createAgentRuntimeDispatcher({ createLegacyRun });
    const resumeValue = {} as Parameters<TestRun['resume']>[0];
    const config = {} as Parameters<TestRun['resume']>[1];
    const resumeOptions = { callbacks: {} } as Parameters<TestRun['resume']>[2];
    const commandOptions = {} as Parameters<TestRun['resume']>[3];

    const result = await dispatcher.resumeTurn({
      engine: 'legacy',
      selection: LEGACY_AGENT_RUNTIME,
      createRunOptions: {} as Parameters<typeof createRun>[0],
      onRunCreated: () => {
        order.push('runExposed');
      },
      beforeResume: () => {
        order.push('beforeResume');
      },
      afterResume: () => {
        order.push('afterResume');
      },
      resumeValue,
      config,
      resumeOptions,
      commandOptions,
    });

    expect(result).toEqual({ engine: 'legacy', run });
    expect(run.resume).toHaveBeenCalledWith(resumeValue, config, resumeOptions, commandOptions);
    expect(order).toEqual(['runExposed', 'beforeResume', 'resume', 'afterResume']);
  });

  it('routes initial and resumed Pi execution through Pi without constructing a Legacy run', async () => {
    const outcome: PiGenerationDispatchResult = { status: 'completed', usage: [] };
    const executePiGeneration = jest.fn(async () => outcome);
    const createLegacyRun = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ createLegacyRun, executePiGeneration });
    const piInput = {
      messages: [],
      createModelBinding: jest.fn(),
      createStepIdentity: jest.fn(),
      handleHostEvent: jest.fn(),
    } as unknown as PiExecuteTurnInput;

    await expect(
      dispatcher.executeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input: piInput,
      }),
    ).resolves.toEqual({ engine: 'pi', outcome });

    const resumeInput = {
      ...piInput,
      resumeToolResult: { continuation: {}, toolArguments: {}, execute: jest.fn() },
    } as unknown as PiGenerationDispatchInput & {
      resumeToolResult: NonNullable<PiGenerationDispatchInput['resumeToolResult']>;
    };
    await expect(
      dispatcher.resumeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input: resumeInput,
      }),
    ).resolves.toEqual({ engine: 'pi', outcome });

    expect(executePiGeneration).toHaveBeenNthCalledWith(1, piInput);
    expect(executePiGeneration).toHaveBeenNthCalledWith(2, resumeInput);
    expect(createLegacyRun).not.toHaveBeenCalled();
  });

  it('rejects Pi resume without its validated host-tool continuation input', async () => {
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration: jest.fn() });

    await expect(
      dispatcher.resumeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input: {
          messages: [],
          createModelBinding: jest.fn(),
          createStepIdentity: jest.fn(),
          handleHostEvent: jest.fn(),
        } as never,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
  });

  it('rejects resume-only tool data on an initial Pi turn', async () => {
    const executePiGeneration = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });

    await expect(
      dispatcher.executeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input: {
          messages: [],
          createModelBinding: jest.fn(),
          createStepIdentity: jest.fn(),
          handleHostEvent: jest.fn(),
          resumeToolResult: {} as never,
        } as never,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);

    expect(executePiGeneration).not.toHaveBeenCalled();
  });

  it('rejects an engine command that conflicts with its pinned identity', async () => {
    const createLegacyRun = jest.fn();
    const executePiGeneration = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ createLegacyRun, executePiGeneration });

    await expect(
      dispatcher.executeTurn({
        engine: 'legacy',
        selection: PINNED_PI_AGENT_RUNTIME,
      } as never),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);

    expect(createLegacyRun).not.toHaveBeenCalled();
    expect(executePiGeneration).not.toHaveBeenCalled();
  });
});
