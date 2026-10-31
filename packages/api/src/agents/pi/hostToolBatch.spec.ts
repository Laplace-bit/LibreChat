import { Tools } from 'librechat-data-provider';
import {
  Constants,
  GraphEvents,
  type EventHandler,
  type ToolExecuteBatchRequest,
  type ToolExecuteResult,
} from '@librechat/agents';
import type { PiHostToolCall } from './toolExecution';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { createPiHostToolBatchExecutor } from './hostToolBatch';
import { createPiCodeSessionBridge } from './codeSession';

type EventHandlerMethod = EventHandler['handle'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolExecuteBatchRequest(value: unknown): value is ToolExecuteBatchRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.toolCalls) &&
    typeof value.resolve === 'function' &&
    typeof value.reject === 'function'
  );
}

function getToolBatch(
  data: Parameters<EventHandlerMethod>[1] | undefined,
): ToolExecuteBatchRequest {
  if (!isToolExecuteBatchRequest(data)) {
    throw new Error('Expected a tool execute batch.');
  }
  return data;
}

function createHandler(
  execute: (
    batch: ToolExecuteBatchRequest,
    metadata?: Record<string, unknown>,
  ) => void | Promise<void>,
): {
  handler: EventHandler;
  handle: jest.Mock<ReturnType<EventHandlerMethod>, Parameters<EventHandlerMethod>>;
} {
  const handle = jest.fn<ReturnType<EventHandlerMethod>, Parameters<EventHandlerMethod>>(
    (event, data, metadata) => {
      if (event !== GraphEvents.ON_TOOL_EXECUTE) {
        throw new Error('Unexpected event.');
      }
      return execute(getToolBatch(data), metadata);
    },
  );
  return { handler: { handle }, handle };
}

function hostCall(): PiHostToolCall {
  return {
    id: 'pi-call-1',
    name: Tools.file_search,
    args: { query: 'machine manual' },
    stepId: 'pi-step-1',
  };
}

function successfulResult(toolCallId = 'pi-call-1'): ToolExecuteResult {
  return { toolCallId, status: 'success', content: 'Found a manual.' };
}

