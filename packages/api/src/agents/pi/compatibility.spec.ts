import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { assertPiTextOnlyCompatible } from './compatibility';

describe('assertPiTextOnlyCompatible', () => {
  const supported = {
    rootAgentId: 'agent-root',
    loadedAgentIds: ['agent-root'],
    callableToolNames: [],
    unsupportedModes: [],
  } as const;

  it('allows one isolated agent with no callable tools or unsupported lifecycle modes', () => {
    expect(() => assertPiTextOnlyCompatible(supported)).not.toThrow();
  });

  it.each([
    {
      ...supported,
      loadedAgentIds: ['agent-root', 'agent-child'],
    },
    {
      ...supported,
      callableToolNames: ['search_knowledge'],
    },
    {
      ...supported,
      unsupportedModes: ['scheduled'] as const,
    },
  ])('fails closed for a capability outside the text-only Pi slice', (input) => {
    expect(() => assertPiTextOnlyCompatible(input)).toThrow(AgentRuntimeUnavailableError);
  });
});
