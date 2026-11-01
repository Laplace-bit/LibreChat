import {
  AgentRuntimeUnavailableError,
  PINNED_PI_AGENT_RUNTIME,
  assertAgentRuntimeCompatibleGraph,
  resolveResumableAgentRuntime,
  resolveStoredAgentRuntime,
  selectAgentRuntimeForAgent,
} from './selection';

describe('selectAgentRuntimeForAgent', () => {
  it('selects the pinned Pi SDK for every new Agent generation', () => {
    expect(selectAgentRuntimeForAgent()).toBe(PINNED_PI_AGENT_RUNTIME);
  });

  it('accepts only the exact root agent for a Pi generation', () => {
    expect(() =>
      assertAgentRuntimeCompatibleGraph({
        runtime: PINNED_PI_AGENT_RUNTIME,
        rootAgentId: 'agent-root',
        agentIds: ['agent-root'],
      }),
    ).not.toThrow();
    expect(() =>
      assertAgentRuntimeCompatibleGraph({
        runtime: PINNED_PI_AGENT_RUNTIME,
        rootAgentId: 'agent-root',
        agentIds: ['agent-root', 'connected-agent'],
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it('rejects absent, old and malformed identities instead of falling back', () => {
    for (const runtime of [
      undefined,
      { engine: 'legacy' },
      { engine: 'pi', sdkVersion: '99.0.0' },
      null,
    ]) {
      expect(() =>
        assertAgentRuntimeCompatibleGraph({
          runtime,
          rootAgentId: 'agent-root',
          agentIds: ['agent-root'],
        }),
      ).toThrow(AgentRuntimeUnavailableError);
    }
  });

  it('resumes only a Pi generation with a decoded durable continuation', () => {
    expect(resolveResumableAgentRuntime(PINNED_PI_AGENT_RUNTIME)).toEqual({
      status: 'unavailable',
    });
    expect(resolveResumableAgentRuntime(PINNED_PI_AGENT_RUNTIME, true)).toEqual({
      status: 'available',
      selection: PINNED_PI_AGENT_RUNTIME,
    });
    expect(resolveResumableAgentRuntime({ engine: 'legacy' }, true)).toEqual({
      status: 'unavailable',
    });
  });

  it('resolves Pi identities, leaves generic jobs unselected and rejects old or unknown versions', () => {
    expect(resolveStoredAgentRuntime(PINNED_PI_AGENT_RUNTIME)).toEqual({
      status: 'resolved',
      selection: PINNED_PI_AGENT_RUNTIME,
    });
    expect(resolveStoredAgentRuntime(undefined)).toEqual({ status: 'unselected' });
    expect(resolveStoredAgentRuntime({ engine: 'legacy' })).toEqual({ status: 'unsupported' });
    expect(resolveStoredAgentRuntime({ engine: 'pi', sdkVersion: '99.0.0' })).toEqual({
      status: 'unsupported',
    });
  });

  it('exposes a safe, stable unavailable-runtime error', () => {
    const error = new AgentRuntimeUnavailableError();
    expect(error).toMatchObject({
      name: 'AgentRuntimeUnavailableError',
      code: 'AGENT_RUNTIME_UNAVAILABLE',
      status: 503,
      statusCode: 503,
      message: 'The Pi agent runtime is not available on this server.',
    });
  });
});
