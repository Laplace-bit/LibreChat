import {
  createAgentRuntimeExecutionProgress,
  markAgentRuntimeExecutionStarted,
  settleAgentRuntimeExecution,
} from './execution';
import { LEGACY_AGENT_RUNTIME, PINNED_PI_AGENT_RUNTIME } from './selection';

describe('agent runtime execution progress', () => {
  it.each([LEGACY_AGENT_RUNTIME, PINNED_PI_AGENT_RUNTIME])(
    'tracks started and settled progress for the $engine engine',
    (selection) => {
      const initial = createAgentRuntimeExecutionProgress(selection);
      expect(initial).toEqual({ selection, started: false });

      const started = markAgentRuntimeExecutionStarted(initial);
      expect(started).toEqual({ selection, started: true });
      expect(markAgentRuntimeExecutionStarted(started)).toBe(started);

      expect(settleAgentRuntimeExecution(started, 'paused')).toEqual({
        selection,
        started: true,
        status: 'paused',
      });
    },
  );

  it('does not settle an engine that never created its run or session', () => {
    const initial = createAgentRuntimeExecutionProgress(PINNED_PI_AGENT_RUNTIME);
    expect(settleAgentRuntimeExecution(initial, 'failed')).toBe(initial);
  });

  it('does not rewrite an already settled engine outcome', () => {
    const started = markAgentRuntimeExecutionStarted(
      createAgentRuntimeExecutionProgress(LEGACY_AGENT_RUNTIME),
    );
    const completed = settleAgentRuntimeExecution(started, 'completed');

    expect(settleAgentRuntimeExecution(completed, 'failed')).toBe(completed);
  });
});
