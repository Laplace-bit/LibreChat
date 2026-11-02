import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { PiHistoryModel } from './history';
import { createPiHistoryPruningOptions, projectPiHistory } from './pruning';

const model: PiHistoryModel = {
  api: 'openai-responses',
  provider: 'openai',
  id: 'gpt-4o',
};

function tokenCounter(message: BaseMessage): number {
  return JSON.stringify({
    content: message.content,
    toolCalls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
  }).length;
}

function createHistory(systemPrompt = ''): BaseMessage[] {
  return [
    ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
    new HumanMessage('Earlier question'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'lookup', args: { query: 'machine status' } }],
    }),
    new ToolMessage({
      content: 'authorized result '.repeat(120),
      name: 'lookup',
      tool_call_id: 'call-1',
    }),
    new HumanMessage('What should I do next?'),
  ];
}

function createPruningOptions(
  messages: BaseMessage[],
  systemPrefixCount: number,
  maxTokens = 10_000,
) {
  const indexTokenCountMap = Object.fromEntries(
    messages.slice(systemPrefixCount).map((message, index) => [index, tokenCounter(message)]),
  );
  return createPiHistoryPruningOptions({
    indexTokenCountMap,
    systemPrefixCount,
    maxContextTokens: maxTokens,
    reserveRatio: 0,
    calibrationRatio: 1,
    maxToolResultChars: 100,
  });
}

describe('projectPiHistory', () => {
  it('caps tool results in the Pi projection without changing the canonical transcript', () => {
    const messages = createHistory();
    const originalSnapshot = JSON.stringify(messages.map((message) => message.toDict()));
    const pruning = createPruningOptions(messages, 0);

    const projection = projectPiHistory({ messages, model, tokenCounter, pruning });

    expect(projection.pruned).toBe(true);
    expect(projection.messages).not.toBe(messages);
    expect(projection.conversion.prompt.text).toBe('What should I do next?');
    expect(projection.conversion.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
    ]);
    expect(projection.conversion.history[1]).toMatchObject({
      content: [{ type: 'toolCall', id: 'call-1', name: 'lookup' }],
      stopReason: 'toolUse',
    });
    expect(projection.conversion.history[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup',
    });
    expect((projection.messages[2] as ToolMessage).content).not.toBe(
      (messages[2] as ToolMessage).content,
    );
    expect(JSON.stringify(messages.map((message) => message.toDict()))).toBe(originalSnapshot);
  });

  it('counts the system prompt once as instruction overhead', () => {
    const messages = createHistory('system guidance '.repeat(15));
    const pruning = createPruningOptions(messages, 1, 700);

    const projection = projectPiHistory({ messages, model, tokenCounter, pruning });

    expect(projection.pruned).toBe(true);
    expect(projection.messages[0]).toBe(messages[0]);
    expect(projection.conversion.systemPrompt).toBe((messages[0] as SystemMessage).content);
    expect(projection.conversion.prompt.text).toBe('What should I do next?');
  });

  it('keeps the original transcript when hard pruning would drop messages', () => {
    const messages = createHistory();
    const pruning = createPruningOptions(messages, 0, 80);

    const projection = projectPiHistory({ messages, model, tokenCounter, pruning });

    expect(projection.pruned).toBe(false);
    expect(projection.messages).toBe(messages);
    expect((messages[2] as ToolMessage).content).toContain('authorized result');
  });

  it('shifts host token indexes without charging the Pi system prefix as a message', () => {
    expect(
      createPiHistoryPruningOptions({
        indexTokenCountMap: { 0: 3, 1: 7 },
        systemPrefixCount: 1,
        maxContextTokens: 100,
      }),
    ).toEqual({
      indexTokenCountMap: { 1: 3, 2: 7 },
      maxContextTokens: 100,
    });
  });

  it('plans a durable summary over the old prefix and keeps the latest user turn verbatim', () => {
    const messages = [
      new HumanMessage({ content: 'older question '.repeat(8), id: 'user-old' }),
      new AIMessage({ content: 'older answer '.repeat(8), id: 'assistant-old' }),
      new HumanMessage({ content: 'recent question '.repeat(5), id: 'user-recent' }),
      new AIMessage({ content: 'recent answer '.repeat(5), id: 'assistant-recent' }),
      new HumanMessage({ content: 'current question', id: 'user-current' }),
    ];
    for (const message of messages) {
      message.additional_kwargs.sourceMessageId = message.id;
    }
    const originalSnapshot = JSON.stringify(messages.map((message) => message.toDict()));
    const pruning = createPruningOptions(messages, 0, 120);

    const projection = projectPiHistory({
      messages,
      model,
      tokenCounter,
      pruning,
      automaticCompaction: { retainRecent: { turns: 1 } },
    });

    expect(projection.compactionPlan).toMatchObject({
      messagesToSummarize: messages.slice(0, 4),
      retainedMessages: [expect.objectContaining({ id: 'user-current' })],
      coverage: { retainedFromMessageId: 'user-current' },
    });
    expect(JSON.stringify(messages.map((message) => message.toDict()))).toBe(originalSnapshot);
  });

  it('does not plan compaction when the configured trigger has not fired', () => {
    const messages = [
      new HumanMessage({ content: 'older question '.repeat(8), id: 'user-old' }),
      new AIMessage({ content: 'older answer '.repeat(8), id: 'assistant-old' }),
      new HumanMessage({ content: 'current question', id: 'user-current' }),
    ];
    for (const message of messages) {
      message.additional_kwargs.sourceMessageId = message.id;
    }
    const pruning = createPruningOptions(messages, 0, 100);

    const projection = projectPiHistory({
      messages,
      model,
      tokenCounter,
      pruning,
      automaticCompaction: {
        trigger: { type: 'messages_to_refine', value: 100 },
        retainRecent: { turns: 1 },
      },
    });

    expect(projection.compactionPlan).toBeUndefined();
    expect(projection.messages).toBe(messages);
  });

  it('uses the bound model context window when it is below the configured pruning cap', () => {
    const messages = [
      new HumanMessage({ content: 'older question '.repeat(4), id: 'user-old' }),
      new AIMessage({ content: 'older answer '.repeat(4), id: 'assistant-old' }),
      new HumanMessage({ content: 'current question', id: 'user-current' }),
    ];
    for (const message of messages) {
      message.additional_kwargs.sourceMessageId = message.id;
    }
    const pruning = createPruningOptions(messages, 0, 1_000);

    const projection = projectPiHistory({
      messages,
      model: { ...model, contextWindow: 100 },
      tokenCounter,
      pruning,
      automaticCompaction: { retainRecent: { turns: 1 } },
    });

    expect(projection.compactionPlan?.messagesToSummarize).toEqual(messages.slice(0, 2));
    expect(projection.compactionPlan?.coverage).toEqual({
      retainedFromMessageId: 'user-current',
    });
  });
});
