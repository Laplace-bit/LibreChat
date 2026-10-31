import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { assertPiCompatible } from './compatibility';

describe('assertPiCompatible', () => {
  const supported = {
    rootAgentId: 'agent-root',
    loadedAgentIds: ['agent-root'],
    callableToolNames: [],
    supportedToolNames: [],
    toolApprovalCanPause: false,
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

  it('rejects callable tools when host approval could require durable resume', () => {
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: ['file_search'],
        supportedToolNames: ['file_search'],
        toolApprovalCanPause: true,
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it('does not block a tool-free turn when host approval could require durable resume', () => {
    expect(() => assertPiCompatible({ ...supported, toolApprovalCanPause: true })).not.toThrow();
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
  ])('fails closed for a capability outside the text-only Pi slice', (input) => {
    expect(() => assertPiCompatible(input)).toThrow(AgentRuntimeUnavailableError);
  });
});
