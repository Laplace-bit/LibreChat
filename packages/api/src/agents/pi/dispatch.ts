import { UsageEvents } from 'librechat-data-provider';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type {
  CompactionSemanticIndexSnapshot,
  LCTool,
  SummarizationTrigger,
  ToolExecuteResult,
} from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { PiManualCompactionConfiguration, PiManualCompactionSettings } from './compaction';
import type { PiCallerToolCall, PiCallerToolDefinition } from './callerTools';
import type { PiContentEventTranslatorOptions, PiHostEvent } from './events';
import type { PiContextUsageProjectionInput } from './contextUsage';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { PiActionToolSchemaRegistry } from './actionSchema';
import type { PiGenerationExecutorInput } from './execution';
import type { PiToolExecutionGate } from './toolExecution';
import type { PiCodeSessionSnapshot } from './codeSession';
import type { PiMcpToolSchemaRegistry } from './mcpSchema';
import type { PiHistoryPruningOptions } from './pruning';
import type { PiToolResultContinuation } from './resume';
import type { PiHostToolCall } from './toolExecution';
import type { PiMessageStepIdentity } from './events';
import type { HostPiTurnEndContext } from './session';
import type { PiHostSessionOutcome } from './bridge';
import type { PiModelBinding } from './session';
import type { PiToolArguments } from './tools';
import {
  compilePiActionToolSchemaRegistry,
  compilePiMcpToolSchemaRegistry,
  createPiTools,
  PiToolCompatibilityError,
} from './tools';
import {
  buildPiManualCompactionInstruction,
  PiCompactionConfigurationError,
  resolvePiManualCompactionSettings,
} from './compaction';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { createPiCallerToolDefinitions } from './callerTools';
import { createPiHostToolExecutor } from './toolExecution';
import { createPiContentEventTranslator } from './events';
import { appendPiToolResultContinuation } from './resume';
import { ASK_USER_QUESTION_TOOL_NAME } from './toolNames';
import { createPiGenerationExecutor } from './execution';
import { convertLibreChatHistoryToPi } from './history';
import { projectPiContextUsage } from './contextUsage';
import { createPiHostEventSequencer } from './bridge';
import { createPiPauseController } from './pause';
import { projectPiHistory } from './pruning';

export class PiContextUsageUnavailableError extends Error {
  readonly code = 'PI_CONTEXT_USAGE_UNAVAILABLE';
  readonly status = 503;
  readonly statusCode = 503;

  constructor() {
    super('Pi could not produce the required host context-usage snapshot.');
    this.name = 'PiContextUsageUnavailableError';
  }
}

export class PiAutomaticSummaryFailedError extends Error {
  readonly code = 'PI_AUTOMATIC_SUMMARY_FAILED';
  readonly status = 503;
  readonly statusCode = 503;

  constructor() {
    super('Pi could not create a complete conversation summary. The answer was not started.');
    this.name = 'PiAutomaticSummaryFailedError';
  }
}

export interface PiAutomaticSummaryInput {
  enabled: boolean;
  agentId: string;
  agentProvider?: string;
  agentModel?: string;
  configuration?: PiManualCompactionConfiguration;
  trigger?: SummarizationTrigger;
  retainRecent?: { turns?: number; tokens?: number };
  previousSummary?: string;
  semanticIndex?: CompactionSemanticIndexSnapshot;
  summaryVersion: number;
  countSummaryTokens(text: string): number;
  buildPrimaryMessages(input: {
    summaryText: string;
    summaryTokenCount: number;
    retainedMessages: BaseMessage[];
  }): BaseMessage[];
}

