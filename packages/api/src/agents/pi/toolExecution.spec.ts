import { StepEvents, StepTypes, Tools } from 'librechat-data-provider';
import {
  GraphEvents,
  type EventHandler,
  type ToolExecuteBatchRequest,
  type ToolExecuteResult,
} from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import type { PiHostEvent } from './events';
import { createPiHostToolBatchExecutor } from './hostToolBatch';
import { createPiHostToolExecutor } from './toolExecution';
import { createPiHostEventSequencer } from './bridge';
import { createPiTools } from './tools';

const fileSearchDefinition: LCTool = {
  name: Tools.file_search,
  description: 'Search files attached to this agent.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function isToolExecuteBatchRequest(
  data: Parameters<EventHandler['handle']>[1],
): data is ToolExecuteBatchRequest {
  return (
    data != null &&
    typeof data === 'object' &&
    'toolCalls' in data &&
    'resolve' in data &&
    typeof data.resolve === 'function'
  );
}

function createAuthorizedHandler(
  result: ToolExecuteResult,
  batches: ToolExecuteBatchRequest[],
): EventHandler {
  return {
    handle: async (_event, data) => {
      if (!isToolExecuteBatchRequest(data)) {
        throw new Error('Expected the host tool batch.');
      }
      batches.push(data);
      data.resolve([{ ...result, toolCallId: data.toolCalls[0]?.id ?? '' }]);
    },
  };
}

function createHarness(result: ToolExecuteResult) {
  const events: PiHostEvent[] = [];
  const batches: ToolExecuteBatchRequest[] = [];
  const eventSequencer = createPiHostEventSequencer((event) => {
    events.push(event);
  });
  const executeHostToolCall = createPiHostToolBatchExecutor({
    handler: createAuthorizedHandler(result, batches),
    userId: 'user-1',
    agentId: 'agent-1',
    request: { user: { id: 'user-1' } },
    threadId: 'thread-1',
    runId: 'run-1',
    metadata: {},
  });
  const executePiTool = createPiHostToolExecutor({
    createStepIdentity: () => ({
      id: 'pi-step-1',
      index: 3,
      messageId: 'response-1',
      runId: 'run-1',
      agentId: 'agent-1',
    }),
    createToolCallId: () => 'host-call-1',
    executeHostToolCall,
    handleHostEvent: eventSequencer.enqueue,
    now: () => 42,
  });
  const [tool] = createPiTools({ definitions: [fileSearchDefinition], execute: executePiTool });

  return { batches, events, eventSequencer, tool };
}

describe('createPiHostToolExecutor', () => {
  it('routes Pi file_search through the host handler and emits ordered LibreChat tool events', async () => {
    const hostResult: ToolExecuteResult = {
      toolCallId: 'host-call-1',
      status: 'success',
      content: 'Found the maintenance manual.',
    };
    const { batches, events, eventSequencer, tool } = createHarness(hostResult);

    const result = await tool.execute('pi-call-1', { query: 'maintenance manual' });
    await eventSequencer.drain();

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Found the maintenance manual.' }],
      details: { status: 'success' },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.toolCalls[0]).toMatchObject({
      id: 'host-call-1',
      name: Tools.file_search,
      args: { query: 'maintenance manual' },
      stepId: 'pi-step-1',
    });
    expect(events.map(({ event }) => event)).toEqual([
      GraphEvents.ON_RUN_STEP,
      StepEvents.ON_TOOL_CALLS_DISPATCHED,
      GraphEvents.ON_RUN_STEP_COMPLETED,
      GraphEvents.ON_RUN_STEP_CLOSED,
    ]);
    expect(events[0]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP,
      data: {
        id: 'pi-step-1',
        index: 3,
        type: StepTypes.TOOL_CALLS,
        stepDetails: {
          tool_calls: [
            {
              id: 'host-call-1',
              function: { name: Tools.file_search, arguments: { query: 'maintenance manual' } },
            },
          ],
        },
      },
    });
    expect(events[2]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          id: 'pi-step-1',
          tool_call: {
            id: 'host-call-1',
            output: 'Found the maintenance manual.',
          },
        },
      },
    });
    expect(events[3]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_CLOSED,
      data: { id: 'pi-step-1', status: 'completed' },
    });
  });

  it('does not forward an arbitrary host error message to Pi', async () => {
    const hostResult: ToolExecuteResult = {
      toolCallId: 'host-call-1',
      status: 'error',
      content: '',
      errorMessage: 'credential=private-secret',
    };
    const { eventSequencer, tool } = createHarness(hostResult);

    const result = await tool.execute('pi-call-1', { query: 'maintenance manual' });
    await eventSequencer.drain();

    expect(result).toEqual({
      content: [{ type: 'text', text: 'The tool could not complete this request.' }],
      details: { status: 'error' },
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('settles a cancelled host tool step and returns only a safe AbortError', async () => {
    const controller = new AbortController();
    const events: PiHostEvent[] = [];
    const eventSequencer = createPiHostEventSequencer((event) => {
      events.push(event);
    });
    const executePiTool = createPiHostToolExecutor({
      createStepIdentity: () => ({
        id: 'pi-step-1',
        index: 0,
        messageId: 'response-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      createToolCallId: () => 'host-call-1',
      executeHostToolCall: async (_call, signal) =>
        new Promise<ToolExecuteResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('private cancellation detail');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
      handleHostEvent: eventSequencer.enqueue,
    });

    const [tool] = createPiTools({ definitions: [fileSearchDefinition], execute: executePiTool });
    const execution = tool.execute('pi-call-1', { query: 'maintenance manual' }, controller.signal);
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Pi tool execution was aborted',
    });
    await eventSequencer.drain();
    expect(events[events.length - 1]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_CLOSED,
      data: { id: 'pi-step-1', status: 'cancelled' },
    });
    expect(JSON.stringify(events)).not.toContain('private cancellation detail');
  });
});
