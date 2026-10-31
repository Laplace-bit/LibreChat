import { DEFAULT_RESERVE_RATIO, REPLY_PRIMER_TOKENS } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { TContextUsageEvent } from 'librechat-data-provider';
import type { PiModelBinding } from './session';

export interface PiContextUsageProjectionInput {
  messages: readonly BaseMessage[];
  model: PiModelBinding['model'];
  tokenCounter(message: BaseMessage): number;
  runId: string;
  agentId: string;
  maxContextTokens?: number;
  reserveRatio?: number;
  provider?: string;
  calibrationRatio?: number;
  /** Token count of the cross-run summary already included in the system prompt. */
  summaryTokens?: number;
}

/** Pi does not yet have the host graph's history pruner, so an estimated
 * over-budget transcript must fail before the provider sees an incomplete or
 * known-to-overflow prompt. */
export class PiContextBudgetExceededError extends Error {
  readonly code = 'PI_CONTEXT_BUDGET_EXCEEDED';
  readonly status = 413;
  readonly statusCode = 413;

  constructor() {
    super('Pi cannot run this turn because its estimated context exceeds the configured budget.');
    this.name = 'PiContextBudgetExceededError';
  }
}

function isValidTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Projects the exact host transcript into the existing pre-invoke usage shape.
 * The local tokenizer supplies the live estimate; the provider's subsequent
 * token-usage event reconciles messageTokens and persists the completed call.
 */
export function projectPiContextUsage(
  input: PiContextUsageProjectionInput,
): TContextUsageEvent | undefined {
  const { contextWindow: modelContextWindow, maxTokens } = input.model;
  if (
    !Number.isSafeInteger(modelContextWindow) ||
    modelContextWindow <= 0 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 0 ||
    typeof input.runId !== 'string' ||
    input.runId.length === 0 ||
    typeof input.agentId !== 'string' ||
    input.agentId.length === 0
  ) {
    return undefined;
  }
  if (
    input.maxContextTokens !== undefined &&
    (!Number.isSafeInteger(input.maxContextTokens) || input.maxContextTokens <= 0)
  ) {
    return undefined;
  }
  if (input.summaryTokens !== undefined && !isValidTokenCount(input.summaryTokens)) {
    return undefined;
  }
  const contextWindow =
    input.maxContextTokens == null
      ? modelContextWindow
      : Math.min(input.maxContextTokens, modelContextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  let instructionTokens = 0;
  let messageTokens = 0;
  let messageCount = 0;
  for (const message of input.messages) {
    let count: number;
    try {
      count = input.tokenCounter(message);
    } catch {
      return undefined;
    }
    if (!isValidTokenCount(count)) {
      return undefined;
    }

    if (message._getType() === 'system') {
      instructionTokens += count;
    } else {
      messageCount += 1;
      messageTokens += count;
    }
  }

  if (!isValidTokenCount(instructionTokens) || !isValidTokenCount(messageTokens)) {
    return undefined;
  }

  const reserveRatio = input.reserveRatio ?? DEFAULT_RESERVE_RATIO;
  const reserveTokens =
    Number.isFinite(reserveRatio) && reserveRatio > 0 && reserveRatio < 1
      ? Math.round(contextWindow * reserveRatio)
      : 0;
  const contextBudget = Math.max(0, contextWindow - reserveTokens);
  const calibrationRatio =
    input.calibrationRatio != null &&
    Number.isFinite(input.calibrationRatio) &&
    input.calibrationRatio > 0
      ? input.calibrationRatio
      : 1;
  const calibratedMessageTokens = Math.round(messageTokens * calibrationRatio);
  const remainingContextTokens =
    contextBudget - instructionTokens - calibratedMessageTokens - REPLY_PRIMER_TOKENS;
  if (remainingContextTokens < 0) {
    throw new PiContextBudgetExceededError();
  }
  return {
    runId: input.runId,
    agentId: input.agentId,
    model: input.model.id,
    provider: input.provider ?? input.model.provider,
    breakdown: {
      maxContextTokens: contextWindow,
      instructionTokens,
      systemMessageTokens: instructionTokens,
      dynamicInstructionTokens: 0,
      toolSchemaTokens: 0,
      summaryTokens: input.summaryTokens ?? 0,
      toolCount: 0,
      messageCount,
      messageTokens,
      availableForMessages: Math.max(0, contextBudget - instructionTokens),
    },
    contextBudget,
    effectiveInstructionTokens: instructionTokens,
    prePruneContextTokens: calibratedMessageTokens,
    remainingContextTokens,
    calibrationRatio,
    ...(input.summaryTokens == null || input.summaryTokens === 0
      ? {}
      : { summaryPlacement: 'system_prompt' as const }),
  };
}