export interface PiGenerationDispatchInput {
  /** Final server-formatted message history. The final user message becomes the Pi prompt. */
  messages: BaseMessage[];
  /** Retrieved from the exact initialized server-side agent object. */
  createModelBinding(): Promise<PiModelBinding>;
  /** Tool definitions are the initialized root agent's host-authorized tools. */
  toolDefinitions?: readonly LCTool[];
  /** Responses API caller-owned function tools; Pi returns the call without executing it. */
  clientToolDefinitions?: readonly PiCallerToolDefinition[];
  /** Schemas compiled from the same authorized host definitions used to build tools. */
  mcpToolSchemas?: PiMcpToolSchemaRegistry;
  /** Schemas compiled from the same current host-authorized Action definitions. */
  actionToolSchemas?: PiActionToolSchemaRegistry;
  /** Executes a tool through the existing host handler. */
  executeHostToolCall?: (call: PiHostToolCall, signal?: AbortSignal) => Promise<ToolExecuteResult>;
  /** Server-owned context persisted if a Code API tool waits for approval. */
  getCodeSessionContext?(): PiCodeSessionSnapshot | undefined;
  /** Per-tool call counts reconstructed from the current generation on resume. */
  initialToolUsageCounts?: Readonly<Record<string, number>>;
  /** Host-created internal authorization/approval gate; never supplied by clients. */
  toolExecutionGate?: PiToolExecutionGate;
  /** Must be derived from the existing Agent capability and administrator gates. */
  askUserQuestionEnabled?: boolean;
  /** Uses the model turn only to create one durable manual-compaction summary. */
  summaryOnly?: {
    settings: PiManualCompactionSettings;
    agentId: string;
    messagesToRefineCount: number;
    summaryVersion: number;
    countSummaryTokens(text: string): number;
    coverage?: { retainedFromMessageId: string };
    onComplete?(summaryText: string, summaryTokenCount: number): void;
  };
  /** Host-generated identities for LibreChat tool call steps. */
  createToolStepIdentity?(): PiMessageStepIdentity;
  createToolCallId?(): string;
  /** Product identities are supplied by the host, never generated by Pi. */
  createStepIdentity: PiContentEventTranslatorOptions['createStepIdentity'];
  usageAttribution?: PiContentEventTranslatorOptions['usageAttribution'];
  onModelProviderError?: PiContentEventTranslatorOptions['onModelProviderError'];
  /** Host tokenizer and identifiers for the pre-invoke context snapshot. */
  contextUsage?: Omit<PiContextUsageProjectionInput, 'messages' | 'model' | 'provider'>;
  /** Existing host tool-result caps for an ordinary, non-resumed provider projection. */
  contextPruning?: PiHistoryPruningOptions;
  /** Host-owned automatic summary configuration and compacted-prompt builder. */
  autoSummary?: PiAutomaticSummaryInput;
  /** Exact approved tool exchange to continue without replaying the user prompt. */
  resumeToolResult?: {
    continuation: PiToolResultContinuation;
    /** The exact validated arguments executed after the user's approval decision. */
    toolArguments: PiToolArguments;
    execute(): Promise<Pick<ToolResultMessage, 'content' | 'isError'>>;
  };
  /** Called when the executor has created the isolated host Pi session. */
  onSessionCreated?(): void;
  /**
   * Consumes host-persisted steering at Pi's turn-end poll window. The
   * dispatcher flushes earlier host events first and leaves paused runs queued.
   */
  onTurnEnd?(context: HostPiTurnEndContext): void | Promise<void>;
  signal?: AbortSignal;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
}

export interface PiGenerationDispatchDependencies {
  execute?: ReturnType<typeof createPiGenerationExecutor>;
}

export type PiGenerationDispatchResult = PiHostSessionOutcome & { usage: UsageMetadata[] };

/**
 * Runs one isolated Pi turn from the host's already-formatted transcript.
 * Model binding creation precedes history conversion so the exact authorized Pi
 * model identity is also used to tag synthetic assistant history entries.
 */
