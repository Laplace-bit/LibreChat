import { actionDelimiter, Constants } from 'librechat-data-provider';
import {
  assertPiCompatible,
  isPiManagedCodeExecutionCompatible,
  isPiOrdinaryTriggerCandidate,
} from './compatibility';
import { PI_SUBAGENT_TOOL_NAME, PI_SUPPORTED_HOST_TOOLS } from './toolNames';
import { AgentRuntimeUnavailableError } from '../runtime/selection';

describe('isPiOrdinaryTriggerCandidate', () => {
  it('admits only authenticated triggers without Event Actor state', () => {
    const ordinary = { authenticatedTrigger: true };
    expect(isPiOrdinaryTriggerCandidate(ordinary)).toBe(true);
    expect(isPiOrdinaryTriggerCandidate({ authenticatedTrigger: false })).toBe(false);
    for (const actorField of [
      'bindingId',
      'parentConversationId',
      'parentAgentId',
      'conversationBinding',
      'rawEventDelivery',
    ]) {
      expect(isPiOrdinaryTriggerCandidate({ ...ordinary, [actorField]: {} })).toBe(false);
    }
  });
});

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
        callableToolNames: PI_SUPPORTED_HOST_TOOLS.filter((name) => name !== PI_SUBAGENT_TOOL_NAME),
        supportedToolNames: PI_SUPPORTED_HOST_TOOLS.filter(
          (name) => name !== PI_SUBAGENT_TOOL_NAME,
        ),
      }),
    ).not.toThrow();
  });

  it('allows the generated subagent capability only when the caller has a validated plan', () => {
    const subagent = {
      ...supported,
      callableToolNames: [PI_SUBAGENT_TOOL_NAME],
      supportedToolNames: [PI_SUBAGENT_TOOL_NAME],
    };
    expect(() => assertPiCompatible(subagent)).toThrow(AgentRuntimeUnavailableError);
    expect(() => assertPiCompatible({ ...subagent, allowPiSubagent: true })).not.toThrow();
    expect(() =>
      assertPiCompatible({
        ...subagent,
        supportedToolNames: ['invented_tool'],
        allowPiSubagent: true,
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it('does not admit background task tools into the Pi callable set', () => {
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: ['check_background_task', 'run_in_background'],
        supportedToolNames: ['check_background_task', 'run_in_background'],
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it('allows only server-loaded MCP names present in the authorized tool-definition set', () => {
    const toolName = `lookup${Constants.mcp_delimiter}inventory`;
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: [toolName],
        supportedToolNames: [toolName],
      }),
    ).not.toThrow();
  });

  it('allows only Action names present in the current authorized definition set', () => {
    const toolName = `get_inventory${actionDelimiter}api---example---com`;
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: [toolName],
        supportedToolNames: [toolName],
      }),
    ).not.toThrow();
    expect(() =>
      assertPiCompatible({
        ...supported,
        callableToolNames: [toolName],
        supportedToolNames: [],
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it('permits only an explicitly configured managed Code API context for Pi code tools', () => {
    const agent = {
      codeEnvAvailable: true,
      statefulCodeSessions: false,
      codeExecutionContext: {
        baseUrl: 'https://code.example/v1',
        codeSessionKey: 'execute_code',
        executionProfile: 'default',
        statefulSessions: false,
      },
    };

    expect(isPiManagedCodeExecutionCompatible(agent, 'https://code.example/v1/')).toBe(true);
    expect(isPiManagedCodeExecutionCompatible(agent, undefined)).toBe(false);
    expect(
      isPiManagedCodeExecutionCompatible(
        {
          ...agent,
          codeExecutionContext: { ...agent.codeExecutionContext, statefulSessions: true },
        },
        'https://code.example/v1',
      ),
    ).toBe(false);
  });

  it.each([
    {
      ...supported,
      loadedAgentIds: ['agent-root', 'agent-child'],
    },
    {
      ...supported,
      callableToolNames: ['invented_tool'],
      supportedToolNames: ['invented_tool'],
    },
    {
      ...supported,
      callableToolNames: ['file_search'],
      supportedToolNames: [],
    },
    {
      ...supported,
      unsupportedModes: ['code_api_environment'] as const,
    },
  ])('fails closed for a capability outside the text-only Pi slice', (input) => {
    expect(() => assertPiCompatible(input)).toThrow(AgentRuntimeUnavailableError);
  });
});
