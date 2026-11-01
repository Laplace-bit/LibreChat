import { ErrorTypes } from 'librechat-data-provider';
export const PINNED_PI_AGENT_RUNTIME: Readonly<{ engine: 'pi'; sdkVersion: '1.4.0' }> =
  Object.freeze({ engine: 'pi', sdkVersion: '1.4.0' });

export type AgentRuntimeSelection = typeof PINNED_PI_AGENT_RUNTIME;

export type StoredAgentRuntimeResolution =
  | { status: 'resolved'; selection: typeof PINNED_PI_AGENT_RUNTIME }
  | { status: 'unselected' }
  | { status: 'unsupported' };

export type ResumableAgentRuntimeResolution =
  | {
      status: 'available';
      selection: typeof PINNED_PI_AGENT_RUNTIME;
    }
  | { status: 'unavailable' };

/** Every new Agent generation uses the pinned Pi engine. */
export function selectAgentRuntimeForAgent(): typeof PINNED_PI_AGENT_RUNTIME {
  return PINNED_PI_AGENT_RUNTIME;
}

/** Typed boundary error for an unsupported or unavailable Pi runtime path. */
export class AgentRuntimeUnavailableError extends Error {
  readonly code: ErrorTypes.AGENT_RUNTIME_UNAVAILABLE = ErrorTypes.AGENT_RUNTIME_UNAVAILABLE;
  readonly status = 503;
  readonly statusCode = 503;

  constructor() {
    super('The Pi agent runtime is not available on this server.');
    this.name = 'AgentRuntimeUnavailableError';
  }
}

/** Pi currently accepts one exact root agent; mixed and connected-agent graphs fail closed. */
export function assertAgentRuntimeCompatibleGraph(input: {
  runtime: unknown;
  rootAgentId: unknown;
  agentIds: readonly unknown[];
}): void {
  const resolution = resolveStoredAgentRuntime(input.runtime);
  if (resolution.status !== 'resolved') {
    throw new AgentRuntimeUnavailableError();
  }

  if (
    typeof input.rootAgentId !== 'string' ||
    input.rootAgentId.length === 0 ||
    input.agentIds.length !== 1 ||
    input.agentIds[0] !== input.rootAgentId
  ) {
    throw new AgentRuntimeUnavailableError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime identity is set only while creating a generation and is immutable afterward. */
export function assertRuntimeIdentityImmutable(value: unknown, clear?: readonly string[]): void {
  if (
    (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'agentRuntime')) ||
    clear?.includes('agentRuntime')
  ) {
    throw new Error('Generation runtime identity is immutable');
  }
}

/** Prevent callers from mutating a runtime identity through the job facade. */
export function freezeStoredAgentRuntimeIdentity(value: unknown): unknown {
  return isRecord(value) ? Object.freeze({ ...value }) : value;
}

/**
 * Resolve the immutable runtime identity persisted on a generation job.
 * Generic host jobs have no Agent runtime identity. Only pinned Pi is valid for
 * Agent execution; an old engine identity is unsupported.
 */
export function resolveStoredAgentRuntime(value: unknown): StoredAgentRuntimeResolution {
  if (value === undefined) {
    return { status: 'unselected' };
  }
  if (!isRecord(value)) {
    return { status: 'unsupported' };
  }
  const keys = Object.keys(value);
  if (
    value.engine === 'pi' &&
    value.sdkVersion === PINNED_PI_AGENT_RUNTIME.sdkVersion &&
    keys.length === 2 &&
    keys.includes('engine') &&
    keys.includes('sdkVersion')
  ) {
    return { status: 'resolved', selection: PINNED_PI_AGENT_RUNTIME };
  }
  return { status: 'unsupported' };
}

/** Pi resume is available only when the caller has decoded its durable host continuation. */
export function resolveResumableAgentRuntime(
  value: unknown,
  hasValidatedPiContinuation = false,
): ResumableAgentRuntimeResolution {
  const resolution = resolveStoredAgentRuntime(value);
  if (resolution.status === 'resolved' && hasValidatedPiContinuation) {
    return { status: 'available', selection: PINNED_PI_AGENT_RUNTIME };
  }
  return { status: 'unavailable' };
}
