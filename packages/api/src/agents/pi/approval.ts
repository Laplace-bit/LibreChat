import { HookRegistry, executeHooks } from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { ExecuteHooksOptions } from '@librechat/agents';
import type { ResolvedToolApprovalHook, ToolApprovalHookContext } from '~/agents/hitl/hooks';
import type { PiToolExecutionContext, PiToolExecutionGate } from './toolExecution';
import type { PluginHookSource } from '~/agents/hooks/source';
import { buildEffectiveToolApprovalPolicy } from '~/agents/hitl/allow';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { buildHITLRunWiring } from '~/agents/hitl/runtime';
import { validatePiToolExecutionInput } from './tools';

export interface PiToolApprovalGateOptions {
  policy?: TToolApprovalPolicy;
  allowedTools?: readonly string[];
  logger?: NonNullable<ExecuteHooksOptions['logger']>;
  pluginHookSource?: PluginHookSource;
  resolvedHooks?: readonly ResolvedToolApprovalHook[];
  hookContext: ToolApprovalHookContext;
  runId: string;
  threadId: string;
  agentId: string;
  model?: string;
}

/**
 * Evaluates the same host PreToolUse policy before Pi reaches ON_TOOL_EXECUTE.
 * Pi currently cannot persist an interactive approval pause, so an unexpected
 * `ask` decision pauses and fails closed at the owning generation boundary.
 */
export function createPiToolApprovalGate(options: PiToolApprovalGateOptions): PiToolExecutionGate {
  const policy = buildEffectiveToolApprovalPolicy(options.policy, [], options.allowedTools);
  const wiring = buildHITLRunWiring(policy, options.hookContext, [], options.resolvedHooks ?? []);
  const pluginHookSource = options.pluginHookSource;
  const registry =
    wiring?.hooks ?? (pluginHookSource?.hasHooks() === true ? new HookRegistry() : undefined);

  if (registry == null) {
    return async () => ({ kind: 'execute' });
  }

  if (pluginHookSource?.hasHooks() === true) {
    try {
      pluginHookSource.register({
        registry,
        context: {
          sessionId: options.threadId,
          userId: options.hookContext.userId,
          model: options.model,
          agentType: options.agentId,
        },
        askDecisionSupported: false,
      });
    } catch {
      throw new AgentRuntimeUnavailableError();
    }
  }

  return async (input: PiToolExecutionContext, signal?: AbortSignal) => {
    let result;
    try {
      result = await executeHooks({
        registry,
        input: {
          hook_event_name: 'PreToolUse',
          runId: options.runId,
          threadId: options.threadId,
          agentId: options.agentId,
          executingAgentId: options.agentId,
          toolName: input.name,
          toolInput: { ...input.args },
          toolUseId: input.toolCallId,
          stepId: input.toolCallId,
          turn: input.turn,
        },
        sessionId: options.runId,
        matchQuery: input.name,
        signal,
        ...(options.logger == null ? {} : { logger: options.logger }),
      });
    } catch {
      throw new AgentRuntimeUnavailableError();
    }

    if (result.hasHookFailures === true) {
      throw new AgentRuntimeUnavailableError();
    }

    switch (result.decision) {
      case 'allow': {
        if (result.updatedInput === undefined) {
          return { kind: 'execute' };
        }
        try {
          const validated = validatePiToolExecutionInput(
            input.name,
            input.toolCallId,
            result.updatedInput,
          );
          return {
            kind: 'execute',
            args: validated.args,
          };
        } catch {
          throw new AgentRuntimeUnavailableError();
        }
      }
      case 'deny':
        return { kind: 'deny' };
      case 'ask':
      case undefined:
        return { kind: 'pause' };
      default: {
        const exhaustive: never = result.decision;
        throw exhaustive;
      }
    }
  };
}
