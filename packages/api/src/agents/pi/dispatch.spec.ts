import { GraphEvents } from '@librechat/agents';
import { Tools, UsageEvents } from 'librechat-data-provider';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { LCTool } from '@librechat/agents';
import type { PiGenerationExecutorInput } from './execution';
import type { PiGenerationDispatchInput } from './dispatch';
import type { PiModelBinding } from './session';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { PiContextBudgetExceededError } from './contextUsage';
import { PiAutomaticSummaryFailedError } from './dispatch';
import { createPiGenerationDispatcher } from './dispatch';
import { createPiHistoryPruningOptions } from './pruning';
import { ASK_USER_QUESTION_TOOL_NAME } from './toolNames';

const fileSearchDefinition: LCTool = {
  name: Tools.file_search,
  description: 'Search agent files.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function input(overrides: Partial<PiGenerationDispatchInput> = {}): PiGenerationDispatchInput {
  return {
    messages: [],
    createModelBinding: async (): Promise<PiModelBinding> => {
      throw new Error('Unsupported Pi tool configurations must fail before binding creation.');
    },
    createStepIdentity: () => ({
      id: 'step-1',
      index: 0,
      messageId: 'message-1',
      runId: 'run-1',
      agentId: 'agent-1',
    }),
    handleHostEvent: () => undefined,
    ...overrides,
  };
}

