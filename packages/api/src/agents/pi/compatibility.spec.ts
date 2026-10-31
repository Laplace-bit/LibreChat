import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { assertPiCompatible } from './compatibility';

describe('assertPiCompatible', () => {
  const supported = {
    rootAgentId: 'agent-root',
    loadedAgentIds: ['agent-root'],
    callableToolNames: [],
    supportedToolNames: [],
    unsupportedModes: [],
  } as const;

  it('allows one isolated agent with no callable tools or unsupported lifecycle modes', () => {
    expect(() => assertPiCompatible(supported)).not.toThrow();
  });

  it('allows only the host tools with a reviewed Pi adapter', () => {
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: ['file_search', 'calculator'],
        supportedToolNames: ['file_search', 'calculator'],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      ...supported,
      loadedAgentIds: ['agent-root', 'agent-child'],
    },
    {
      ...supported,
      callableToolNames: ['web_search'],
      supportedToolNames: ['web_search'],
    },
    {
      ...supported,
      callableToolNames: ['file_search'],
      supportedToolNames: [],
    },
    {
      ...supported,
      unsupportedModes: ['scheduled'] as const,
    },
    {
      ...supported,
      unsupportedModes: ['code_api_environment'] as const,
    },
  ])('fails closed for a capability outside the text-only Pi slice', (input) => {
    expect(() => assertPiCompatible(input)).toThrow(AgentRuntimeUnavailableError);
  });
});