export function createPiGenerationDispatcher(
  dependencies: PiGenerationDispatchDependencies = {},
): (input: PiGenerationDispatchInput) => Promise<PiGenerationDispatchResult> {
  const execute = dependencies.execute ?? createPiGenerationExecutor();

  const dispatch = async (
    input: PiGenerationDispatchInput,
  ): Promise<PiGenerationDispatchResult> => {
    if (input.signal?.aborted) {
      return { status: 'cancelled', usage: [] };
    }

    const usage: UsageMetadata[] = [];
    const toolDefinitions = input.toolDefinitions ?? [];
    if (
      input.summaryOnly != null &&
      (toolDefinitions.length > 0 ||
        (input.clientToolDefinitions?.length ?? 0) > 0 ||
        input.executeHostToolCall != null ||
        input.toolExecutionGate != null ||
        input.askUserQuestionEnabled === true)
    ) {
      throw new AgentRuntimeUnavailableError();
    }
    let mcpToolSchemas: PiMcpToolSchemaRegistry;
    let actionToolSchemas: PiActionToolSchemaRegistry;
    try {
      mcpToolSchemas = input.mcpToolSchemas ?? compilePiMcpToolSchemaRegistry(toolDefinitions);
      actionToolSchemas =
        input.actionToolSchemas ?? compilePiActionToolSchemaRegistry(toolDefinitions);
    } catch (error) {
      if (error instanceof PiToolCompatibilityError) {
        throw new AgentRuntimeUnavailableError();
      }
      throw error;
    }
    const pauseController = createPiPauseController({ mcpToolSchemas, actionToolSchemas });
    const eventSequencer = createPiHostEventSequencer(async (event) => {
      if (event.event === UsageEvents.ON_TOKEN_USAGE) {
        usage.push(event.data);
      }
      await input.handleHostEvent(event);
    });

    let tools: ReturnType<typeof createPiTools>;
    let callerToolHandoff: PiCallerToolCall | undefined;
    let executeTool: ReturnType<typeof createPiHostToolExecutor> | undefined;
    try {
      if (
        input.executeHostToolCall != null &&
        input.createToolStepIdentity != null &&
        input.createToolCallId != null
      ) {
        executeTool = createPiHostToolExecutor({
          createStepIdentity: input.createToolStepIdentity,
          createToolCallId: input.createToolCallId,
          executeHostToolCall: input.executeHostToolCall,
          mcpToolSchemas,
          actionToolSchemas,
          ...(input.getCodeSessionContext == null
            ? {}
            : { getCodeSessionContext: input.getCodeSessionContext }),
          ...(input.initialToolUsageCounts == null
            ? {}
            : { initialToolUsageCounts: input.initialToolUsageCounts }),
          handleHostEvent: eventSequencer.enqueue,
          askUserQuestionEnabled: input.askUserQuestionEnabled === true,
          pauseGate: {
            controller: pauseController,
            evaluate: input.toolExecutionGate ?? (() => ({ kind: 'execute' as const })),
          },
        });
      }
      tools = createPiTools({
        definitions: toolDefinitions,
        execute: executeTool,
        mcpToolSchemas,
        actionToolSchemas,
      });
      const clientToolDefinitions = createPiCallerToolDefinitions(
        input.clientToolDefinitions ?? [],
        (call) => {
          if (callerToolHandoff != null) {
            throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
          }
          callerToolHandoff = call;
        },
      );
      const registeredNames = new Set(tools.map(({ name }) => name));
      if (clientToolDefinitions.some(({ name }) => registeredNames.has(name))) {
        throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
      }
      tools = [...tools, ...clientToolDefinitions];
    } catch (error) {
      if (error instanceof PiToolCompatibilityError) {
        throw new AgentRuntimeUnavailableError();
      }
      throw error;
    }
    if (
      input.toolExecutionGate != null ||
      (input.clientToolDefinitions?.length ?? 0) > 0 ||
      toolDefinitions.some(({ name }) => name === ASK_USER_QUESTION_TOOL_NAME)
    ) {
      // Once a gate can pause a tool batch, a sibling must not begin a side effect
      // while another call is awaiting its gate decision.
      tools = tools.map((tool) => ({ ...tool, executionMode: 'sequential' }));
    }

    let modelBinding = await input.createModelBinding();
    let bindingTransferred = false;
    let bindingDisposed = false;
    const disposeUntransferredBinding = async () => {
      if (bindingDisposed) {
        return;
      }
      bindingDisposed = true;
      await modelBinding.dispose();
    };
    try {
      if (input.summaryOnly?.settings.maxSummaryTokens !== undefined) {
        const configuredLimit = Math.floor(input.summaryOnly.settings.maxSummaryTokens);
        const modelLimit = modelBinding.model.maxTokens;
        if (
          !Number.isSafeInteger(configuredLimit) ||
          configuredLimit < 1 ||
          !Number.isSafeInteger(modelLimit) ||
          modelLimit < 1
        ) {
          throw new PiCompactionConfigurationError();
        }
        modelBinding = {
          ...modelBinding,
          model: {
            ...modelBinding.model,
            maxTokens: Math.min(modelLimit, configuredLimit),
          },
        };
      }
      if (input.signal?.aborted) {
        await disposeUntransferredBinding();
        return { status: 'cancelled', usage };
      }

      const historyProjection =
        input.contextPruning != null &&
        input.contextUsage != null &&
        input.summaryOnly == null &&
        input.resumeToolResult == null
          ? projectPiHistory({
              messages: input.messages,
              model: modelBinding.model,
              tokenCounter: input.contextUsage.tokenCounter,
              pruning: input.contextPruning,
              ...(input.autoSummary?.enabled === true &&
              input.autoSummary.configuration?.enabled !== false
                ? {
                    automaticCompaction: {
                      trigger: input.autoSummary.trigger,
                      retainRecent: input.autoSummary.retainRecent,
                    },
                  }
                : {}),
            })
          : {
              messages: input.messages,
              conversion: convertLibreChatHistoryToPi({
                messages: input.messages,
                model: modelBinding.model,
              }),
              pruned: false,
            };
      const automaticCompactionPlan =
        'compactionPlan' in historyProjection ? historyProjection.compactionPlan : undefined;

      if (
        automaticCompactionPlan != null &&
        input.autoSummary != null &&
        input.contextUsage != null
      ) {
        const settings = resolvePiManualCompactionSettings({
          agentProvider: input.autoSummary.agentProvider,
          agentModel: input.autoSummary.agentModel,
          configured: input.autoSummary.configuration,
        });
        const summaryInstruction = buildPiManualCompactionInstruction({
          settings,
          previousSummary: input.autoSummary.previousSummary,
          semanticIndex: input.autoSummary.semanticIndex,
        });
        const summaryMessages = [
          ...automaticCompactionPlan.systemMessages,
          ...automaticCompactionPlan.messagesToSummarize,
          new HumanMessage(summaryInstruction),
        ];
        if (
          projectPiContextUsage({
            messages: summaryMessages,
            model: modelBinding.model,
            ...input.contextUsage,
            provider: input.usageAttribution?.provider,
          }) == null
        ) {
          throw new PiContextUsageUnavailableError();
        }
        let summaryBindingAvailable = true;
        let summaryResult: { text: string; tokenCount: number } | undefined;
        const summaryOutcome = await dispatch({
          ...input,
          messages: summaryMessages,
          createModelBinding: async () => {
            if (summaryBindingAvailable) {
              summaryBindingAvailable = false;
              bindingTransferred = true;
              return modelBinding;
            }
            return input.createModelBinding();
          },
          toolDefinitions: [],
          clientToolDefinitions: [],
          mcpToolSchemas: undefined,
          actionToolSchemas: undefined,
          executeHostToolCall: undefined,
          getCodeSessionContext: undefined,
          initialToolUsageCounts: undefined,
          toolExecutionGate: undefined,
          askUserQuestionEnabled: false,
          contextUsage: undefined,
          contextPruning: undefined,
          autoSummary: undefined,
          resumeToolResult: undefined,
          onTurnEnd: undefined,
          summaryOnly: {
            settings,
            agentId: input.autoSummary.agentId,
            messagesToRefineCount: automaticCompactionPlan.messagesToSummarize.length,
            summaryVersion: input.autoSummary.summaryVersion,
            countSummaryTokens: input.autoSummary.countSummaryTokens,
            coverage: automaticCompactionPlan.coverage,
            onComplete: (text, tokenCount) => {
              summaryResult = { text, tokenCount };
            },
          },
        });

        if (summaryBindingAvailable) {
          await disposeUntransferredBinding();
        }
        if (summaryOutcome.status !== 'completed') {
          return {
            ...summaryOutcome,
            usage: [...usage, ...summaryOutcome.usage],
          };
        }
        if (summaryResult == null || summaryResult.text.length === 0) {
          throw new PiAutomaticSummaryFailedError();
        }
        if (input.signal?.aborted) {
          return { status: 'cancelled', usage: [...usage, ...summaryOutcome.usage] };
        }

        const primaryMessages = input.autoSummary.buildPrimaryMessages({
          summaryText: summaryResult.text,
          summaryTokenCount: summaryResult.tokenCount,
          retainedMessages: automaticCompactionPlan.retainedMessages,
        });
        const primaryOutcome = await dispatch({
          ...input,
          messages: primaryMessages,
          contextPruning: undefined,
          autoSummary: undefined,
          contextUsage: {
            ...input.contextUsage,
            summaryTokens: summaryResult.tokenCount,
          },
        });
        return {
          ...primaryOutcome,
          usage: [...usage, ...summaryOutcome.usage, ...primaryOutcome.usage],
        };
      }

      const { conversion } = historyProjection;
      const translateEvent = createPiContentEventTranslator({
        createStepIdentity: input.createStepIdentity,
        supportedToolNames: tools.map(({ name }) => name),
        usageAttribution: {
          ...input.usageAttribution,
          ...(input.contextUsage == null ? {} : { runId: input.contextUsage.runId }),
        },
        ...(input.onModelProviderError == null
          ? {}
          : { onModelProviderError: input.onModelProviderError }),
        ...(input.summaryOnly == null
          ? {}
          : {
              summaryOnly: {
                agentId: input.summaryOnly.agentId,
                provider: input.summaryOnly.settings.provider,
                model: input.summaryOnly.settings.model,
                messagesToRefineCount: input.summaryOnly.messagesToRefineCount,
                summaryVersion: input.summaryOnly.summaryVersion,
                streamDeltas: input.summaryOnly.settings.streamDeltas,
                countSummaryTokens: input.summaryOnly.countSummaryTokens,
                ...(input.summaryOnly.coverage == null
                  ? {}
                  : { coverage: input.summaryOnly.coverage }),
                ...(input.summaryOnly.onComplete == null
                  ? {}
                  : { onComplete: input.summaryOnly.onComplete }),
              },
            }),
      });
      if (input.contextUsage != null) {
        const contextUsage = projectPiContextUsage({
          messages: historyProjection.messages,
          model: modelBinding.model,
          ...input.contextUsage,
          provider: input.usageAttribution?.provider,
        });
        if (contextUsage == null) {
          throw new PiContextUsageUnavailableError();
        }
        await eventSequencer.enqueue({
          event: UsageEvents.ON_CONTEXT_USAGE,
          data: contextUsage,
        });
      }

      let history = conversion.history;
      let operation: PiGenerationExecutorInput['operation'];
      if (input.resumeToolResult == null) {
        operation = {
          kind: 'ordered_prompt',
          content: conversion.prompt.content,
        };
      } else {
        const resumeToolResult = await input.resumeToolResult.execute();
        if (resumeToolResult == null) {
          throw new AgentRuntimeUnavailableError();
        }
        history = appendPiToolResultContinuation({
          conversion,
          continuation: input.resumeToolResult.continuation,
          toolArguments: input.resumeToolResult.toolArguments,
          result: resumeToolResult,
          model: modelBinding.model,
        });
        operation = {
          kind: 'continue_tool_result',
          toolCallId: input.resumeToolResult.continuation.piToolCallId,
        };
      }
      const executionInput: PiGenerationExecutorInput = {
        createModelBinding: async () => {
          if (bindingTransferred) {
            throw new Error('A Pi generation model binding can only be transferred once');
          }
          bindingTransferred = true;
          return modelBinding;
        },
        systemPrompt: conversion.systemPrompt,
        tools,
        history,
        operation,
        signal: input.signal,
        pauseController,
        ...(input.clientToolDefinitions?.length
          ? { getCallerToolHandoff: () => callerToolHandoff }
          : {}),
        ...(input.toolExecutionGate == null && (input.clientToolDefinitions?.length ?? 0) === 0
          ? {}
          : { toolBatchPolicy: { controller: pauseController } }),
        translateEvent,
        handleHostEvent: eventSequencer.enqueue,
        ...(input.onSessionCreated == null ? {} : { onSessionCreated: input.onSessionCreated }),
        ...(input.onTurnEnd == null
          ? {}
          : {
              onTurnEnd: async (context: HostPiTurnEndContext) => {
                if (pauseController.signal != null) {
                  return;
                }
                await eventSequencer.drain();
                await input.onTurnEnd?.(context);
              },
            }),
        eventSequencer,
      };

      const outcome = await execute(executionInput);
      if (!bindingTransferred) {
        await disposeUntransferredBinding();
      }
      return { ...outcome, usage };
    } catch (error) {
      if (bindingTransferred) {
        throw error;
      }
      if (!bindingDisposed) {
        try {
          await disposeUntransferredBinding();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Pi generation setup and cleanup failed');
        }
      }
      throw error;
    }
  };

  return dispatch;
}

export const executePiGeneration: ReturnType<typeof createPiGenerationDispatcher> =
  createPiGenerationDispatcher();
