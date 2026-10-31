import { StepEvents, StepTypes, Tools } from 'librechat-data-provider';
import { GraphEvents, type ToolExecuteResult } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type {
  PiCalculatorArguments,
  PiFileSearchArguments,
  PiHostToolExecutionInput,
  PiToolArguments,
} from './tools';
import type { PiPauseController, PiPauseSignal, PiPauseToolCall } from './pause';
import type { PiMessageStepIdentity } from './events';
import type { PiHostEvent } from './events';
import { validatePiToolExecutionInput } from './tools';
import { PI_CALCULATOR_TOOL_NAME } from './toolNames';

export type PiToolExecutionInput = PiHostToolExecutionInput;

export type PiToolExecutionContext = PiToolExecutionInput & { turn: number };

export type PiToolGateDecision =
  | { kind: 'execute'; args?: PiToolArguments }
  | { kind: 'deny' }
  | { kind: 'pause' };

export type PiToolExecutionGate = (
  input: PiToolExecutionContext,
  signal?: AbortSignal,
) => PiToolGateDecision | Promise<PiToolGateDecision>;

export type PiHostToolCall =
  | {
      id: string;
      name: typeof Tools.file_search;
      args: PiFileSearchArguments;
      stepId: string;
      turn?: number;
    }
  | {
      id: string;
      name: typeof PI_CALCULATOR_TOOL_NAME;
      args: PiCalculatorArguments;
      stepId: string;
      turn?: number;
    };

export interface PiToolExecutionOptions {
  createStepIdentity(): PiMessageStepIdentity;
  createToolCallId(): string;
  executeHostToolCall(call: PiHostToolCall, signal?: AbortSignal): Promise<ToolExecuteResult>;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
  pauseGate?: {
    controller: PiPauseController;
    evaluate: PiToolExecutionGate;
  };
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

function toPauseToolCall(input: PiToolExecutionInput): PiPauseToolCall {
  switch (input.name) {
    case Tools.file_search:
      return {
        toolCallId: input.toolCallId,
        name: input.name,
        args: { query: input.args.query },
      };
    case PI_CALCULATOR_TOOL_NAME:
      return {
        toolCallId: input.toolCallId,
        name: input.name,
        args: { input: input.args.input },
      };
  }
}

function toHostToolCall(input: PiToolExecutionContext, id: string, stepId: string): PiHostToolCall {
  switch (input.name) {
    case Tools.file_search:
      return {
        id,
        name: Tools.file_search,
        args: input.args,
        stepId,
        turn: input.turn,
      };
    case PI_CALCULATOR_TOOL_NAME:
      return {
        id,
        name: PI_CALCULATOR_TOOL_NAME,
        args: input.args,
        stepId,
        turn: input.turn,
      };
  }
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

interface StartedPiToolStep {
  identity: PiMessageStepIdentity;
  toolCallId: string;
  input: PiToolExecutionInput;
  createdAt: number;
}

async function startPiToolStep(
  options: PiToolExecutionOptions,
  input: PiToolExecutionInput,
  createdAt: number,
  now: () => number,
): Promise<StartedPiToolStep> {
  const identity = options.createStepIdentity();
  const toolCallId = options.createToolCallId();
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

  return { identity, toolCallId, input, createdAt };
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
  details: { status: HostToolStatus | 'paused' | 'unsupported_batch' };
  isError?: boolean;
  terminate?: boolean;
}> {
  const now = options.now ?? Date.now;
  let nextTurn = 0;
  const createPauseResult = (signal: PiPauseSignal) =>
    signal.kind === 'tool_approval'
      ? {
          content: [{ type: 'text' as const, text: 'This tool call is paused for host review.' }],
          details: { status: 'paused' as const },
          terminate: true,
        }
      : {
          content: [{ type: 'text' as const, text: 'This tool batch cannot be paused safely.' }],
          details: { status: 'unsupported_batch' as const },
          isError: true,
          terminate: true,
        };

  return async (input, signal) => {
    if (signal?.aborted) {
      throw abortError();
    }

    const toolInput: PiToolExecutionContext = { ...input, turn: nextTurn++ };
    let executionInput = toolInput;

    if (options.pauseGate != null) {
      const pendingPause = options.pauseGate.controller.signal;
      if (pendingPause != null) {
        return createPauseResult(options.pauseGate.controller.request(toPauseToolCall(toolInput)));
      }
      const decision = await options.pauseGate.evaluate(toolInput, signal);
      if (signal?.aborted) {
        throw abortError();
      }
      const pendingPauseAfterGate = options.pauseGate.controller.signal;
      if (pendingPauseAfterGate != null) {
        return createPauseResult(options.pauseGate.controller.request(toPauseToolCall(toolInput)));
      }
      switch (decision.kind) {
        case 'execute':
          if (decision.args != null) {
            executionInput = {
              ...validatePiToolExecutionInput(toolInput.name, toolInput.toolCallId, decision.args),
              turn: toolInput.turn,
            };
          }
          break;
        case 'deny': {
          const deniedStep = await startPiToolStep(options, toolInput, now(), now);
          const deniedOutput = 'This tool call was denied by the server policy.';
          await settleRunStep({
            ...deniedStep,
            output: deniedOutput,
            status: 'error',
            now,
            handleHostEvent: options.handleHostEvent,
          });
          return {
            content: [{ type: 'text', text: deniedOutput }],
            details: { status: 'error' },
            isError: true,
          };
        }
        case 'pause': {
          return createPauseResult(
            options.pauseGate.controller.request(toPauseToolCall(toolInput)),
          );
        }
        default: {
          const exhaustive: never = decision;
          throw exhaustive;
        }
      }
    }

    if (signal?.aborted) {
      throw abortError();
    }

    const createdAt = now();
    const started = await startPiToolStep(options, executionInput, createdAt, now);
    const { identity, toolCallId } = started;

    const hostCall = toHostToolCall(executionInput, toolCallId, identity.id);

    if (signal?.aborted) {
      await settleRunStep({
        identity,
        toolCallId,
        input: executionInput,
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
        input: executionInput,
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
        input: executionInput,
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
      input: executionInput,
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
