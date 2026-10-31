import {
  GraphEvents,
  type EventHandler,
  type ToolExecuteBatchRequest,
  type ToolExecuteResult,
} from '@librechat/agents';
import type { PiCodeSessionBridge, PiCodeSessionSnapshot } from './codeSession';
import type { PiHostToolCall } from './toolExecution';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { isPiCodeExecutionToolName } from './toolNames';

export interface PiHostToolBatchOptions {
  handler?: EventHandler;
  userId: string;
  agentId: string;
  request: unknown;
  threadId: string;
  runId: string;
  metadata: Record<string, unknown>;
  codeSessionBridge?: PiCodeSessionBridge;
  onError?: (error: AgentRuntimeUnavailableError) => void;
}

export type PiHostToolBatchExecutor = (
  call: PiHostToolCall,
  signal?: AbortSignal,
) => Promise<ToolExecuteResult>;

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError(): Error {
  const error = new Error('Tool execution was aborted.');
  error.name = 'AbortError';
  return error;
}

function reportUnavailable(
  onError?: (error: AgentRuntimeUnavailableError) => void,
): AgentRuntimeUnavailableError {
  const error = new AgentRuntimeUnavailableError();
  try {
    onError?.(error);
  } catch {
    // Diagnostic hooks must not change the tool execution result.
  }
  return error;
}

function rejectWithSafeError(
  error: unknown,
  reject: (reason: Error) => void,
  onError?: (error: AgentRuntimeUnavailableError) => void,
): void {
  if (isAbortError(error)) {
    reject(createAbortError());
    return;
  }
  reject(reportUnavailable(onError));
}

/**
 * Adapts a Pi host tool call to LibreChat's authorized ON_TOOL_EXECUTE handler.
 * The handler remains the sole owner of tool lookup, authorization, and execution.
 */
export function createPiHostToolBatchExecutor(
  options: PiHostToolBatchOptions,
): PiHostToolBatchExecutor {
  if (typeof options.request !== 'object' || options.request === null) {
    throw reportUnavailable(options.onError);
  }
  const handler = options.handler;
  const metadata = {
    ...options.metadata,
    thread_id: options.threadId,
    run_id: options.runId,
  };

  const executeCall = (
    hostCall: PiHostToolCall & { codeSessionContext?: PiCodeSessionSnapshot },
    signal?: AbortSignal,
  ): Promise<ToolExecuteResult> => {
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError());
    }
    if (handler == null) {
      return Promise.reject(reportUnavailable(options.onError));
    }

    return new Promise<ToolExecuteResult>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectWithSafeError(error, reject, options.onError);
      };
      const acceptResults = (results: ToolExecuteResult[]): void => {
        if (settled) {
          return;
        }
        if (!Array.isArray(results) || results.length !== 1) {
          fail(new Error('The host tool handler returned an invalid result count.'));
          return;
        }

        const [result] = results;
        if (result == null || typeof result !== 'object' || result.toolCallId !== hostCall.id) {
          fail(new Error('The host tool handler returned a result for a different call.'));
          return;
        }

        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = (): void => {
        if (signal != null) {
          fail(createAbortError());
        }
      };

      try {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted === true) {
          onAbort();
          return;
        }

        const configurable = {
          req: options.request,
          user_id: options.userId,
          thread_id: options.threadId,
          run_id: options.runId,
        };
        const batchMetadata = { ...metadata };
        const batch: ToolExecuteBatchRequest = {
          toolCalls: [
            {
              id: hostCall.id,
              name: hostCall.name,
              args: hostCall.args,
              stepId: hostCall.stepId,
              ...(hostCall.codeSessionContext == null
                ? {}
                : { codeSessionContext: hostCall.codeSessionContext }),
            },
          ],
          userId: options.userId,
          agentId: options.agentId,
          configurable,
          metadata: batchMetadata,
          signal,
          resolve: acceptResults,
          reject: (error) => fail(error),
        };

        const handleResult = handler.handle(GraphEvents.ON_TOOL_EXECUTE, batch, batchMetadata);
        void Promise.resolve(handleResult).then(() => {
          if (!settled) {
            fail(new Error('The host tool handler did not settle the batch.'));
          }
        }, fail);
      } catch (error) {
        fail(error);
      }
    });
  };

  return (call, signal) => {
    if (isPiCodeExecutionToolName(call.name) && options.codeSessionBridge == null) {
      return Promise.reject(reportUnavailable(options.onError));
    }
    if (options.codeSessionBridge == null) {
      return executeCall(call, signal);
    }
    return options.codeSessionBridge.execute(call, (hostCall) => executeCall(hostCall, signal));
  };
}
