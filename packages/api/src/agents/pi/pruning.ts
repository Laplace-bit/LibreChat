import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';
import {
  createPruneMessages,
  DEFAULT_RETAIN_RECENT_TURNS,
  resolveIntraTurnRetainTokens,
  shouldTriggerSummarization,
  splitAtRecencyBoundary,
} from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { SummarizationTrigger } from '@librechat/agents';
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
  automaticCompaction?: {
    trigger?: SummarizationTrigger;
    retainRecent?: { turns?: number; tokens?: number };
  };
}

export interface PiHistoryProjection {
  messages: BaseMessage[];
  conversion: ReturnType<typeof convertLibreChatHistoryToPi>;
  pruned: boolean;
  compactionPlan?: PiHistoryCompactionPlan;
}

export interface PiHistoryCompactionPlan {
  systemMessages: BaseMessage[];
  /** Canonical old messages to summarize; tool-result caps are not applied here. */
  messagesToSummarize: BaseMessage[];
  /** Provider projection retained verbatim after the summary. */
  retainedMessages: BaseMessage[];
  coverage: { retainedFromMessageId: string };
}

function sourceMessageId(message: BaseMessage): string | undefined {
  const additional = message.additional_kwargs;
  if (
    additional != null &&
    typeof additional === 'object' &&
    'sourceMessageId' in additional &&
    typeof additional.sourceMessageId === 'string' &&
    additional.sourceMessageId.trim().length > 0
  ) {
    return additional.sourceMessageId.trim();
  }
  return undefined;
}

function getMessageIndices(messages: readonly BaseMessage[]): {
  indexByMessage: WeakMap<BaseMessage, number>;
  indexById: Map<string, number | undefined>;
} {
  const indexByMessage = new WeakMap<BaseMessage, number>();
  const indexById = new Map<string, number | undefined>();
  for (const [index, message] of messages.entries()) {
    indexByMessage.set(message, index);
    if (typeof message.id !== 'string' || message.id.length === 0) {
      continue;
    }
    indexById.set(message.id, indexById.has(message.id) ? undefined : index);
  }
  return { indexByMessage, indexById };
}

function resolveMessageIndex(
  message: BaseMessage,
  indices: ReturnType<typeof getMessageIndices>,
): number | undefined {
  const direct = indices.indexByMessage.get(message);
  if (direct != null) {
    return direct;
  }
  return typeof message.id === 'string' ? indices.indexById.get(message.id) : undefined;
}

function isExactPrefixSuffixPartition(input: {
  messages: readonly BaseMessage[];
  prefix: readonly BaseMessage[];
  suffix: readonly BaseMessage[];
  indices: ReturnType<typeof getMessageIndices>;
}): boolean {
  const { messages, prefix, suffix, indices } = input;
  if (prefix.length + suffix.length !== messages.length) {
    return false;
  }
  let expectedIndex = 0;
  for (const message of [...prefix, ...suffix]) {
    if (resolveMessageIndex(message, indices) !== expectedIndex) {
      return false;
    }
    expectedIndex += 1;
  }
  return expectedIndex === messages.length;
}

/**
 * Produces an automatic-compaction plan only when the SDK pruner yields a
 * provable contiguous prefix/suffix split and the original latest user message
 * remains in a valid provider history. Unsafe or ambiguous splits return no
 * plan so the ordinary context-budget check fails closed.
 */
