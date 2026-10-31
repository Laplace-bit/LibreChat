import { StepEvents, StepTypes, Tools } from 'librechat-data-provider';
import { GraphEvents, type ToolExecuteResult } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { PiMessageStepIdentity } from './events';
import type { PiFileSearchArguments } from './tools';
import type { PiHostEvent } from './events';

export interface PiToolExecutionInput {
  toolCallId: string;
  name: typeof Tools.file_search;
  args: PiFileSearchArguments;
}

export interface PiHostToolCall {
  id: string;
  name: typeof Tools.file_search;
  args: PiFileSearchArguments;
  stepId: string;
}

export interface PiToolExecutionOptions {
  createStepIdentity(): PiMessageStepIdentity;
  createToolCallId(): string;
  executeHostToolCall(call: PiHostToolCall, signal?: AbortSignal): Promise<ToolExecuteResult>;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
  now?: () => number;
}

type HostToolStatus = 'success' | 'error' | 'cancelled';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostContentToText(content: ToolExecuteResult['content']): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const fragments: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      fragments.push(part);
    } else if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      fragments.push(part.text);
    } else {
      return undefined;
    }
  }
  return fragments.join('\n');
}

function abortError(): Error {
  const error = new Error('Pi tool execution was aborted');
  error.name = 'AbortError';
  return error;
}

function buildRunStep(
  identity: PiMessageStepIdentity,
  toolCallId: string,
  input: PiToolExecutionInput,
  createdAt: number,
): Agents.RunStep {
  return {
    id: identity.id,
    runId: identity.runId,
    agentId: identity.agentId,
    type: StepTypes.TOOL_CALLS,
    index: identity.index,
    created_at: createdAt,
    status: 'in_progress',
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: input.name,
            arguments: input.args,
          },
        },
      ],
    },
  };
}

async function settleRunStep(options: {
  identity: PiMessageStepIdentity;
  toolCallId: string;
  input: PiToolExecutionInput;
  output: string;
  status: HostToolStatus;
  createdAt: number;
  now: () => number;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
}): Promise<void> {
  const { identity, toolCallId, input, output, status, createdAt, now, handleHostEvent } = options;
  const completedAt = now();
  const toolCall: Agents.ToolCall = {
    type: 'tool_call',
    id: toolCallId,
    stepId: identity.id,
    name: input.name,
    args: input.args,
    output,
  };
  const completed: PiHostEvent = {
    event: GraphEvents.ON_RUN_STEP_COMPLETED,
    data: {
      result: {
        id: identity.id,
        index: identity.index,
        completed_at: completedAt,
        tool_call: toolCall,
      },
    },
  };
  const stepStatus = {
    cancelled: 'cancelled',
    success: 'completed',
    error: 'failed',
  } satisfies Record<HostToolStatus, Agents.RunStepClosedStatus>;
  const closed: PiHostEvent = {
    event: GraphEvents.ON_RUN_STEP_CLOSED,
    data: {
      id: identity.id,
      index: identity.index,
      type: StepTypes.TOOL_CALLS,
      status: stepStatus[status],
      created_at: createdAt,
      closed_at: completedAt,
      runId: identity.runId,
      agentId: identity.agentId,
    },
  };

  let completionFailure: unknown;
  try {
    await handleHostEvent(completed);
  } catch (error) {
    completionFailure = error;
  }

  try {
    await handleHostEvent(closed);
  } catch (error) {
    if (completionFailure != null) {
      throw new AggregateError(
        [completionFailure, error],
        'Pi tool result and terminal step event both failed',
      );
    }
    throw error;
  }

  if (completionFailure != null) {
    throw completionFailure;
  }
}

/**
 * Executes one Pi tool through the host's existing tool handler and emits the
 * LibreChat run-step lifecycle around it. Tool authorization, execution,
 * output filtering, and artifact persistence remain owned by the host handler.
 */
export function createPiHostToolExecutor(options: PiToolExecutionOptions): (
  input: PiToolExecutionInput,
  signal?: AbortSignal,
) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: { status: HostToolStatus };
  isError?: boolean;
}> {
  const now = options.now ?? Date.now;

  return async (input, signal) => {
    if (signal?.aborted) {
      throw abortError();
    }

    const identity = options.createStepIdentity();
    const toolCallId = options.createToolCallId();
    const createdAt = now();
    const step = buildRunStep(identity, toolCallId, input, createdAt);
    try {
      await options.handleHostEvent({ event: GraphEvents.ON_RUN_STEP, data: step });
      await options.handleHostEvent({
        event: StepEvents.ON_TOOL_CALLS_DISPATCHED,
        data: {
          dispatched_at: createdAt,
          runId: identity.runId,
          toolCalls: [{ id: toolCallId, name: input.name, stepId: identity.id }],
        },
      });
    } catch (error) {
      try {
        await settleRunStep({
          identity,
          toolCallId,
          input,
          output: 'Tool execution could not be started.',
          status: 'error',
          createdAt,
          now,
          handleHostEvent: options.handleHostEvent,
        });
      } catch (settleError) {
        throw new AggregateError(
          [error, settleError],
          'Pi tool dispatch and step settlement both failed',
        );
      }
      throw error;
    }

    const hostCall: PiHostToolCall = {
      id: toolCallId,
      name: input.name,
      args: input.args,
      stepId: identity.id,
    };

    if (signal?.aborted) {
      await settleRunStep({
        identity,
        toolCallId,
        input,
        output: 'Tool execution was cancelled.',
        status: 'cancelled',
        createdAt,
        now,
        handleHostEvent: options.handleHostEvent,
      });
      throw abortError();
    }

    let hostResult: ToolExecuteResult;
    try {
      hostResult = await options.executeHostToolCall(hostCall, signal);
    } catch (error) {
      const cancelled = signal?.aborted === true;
      await settleRunStep({
        identity,
        toolCallId,
        input,
        output: cancelled ? 'Tool execution was cancelled.' : 'Tool execution failed.',
        status: cancelled ? 'cancelled' : 'error',
        createdAt,
        now,
        handleHostEvent: options.handleHostEvent,
      });
      if (cancelled) {
        throw abortError();
      }
      throw error;
    }

    if (signal?.aborted) {
      await settleRunStep({
        identity,
        toolCallId,
        input,
        output: 'Tool execution was cancelled.',
        status: 'cancelled',
        createdAt,
        now,
        handleHostEvent: options.handleHostEvent,
      });
      throw abortError();
    }

    const hostText = hostContentToText(hostResult.content);
    const status: Exclude<HostToolStatus, 'cancelled'> =
      hostResult.status === 'success' && hostText != null ? 'success' : 'error';
    const output = hostText ?? 'The host tool returned an unsupported result format.';
    await settleRunStep({
      identity,
      toolCallId,
      input,
      output,
      status,
      createdAt,
      now,
      handleHostEvent: options.handleHostEvent,
    });

    const modelText =
      output.length > 0 || status === 'success'
        ? output
        : 'The tool could not complete this request.';
    return {
      content: [{ type: 'text', text: modelText }],
      details: { status },
      ...(status === 'error' ? { isError: true } : {}),
    };
  };
}