describe('createPiHostToolBatchExecutor', () => {
  const serverRequest = Object.freeze({ requestId: 'request-1' });

  it('dispatches one exact call through ON_TOOL_EXECUTE with authoritative run metadata', async () => {
    const call = hostCall();
    const result = successfulResult(call.id);
    const { handler, handle } = createHandler((batch) => batch.resolve([result]));
    const suppliedMetadata = {
      provider: 'pi',
      thread_id: 'untrusted-thread',
      run_id: 'untrusted-run',
    };
    const expectedMetadata = {
      provider: 'pi',
      thread_id: 'thread-1',
      run_id: 'run-1',
    };
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: suppliedMetadata,
    });

    await expect(execute(call)).resolves.toBe(result);

    expect(handle).toHaveBeenCalledTimes(1);
    const handlerCall = handle.mock.calls[0];
    if (handlerCall == null) {
      throw new Error('The host tool handler was not called.');
    }
    const [event, data, dispatchedMetadata] = handlerCall;
    expect(event).toBe(GraphEvents.ON_TOOL_EXECUTE);
    const batch = getToolBatch(data);
    expect(batch.toolCalls).toEqual([call]);
    expect(batch.toolCalls[0]?.id).toBe(call.id);
    expect(batch.userId).toBe('user-1');
    expect(batch.agentId).toBe('agent-1');
    expect(batch.configurable).toMatchObject({
      user_id: 'user-1',
      thread_id: 'thread-1',
      run_id: 'run-1',
    });
    expect(batch.configurable?.req).toBe(serverRequest);
    expect(batch.metadata).toEqual(expectedMetadata);
    expect(dispatchedMetadata).toEqual(expectedMetadata);
    expect(handle.mock.calls[0]).toHaveLength(3);
    expect(suppliedMetadata).toEqual({
      provider: 'pi',
      thread_id: 'untrusted-thread',
      run_id: 'untrusted-run',
    });
  });

  it('passes seeded and returned Code API refs through consecutive authorized host calls', async () => {
    const bridge = createPiCodeSessionBridge({
      session_id: 'exec-initial',
      files: [
        {
          id: 'upload-1',
          resource_id: 'user-1',
          name: 'source.csv',
          storage_session_id: 'storage-1',
          kind: 'user',
        },
      ],
    });
    const batches: ToolExecuteBatchRequest[] = [];
    const { handler } = createHandler((batch) => {
      batches.push(batch);
      const call = batch.toolCalls[0];
      if (call?.name === Constants.BASH_TOOL) {
        batch.resolve([
          {
            toolCallId: call.id,
            status: 'success',
            content: 'created output.csv',
            artifact: {
              session_id: 'exec-after-bash',
              files: [
                {
                  id: 'upload-1',
                  name: 'source.csv',
                  storage_session_id: 'storage-1',
                },
                {
                  id: 'output-1',
                  name: 'output.csv',
                  storage_session_id: 'storage-output',
                },
              ],
            },
          },
        ]);
      } else {
        batch.resolve([successfulResult(call?.id)]);
      }
    });
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      codeSessionBridge: bridge,
    });

    await execute({
      id: 'bash-1',
      name: Constants.BASH_TOOL,
      args: { command: 'python transform.py' },
      stepId: 'step-1',
    });
    await execute({
      id: 'read-1',
      name: Constants.READ_FILE,
      args: { path: 'output.csv' },
      stepId: 'step-2',
    });

    expect(batches[0]?.toolCalls[0]?.codeSessionContext).toEqual({
      session_id: 'exec-initial',
      files: [
        {
          id: 'upload-1',
          resource_id: 'user-1',
          name: 'source.csv',
          storage_session_id: 'storage-1',
          kind: 'user',
        },
      ],
    });
    expect(batches[1]?.toolCalls[0]?.codeSessionContext).toEqual({
      session_id: 'exec-after-bash',
      files: [
        {
          id: 'upload-1',
          resource_id: 'user-1',
          name: 'source.csv',
          storage_session_id: 'storage-1',
          kind: 'user',
        },
        {
          id: 'output-1',
          resource_id: 'output-1',
          name: 'output.csv',
          storage_session_id: 'storage-output',
          kind: 'user',
        },
      ],
    });
  });

  it('requires the run-scoped Code API bridge before dispatching a code tool', async () => {
    const { handler, handle } = createHandler((batch) =>
      batch.resolve([successfulResult('bash-1')]),
    );
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
    });

    await expect(
      execute({
        id: 'bash-1',
        name: Constants.BASH_TOOL,
        args: { command: 'echo unsafe' },
        stepId: 'step-1',
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('fails closed when no event handler is available', async () => {
    const onError = jest.fn<void, [AgentRuntimeUnavailableError]>();
    const execute = createPiHostToolBatchExecutor({
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      onError,
    });

    await expect(execute(hostCall())).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toBe(
      'The selected agent runtime is not available on this server.',
    );
  });

  it.each([
    { label: 'no result', results: [] },
    { label: 'multiple results', results: [successfulResult(), successfulResult()] },
    { label: 'a different tool call id', results: [successfulResult('other-call')] },
  ])('rejects $label and reports only a safe runtime error', async ({ results }) => {
    const onError = jest.fn<void, [AgentRuntimeUnavailableError]>();
    const { handler } = createHandler((batch) => batch.resolve(results));
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      onError,
    });

    await expect(execute(hostCall())).rejects.toMatchObject({
      name: 'AgentRuntimeUnavailableError',
      message: 'The selected agent runtime is not available on this server.',
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('sanitizes handler failures and reports only through the injected callback', async () => {
    const onError = jest.fn<void, [AgentRuntimeUnavailableError]>();
    const { handler } = createHandler(() => {
      throw new Error('private query text and credential detail');
    });
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      onError,
    });

    await expect(execute(hostCall())).rejects.toMatchObject({
      name: 'AgentRuntimeUnavailableError',
      message: 'The selected agent runtime is not available on this server.',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).not.toContain('private query text');
    expect(onError.mock.calls[0]?.[0].message).not.toContain('credential detail');
  });

  it('rejects a handler that returns without settling the batch', async () => {
    const { handler } = createHandler(() => undefined);
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
    });

    await expect(execute(hostCall())).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);
  });

  it('sanitizes AbortError and removes its abort listener when cancelled', async () => {
    const controller = new AbortController();
    const onError = jest.fn<void, [AgentRuntimeUnavailableError]>();
    const addListener = jest.spyOn(controller.signal, 'addEventListener');
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const { handler, handle } = createHandler(() => new Promise<void>(() => undefined));
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      onError,
    });

    const execution = execute(hostCall(), controller.signal);
    expect(handle).toHaveBeenCalledTimes(1);
    const listener = addListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(listener).toBeDefined();

    controller.abort(new Error('sensitive cancellation details'));

    await expect(execution).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Tool execution was aborted.',
    });
    expect(removeListener).toHaveBeenCalledWith('abort', listener);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not dispatch a pre-aborted call', async () => {
    const controller = new AbortController();
    controller.abort(new Error('sensitive cancellation details'));
    const { handler, handle } = createHandler(() => undefined);
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
    });

    await expect(execute(hostCall(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Tool execution was aborted.',
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('preserves only the AbortError classification from handler cancellation', async () => {
    const onError = jest.fn<void, [AgentRuntimeUnavailableError]>();
    const { handler } = createHandler(() => {
      const error = new Error('sensitive abort details');
      error.name = 'AbortError';
      throw error;
    });
    const execute = createPiHostToolBatchExecutor({
      handler,
      userId: 'user-1',
      agentId: 'agent-1',
      request: serverRequest,
      threadId: 'thread-1',
      runId: 'run-1',
      metadata: {},
      onError,
    });

    await expect(execute(hostCall())).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Tool execution was aborted.',
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
