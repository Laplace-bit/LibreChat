import type { AgentRuntimeSelection } from './selection';

export type AgentRuntimeExecutionStatus = 'completed' | 'paused' | 'cancelled' | 'failed';

/**
 * Host-owned progress for one selected engine. `started` records a host-observed
 * milestone: Legacy has a created AgentRun, or Pi has a created host session. It is
 * monotonic for this client and remains true if later execution or pause persistence fails.
 */
export interface AgentRuntimeExecutionProgress {
  readonly selection: AgentRuntimeSelection;
  readonly started: boolean;
  readonly status?: AgentRuntimeExecutionStatus;
}

export function createAgentRuntimeExecutionProgress(
  selection: AgentRuntimeSelection,
): AgentRuntimeExecutionProgress {
  return Object.freeze({ selection, started: false });
}

export function markAgentRuntimeExecutionStarted(
  progress: AgentRuntimeExecutionProgress | undefined,
): AgentRuntimeExecutionProgress | undefined {
  if (progress == null) {
    return progress;
  }
  if (progress.started) {
    return progress;
  }
  return Object.freeze({ selection: progress.selection, started: true });
}

export function settleAgentRuntimeExecution(
  progress: AgentRuntimeExecutionProgress | undefined,
  status: AgentRuntimeExecutionStatus,
): AgentRuntimeExecutionProgress | undefined {
  if (progress == null || !progress.started || progress.status != null) {
    return progress;
  }
  return Object.freeze({ ...progress, status });
}
