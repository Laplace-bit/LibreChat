import { createPruneMessages } from '@librechat/agents';
import { SystemMessage } from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { PiContextUsageProjectionInput } from './contextUsage';
import type { PiHistoryModel } from './history';
import { convertLibreChatHistoryToPi, PiHistoryCompatibilityError } from './history';

export interface PiHistoryPruningOptions {
  maxContextTokens: number;
  reserveRatio?: number;
  calibrationRatio?: number;
  maxToolResultChars?: number;
  indexTokenCountMap: Record<string, number | undefined>;
}

export interface CreatePiHistoryPruningOptionsInput {
  indexTokenCountMap: Record<string, number | undefined>;
  systemPrefixCount: number;
  maxContextTokens: number | undefined;
  reserveRatio?: number;
  calibrationRatio?: number;
  maxToolResultChars?: number;
}

/**
 * Aligns the host formatter's token indexes with Pi's optional leading system
 * message. The system prompt is budgeted separately as instruction overhead.
 */
export function createPiHistoryPruningOptions(
  input: CreatePiHistoryPruningOptionsInput,
): PiHistoryPruningOptions | undefined {
  if (
    typeof input.maxContextTokens !== 'number' ||
    !Number.isSafeInteger(input.maxContextTokens) ||
    input.maxContextTokens <= 0 ||
    !Number.isSafeInteger(input.systemPrefixCount) ||
    input.systemPrefixCount < 0
  ) {
    return undefined;
  }

  const indexTokenCountMap: Record<string, number | undefined> = {};
  for (const [rawIndex, count] of Object.entries(input.indexTokenCountMap)) {
    const index = Number(rawIndex);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
    ) {
      return undefined;
    }
    indexTokenCountMap[index + input.systemPrefixCount] = count;
  }

  return {
    maxContextTokens: input.maxContextTokens,
    indexTokenCountMap,
    ...(input.reserveRatio === undefined ? {} : { reserveRatio: input.reserveRatio }),
    ...(input.calibrationRatio === undefined ? {} : { calibrationRatio: input.calibrationRatio }),
    ...(input.maxToolResultChars === undefined
      ? {}
      : { maxToolResultChars: input.maxToolResultChars }),
  };
}

export interface PiHistoryProjectionInput {
  messages: BaseMessage[];
  model: PiHistoryModel;
  tokenCounter: PiContextUsageProjectionInput['tokenCounter'];
  pruning?: PiHistoryPruningOptions;
}

export interface PiHistoryProjection {
  messages: BaseMessage[];
  conversion: ReturnType<typeof convertLibreChatHistoryToPi>;
  pruned: boolean;
}

/**
 * Applies the existing host tool-result limits to a provider-only copy of the
 * transcript. It never drops a message or changes the persisted host history.
 */
export function projectPiHistory(input: PiHistoryProjectionInput): PiHistoryProjection {
  const originalConversion = convertLibreChatHistoryToPi({
    messages: input.messages,
    model: input.model,
  });
  const pruning = input.pruning;
  if (
    pruning == null ||
    !Number.isSafeInteger(pruning.maxContextTokens) ||
    pruning.maxContextTokens <= 0
  ) {
    return { messages: input.messages, conversion: originalConversion, pruned: false };
  }

  let systemMessageCount = 0;
  while (
    systemMessageCount < input.messages.length &&
    SystemMessage.isInstance(input.messages[systemMessageCount])
  ) {
    systemMessageCount += 1;
  }
  const conversationMessages = input.messages.slice(systemMessageCount);
  const conversationTokenCounts: Record<string, number | undefined> = {};
  for (const [rawIndex, count] of Object.entries(pruning.indexTokenCountMap)) {
    const index = Number(rawIndex);
    if (Number.isSafeInteger(index) && index >= systemMessageCount) {
      conversationTokenCounts[index - systemMessageCount] = count;
    }
  }

  const instructionTokens = input.tokenCounter(new SystemMessage(originalConversion.systemPrompt));
  if (!Number.isSafeInteger(instructionTokens) || instructionTokens < 0) {
    return { messages: input.messages, conversion: originalConversion, pruned: false };
  }

  const pruneMessages = createPruneMessages({
    maxTokens: pruning.maxContextTokens,
    startIndex: 0,
    tokenCounter: input.tokenCounter,
    indexTokenCountMap: conversationTokenCounts,
    getInstructionTokens: () => instructionTokens,
    summarizationEnabled: true,
    ...(pruning.maxToolResultChars === undefined
      ? {}
      : { maxToolResultChars: pruning.maxToolResultChars }),
    ...(pruning.reserveRatio === undefined ? {} : { reserveRatio: pruning.reserveRatio }),
    ...(pruning.calibrationRatio === undefined
      ? {}
      : { calibrationRatio: pruning.calibrationRatio }),
  });
  const projection = pruneMessages({
    messages: [...conversationMessages],
    canonicalMessages: conversationMessages,
  });

  if (
    projection.context.length !== conversationMessages.length ||
    (projection.messagesToRefine?.length ?? 0) > 0 ||
    projection.context.every((message, index) => message === conversationMessages[index])
  ) {
    return { messages: input.messages, conversion: originalConversion, pruned: false };
  }

  try {
    const messages = [...input.messages.slice(0, systemMessageCount), ...projection.context];
    const conversion = convertLibreChatHistoryToPi({
      messages,
      model: input.model,
    });
    return { messages, conversion, pruned: true };
  } catch (error) {
    if (error instanceof PiHistoryCompatibilityError) {
      return { messages: input.messages, conversion: originalConversion, pruned: false };
    }
    throw error;
  }
}
