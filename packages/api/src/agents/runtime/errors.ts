import { ErrorTypes } from 'librechat-data-provider';

/** Converts a known runtime-boundary failure to localized client error content. */
export function getAgentRuntimeUserFacingError(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== ErrorTypes.AGENT_RUNTIME_UNAVAILABLE
  ) {
    return undefined;
  }

  return JSON.stringify({ type: ErrorTypes.AGENT_RUNTIME_UNAVAILABLE });
}
