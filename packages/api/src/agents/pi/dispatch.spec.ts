import { Tools } from 'librechat-data-provider';
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
