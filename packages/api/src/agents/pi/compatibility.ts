import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { PI_SUPPORTED_HOST_TOOLS } from './toolNames';
import { isPiMcpToolName } from './mcpSchema';

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

/** Pi Code API support is limited to an explicitly configured managed endpoint. */
export function isPiManagedCodeExecutionCompatible(
  agent: unknown,
  configuredBaseUrl: string | undefined = process.env.LIBRECHAT_CODE_BASEURL,
): boolean {
  if (agent == null || typeof agent !== 'object' || Array.isArray(agent)) {
    return false;
  }
  const candidate = agent as {
    codeEnvAvailable?: unknown;
    codeExecutionContext?: {
      baseUrl?: unknown;
      executionProfile?: unknown;
      statefulSessions?: unknown;
      codeWorkspace?: unknown;
      environmentId?: unknown;
      environmentType?: unknown;
    } | null;
    codeExecutionChoices?: unknown;
    statefulCodeSessions?: unknown;
  };
  const configured = configuredBaseUrl?.trim().replace(/\/+$/, '');
  const context = candidate.codeExecutionContext;
  return (
    candidate.codeEnvAvailable === true &&
    candidate.statefulCodeSessions !== true &&
    (candidate.codeExecutionChoices == null ||
      (Array.isArray(candidate.codeExecutionChoices) &&
        candidate.codeExecutionChoices.length === 0)) &&
    configured != null &&
    configured.length > 0 &&
    context != null &&
    context.executionProfile === 'default' &&
    context.statefulSessions === false &&
    context.codeWorkspace == null &&
    context.environmentId == null &&
    context.environmentType == null &&
    typeof context.baseUrl === 'string' &&
    context.baseUrl.trim().replace(/\/+$/, '') === configured
  );
}

/**
 * Pi supports only host tools with a reviewed adapter. Unknown and unimplemented
 * tool names remain rejected even if the caller mistakenly lists them as supported.
 */
export function assertPiCompatible(input: PiCompatibilityInput): void {
  const supportedNames = new Set(
    input.supportedToolNames.filter(
      (name) =>
        PI_SUPPORTED_HOST_TOOLS.some((supportedName) => supportedName === name) ||
        isPiMcpToolName(name),
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
