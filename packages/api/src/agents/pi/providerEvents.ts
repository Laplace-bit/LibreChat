export const PI_TOOL_BATCH_EVENT_APIS = ['openai-completions', 'openai-responses'] as const;

export type PiToolBatchEventApi = (typeof PI_TOOL_BATCH_EVENT_APIS)[number];

export type PiProviderEventFailure =
  | {
      readonly kind: 'repeated_call_id';
      readonly api: PiToolBatchEventApi;
      readonly callId: string;
      readonly firstIndex: number;
      readonly repeatedIndex: number;
    }
  | {
      readonly kind: 'conflicting_call_id';
      readonly api: PiToolBatchEventApi;
      readonly previousCallId: string;
      readonly callId: string;
      readonly index: number;
    }
  | {
      readonly kind: 'cross_choice_tool_call';
      readonly api: PiToolBatchEventApi;
      readonly firstChoiceIndex: number;
      readonly choiceIndex: number;
      readonly toolCallIndex: number;
    }
  | {
      readonly kind: 'missing_choice_index';
      readonly api: PiToolBatchEventApi;
    }
  | { readonly kind: 'missing_response_id'; readonly api: PiToolBatchEventApi }
  | {
      readonly kind: 'missing_tool_call_index';
      readonly api: PiToolBatchEventApi;
      readonly callId?: string;
    }
  | {
      readonly kind: 'missing_tool_call_id';
      readonly api: PiToolBatchEventApi;
      readonly index: number;
    }
  | { readonly kind: 'unsupported_api'; readonly api: string };

interface ToolCallIndexes {
  readonly idByIndex: Map<number, string>;
  readonly indexById: Map<string, number>;
}

interface CompletionToolCallIndexes {
  readonly identities: ToolCallIndexes;
  readonly choiceByIndex: Map<number, number>;
  readonly choiceById: Map<string, number>;
}

export interface PiProviderEventObserver {
  observe(api: PiToolBatchEventApi, event: unknown): PiProviderEventFailure | undefined;
}

