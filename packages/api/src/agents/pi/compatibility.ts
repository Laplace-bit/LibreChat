import { AgentRuntimeUnavailableError } from '../runtime/selection';

export type PiUnsupportedTurnMode =
  | 'event_actor'
  | 'scheduled'
  | 'background'
  | 'compaction'
  | 'regenerate'
  | 'steer'
  | 'skills';

export interface PiTextOnlyCompatibilityInput {
  rootAgentId: unknown;
  loadedAgentIds: readonly unknown[];
  callableToolNames: readonly string[];
  unsupportedModes: readonly PiUnsupportedTurnMode[];
}

/**
 * The first dispatched Pi slice is one root agent producing text/reasoning only.
 * Every other capability remains rejected until its host adapter is complete.
 */
export function assertPiTextOnlyCompatible(input: PiTextOnlyCompatibilityInput): void {
  if (
    typeof input.rootAgentId !== 'string' ||
    input.rootAgentId.length === 0 ||
    input.loadedAgentIds.length !== 1 ||
    input.loadedAgentIds[0] !== input.rootAgentId ||
    input.callableToolNames.length > 0 ||
    input.unsupportedModes.length > 0
  ) {
    throw new AgentRuntimeUnavailableError();
  }
}
