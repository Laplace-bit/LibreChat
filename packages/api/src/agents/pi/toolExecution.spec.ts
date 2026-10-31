import { StepEvents, StepTypes, Tools } from 'librechat-data-provider';
import {
  Constants,
  GraphEvents,
  type EventHandler,
  type ToolExecuteBatchRequest,
  type ToolExecuteResult,
} from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import type { PiToolExecutionGate } from './toolExecution';
import type { PiCodeSessionBridge } from './codeSession';
import type { PiHostEvent } from './events';
import { createPiHostToolBatchExecutor } from './hostToolBatch';
import { createPiHostToolExecutor } from './toolExecution';
import { createPiCodeSessionBridge } from './codeSession';
import { PI_CALCULATOR_TOOL_NAME } from './toolNames';
import { createPiHostEventSequencer } from './bridge';
import { createPiPauseController } from './pause';
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

const calculatorDefinition: LCTool = {
  name: PI_CALCULATOR_TOOL_NAME,
  description: 'Evaluate an expression.',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
  },
};

const readFileDefinition: LCTool = {
  name: Constants.READ_FILE,
  description: 'Read a sandbox file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

function createHarness(
  result: ToolExecuteResult,
  evaluateTool?: PiToolExecutionGate,
  definition: LCTool = fileSearchDefinition,
  codeSessionBridge?: PiCodeSessionBridge,
) {
  const events: PiHostEvent[] = [];
  const batches: ToolExecuteBatchRequest[] = [];
  const pauseController = createPiPauseController();
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
    ...(codeSessionBridge == null ? {} : { codeSessionBridge }),
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
    ...(evaluateTool == null
      ? {}
      : { pauseGate: { controller: pauseController, evaluate: evaluateTool } }),
    now: () => 42,
  });
  const [tool] = createPiTools({ definitions: [definition], execute: executePiTool });

  return { batches, events, eventSequencer, pauseController, tool };
}

