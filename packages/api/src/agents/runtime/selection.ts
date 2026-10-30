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