describe('createPiGenerationDispatcher tool preflight', () => {
  it('fails before model binding when a host tool handler is unavailable', async () => {
    const execute = jest.fn(async (_input: PiGenerationExecutorInput) => ({
      status: 'completed' as const,
    }));
    const createModelBinding = jest.fn(async (): Promise<PiModelBinding> => {
      throw new Error('must not create a model binding');
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(input({ toolDefinitions: [fileSearchDefinition], createModelBinding })),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(createModelBinding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails before model binding when a callable tool has no reviewed adapter', async () => {
    const execute = jest.fn(async (_input: PiGenerationExecutorInput) => ({
      status: 'completed' as const,
    }));
    const createModelBinding = jest.fn(async (): Promise<PiModelBinding> => {
      throw new Error('must not create a model binding');
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          toolDefinitions: [{ name: 'calculator' }],
          executeHostToolCall: async () => {
            throw new Error('must not execute an unsupported tool');
          },
          createToolStepIdentity: () => ({
            id: 'step-2',
            index: 0,
            messageId: 'message-1',
            runId: 'run-1',
            agentId: 'agent-1',
          }),
          createToolCallId: () => 'call-1',
          createModelBinding,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(createModelBinding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('createPiGenerationDispatcher approval continuation', () => {
  const continuation = {
    version: 1 as const,
    actionId: 'action-1',
    piToolCallId: 'pi-call-1',
    hostToolCallId: 'host-call-1',
    toolTurn: 0,
    toolName: Tools.file_search as typeof Tools.file_search,
    args: { query: 'maintenance manual' },
    allowedDecisions: ['approve', 'reject', 'edit', 'respond'] as const,
    stepIdentity: {
      id: 'tool-step-1',
      index: 1,
      messageId: 'message-1',
      runId: 'run-1',
      agentId: 'agent-1',
    },
    stepCreatedAt: 100,
  };

  function createModelBinding(): Promise<PiModelBinding> {
    return Promise.resolve({
      model: {
        api: 'openai-responses',
        provider: 'librechat-openai',
        id: 'gpt-4o-mini',
      } as PiModelBinding['model'],
      modelRuntime: {} as PiModelBinding['modelRuntime'],
      dispose: jest.fn(),
    });
  }

  it('forwards the session-created lifecycle boundary to the Pi executor', async () => {
    const onSessionCreated = jest.fn();
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      value.onSessionCreated?.();
      return { status: 'completed' as const };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage('hello')],
          createModelBinding,
          onSessionCreated,
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].onSessionCreated).toBe(onSessionCreated);
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
  });

  it('forwards mixed text and image prompts to the executor in source order', async () => {
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
      { type: 'text', text: 'after' },
    ];
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      expect(value.operation).toEqual({
        kind: 'ordered_prompt',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', mimeType: 'image/png', data: 'YQ==' },
          { type: 'text', text: 'after' },
        ],
      });
      return { status: 'completed' as const };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage({ content })],
          createModelBinding: async () => ({
            model: {
              api: 'openai-responses',
              provider: 'librechat-openai',
              id: 'gpt-4o-mini',
            } as PiModelBinding['model'],
            modelRuntime: {} as PiModelBinding['modelRuntime'],
            dispose: jest.fn(),
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('executes the approved host result once and continues the exact Pi tool call', async () => {
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      expect(value.operation).toEqual({ kind: 'continue_tool_result', toolCallId: 'pi-call-1' });
      expect(value.history?.map(({ role }) => role)).toEqual(['user', 'assistant', 'toolResult']);
      return { status: 'completed' as const };
    });
    const executeApprovedTool = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Found two manuals.' }],
      isError: false,
    }));
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage('Find the maintenance manual.')],
          createModelBinding,
          resumeToolResult: {
            continuation,
            toolArguments: continuation.args,
            execute: executeApprovedTool,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(executeApprovedTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the approved host tool does not produce a result', async () => {
    const execute = jest.fn(async (_value: PiGenerationExecutorInput) => ({
      status: 'completed' as const,
    }));
    const executeApprovedTool = jest.fn(async () => undefined as never);
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage('Find the maintenance manual.')],
          createModelBinding,
          resumeToolResult: {
            continuation,
            toolArguments: continuation.args,
            execute: executeApprovedTool,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(executeApprovedTool).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('createPiGenerationDispatcher context pruning', () => {
  it('executes and reports context usage from the same pruned provider history', async () => {
    const messages = [
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
    const tokenCounter = (message: BaseMessage) =>
      JSON.stringify({
        content: message.content,
        toolCalls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
      }).length;
    const indexTokenCountMap = Object.fromEntries(
      messages.map((message, index) => [index, tokenCounter(message)]),
    );
    const events: Array<{ event: string; data: unknown }> = [];
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const toolResult = value.history?.find((message) => message.role === 'toolResult');
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult?.content).length).toBeLessThan(
        JSON.stringify(messages[2].content).length,
      );
      return { status: 'completed' as const };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages,
          createModelBinding: async () => ({
            model: {
              api: 'openai-responses',
              provider: 'librechat-openai',
              id: 'gpt-4o-mini',
              contextWindow: 4_096,
              maxTokens: 4_096,
            } as PiModelBinding['model'],
            modelRuntime: {} as PiModelBinding['modelRuntime'],
            dispose: jest.fn(),
          }),
          handleHostEvent: async (event) => {
            events.push(event);
          },
          contextUsage: {
            tokenCounter,
            runId: 'run-1',
            agentId: 'agent-1',
            maxContextTokens: 10_000,
            reserveRatio: 0,
            calibrationRatio: 1,
          },
          contextPruning: {
            indexTokenCountMap,
            maxContextTokens: 10_000,
            reserveRatio: 0,
            calibrationRatio: 1,
            maxToolResultChars: 100,
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });

    const contextEvent = events.find((event) => event.event === UsageEvents.ON_CONTEXT_USAGE);
    expect(contextEvent).toBeDefined();
    expect(
      (contextEvent?.data as { breakdown: { messageTokens: number } }).breakdown.messageTokens,
    ).toBeLessThan(messages.reduce((total, message) => total + tokenCounter(message), 0));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when fitting the budget would require dropping host history', async () => {
    const messages = [
      new HumanMessage('Earlier question '.repeat(8)),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'lookup', args: { query: 'machine status' } }],
      }),
      new ToolMessage({
        content: 'authorized result '.repeat(30),
        name: 'lookup',
        tool_call_id: 'call-1',
      }),
      new HumanMessage('What should I do next? '.repeat(8)),
    ];
    const tokenCounter = (message: BaseMessage) =>
      JSON.stringify({
        content: message.content,
        toolCalls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
      }).length;
    const indexTokenCountMap = Object.fromEntries(
      messages.map((message, index) => [index, tokenCounter(message)]),
    );
    const execute = jest.fn(async (_input: PiGenerationExecutorInput) => ({
      status: 'completed' as const,
    }));
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages,
          createModelBinding: async () => ({
            model: {
              api: 'openai-responses',
              provider: 'librechat-openai',
              id: 'gpt-4o-mini',
              contextWindow: 4_096,
              maxTokens: 4_096,
            } as PiModelBinding['model'],
            modelRuntime: {} as PiModelBinding['modelRuntime'],
            dispose: jest.fn(),
          }),
          contextUsage: {
            tokenCounter,
            runId: 'run-1',
            agentId: 'agent-1',
            maxContextTokens: 80,
            reserveRatio: 0,
            calibrationRatio: 1,
          },
          contextPruning: {
            indexTokenCountMap,
            maxContextTokens: 80,
            reserveRatio: 0,
            calibrationRatio: 1,
            maxToolResultChars: 50,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PiContextBudgetExceededError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('createPiGenerationDispatcher ask-user pause', () => {
  const createModelBinding = async (): Promise<PiModelBinding> => ({
    model: {
      api: 'openai-responses',
      provider: 'librechat-openai',
      id: 'gpt-4o-mini',
    } as PiModelBinding['model'],
    modelRuntime: {} as PiModelBinding['modelRuntime'],
    dispose: jest.fn(),
  });

  it('routes ask-user through the host pause controller without invoking a host tool', async () => {
    const args = { questions: [{ id: 'plant_code', question: 'Which plant?' }] };
    const executeHostToolCall = jest.fn(async () => {
      throw new Error('ask_user_question must not invoke the host tool batch');
    });
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const askTool = value.tools.find(({ name }) => name === ASK_USER_QUESTION_TOOL_NAME);
      if (askTool == null) throw new Error('Pi ask-user tool was not registered');
      const result = await askTool.execute('pi-ask-call-1', args);
      expect(result.details).toEqual({ status: 'paused' });
      const pause = value.pauseController?.signal;
      if (pause?.kind !== 'ask_user_question') {
        throw new Error('Pi ask-user invocation did not raise its durable host pause');
      }
      return { status: 'paused' as const, signal: pause };
    });
    const dispatch = createPiGenerationDispatcher({ execute });
    const result = await dispatch(
      input({
        messages: [new HumanMessage('Pick a plant.')],
        createModelBinding,
        toolDefinitions: [{ name: ASK_USER_QUESTION_TOOL_NAME, description: 'Ask user.' }],
        executeHostToolCall,
        createToolStepIdentity: () => ({
          id: 'host-ask-step-1',
          index: 2,
          messageId: 'message-1',
          runId: 'run-1',
          agentId: 'agent-1',
        }),
        createToolCallId: () => 'host-ask-call-1',
        askUserQuestionEnabled: true,
      }),
    );

    expect(result).toMatchObject({
      status: 'paused',
      signal: {
        kind: 'ask_user_question',
        toolCall: {
          toolCallId: 'pi-ask-call-1',
          hostExecution: { toolCallId: 'host-ask-call-1' },
        },
      },
    });
    expect(executeHostToolCall).not.toHaveBeenCalled();
  });
});

describe('createPiGenerationDispatcher caller tool handoff', () => {
  const createModelBinding = async (): Promise<PiModelBinding> => ({
    model: {
      api: 'openai-responses',
      provider: 'librechat-openai',
      id: 'gpt-4o-mini',
    } as PiModelBinding['model'],
    modelRuntime: {} as PiModelBinding['modelRuntime'],
    dispose: jest.fn(),
  });

  it('returns exact caller function identity and JSON arguments without host execution', async () => {
    const executeHostToolCall = jest.fn(async () => {
      throw new Error('caller-owned functions must never execute on the server');
    });
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const tool = value.tools.find(({ name }) => name === 'lookup_order');
      if (tool == null) throw new Error('caller function was not registered');
      const result = await tool.execute('call_exact_1', { order: 'WO-42' });
      expect(result.terminate).toBe(true);
      const call = value.getCallerToolHandoff?.();
      if (call == null) throw new Error('caller function did not request handoff');
      return { status: 'caller_tool_handoff' as const, call };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage('Look up work order WO-42.')],
          createModelBinding,
          clientToolDefinitions: [
            {
              name: 'lookup_order',
              description: 'Look up a work order.',
              parameters: {
                type: 'object',
                properties: { order: { type: 'string' } },
                required: ['order'],
                additionalProperties: false,
              },
            },
          ],
          executeHostToolCall,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'caller_tool_handoff',
      call: {
        callId: 'call_exact_1',
        name: 'lookup_order',
        arguments: '{"order":"WO-42"}',
      },
    });
    expect(executeHostToolCall).not.toHaveBeenCalled();
  });

  it('rejects invalid caller arguments before exposing a handoff', async () => {
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const tool = value.tools.find(({ name }) => name === 'lookup_order');
      if (tool == null) throw new Error('caller function was not registered');
      await expect(tool.execute('call-invalid', { order: 42 })).rejects.toMatchObject({
        code: 'PI_TOOL_ARGUMENTS_INVALID',
      });
      return { status: 'completed' as const };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [new HumanMessage('Lookup the order.')],
          createModelBinding,
          clientToolDefinitions: [
            {
              name: 'lookup_order',
              parameters: {
                type: 'object',
                properties: { order: { type: 'string' } },
                required: ['order'],
              },
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('createPiGenerationDispatcher automatic summarization', () => {
  async function emitSummary(value: PiGenerationExecutorInput): Promise<void> {
    const assistant = {
      role: 'assistant' as const,
      content: [],
      api: 'openai-responses',
      provider: 'openAI',
      model: 'gpt-4o-mini',
      usage: {
        input: 4,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop' as const,
      timestamp: 1,
    };
    for (const event of value.translateEvent({ type: 'message_start', message: assistant })) {
      await value.handleHostEvent(event);
    }
    for (const event of value.translateEvent({
      type: 'message_update',
      message: assistant,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Saved checkpoint',
        partial: assistant,
      },
    })) {
      await value.handleHostEvent(event);
    }
    for (const event of value.translateEvent({
      type: 'agent_end',
      messages: [assistant],
      willRetry: false,
    })) {
      await value.handleHostEvent(event);
    }
  }

  function createAutoSummaryInput() {
    const messages = [
      new HumanMessage({ content: 'older user turn '.repeat(10), id: 'user-old' }),
      new AIMessage({ content: 'older assistant turn '.repeat(10), id: 'assistant-old' }),
      new HumanMessage({ content: 'current user question', id: 'user-current' }),
    ];
    for (const message of messages) {
      message.additional_kwargs.sourceMessageId = message.id;
    }
    const tokenCounter = (message: BaseMessage) => JSON.stringify(message.content).length;
    const indexTokenCountMap = Object.fromEntries(
      messages.map((message, index) => [index, tokenCounter(message)]),
    );
    const contextPruning = createPiHistoryPruningOptions({
      indexTokenCountMap,
      systemPrefixCount: 0,
      maxContextTokens: 100,
      reserveRatio: 0,
      calibrationRatio: 1,
    });
    const dispose = jest.fn();
    const createModelBinding = jest.fn(
      async (): Promise<PiModelBinding> => ({
        model: {
          api: 'openai-responses',
          provider: 'openAI',
          id: 'gpt-4o-mini',
          contextWindow: 8192,
          maxTokens: 1024,
        } as PiModelBinding['model'],
        modelRuntime: {} as PiModelBinding['modelRuntime'],
        dispose,
      }),
    );
    const value = input({
      messages,
      createModelBinding,
      contextPruning,
      contextUsage: {
        tokenCounter,
        runId: 'response-1',
        agentId: 'agent-1',
        maxContextTokens: 8192,
      },
      usageAttribution: { provider: 'openAI', agentId: 'agent-1', runId: 'response-1' },
      autoSummary: {
        enabled: true,
        agentId: 'agent-1',
        agentProvider: 'openAI',
        agentModel: 'gpt-4o-mini',
        configuration: {},
        retainRecent: { turns: 1 },
        summaryVersion: 1,
        countSummaryTokens: () => 7,
        buildPrimaryMessages: ({ summaryText, retainedMessages }) => [
          new SystemMessage(`## Conversation Summary\n\n${summaryText}`),
          ...retainedMessages,
        ],
      },
    });
    return { value, createModelBinding, dispose };
  }

  it('sends the safe pruned suffix when the summary trigger is not met', async () => {
    const { value } = createAutoSummaryInput();
    if (value.autoSummary == null) {
      throw new Error('automatic summary test input must include a summary configuration');
    }
    value.autoSummary = {
      ...value.autoSummary,
      trigger: { type: 'messages_to_refine', value: 100 },
    };
    const execute = jest.fn(async (executorInput: PiGenerationExecutorInput) => {
      const binding = await executorInput.createModelBinding();
      try {
        expect(executorInput.operation).toEqual({
          kind: 'ordered_prompt',
          content: [{ type: 'text', text: 'current user question' }],
        });
        return { status: 'completed' as const };
      } finally {
        await binding.dispose();
      }
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(dispatch(value)).resolves.toMatchObject({ status: 'completed' });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('summarizes once, persists coverage, then starts the primary turn with the retained user prompt', async () => {
    const order: string[] = [];
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const binding = await value.createModelBinding();
      try {
        if (value.systemPrompt.length === 0) {
          await emitSummary(value);
          return { status: 'completed' as const };
        }

        order.push('primary-start');
        expect(value.systemPrompt).toContain('Saved checkpoint');
        expect(value.operation).toEqual({
          kind: 'ordered_prompt',
          content: [{ type: 'text', text: 'current user question' }],
        });
        return { status: 'completed' as const };
      } finally {
        await binding.dispose();
      }
    });
    const { value, createModelBinding } = createAutoSummaryInput();
    value.handleHostEvent = (event) => {
      if (event.event === GraphEvents.ON_SUMMARIZE_COMPLETE) {
        order.push('summary-complete');
        expect(event.data.summary?.coverage).toEqual({
          retainedFromMessageId: 'user-current',
        });
      }
    };
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(dispatch(value)).resolves.toMatchObject({ status: 'completed' });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['summary-complete', 'primary-start']);
    expect(createModelBinding).toHaveBeenCalledTimes(2);
  });

  it('does not start the primary turn when cancelled after the durable summary completes', async () => {
    const abortController = new AbortController();
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const binding = await value.createModelBinding();
      try {
        if (value.systemPrompt.length === 0) {
          await emitSummary(value);
          return { status: 'completed' as const };
        }
        return { status: 'completed' as const };
      } finally {
        await binding.dispose();
      }
    });
    const { value, createModelBinding, dispose } = createAutoSummaryInput();
    value.signal = abortController.signal;
    value.handleHostEvent = (event) => {
      if (event.event === GraphEvents.ON_SUMMARIZE_COMPLETE) {
        abortController.abort();
      }
    };
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(dispatch(value)).resolves.toMatchObject({ status: 'cancelled' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(createModelBinding).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not start the primary turn if the summary phase returns no completed summary', async () => {
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const binding = await value.createModelBinding();
      await binding.dispose();
      return { status: 'completed' as const };
    });
    const { value } = createAutoSummaryInput();
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(dispatch(value)).rejects.toBeInstanceOf(PiAutomaticSummaryFailedError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('createPiGenerationDispatcher summarize-only mode', () => {
  const createModelBinding = async (): Promise<PiModelBinding> => ({
    model: {
      api: 'openai-responses',
      provider: 'librechat-openai',
      id: 'gpt-4o-mini',
      maxTokens: 4096,
    } as PiModelBinding['model'],
    modelRuntime: {} as PiModelBinding['modelRuntime'],
    dispose: jest.fn(),
  });
  const summaryOnly: NonNullable<PiGenerationDispatchInput['summaryOnly']> = {
    settings: {
      provider: 'openAI',
      model: 'gpt-4o-mini',
      prompt: 'Checkpoint everything.',
      updatePrompt: 'Update the checkpoint.',
      maxSummaryTokens: 256,
      streamDeltas: true,
    },
    agentId: 'agent-1',
    messagesToRefineCount: 3,
    summaryVersion: 2,
    countSummaryTokens: () => 44,
  };

  it('rejects every executable capability before creating a model binding', async () => {
    const execute = jest.fn(async (_value: PiGenerationExecutorInput) => ({
      status: 'completed' as const,
    }));
    const createBinding = jest.fn(createModelBinding);
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          summaryOnly,
          askUserQuestionEnabled: true,
          createModelBinding: createBinding,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(createBinding).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs only the summary prompt and applies the configured output token ceiling', async () => {
    let disposed = false;
    const bindingFactory = async (): Promise<PiModelBinding> => ({
      ...(await createModelBinding()),
      dispose: () => {
        disposed = true;
      },
    });
    const execute = jest.fn(async (value: PiGenerationExecutorInput) => {
      const binding = await value.createModelBinding();
      expect(binding.model.maxTokens).toBe(256);
      expect(value.tools).toEqual([]);
      expect(value.systemPrompt).toBe('');
      expect(value.operation).toEqual({
        kind: 'ordered_prompt',
        content: [{ type: 'text', text: 'Checkpoint everything.' }],
      });
      expect(
        value.translateEvent({
          type: 'message_start',
          message: {
            role: 'assistant',
            content: [],
            api: 'openai-responses',
            provider: 'librechat-openai',
            model: 'gpt-4o-mini',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 1,
          },
        }),
      ).toHaveLength(2);
      await binding.dispose();
      return { status: 'completed' as const };
    });
    const dispatch = createPiGenerationDispatcher({ execute });

    await expect(
      dispatch(
        input({
          messages: [
            new HumanMessage('The conversation history.'),
            new HumanMessage('Checkpoint everything.'),
          ],
          createModelBinding: bindingFactory,
          summaryOnly,
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(disposed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
