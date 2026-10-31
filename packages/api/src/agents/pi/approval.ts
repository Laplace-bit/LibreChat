import { HookRegistry, executeHooks } from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { ExecuteHooksOptions } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { ResolvedToolApprovalHook, ToolApprovalHookContext } from '~/agents/hitl/hooks';
import type { PiToolExecutionContext, PiToolExecutionGate } from './toolExecution';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { PiMcpToolSchemaRegistry } from './mcpSchema';
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
  mcpToolSchemas?: PiMcpToolSchemaRegistry;
}

const DEFAULT_ALLOWED_DECISIONS: readonly Agents.ToolApprovalDecisionType[] = [
  'approve',
  'reject',
  'edit',
  'respond',
];

const SUPPORTED_DECISIONS = new Set<Agents.ToolApprovalDecisionType>(DEFAULT_ALLOWED_DECISIONS);

/**
 * Evaluates the same host PreToolUse policy before Pi reaches ON_TOOL_EXECUTE.
 * Interactive `ask` decisions enter the host's durable approval lifecycle.
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
        askDecisionSupported: true,
      });
    } catch {
      throw new AgentRuntimeUnavailableError();
    }
  }

  return async (input: PiToolExecutionContext, signal?: AbortSignal) => {
    const validationContext = {
      ...(options.mcpToolSchemas == null ? {} : { mcpToolSchemas: options.mcpToolSchemas }),
      ...('kind' in input && input.kind === 'mcp'
        ? { expectedSchemaFingerprint: input.schemaFingerprint }
        : {}),
    };
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
            validationContext,
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
      case 'ask': {
        let args = input.args;
        if (result.updatedInput !== undefined) {
          try {
            args = validatePiToolExecutionInput(
              input.name,
              input.toolCallId,
              result.updatedInput,
              validationContext,
            ).args;
          } catch {
            throw new AgentRuntimeUnavailableError();
          }
        }
        const allowedDecisions = result.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
        if (
          allowedDecisions.length === 0 ||
          allowedDecisions.some((decision) => !SUPPORTED_DECISIONS.has(decision)) ||
          new Set(allowedDecisions).size !== allowedDecisions.length ||
          (result.reason !== undefined &&
            (result.reason.trim().length === 0 || result.reason.length > 1_000))
        ) {
          throw new AgentRuntimeUnavailableError();
        }
        return {
          kind: 'pause',
          args,
          allowedDecisions,
          ...(result.reason == null ? {} : { description: result.reason }),
        };
      }
      case undefined:
        return {
          kind: 'pause',
          allowedDecisions: DEFAULT_ALLOWED_DECISIONS,
        };
      default: {
        const exhaustive: never = result.decision;
        throw exhaustive;
      }
    }
  };
}
