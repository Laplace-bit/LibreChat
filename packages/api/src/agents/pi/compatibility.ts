import { AgentRuntimeUnavailableError } from '../runtime/selection';

export type PiUnsupportedTurnMode =
  | 'event_actor'
  | 'scheduled'
  | 'background'
  | 'compaction'
  | 'regenerate'
  | 'steer'
  | 'skills';

export const PI_SUPPORTED_HOST_TOOLS = ['file_search'] as const;
export type PiSupportedHostTool = (typeof PI_SUPPORTED_HOST_TOOLS)[number];

export interface PiCompatibilityInput {
  rootAgentId: unknown;
  loadedAgentIds: readonly unknown[];
  callableToolNames: readonly string[];
  supportedToolNames: readonly string[];
  /** Pi cannot yet execute LibreChat's PreToolUse approval hooks or durable resume flow. */
  toolApprovalRequired: boolean;
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
    (input.toolApprovalRequired === true && input.callableToolNames.length > 0) ||
    input.unsupportedModes.length > 0
  ) {
    throw new AgentRuntimeUnavailableError();
  }
}
