import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes, UsageEvents } from 'librechat-data-provider';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  PiProviderResponseError,
  PiRuntimeResponseError,
  createPiContentEventTranslator,
} from './events';

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
      usageAttribution: { provider: 'openAI', agentId: 'agent-1', runId: 'response-1' },
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
          runId: 'response-1',
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

  it('reports terminal provider failures to the host observer before rejecting the turn', () => {
    const onModelProviderError = jest.fn();
    const translate = createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'step-1',
        index: 0,
        messageId: 'message-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      onModelProviderError,
    });
    const failure = assistantMessage({
      stopReason: 'error',
      errorMessage: '503: provider unavailable',
    });

    let thrown: unknown;
    try {
      translate({ type: 'agent_end', messages: [failure], willRetry: false });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PiProviderResponseError);
    expect(thrown).toMatchObject({ status: 503, statusCode: 503 });
    expect(onModelProviderError).toHaveBeenCalledWith(thrown);
  });

  it('treats a registered host tool call as a completed assistant message and accounts for usage', () => {
    const translate = createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'message-step-1',
        index: 0,
        messageId: 'message-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      supportedToolNames: ['file_search'],
      now: () => 42,
    });

    expect(translate({ type: 'message_start', message: assistantMessage() })).toEqual([]);
    expect(
      translate({
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Searching',
          partial: assistantMessage(),
        },
      }),
    ).toEqual([
      {
        event: GraphEvents.ON_RUN_STEP,
        data: expect.objectContaining({ id: 'message-step-1', status: 'in_progress' }),
      },
      {
        event: GraphEvents.ON_MESSAGE_DELTA,
        data: {
          id: 'message-step-1',
          delta: { content: [{ type: ContentTypes.TEXT, text: 'Searching' }] },
        },
      },
    ]);
    expect(
      translate({
        type: 'message_end',
        message: assistantMessage({ stopReason: 'toolUse' }),
      }),
    ).toEqual([
      {
        event: GraphEvents.ON_RUN_STEP_CLOSED,
        data: {
          id: 'message-step-1',
          index: 0,
          type: StepTypes.MESSAGE_CREATION,
          status: 'completed',
          created_at: 42,
          closed_at: 42,
          runId: 'run-1',
          agentId: 'agent-1',
        },
      },
    ]);
    expect(
      translate({
        type: 'agent_end',
        messages: [
          assistantMessage({
            content: [
              {
                type: 'toolCall',
                id: 'tool-1',
                name: 'file_search',
                arguments: { query: 'manual' },
              },
            ],
            stopReason: 'toolUse',
          }),
        ],
        willRetry: false,
      }),
    ).toMatchObject([{ event: UsageEvents.ON_TOKEN_USAGE, data: { total_tokens: 80 } }]);
  });
});

