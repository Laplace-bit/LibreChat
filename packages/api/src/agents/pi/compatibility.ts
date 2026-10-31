import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { PI_SUPPORTED_HOST_TOOLS } from './toolNames';

export type PiUnsupportedTurnMode =
  | 'event_actor'
  | 'scheduled'
  | 'background'
  | 'compaction'
  | 'regenerate'
  | 'steer'
  | 'skills'
  | 'code_api_environment';

export interface PiCompatibilityInput {
  rootAgentId: unknown;
  loadedAgentIds: readonly unknown[];
  callableToolNames: readonly string[];
  supportedToolNames: readonly string[];
  unsupportedModes: readonly PiUnsupportedTurnMode[];
}

/**
 * Pi supports only host tools with a reviewed adapter. Unknown and unimplemented
 * tool names remain rejected even if the caller mistakenly lists them as supported.
 */
export function assertPiCompatible(input: PiCompatibilityInput): void {
  const supportedNames = new Set(
    input.supportedToolNames.filter((name) =>
      PI_SUPPORTED_HOST_TOOLS.some((supportedName) => supportedName === name),
    ),
  );
  if (
    typeof input.rootAgentId !== 'string' ||
    input.rootAgentId.length === 0 ||
    input.loadedAgentIds.length !== 1 ||
    input.loadedAgentIds[0] !== input.rootAgentId ||
    !input.callableToolNames.every((name) => supportedNames.has(name)) ||
    input.unsupportedModes.length > 0
  ) {
    throw new AgentRuntimeUnavailableError();
  }
}
