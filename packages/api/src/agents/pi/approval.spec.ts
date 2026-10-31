import { Tools } from 'librechat-data-provider';
import type { ResolvedToolApprovalHook } from '~/agents/hitl/hooks';
import type { PluginHookSource } from '~/agents/hooks/source';
import { registerToolApprovalHook, buildToolApprovalHooks } from '~/agents/hitl/hooks';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { setPluginHookSource } from '~/agents/hooks/source';
import { PI_CALCULATOR_TOOL_NAME } from './toolNames';
import { createPiToolApprovalGate } from './approval';

const baseOptions = {
  hookContext: { userId: 'user-1', conversationId: 'thread-1', tenantId: 'tenant-1' },
  runId: 'run-1',
  threadId: 'thread-1',
  agentId: 'agent-1',
  model: 'gpt-4o',
} as const;

function toolInput() {
  return {
    toolCallId: 'pi-call-1',
    name: Tools.file_search,
    args: { query: 'maintenance manual' },
    turn: 0,
  } as const;
}

function calculatorInput() {
  return {
    toolCallId: 'pi-calculator-call-1',
    name: PI_CALCULATOR_TOOL_NAME,
    args: { input: '2 + 2' },
    turn: 0,
  } as const;
}

describe('Pi PreToolUse gate', () => {
  beforeEach(() => {
    setPluginHookSource(undefined);
  });

  afterEach(() => {
    setPluginHookSource(undefined);
  });

  it('allows calls when no approval policy or PreToolUse hook is active', async () => {
    const gate = createPiToolApprovalGate(baseOptions);

    await expect(gate(toolInput())).resolves.toEqual({ kind: 'execute' });
  });

  it('applies static allow rules before the host execution handler', async () => {
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'dontAsk', allow: [Tools.file_search] },
    });

    await expect(gate(toolInput())).resolves.toEqual({ kind: 'execute' });
  });

  it('applies the same static host policy to calculator calls', async () => {
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'dontAsk', allow: [PI_CALCULATOR_TOOL_NAME] },
    });

    await expect(gate(calculatorInput())).resolves.toEqual({ kind: 'execute' });
  });

  it('keeps static deny ahead of allow and bypass rules', async () => {
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      policy: {
        enabled: true,
        mode: 'bypass',
        allow: [Tools.file_search],
        deny: [Tools.file_search],
      },
    });

    await expect(gate(toolInput())).resolves.toEqual({ kind: 'deny' });
  });

  it('marks an ask decision for the fail-closed pause path', async () => {
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'bypass', ask: [Tools.file_search] },
    });

    await expect(gate(toolInput())).resolves.toEqual({ kind: 'pause' });
  });

  it('registers the injected deployment hook source into the host policy registry', async () => {
    const hook = jest.fn(async () => ({ decision: 'deny' as const }));
    const pluginHookSource: PluginHookSource = {
      hasHooks: () => true,
      register: ({ registry, askDecisionSupported }) => {
        expect(askDecisionSupported).toBe(false);
        registry.register('PreToolUse', { hooks: [hook] });
        return 1;
      },
    };
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      pluginHookSource,
    });

    await expect(gate(toolInput())).resolves.toEqual({ kind: 'deny' });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('applies a PreToolUse updatedInput only after revalidating the host schema', async () => {
    const hook = jest.fn(async () => ({
      decision: 'allow' as const,
      updatedInput: { query: 'sanitized maintenance manual' },
    }));
    const unregister = registerToolApprovalHook(() => hook);
    const resolvedHooks: ResolvedToolApprovalHook[] = buildToolApprovalHooks(
      baseOptions.hookContext,
    );
    const gate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'bypass' },
      resolvedHooks,
    });

    try {
      await expect(gate(toolInput())).resolves.toEqual({
        kind: 'execute',
        args: { query: 'sanitized maintenance manual' },
      });
    } finally {
      unregister();
    }

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: Tools.file_search,
        toolInput: { query: 'maintenance manual' },
        toolUseId: 'pi-call-1',
        turn: 0,
      }),
      expect.any(AbortSignal),
    );
  });

  it('fails closed when a PreToolUse hook fails or returns an invalid rewrite', async () => {
    const failingHook = jest.fn(async () => {
      throw new Error('private hook diagnostic');
    });
    const unregisterFailure = registerToolApprovalHook(() => failingHook);
    const failingGate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'bypass' },
      resolvedHooks: buildToolApprovalHooks(baseOptions.hookContext),
    });

    try {
      await expect(failingGate(toolInput())).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    } finally {
      unregisterFailure();
    }

    const invalidHook = jest.fn(async () => ({
      decision: 'allow' as const,
      updatedInput: { query: 'rewritten', unexpected: true },
    }));
    const unregisterInvalid = registerToolApprovalHook(() => invalidHook);
    const invalidGate = createPiToolApprovalGate({
      ...baseOptions,
      policy: { enabled: true, mode: 'bypass' },
      resolvedHooks: buildToolApprovalHooks(baseOptions.hookContext),
    });

    try {
      await expect(invalidGate(toolInput())).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    } finally {
      unregisterInvalid();
    }
  });
});
