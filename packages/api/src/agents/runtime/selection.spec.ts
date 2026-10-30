import { agentRuntimeRolloutSchema } from 'librechat-data-provider';
import {
  AgentRuntimeUnavailableError,
  LEGACY_AGENT_RUNTIME,
  PINNED_PI_AGENT_RUNTIME,
  assertLegacyRuntimeCompatibleGraph,
  findPiAgentInRuntimeGraph,
  selectAgentRuntimeForAgent,
} from './selection';

describe('selectAgentRuntimeForAgent', () => {
  const rollout = agentRuntimeRolloutSchema.parse({ piAgentIds: ['agent-canary'] });

  it('keeps the legacy engine when the rollout config is absent or the agent is not listed', () => {
    expect(selectAgentRuntimeForAgent({ agentId: 'agent-canary' })).toBe(LEGACY_AGENT_RUNTIME);
    expect(selectAgentRuntimeForAgent({ agentId: 'agent-other', rollout })).toBe(
      LEGACY_AGENT_RUNTIME,
    );
    expect(selectAgentRuntimeForAgent({ agentId: undefined, rollout })).toBe(LEGACY_AGENT_RUNTIME);
  });

  it('selects the pinned Pi SDK only for an exact server allowlist match', () => {
    expect(selectAgentRuntimeForAgent({ agentId: 'agent-canary', rollout })).toBe(
      PINNED_PI_AGENT_RUNTIME,
    );
    expect(selectAgentRuntimeForAgent({ agentId: ' agent-canary ', rollout })).toBe(
      LEGACY_AGENT_RUNTIME,
    );
    expect(selectAgentRuntimeForAgent({ agentId: { id: 'agent-canary' }, rollout })).toBe(
      LEGACY_AGENT_RUNTIME,
    );
  });

  it('finds an allowlisted Pi agent anywhere in a legacy graph', () => {
    expect(
      findPiAgentInRuntimeGraph({
        agentIds: ['agent-root', undefined, 'agent-canary'],
        rollout,
      }),
    ).toBe('agent-canary');
    expect(
      findPiAgentInRuntimeGraph({ agentIds: ['agent-root', { id: 'agent-canary' }], rollout }),
    ).toBeUndefined();
  });

  it('rejects a legacy graph that contains any allowlisted Pi agent', () => {
    expect(() =>
      assertLegacyRuntimeCompatibleGraph({ agentIds: ['agent-root', 'agent-canary'], rollout }),
    ).toThrow(AgentRuntimeUnavailableError);
    expect(() =>
      assertLegacyRuntimeCompatibleGraph({ agentIds: ['agent-root'], rollout }),
    ).not.toThrow();
  });

  it('exposes a safe, stable unavailable-runtime error until dispatch is implemented', () => {
    const error = new AgentRuntimeUnavailableError();
    expect(error).toMatchObject({
      name: 'AgentRuntimeUnavailableError',
      code: 'AGENT_RUNTIME_UNAVAILABLE',
      status: 503,
      statusCode: 503,
      message: 'The selected agent runtime is not available on this server.',
    });
  });
});
