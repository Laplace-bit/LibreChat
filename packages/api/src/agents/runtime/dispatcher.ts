import type { PiGenerationDispatchInput, PiGenerationDispatchResult } from '../pi/dispatch';
import {
  AgentRuntimeUnavailableError,
  PINNED_PI_AGENT_RUNTIME,
  resolveStoredAgentRuntime,
} from './selection';
import { executePiGeneration } from '../pi/dispatch';

export type PiExecuteTurnInput = Omit<PiGenerationDispatchInput, 'resumeToolResult'> & {
  resumeToolResult?: never;
};

export interface PiExecuteTurnCommand {
  engine: 'pi';
  selection: typeof PINNED_PI_AGENT_RUNTIME;
  input: PiExecuteTurnInput;
}

export type PiResumeTurnInput = PiGenerationDispatchInput & {
  resumeToolResult: NonNullable<PiGenerationDispatchInput['resumeToolResult']>;
};

export interface PiResumeTurnCommand {
  engine: 'pi';
  selection: typeof PINNED_PI_AGENT_RUNTIME;
  input: PiResumeTurnInput;
}

export interface AgentRuntimeDispatcherDependencies {
  executePiGeneration?: typeof executePiGeneration;
}

/**
 * The Agent execution boundary is Pi-only. Admission, persistence, approvals,
 * cancellation and terminal state remain owned by the host job lifecycle.
 */
export function createAgentRuntimeDispatcher(
  dependencies: AgentRuntimeDispatcherDependencies = {},
): {
  executeTurn(command: PiExecuteTurnCommand): Promise<PiGenerationDispatchResult>;
  resumeTurn(command: PiResumeTurnCommand): Promise<PiGenerationDispatchResult>;
} {
  const executePi = dependencies.executePiGeneration ?? executePiGeneration;

  const assertPiSelection = (selection: unknown, engine: unknown): void => {
    const resolution = resolveStoredAgentRuntime(selection);
    if (resolution.status !== 'resolved' || engine !== 'pi') {
      throw new AgentRuntimeUnavailableError();
    }
  };

  return {
    async executeTurn(command) {
      assertPiSelection(command.selection, command.engine);
      if (command.input.resumeToolResult != null) {
        throw new AgentRuntimeUnavailableError();
      }
      return executePi(command.input);
    },

    async resumeTurn(command) {
      assertPiSelection(command.selection, command.engine);
      if (command.input.resumeToolResult == null) {
        throw new AgentRuntimeUnavailableError();
      }
      return executePi(command.input);
    },
  };
}