export function isPiToolBatchEventApi(api: string): api is PiToolBatchEventApi {
  return PI_TOOL_BATCH_EVENT_APIS.some((supportedApi) => supportedApi === api);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function createToolCallIndexes(): ToolCallIndexes {
  return { idByIndex: new Map(), indexById: new Map() };
}

function recordToolCallIdentity(
  api: PiToolBatchEventApi,
  indexes: ToolCallIndexes,
  index: number,
  callId: string,
): PiProviderEventFailure | undefined {
  const previousId = indexes.idByIndex.get(index);
  if (previousId != null && previousId !== callId) {
    return { kind: 'conflicting_call_id', api, previousCallId: previousId, callId, index };
  }

  const previousIndex = indexes.indexById.get(callId);
  if (previousIndex != null && previousIndex !== index) {
    return {
      kind: 'repeated_call_id',
      api,
      callId,
      firstIndex: previousIndex,
      repeatedIndex: index,
    };
  }

  indexes.idByIndex.set(index, callId);
  indexes.indexById.set(callId, index);
  return undefined;
}

function createCompletionToolCallIndexes(): CompletionToolCallIndexes {
  return {
    identities: createToolCallIndexes(),
    choiceByIndex: new Map(),
    choiceById: new Map(),
  };
}

function recordCompletionToolCallIdentity(input: {
  state: CompletionToolCallIndexes;
  choiceIndex: number;
  toolCallIndex: number;
  callId?: string;
}): PiProviderEventFailure | undefined {
  const { state, choiceIndex, toolCallIndex, callId } = input;
  const previousChoiceForIndex = state.choiceByIndex.get(toolCallIndex);
  if (previousChoiceForIndex != null && previousChoiceForIndex !== choiceIndex) {
    return {
      kind: 'cross_choice_tool_call',
      api: 'openai-completions',
      firstChoiceIndex: previousChoiceForIndex,
      choiceIndex,
      toolCallIndex,
    };
  }

  if (callId != null) {
    const previousChoiceForId = state.choiceById.get(callId);
    if (previousChoiceForId != null && previousChoiceForId !== choiceIndex) {
      return {
        kind: 'cross_choice_tool_call',
        api: 'openai-completions',
        firstChoiceIndex: previousChoiceForId,
        choiceIndex,
        toolCallIndex,
      };
    }

    const identityFailure = recordToolCallIdentity(
      'openai-completions',
      state.identities,
      toolCallIndex,
      callId,
    );
    if (identityFailure != null) {
      return identityFailure;
    }
    state.choiceById.set(callId, choiceIndex);
  }
  state.choiceByIndex.set(toolCallIndex, choiceIndex);
  return undefined;
}

/** Observes the OpenAI adapter's raw events before Pi normalizes tool-call blocks. */
export function createPiProviderEventObserver(): PiProviderEventObserver {
  // The Completions adapter keeps its tool-call maps per response, not per choice.
  const responseCallsByResponse = new Map<string, ToolCallIndexes>();
  let activeCompletionsId: string | undefined;
  let activeCompletionsCalls: CompletionToolCallIndexes | undefined;
  let activeResponsesId: string | undefined;

  const observeCompletions = (event: unknown): PiProviderEventFailure | undefined => {
    if (!isRecord(event) || !Array.isArray(event.choices)) {
      return undefined;
    }

    const eventResponseId = readNonEmptyString(event.id);
    if (eventResponseId != null && eventResponseId !== activeCompletionsId) {
      activeCompletionsId = eventResponseId;
      activeCompletionsCalls = undefined;
    }

    for (const rawChoice of event.choices) {
      if (!isRecord(rawChoice)) {
        continue;
      }

      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
      const rawToolCalls = delta?.tool_calls;
      const hasToolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0;
      const choiceIndex = readIndex(rawChoice.index);
      if (hasToolCalls) {
        if (eventResponseId == null) {
          return { kind: 'missing_response_id', api: 'openai-completions' };
        }
        if (choiceIndex == null) {
          return { kind: 'missing_choice_index', api: 'openai-completions' };
        }
        activeCompletionsCalls ??= createCompletionToolCallIndexes();
        for (const rawToolCall of rawToolCalls) {
          if (!isRecord(rawToolCall)) {
            return { kind: 'missing_tool_call_index', api: 'openai-completions' };
          }
          const toolCallIndex = readIndex(rawToolCall.index);
          if (toolCallIndex == null) {
            return {
              kind: 'missing_tool_call_index',
              api: 'openai-completions',
              callId: readNonEmptyString(rawToolCall.id),
            };
          }

          const failure = recordCompletionToolCallIdentity({
            state: activeCompletionsCalls,
            choiceIndex,
            toolCallIndex,
            callId: readNonEmptyString(rawToolCall.id),
          });
          if (failure != null) {
            return failure;
          }
        }
      }
    }
    return undefined;
  };

  const observeResponses = (event: unknown): PiProviderEventFailure | undefined => {
    if (!isRecord(event) || typeof event.type !== 'string') {
      return undefined;
    }

    if (event.type === 'response.created') {
      const response = isRecord(event.response) ? event.response : undefined;
      activeResponsesId = readNonEmptyString(response?.id);
    }

    const responseId =
      readNonEmptyString(event.response_id) ?? activeResponsesId ?? 'response-without-id';
    let callIndexes = responseCallsByResponse.get(responseId);

    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = isRecord(event.item) ? event.item : undefined;
      const outputIndex = readIndex(event.output_index);
      const isCallableItem = item?.type === 'function_call' || item?.type === 'custom_tool_call';
      const callId = readNonEmptyString(item?.call_id);
      if (isCallableItem && outputIndex == null) {
        return { kind: 'missing_tool_call_index', api: 'openai-responses', callId };
      }
      if (isCallableItem && outputIndex != null && callId == null) {
        return { kind: 'missing_tool_call_id', api: 'openai-responses', index: outputIndex };
      }
      if (isCallableItem && outputIndex != null && callId != null) {
        callIndexes ??= createToolCallIndexes();
        responseCallsByResponse.set(responseId, callIndexes);
        const failure = recordToolCallIdentity(
          'openai-responses',
          callIndexes,
          outputIndex,
          callId,
        );
        if (failure != null) {
          return failure;
        }
      }
    }

    if (
      event.type === 'response.completed' ||
      event.type === 'response.incomplete' ||
      event.type === 'response.failed'
    ) {
      responseCallsByResponse.delete(responseId);
      if (responseId === activeResponsesId) {
        activeResponsesId = undefined;
      }
    }
    return undefined;
  };

  return {
    observe(api, event) {
      switch (api) {
        case 'openai-completions':
          return observeCompletions(event);
        case 'openai-responses':
          return observeResponses(event);
        default: {
          const exhaustive: never = api;
          return { kind: 'unsupported_api', api: exhaustive };
        }
      }
    },
  };
}
