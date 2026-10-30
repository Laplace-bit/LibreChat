import { UsageEvents } from 'librechat-data-provider';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { PiRuntimeResponseError, createPiContentEventTranslator } from './events';

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'librechat-openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 50,
      output: 10,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 80,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
    ...overrides,
  };
}

describe('createPiContentEventTranslator usage mapping', () => {
  it('maps Pi cache token semantics to the host usage contract and trusted attribution', () => {
    const translate = createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'step-1',
        index: 0,
        messageId: 'message-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      usageAttribution: { provider: 'openAI', agentId: 'agent-1' },
    });

    expect(
      translate({
        type: 'agent_end',
        messages: [assistantMessage()],
        willRetry: false,
      }),
    ).toEqual([
      {
        event: UsageEvents.ON_TOKEN_USAGE,
        data: {
          input_tokens: 70,
          output_tokens: 10,
          total_tokens: 80,
          model: 'gpt-4o-mini',
          provider: 'openAI',
          agentId: 'agent-1',
          input_token_details: { cache_read: 20 },
        },
      },
    ]);
  });

  it('fails closed when provider usage is inconsistent or a non-retried tool call is unsupported', () => {
    const translate = createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'step-1',
        index: 0,
        messageId: 'message-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
    });

    expect(() =>
      translate({
        type: 'agent_end',
        messages: [assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: 99 } })],
        willRetry: false,
      }),
    ).toThrow(PiRuntimeResponseError);
    expect(() =>
      translate({
        type: 'agent_end',
        messages: [
          assistantMessage({
            content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }],
            stopReason: 'toolUse',
          }),
        ],
        willRetry: false,
      }),
    ).toThrow(PiRuntimeResponseError);
  });
});