function createCompactionPlan(input: {
  messages: BaseMessage[];
  model: PiHistoryModel;
  tokenCounter: PiContextUsageProjectionInput['tokenCounter'];
  pruning: PiHistoryPruningOptions;
  trigger?: SummarizationTrigger;
  retainRecent?: { turns?: number; tokens?: number };
  systemMessageCount: number;
  conversationMessages: BaseMessage[];
  projection: ReturnType<ReturnType<typeof createPruneMessages>>;
  instructionTokens: number;
}): PiHistoryCompactionPlan | undefined {
  const { messagesToRefine = [], context } = input.projection;
  if (
    messagesToRefine.length === 0 ||
    !shouldTriggerSummarization({
      trigger: input.trigger,
      maxContextTokens: input.pruning.maxContextTokens,
      prePruneContextTokens:
        input.projection.prePruneContextTokens == null
          ? undefined
          : input.projection.prePruneContextTokens + input.instructionTokens,
      remainingContextTokens: input.projection.remainingContextTokens,
      messagesToRefineCount: messagesToRefine.length,
    })
  ) {
    return undefined;
  }

  const indices = getMessageIndices(input.conversationMessages);
  if (
    !isExactPrefixSuffixPartition({
      messages: input.conversationMessages,
      prefix: messagesToRefine,
      suffix: context,
      indices,
    }) ||
    context.length === 0
  ) {
    return undefined;
  }

  const retainRecent = input.retainRecent;
  const retainTokens =
    retainRecent?.tokens ??
    (retainRecent == null
      ? Math.min(16_000, Math.max(1, Math.floor(input.pruning.maxContextTokens * 0.16)))
      : undefined);
  let recency: ReturnType<typeof splitAtRecencyBoundary>;
  try {
    recency = splitAtRecencyBoundary(context, {
      provider: input.model.provider,
      turns: retainRecent?.turns ?? DEFAULT_RETAIN_RECENT_TURNS,
      ...(retainTokens === undefined ? {} : { tokens: retainTokens }),
      tokenCounter: input.tokenCounter,
      intraTurnTokens: resolveIntraTurnRetainTokens({
        tokens: retainTokens,
        maxContextTokens: input.pruning.maxContextTokens,
      }),
    });
  } catch {
    return undefined;
  }
  if (recency.tail.length === 0) {
    return undefined;
  }

  const retainedStartIndex = resolveMessageIndex(recency.tail[0], indices);
  if (
    retainedStartIndex == null ||
    retainedStartIndex <= 0 ||
    resolveMessageIndex(recency.tail[recency.tail.length - 1], indices) !==
      input.conversationMessages.length - 1 ||
    !HumanMessage.isInstance(input.conversationMessages[input.conversationMessages.length - 1])
  ) {
    return undefined;
  }

  const retainedWithSystem = [
    ...input.messages.slice(0, input.systemMessageCount),
    ...recency.tail,
  ];
  try {
    convertLibreChatHistoryToPi({ messages: retainedWithSystem, model: input.model });
  } catch (error) {
    if (error instanceof PiHistoryCompatibilityError) {
      return undefined;
    }
    throw error;
  }

  const retainedFromMessageId = sourceMessageId(input.conversationMessages[retainedStartIndex]);
  if (retainedFromMessageId == null) {
    return undefined;
  }

  return {
    systemMessages: input.messages.slice(0, input.systemMessageCount),
    messagesToSummarize: input.conversationMessages.slice(0, retainedStartIndex),
    retainedMessages: recency.tail,
    coverage: { retainedFromMessageId },
  };
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
  const modelContextWindow = input.model.contextWindow;
  const maxContextTokens =
    typeof modelContextWindow === 'number' &&
    Number.isSafeInteger(modelContextWindow) &&
    modelContextWindow > 0
      ? Math.min(pruning.maxContextTokens, modelContextWindow)
      : pruning.maxContextTokens;
  const effectivePruning =
    maxContextTokens === pruning.maxContextTokens ? pruning : { ...pruning, maxContextTokens };

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
    maxTokens: effectivePruning.maxContextTokens,
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
  const compactionPlan =
    input.automaticCompaction == null
      ? undefined
      : createCompactionPlan({
          messages: input.messages,
          model: input.model,
          tokenCounter: input.tokenCounter,
          pruning: effectivePruning,
          trigger: input.automaticCompaction.trigger,
          retainRecent: input.automaticCompaction.retainRecent,
          systemMessageCount,
          conversationMessages,
          projection,
          instructionTokens,
        });
  const compaction = compactionPlan == null ? {} : { compactionPlan };

  if (
    projection.context.length !== conversationMessages.length ||
    (projection.messagesToRefine?.length ?? 0) > 0 ||
    projection.context.every((message, index) => message === conversationMessages[index])
  ) {
    return {
      messages: input.messages,
      conversion: originalConversion,
      pruned: false,
      ...compaction,
    };
  }

  try {
    const messages = [...input.messages.slice(0, systemMessageCount), ...projection.context];
    const conversion = convertLibreChatHistoryToPi({
      messages,
      model: input.model,
    });
    return { messages, conversion, pruned: true, ...compaction };
  } catch (error) {
    if (error instanceof PiHistoryCompatibilityError) {
      return {
        messages: input.messages,
        conversion: originalConversion,
        pruned: false,
        ...compaction,
      };
    }
    throw error;
  }
}
