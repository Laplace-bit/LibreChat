import { Tools } from 'librechat-data-provider';
import type { PiExecuteTurnInput, PiResumeTurnInput } from './dispatcher';
import type { PiGenerationDispatchResult } from '../pi/dispatch';
import { AgentRuntimeUnavailableError, PINNED_PI_AGENT_RUNTIME } from './selection';
import { createAgentRuntimeDispatcher } from './dispatcher';

describe('createAgentRuntimeDispatcher', () => {
  function createPiInput(): PiExecuteTurnInput {
    return {
      messages: [],
      createModelBinding: async () => {
        throw new Error('This dispatcher test does not create a model binding.');
      },
      createStepIdentity: () => ({
        id: 'step-1',
        index: 0,
        messageId: 'message-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      handleHostEvent: () => undefined,
    };
  }

  const continuation: NonNullable<PiResumeTurnInput['resumeToolResult']>['continuation'] = {
    version: 1,
    actionId: 'action-1',
    piToolCallId: 'pi-call-1',
    hostToolCallId: 'host-call-1',
    toolTurn: 0,
    toolName: Tools.file_search,
    args: { query: 'manual' },
    allowedDecisions: ['approve', 'reject', 'edit', 'respond'],
    stepIdentity: {
      id: 'tool-step-1',
      index: 0,
      messageId: 'message-1',
      runId: 'run-1',
      agentId: 'agent-1',
    },
    stepCreatedAt: 1,
  };

  it('dispatches a new Agent turn to Pi only', async () => {
    const outcome: PiGenerationDispatchResult = { status: 'completed', usage: [] };
    const executePiGeneration = jest.fn(async () => outcome);
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });
    const input = createPiInput();

    await expect(
      dispatcher.executeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input,
      }),
    ).resolves.toBe(outcome);
    expect(executePiGeneration).toHaveBeenCalledWith(input);
  });

  it('resumes only through Pi with a validated host-tool continuation', async () => {
    const outcome: PiGenerationDispatchResult = { status: 'completed', usage: [] };
    const executePiGeneration = jest.fn(async () => outcome);
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });
    const input: PiResumeTurnInput = {
      ...createPiInput(),
      resumeToolResult: {
        continuation,
        toolArguments: continuation.args,
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      },
    };

    await expect(
      dispatcher.resumeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input,
      }),
    ).resolves.toBe(outcome);
    expect(executePiGeneration).toHaveBeenCalledWith(input);
  });

  it('rejects missing continuation data on resume', async () => {
    const executePiGeneration = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });

    await expect(
      dispatcher.resumeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input: createPiInput() as never,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(executePiGeneration).not.toHaveBeenCalled();
  });

  it('rejects continuation data on a new turn', async () => {
    const executePiGeneration = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });
    const input = {
      ...createPiInput(),
      resumeToolResult: { continuation: {}, toolArguments: {}, execute: jest.fn() },
    } as never;

    await expect(
      dispatcher.executeTurn({
        engine: 'pi',
        selection: PINNED_PI_AGENT_RUNTIME,
        input,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(executePiGeneration).not.toHaveBeenCalled();
  });

  it('rejects Legacy commands instead of falling back to the old engine', async () => {
    const executePiGeneration = jest.fn();
    const dispatcher = createAgentRuntimeDispatcher({ executePiGeneration });

    await expect(
      dispatcher.executeTurn({
        engine: 'legacy',
        selection: { engine: 'legacy' },
      } as never),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    await expect(
      dispatcher.resumeTurn({
        engine: 'legacy',
        selection: { engine: 'legacy' },
      } as never),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(executePiGeneration).not.toHaveBeenCalled();
  });
});
