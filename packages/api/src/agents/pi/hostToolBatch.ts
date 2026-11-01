import {
  GraphEvents,
  type EventHandler,
  type ToolExecuteBatchRequest,
  type ToolExecuteResult,
} from '@librechat/agents';
import type { PiCodeSessionBridge, PiCodeSessionSnapshot } from './codeSession';
import type { PiHostToolCall } from './toolExecution';
import { isPiCodeExecutionToolName, PI_SUPPORTED_HOST_TOOLS } from './toolNames';
import { AgentRuntimeUnavailableError } from '../runtime/selection';

export interface PiHostToolBatchOptions {
  handler?: EventHandler;
  userId: string;
  agentId: string;
  request: unknown;
  threadId: string;
  runId: string;
  metadata: Record<string, unknown>;
  /** Exact tool definitions admitted for this isolated Pi generation. */
  authorizedToolNames?: readonly string[];
  /** Re-checks the live provider fence at the final server-side execution boundary. */
  authorize?: (signal?: AbortSignal) => boolean | Promise<boolean>;
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

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
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
  const authorizedToolNames = new Set(options.authorizedToolNames ?? PI_SUPPORTED_HOST_TOOLS);
  const metadata = {
    ...options.metadata,
    thread_id: options.threadId,
    run_id: options.runId,
  };

  const executeCall = (
    hostCall: PiHostToolCall & { codeSessionContext?: PiCodeSessionSnapshot },
    signal?: AbortSignal,
  ): Promise<ToolExecuteResult> => {
    if (!authorizedToolNames.has(hostCall.name)) {
      return Promise.reject(reportUnavailable(options.onError));
    }
    if (isSignalAborted(signal)) {
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

      const invokeHandler = async (): Promise<void> => {
        try {
          signal?.addEventListener('abort', onAbort, { once: true });
          if (isSignalAborted(signal)) {
            onAbort();
            return;
          }

          /** Admission commits the single-use receipt. This second check is deliberately
           * adjacent to host dispatch so an owner reaped while the caller awaited admission
           * cannot start a side effect. The host call follows this await synchronously. */
          const authorized =
            typeof options.authorize === 'function' && (await options.authorize(signal));
          if (!authorized) {
            fail(new Error('Provider ownership is no longer valid.'));
            return;
          }
          if (isSignalAborted(signal)) {
            onAbort();
            return;
          }
          if (settled) {
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
                ...(hostCall.turn == null ? {} : { turn: hostCall.turn }),
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
      };

      void invokeHandler();
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