describe('createPiContentEventTranslator summarize-only mapping', () => {
  const summaryOnly = {
    agentId: 'agent-1',
    provider: 'openAI',
    model: 'gpt-4o-mini',
    messagesToRefineCount: 4,
    summaryVersion: 3,
    streamDeltas: true,
    countSummaryTokens: jest.fn(() => 23),
  };

  function createTranslator(
    overrides: Partial<typeof summaryOnly> & {
      coverage?: { retainedFromMessageId: string };
      onComplete?: (summaryText: string, summaryTokenCount: number) => void;
    } = {},
  ) {
    return createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'summary-step-1',
        index: 2,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      }),
      usageAttribution: { provider: 'openAI', agentId: 'agent-1', runId: 'response-1' },
      summaryOnly: { ...summaryOnly, countSummaryTokens: jest.fn(() => 23), ...overrides },
      now: () => 42,
    });
  }

  it('maps a summarize-only Pi turn to the durable summary step and completion contract', () => {
    const translate = createTranslator();
    expect(translate({ type: 'message_start', message: assistantMessage() })).toEqual([
      {
        event: GraphEvents.ON_RUN_STEP,
        data: expect.objectContaining({
          id: 'summary-step-1',
          index: 2,
          status: 'in_progress',
          summary: { type: ContentTypes.SUMMARY, provider: 'openAI', model: 'gpt-4o-mini' },
        }),
      },
      {
        event: GraphEvents.ON_SUMMARIZE_START,
        data: {
          agentId: 'agent-1',
          provider: 'openAI',
          model: 'gpt-4o-mini',
          messagesToRefineCount: 4,
          summaryVersion: 3,
        },
      },
    ]);
    expect(
      translate({
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Checkpoint text',
          partial: assistantMessage(),
        },
      }),
    ).toEqual([
      {
        event: GraphEvents.ON_SUMMARIZE_DELTA,
        data: {
          id: 'summary-step-1',
          delta: {
            summary: {
              type: ContentTypes.SUMMARY,
              provider: 'openAI',
              model: 'gpt-4o-mini',
              content: [{ type: ContentTypes.TEXT, text: 'Checkpoint text' }],
            },
          },
        },
      },
    ]);
    expect(
      translate({ type: 'agent_end', messages: [assistantMessage()], willRetry: false }),
    ).toEqual([
      {
        event: GraphEvents.ON_SUMMARIZE_COMPLETE,
        data: {
          id: 'summary-step-1',
          agentId: 'agent-1',
          summary: {
            type: ContentTypes.SUMMARY,
            provider: 'openAI',
            model: 'gpt-4o-mini',
            content: [{ type: ContentTypes.TEXT, text: 'Checkpoint text' }],
            tokenCount: 23,
            summaryVersion: 3,
            boundary: { messageId: 'summary-step-1', contentIndex: 2 },
            createdAt: new Date(42).toISOString(),
          },
        },
      },
      {
        event: GraphEvents.ON_RUN_STEP_CLOSED,
        data: expect.objectContaining({ id: 'summary-step-1', status: 'completed' }),
      },
      {
        event: UsageEvents.ON_TOKEN_USAGE,
        data: expect.objectContaining({ usage_type: 'summarization', provider: 'openAI' }),
      },
    ]);
  });

  it('persists an explicit retained-message coverage anchor for automatic compaction', () => {
    const onComplete = jest.fn();
    const translate = createTranslator({
      coverage: { retainedFromMessageId: 'user-retained-1' },
      onComplete,
    });
    translate({ type: 'message_start', message: assistantMessage() });
    translate({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Checkpoint text',
        partial: assistantMessage(),
      },
    });

    const completed = translate({
      type: 'agent_end',
      messages: [assistantMessage()],
      willRetry: false,
    });

    expect(completed[0]).toMatchObject({
      event: GraphEvents.ON_SUMMARIZE_COMPLETE,
      data: {
        summary: {
          coverage: { retainedFromMessageId: 'user-retained-1' },
        },
      },
    });
    expect(onComplete).toHaveBeenCalledWith('Checkpoint text', 23);
  });

  it('withholds deltas when configured and persists a typed empty-output failure', () => {
    const translate = createTranslator({ streamDeltas: false });
    translate({ type: 'message_start', message: assistantMessage() });
    expect(
      translate({
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'only appears at completion',
          partial: assistantMessage(),
        },
      }),
    ).toEqual([]);
    const success = translate({
      type: 'agent_end',
      messages: [assistantMessage()],
      willRetry: false,
    });
    expect(success).toContainEqual(
      expect.objectContaining({
        event: GraphEvents.ON_SUMMARIZE_COMPLETE,
        data: expect.objectContaining({
          summary: expect.objectContaining({
            content: [{ type: ContentTypes.TEXT, text: 'only appears at completion' }],
          }),
        }),
      }),
    );

    const emptyTranslate = createTranslator();
    emptyTranslate({ type: 'message_start', message: assistantMessage() });
    expect(
      emptyTranslate({ type: 'agent_end', messages: [assistantMessage()], willRetry: false }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: GraphEvents.ON_SUMMARIZE_COMPLETE,
          data: expect.objectContaining({ error: 'Summarization produced empty output' }),
        }),
        expect.objectContaining({
          event: GraphEvents.ON_RUN_STEP_CLOSED,
          data: expect.objectContaining({ status: 'failed' }),
        }),
      ]),
    );
  });

  it('marks provider failures and cancellation with terminal summary step status', () => {
    const onModelProviderError = jest.fn();
    const translate = createPiContentEventTranslator({
      createStepIdentity: () => ({
        id: 'summary-step-1',
        index: 0,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      }),
      summaryOnly,
      onModelProviderError,
    });
    translate({ type: 'message_start', message: assistantMessage() });
    const failure = translate({
      type: 'agent_end',
      messages: [assistantMessage({ stopReason: 'error', errorMessage: '503: unavailable' })],
      willRetry: false,
    });
    expect(onModelProviderError).toHaveBeenCalledWith(expect.any(PiProviderResponseError));
    expect(failure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: GraphEvents.ON_SUMMARIZE_COMPLETE,
          data: expect.objectContaining({
            error: 'Summarization failed before producing a complete checkpoint',
          }),
        }),
        expect.objectContaining({
          event: GraphEvents.ON_RUN_STEP_CLOSED,
          data: expect.objectContaining({ status: 'failed' }),
        }),
      ]),
    );

    const cancelled = createTranslator();
    cancelled({ type: 'message_start', message: assistantMessage() });
    expect(
      cancelled({
        type: 'agent_end',
        messages: [assistantMessage({ stopReason: 'aborted' })],
        willRetry: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: GraphEvents.ON_RUN_STEP_CLOSED,
          data: expect.objectContaining({ status: 'cancelled' }),
        }),
      ]),
    );
  });

  it('isolates streamed text from a provider attempt that is retried', () => {
    const createStepIdentity = jest
      .fn()
      .mockImplementationOnce(() => ({
        id: 'summary-step-attempt-1',
        index: 2,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      }))
      .mockImplementationOnce(() => ({
        id: 'summary-step-attempt-2',
        index: 3,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      }));
    const translate = createPiContentEventTranslator({ createStepIdentity, summaryOnly });
    translate({ type: 'message_start', message: assistantMessage() });
    translate({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'failed attempt fragment',
        partial: assistantMessage(),
      },
    });

    expect(
      translate({
        type: 'agent_end',
        messages: [assistantMessage({ stopReason: 'error', errorMessage: 'temporary failure' })],
        willRetry: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: GraphEvents.ON_SUMMARIZE_COMPLETE,
          data: expect.objectContaining({
            id: 'summary-step-attempt-1',
            error: expect.stringContaining('retried'),
          }),
        }),
        expect.objectContaining({
          event: GraphEvents.ON_RUN_STEP_CLOSED,
          data: expect.objectContaining({ id: 'summary-step-attempt-1', status: 'failed' }),
        }),
      ]),
    );

    translate({ type: 'message_start', message: assistantMessage() });
    translate({
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'successful checkpoint',
        partial: assistantMessage(),
      },
    });
    const completion = translate({
      type: 'agent_end',
      messages: [assistantMessage()],
      willRetry: false,
    });

    expect(completion).toContainEqual(
      expect.objectContaining({
        event: GraphEvents.ON_SUMMARIZE_COMPLETE,
        data: expect.objectContaining({
          id: 'summary-step-attempt-2',
          summary: expect.objectContaining({
            content: [{ type: ContentTypes.TEXT, text: 'successful checkpoint' }],
          }),
        }),
      }),
    );
    expect(completion).not.toContainEqual(
      expect.objectContaining({
        event: GraphEvents.ON_SUMMARIZE_COMPLETE,
        data: expect.objectContaining({
          summary: expect.objectContaining({
            content: [
              { type: ContentTypes.TEXT, text: 'failed attempt fragment successful checkpoint' },
            ],
          }),
        }),
      }),
    );
  });
});