describe('createPiHostToolExecutor', () => {
  it('routes calculator calls through the host authorization and step lifecycle', async () => {
    const { batches, events, eventSequencer, tool } = createHarness(
      {
        toolCallId: 'host-call-1',
        status: 'success',
        content: '4',
      },
      undefined,
      calculatorDefinition,
    );

    const result = await tool.execute('pi-calc-1', { input: '2 + 2' });
    await eventSequencer.drain();

    expect(result).toEqual({
      content: [{ type: 'text', text: '4' }],
      details: { status: 'success' },
    });
    expect(batches[0]?.toolCalls[0]).toMatchObject({
      id: 'host-call-1',
      name: PI_CALCULATOR_TOOL_NAME,
      args: { input: '2 + 2' },
      stepId: 'pi-step-1',
    });
    expect(events.map(({ event }) => event)).toEqual([
      GraphEvents.ON_RUN_STEP,
      StepEvents.ON_TOOL_CALLS_DISPATCHED,
      GraphEvents.ON_RUN_STEP_COMPLETED,
      GraphEvents.ON_RUN_STEP_CLOSED,
    ]);
  });

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

  it('projects a host-validated image artifact to Pi without storing base64 in the host step', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/v1sAAAAASUVORK5CYII=';
    const hostResult: ToolExecuteResult = {
      toolCallId: 'host-call-1',
      status: 'success',
      content: 'Image: /mnt/data/chart.png (68 bytes, image/png)',
      artifact: {
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }],
      },
    };
    const { events, eventSequencer, tool } = createHarness(
      hostResult,
      undefined,
      readFileDefinition,
      createPiCodeSessionBridge({ session_id: 'exec-read' }),
    );

    const result = await tool.execute('pi-read-1', { path: '/mnt/data/chart.png' });
    await eventSequencer.drain();

    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Image: /mnt/data/chart.png (68 bytes, image/png)' },
        { type: 'image', data: png, mimeType: 'image/png' },
      ],
      details: { status: 'success' },
    });
    expect(events[2]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          tool_call: {
            output: 'Image: /mnt/data/chart.png (68 bytes, image/png)',
          },
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain(png);
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

  it('denies a policy-blocked tool call before host execution and records a failed step', async () => {
    const { batches, events, eventSequencer, tool } = createHarness(
      {
        toolCallId: 'host-call-1',
        status: 'success',
        content: 'must not execute',
      },
      async () => ({ kind: 'deny' }),
    );

    await expect(tool.execute('pi-call-1', { query: 'maintenance manual' })).resolves.toEqual({
      content: [{ type: 'text', text: 'This tool call was denied by the server policy.' }],
      details: { status: 'error' },
      isError: true,
    });
    await eventSequencer.drain();

    expect(batches).toHaveLength(0);
    expect(events.map(({ event }) => event)).toEqual([
      GraphEvents.ON_RUN_STEP,
      StepEvents.ON_TOOL_CALLS_DISPATCHED,
      GraphEvents.ON_RUN_STEP_COMPLETED,
      GraphEvents.ON_RUN_STEP_CLOSED,
    ]);
    expect(events[2]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: {
        result: {
          tool_call: {
            output: 'This tool call was denied by the server policy.',
          },
        },
      },
    });
    expect(events[3]).toMatchObject({
      event: GraphEvents.ON_RUN_STEP_CLOSED,
      data: { id: 'pi-step-1', status: 'failed' },
    });
  });

  it('executes only validated PreToolUse rewritten arguments', async () => {
    const evaluateTool = jest.fn(async () => ({
      kind: 'execute' as const,
      args: { query: 'sanitized maintenance manual' },
    }));
    const { batches, eventSequencer, tool } = createHarness(
      {
        toolCallId: 'host-call-1',
        status: 'success',
        content: 'Found the sanitized manual.',
      },
      evaluateTool,
    );

    await tool.execute('pi-call-1', { query: 'maintenance manual' });
    await eventSequencer.drain();

    expect(evaluateTool).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-call-1',
        name: Tools.file_search,
        args: { query: 'maintenance manual' },
        turn: 0,
      },
      undefined,
    );
    expect(batches[0]?.toolCalls[0]).toMatchObject({
      name: Tools.file_search,
      args: { query: 'sanitized maintenance manual' },
    });
  });

  it('records a durable in-progress host step before pausing and dispatches no tool side effect', async () => {
    const { batches, events, eventSequencer, pauseController, tool } = createHarness(
      {
        toolCallId: 'host-call-1',
        status: 'success',
        content: 'This result must not be reached.',
      },
      async () => ({
        kind: 'pause',
        allowedDecisions: ['approve', 'reject'],
        description: 'Review the file search request.',
      }),
    );

    await expect(tool.execute('pi-call-1', { query: 'maintenance manual' })).resolves.toMatchObject(
      {
        details: { status: 'paused' },
        terminate: true,
      },
    );
    await eventSequencer.drain();

    expect(batches).toHaveLength(0);
    expect(events.map(({ event }) => event)).toEqual([
      GraphEvents.ON_RUN_STEP,
      StepEvents.ON_TOOL_CALLS_DISPATCHED,
    ]);
    expect(pauseController.signal).toEqual({
      kind: 'tool_approval',
      toolCall: {
        toolCallId: 'pi-call-1',
        name: Tools.file_search,
        args: { query: 'maintenance manual' },
        hostExecution: {
          toolCallId: 'host-call-1',
          toolTurn: 0,
          stepIdentity: {
            id: 'pi-step-1',
            index: 3,
            messageId: 'response-1',
            runId: 'run-1',
            agentId: 'agent-1',
          },
          createdAt: 42,
        },
        review: {
          allowedDecisions: ['approve', 'reject'],
          description: 'Review the file search request.',
        },
      },
    });
  });

  it('lets an external abort win when it arrives while the tool gate is deciding', async () => {
    const controller = new AbortController();
    const gateStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const events: PiHostEvent[] = [];
    const eventSequencer = createPiHostEventSequencer((event) => {
      events.push(event);
    });
    const pauseController = createPiPauseController();
    let hostToolCalls = 0;
    const executePiTool = createPiHostToolExecutor({
      createStepIdentity: () => ({
        id: 'pi-step-1',
        index: 0,
        messageId: 'response-1',
        runId: 'run-1',
        agentId: 'agent-1',
      }),
      createToolCallId: () => 'host-call-1',
      executeHostToolCall: async () => {
        hostToolCalls += 1;
        return { toolCallId: 'host-call-1', status: 'success', content: 'unexpected' };
      },
      handleHostEvent: eventSequencer.enqueue,
      pauseGate: {
        controller: pauseController,
        evaluate: async () => {
          gateStarted.resolve(undefined);
          await releaseGate.promise;
          return { kind: 'pause', allowedDecisions: ['approve', 'reject'] };
        },
      },
    });
    const [tool] = createPiTools({ definitions: [fileSearchDefinition], execute: executePiTool });
    const execution = tool.execute('pi-call-1', { query: 'maintenance manual' }, controller.signal);

    await gateStarted.promise;
    controller.abort();
    releaseGate.resolve(undefined);

    await expect(execution).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Pi tool execution was aborted',
    });
    await eventSequencer.drain();
    expect(pauseController.signal).toBeUndefined();
    expect(hostToolCalls).toBe(0);
    expect(events).toEqual([]);
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
