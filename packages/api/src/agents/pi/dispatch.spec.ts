import { Tools } from 'librechat-data-provider';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { LCTool } from '@librechat/agents';
import type { PiGenerationExecutorInput } from './execution';
import type { PiGenerationDispatchInput } from './dispatch';
import type { PiModelBinding } from './session';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { createPiGenerationDispatcher } from './dispatch';

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
