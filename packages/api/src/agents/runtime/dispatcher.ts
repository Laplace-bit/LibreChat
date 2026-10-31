import type { PiGenerationDispatchInput, PiGenerationDispatchResult } from '../pi/dispatch';
import {
  AgentRuntimeUnavailableError,
  LEGACY_AGENT_RUNTIME,
  PINNED_PI_AGENT_RUNTIME,
  resolveStoredAgentRuntime,
} from './selection';
import { executePiGeneration } from '../pi/dispatch';
import { createRun } from '../run';

type LegacyAgentRun = Awaited<ReturnType<typeof createRun>>;
type LegacyProcessInput = Parameters<LegacyAgentRun['processStream']>[0];
type LegacyProcessConfig = Parameters<LegacyAgentRun['processStream']>[1];
type LegacyProcessOptions = Parameters<LegacyAgentRun['processStream']>[2];
type LegacyResumeValue = Parameters<LegacyAgentRun['resume']>[0];
type LegacyResumeConfig = Parameters<LegacyAgentRun['resume']>[1];
type LegacyResumeOptions = Parameters<LegacyAgentRun['resume']>[2];
type LegacyCommandOptions = Parameters<LegacyAgentRun['resume']>[3];

export interface LegacyExecuteTurnCommand {
  engine: 'legacy';
  selection: typeof LEGACY_AGENT_RUNTIME;
  createRunOptions: Parameters<typeof createRun>[0];
  /** Started by the host alongside graph construction; both must settle before the run is exposed. */
  checkpointPrunePromise: Promise<unknown>;
  onRunBuilt?(run: LegacyAgentRun): void;
  onRunCreated(run: LegacyAgentRun): void | Promise<void>;
  beforeProcess(run: LegacyAgentRun): void | Promise<void>;
  prepareProcessInput(run: LegacyAgentRun): Promise<LegacyProcessInput>;
  afterProcess?(run: LegacyAgentRun): void | Promise<void>;
  config: LegacyProcessConfig;
  processOptions?: LegacyProcessOptions;
}

export type PiExecuteTurnInput = Omit<PiGenerationDispatchInput, 'resumeToolResult'> & {
  resumeToolResult?: never;
};

export interface PiExecuteTurnCommand {
  engine: 'pi';
  selection: typeof PINNED_PI_AGENT_RUNTIME;
  input: PiExecuteTurnInput;
}

export interface LegacyResumeTurnCommand {
  engine: 'legacy';
  selection: typeof LEGACY_AGENT_RUNTIME;
  createRunOptions: Parameters<typeof createRun>[0];
  onRunCreated(run: LegacyAgentRun): void | Promise<void>;
  beforeResume(run: LegacyAgentRun): void | Promise<void>;
  afterResume?(run: LegacyAgentRun): void | Promise<void>;
  resumeValue: LegacyResumeValue;
  config: LegacyResumeConfig;
  resumeOptions?: LegacyResumeOptions;
  commandOptions?: LegacyCommandOptions;
}

export type PiResumeTurnInput = PiGenerationDispatchInput & {
  resumeToolResult: NonNullable<PiGenerationDispatchInput['resumeToolResult']>;
};

export interface PiResumeTurnCommand {
  engine: 'pi';
  selection: typeof PINNED_PI_AGENT_RUNTIME;
  input: PiResumeTurnInput;
}

export type AgentRuntimeTurnResult =
  | { engine: 'legacy'; run: LegacyAgentRun }
  | { engine: 'pi'; outcome: PiGenerationDispatchResult };

export interface AgentRuntimeDispatcherDependencies {
  createLegacyRun?: typeof createRun;
  executePiGeneration?: typeof executePiGeneration;
}

/**
 * The shared host boundary for actual engine execution. It owns no admission,
 * persistence, pause CAS, or terminal job state; host callbacks run at the exact
 * points where the created engine object becomes usable by AgentClient.
 */
export function createAgentRuntimeDispatcher(
  dependencies: AgentRuntimeDispatcherDependencies = {},
): {
  executeTurn(
    command: LegacyExecuteTurnCommand | PiExecuteTurnCommand,
  ): Promise<AgentRuntimeTurnResult>;
  resumeTurn(
    command: LegacyResumeTurnCommand | PiResumeTurnCommand,
  ): Promise<AgentRuntimeTurnResult>;
} {
  const createLegacyRun = dependencies.createLegacyRun ?? createRun;
  const executePi = dependencies.executePiGeneration ?? executePiGeneration;

  return {
    async executeTurn(command) {
      const resolution = resolveStoredAgentRuntime(command.selection);
      if (resolution.status !== 'resolved') {
        throw new AgentRuntimeUnavailableError();
      }
      if (
        resolution.selection.engine !== command.engine ||
        command.selection.engine !== command.engine
      ) {
        throw new AgentRuntimeUnavailableError();
      }
      if (command.engine === 'pi') {
        if (command.input.resumeToolResult != null) {
          throw new AgentRuntimeUnavailableError();
        }
        return {
          engine: 'pi',
          outcome: await executePi(command.input),
        };
      }
      if (command.engine === 'legacy') {
        const createRunPromise = createLegacyRun(command.createRunOptions).then((run) => {
          if (run == null) {
            throw new Error('Failed to create run');
          }
          command.onRunBuilt?.(run);
          return run;
        });
        const [createRunResult, checkpointPruneResult] = await Promise.allSettled([
          createRunPromise,
          command.checkpointPrunePromise,
        ]);
        if (createRunResult.status === 'rejected') {
          throw createRunResult.reason;
        }
        if (checkpointPruneResult.status === 'rejected') {
          throw checkpointPruneResult.reason;
        }

        const run = createRunResult.value;
        await command.onRunCreated(run);
        await command.beforeProcess(run);
        try {
          const input = await command.prepareProcessInput(run);
          await run.processStream(input, command.config, command.processOptions);
        } finally {
          await command.afterProcess?.(run);
        }
        return { engine: 'legacy', run };
      }
      throw new AgentRuntimeUnavailableError();
    },

    async resumeTurn(command) {
      const resolution = resolveStoredAgentRuntime(command.selection);
      if (resolution.status !== 'resolved') {
        throw new AgentRuntimeUnavailableError();
      }
      if (
        resolution.selection.engine !== command.engine ||
        command.selection.engine !== command.engine
      ) {
        throw new AgentRuntimeUnavailableError();
      }
      if (command.engine === 'pi') {
        if (command.input.resumeToolResult == null) {
          throw new AgentRuntimeUnavailableError();
        }
        return { engine: 'pi', outcome: await executePi(command.input) };
      }
      if (command.engine === 'legacy') {
        const run = await createLegacyRun(command.createRunOptions);
        if (run == null) {
          throw new Error('Failed to create run for resume');
        }
        await command.onRunCreated(run);
        await command.beforeResume(run);
        try {
          await run.resume(
            command.resumeValue,
            command.config,
            command.resumeOptions,
            command.commandOptions,
          );
        } finally {
          await command.afterResume?.(run);
        }
        return { engine: 'legacy', run };
      }
      throw new AgentRuntimeUnavailableError();
    },
  };
}
