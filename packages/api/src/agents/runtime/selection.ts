import type { TAgentRuntimeRollout } from 'librechat-data-provider';

export const LEGACY_AGENT_RUNTIME: Readonly<{ engine: 'legacy' }> = Object.freeze({
  engine: 'legacy',
});
export const PINNED_PI_AGENT_RUNTIME: Readonly<{ engine: 'pi'; sdkVersion: '1.4.0' }> =
  Object.freeze({ engine: 'pi', sdkVersion: '1.4.0' });

export type AgentRuntimeSelection = typeof LEGACY_AGENT_RUNTIME | typeof PINNED_PI_AGENT_RUNTIME;

export type StoredAgentRuntimeResolution =
  | { status: 'resolved'; selection: AgentRuntimeSelection }
  | { status: 'unsupported' };

export type ResumableAgentRuntimeResolution =
  | { status: 'available'; selection: typeof LEGACY_AGENT_RUNTIME }
  | { status: 'unavailable' };

/** Selects a canary only from the server-owned allowlist and an admitted agent identifier. */
export function selectAgentRuntimeForAgent(input: {
  agentId: unknown;
  rollout?: TAgentRuntimeRollout;
}): AgentRuntimeSelection {
  if (
    typeof input.agentId === 'string' &&
    input.agentId.length > 0 &&
    input.rollout?.piAgentIds.includes(input.agentId)
  ) {
    return PINNED_PI_AGENT_RUNTIME;
  }
  return LEGACY_AGENT_RUNTIME;
}

/** Finds any allowlisted Pi agent in a graph that would otherwise run Legacy. */
export function findPiAgentInRuntimeGraph(input: {
  agentIds: readonly unknown[];
  rollout?: TAgentRuntimeRollout;
}): string | undefined {
  const allowlistedAgentIds = new Set(input.rollout?.piAgentIds ?? []);
  return input.agentIds.find(
    (agentId): agentId is string =>
      typeof agentId === 'string' && agentId.length > 0 && allowlistedAgentIds.has(agentId),
  );
}

/** Typed boundary error used while the Pi execution dispatcher is not yet available. */
export class AgentRuntimeUnavailableError extends Error {
  readonly code = 'AGENT_RUNTIME_UNAVAILABLE';
  readonly status = 503;
  readonly statusCode = 503;

  constructor() {
    super('The selected agent runtime is not available on this server.');
    this.name = 'AgentRuntimeUnavailableError';
  }
}

/** Stop legacy dispatch if a connected agent is independently pinned to Pi. */
export function assertLegacyRuntimeCompatibleGraph(input: {
  agentIds: readonly unknown[];
  rollout?: TAgentRuntimeRollout;
}): void {
  if (findPiAgentInRuntimeGraph(input) !== undefined) {
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
 * Missing metadata predates engine pinning and always means the legacy engine.
 */
export function resolveStoredAgentRuntime(value: unknown): StoredAgentRuntimeResolution {
  if (value === undefined) {
    return { status: 'resolved', selection: LEGACY_AGENT_RUNTIME };
  }
  if (!isRecord(value)) {
    return { status: 'unsupported' };
  }
  const keys = Object.keys(value);
  if (value.engine === 'legacy' && keys.length === 1 && keys[0] === 'engine') {
    return { status: 'resolved', selection: LEGACY_AGENT_RUNTIME };
  }
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

/** Pi has no durable host approval-resume adapter yet; only legacy jobs can resume. */
export function resolveResumableAgentRuntime(value: unknown): ResumableAgentRuntimeResolution {
  const resolution = resolveStoredAgentRuntime(value);
  if (resolution.status === 'resolved' && resolution.selection.engine === 'legacy') {
    return { status: 'available', selection: LEGACY_AGENT_RUNTIME };
  }
  return { status: 'unavailable' };
}
