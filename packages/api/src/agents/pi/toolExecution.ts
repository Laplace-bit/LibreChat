import { StepEvents, StepTypes, Tools } from 'librechat-data-provider';
import { GraphEvents, type ToolExecuteResult } from '@librechat/agents';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { Agents } from 'librechat-data-provider';
import type {
  PiBashArguments,
  PiCalculatorArguments,
  PiFileSearchArguments,
  PiHostToolExecutionInput,
  PiReadFileArguments,
  PiToolArguments,
} from './tools';
import type { PiPauseController, PiPauseSignal, PiPauseToolCall } from './pause';
import type { PiCodeSessionSnapshot } from './codeSession';
import type { PiMessageStepIdentity } from './events';
import type { PiHostEvent } from './events';
import {
  isPiCodeExecutionToolName,
  PI_BASH_TOOL_NAME,
  PI_CALCULATOR_TOOL_NAME,
  PI_READ_FILE_TOOL_NAME,
} from './toolNames';
import { validatePiToolExecutionInput } from './tools';

export type PiToolExecutionInput = PiHostToolExecutionInput;

export type PiToolExecutionContext = PiToolExecutionInput & { turn: number };

export type PiToolGateDecision =
  | { kind: 'execute'; args?: PiToolArguments }
  | { kind: 'deny' }
  | {
      kind: 'pause';
      args?: PiToolArguments;
      allowedDecisions: readonly Agents.ToolApprovalDecisionType[];
      description?: string;
    };

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
      codeSessionContext?: PiCodeSessionSnapshot;
    }
  | {
      id: string;
      name: typeof PI_CALCULATOR_TOOL_NAME;
      args: PiCalculatorArguments;
      stepId: string;
      turn?: number;
      codeSessionContext?: PiCodeSessionSnapshot;
    }
  | {
      id: string;
      name: typeof PI_BASH_TOOL_NAME;
      args: PiBashArguments;
      stepId: string;
      turn?: number;
      codeSessionContext?: PiCodeSessionSnapshot;
    }
  | {
      id: string;
      name: typeof PI_READ_FILE_TOOL_NAME;
      args: PiReadFileArguments;
      stepId: string;
      turn?: number;
      codeSessionContext?: PiCodeSessionSnapshot;
    };

export interface PiToolExecutionOptions {
  createStepIdentity(): PiMessageStepIdentity;
  createToolCallId(): string;
  executeHostToolCall(call: PiHostToolCall, signal?: AbortSignal): Promise<ToolExecuteResult>;
  getCodeSessionContext?(): PiCodeSessionSnapshot | undefined;
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

type PiToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

const MAX_PI_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;

function isCompletePiImage(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    return (
      bytes.length >= 6 &&
      (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')
    );
  }
  if (mimeType === 'image/webp') {
    return (
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

function hostArtifactToPiImages(
  artifact: unknown,
):
  | { images: Array<Extract<PiToolResultContent, { type: 'image' }>>; invalid: false }
  | { images: []; invalid: true } {
  if (!isRecord(artifact) || !Array.isArray(artifact.content)) {
    return { images: [], invalid: false };
  }
  const imageParts = artifact.content.filter((part) => isRecord(part) && part.type === 'image_url');
  if (imageParts.length === 0) {
    return { images: [], invalid: false };
  }
  const images: Array<Extract<PiToolResultContent, { type: 'image' }>> = [];
  let totalBytes = 0;
  for (const part of imageParts) {
    if (!isRecord(part) || !isRecord(part.image_url) || typeof part.image_url.url !== 'string') {
      return { images: [], invalid: true };
    }
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      part.image_url.url,
    );
    if (!match || match[2].length > 4 * Math.ceil(MAX_PI_TOOL_IMAGE_BYTES / 3)) {
      return { images: [], invalid: true };
    }
    const [, mimeType, data] = match;
    const bytes = Buffer.from(data, 'base64');
    if (
      bytes.length === 0 ||
      bytes.length > MAX_PI_TOOL_IMAGE_BYTES ||
      bytes.toString('base64') !== data ||
      !isCompletePiImage(mimeType, bytes)
    ) {
      return { images: [], invalid: true };
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_PI_TOOL_IMAGE_BYTES) {
      return { images: [], invalid: true };
    }
    images.push({ type: 'image', data, mimeType });
  }
  return { images, invalid: false };
}

function abortError(): Error {
  const error = new Error('Pi tool execution was aborted');
  error.name = 'AbortError';
  return error;
}

function toPauseToolCall(
  input: PiToolExecutionInput,
  hostExecution: PiPauseToolCall['hostExecution'],
  review: PiPauseToolCall['review'],
  codeSessionContext?: PiCodeSessionSnapshot,
): PiPauseToolCall {
  switch (input.name) {
    case Tools.file_search:
      return {
        toolCallId: input.toolCallId,
        name: input.name,
        args: { query: input.args.query },
        hostExecution,
        review,
      };
    case PI_CALCULATOR_TOOL_NAME:
      return {
        toolCallId: input.toolCallId,
        name: input.name,
        args: { input: input.args.input },
        hostExecution,
        review,
      };
    case PI_BASH_TOOL_NAME:
      return {
        toolCallId: input.toolCallId,
        name: PI_BASH_TOOL_NAME,
        args: input.args,
        ...(codeSessionContext == null ? {} : { codeSessionContext }),
        hostExecution,
        review,
      };
    case PI_READ_FILE_TOOL_NAME:
      return {
        toolCallId: input.toolCallId,
        name: PI_READ_FILE_TOOL_NAME,
        args: input.args,
        ...(codeSessionContext == null ? {} : { codeSessionContext }),
        hostExecution,
        review,
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
    case PI_BASH_TOOL_NAME:
      return {
        id,
        name: PI_BASH_TOOL_NAME,
        args: input.args,
        stepId,
        turn: input.turn,
      };
    case PI_READ_FILE_TOOL_NAME:
      return {
        id,
        name: PI_READ_FILE_TOOL_NAME,
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

/** Persist completion for an approval-stopped Pi host step using its original identities. */
export async function settlePiHostToolStep(options: {
  identity: PiMessageStepIdentity;
  toolCallId: string;
  input: PiToolExecutionContext;
  output: string;
  status: HostToolStatus;
  createdAt: number;
  now?: () => number;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
}): Promise<void> {
  await settleRunStep({
    identity: options.identity,
    toolCallId: options.toolCallId,
    input: options.input,
    output: options.output,
    status: options.status,
    createdAt: options.createdAt,
    now: options.now ?? Date.now,
    handleHostEvent: options.handleHostEvent,
  });
}

export async function settlePiHostToolResult(options: {
  identity: PiMessageStepIdentity;
  toolCallId: string;
  input: PiToolExecutionContext;
  hostResult: ToolExecuteResult;
  createdAt: number;
  now?: () => number;
  handleHostEvent(event: PiHostEvent): void | Promise<void>;
}): Promise<{
  content: PiToolResultContent[];
  details: { status: Exclude<HostToolStatus, 'cancelled'> };
  isError?: boolean;
}> {
  const now = options.now ?? Date.now;
  const hostText = hostContentToText(options.hostResult.content);
  const imageProjection = hostArtifactToPiImages(options.hostResult.artifact);
  const status: Exclude<HostToolStatus, 'cancelled'> =
    options.hostResult.status === 'success' &&
    !imageProjection.invalid &&
    (hostText != null || imageProjection.images.length > 0)
      ? 'success'
      : 'error';
  const output =
    hostText ??
    (imageProjection.images.length > 0
      ? 'The requested image was read from the authorized host.'
      : 'The host tool returned an unsupported result format.');
  await settlePiHostToolStep({
    ...options,
    output,
    status,
    now,
  });
  const modelText =
    output.length > 0 || status === 'success'
      ? output
      : 'The tool could not complete this request.';
  return {
    content: [
      { type: 'text', text: modelText },
      ...(status === 'success' ? imageProjection.images : []),
    ],
    details: { status },
    ...(status === 'error' ? { isError: true } : {}),
  };
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
export function createPiHostToolExecutor(
  options: PiToolExecutionOptions,
): (
  input: PiToolExecutionInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult<{ status: HostToolStatus | 'paused' | 'unsupported_batch' }>> {
  const now = options.now ?? Date.now;
  let nextTurn = 0;
  const seenPiToolCallIds = new Set<string>();
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
    if (seenPiToolCallIds.has(input.toolCallId)) {
      throw new Error('A Pi host tool call ID can only be executed once per generation');
    }
    seenPiToolCallIds.add(input.toolCallId);

    const toolInput: PiToolExecutionContext = { ...input, turn: nextTurn++ };
    let executionInput = toolInput;

    if (options.pauseGate != null) {
      const pendingPause = options.pauseGate.controller.signal;
      if (pendingPause != null) {
        if (pendingPause.kind === 'tool_approval') {
          return createPauseResult(
            options.pauseGate.controller.rejectBatch([
              pendingPause.toolCall.toolCallId,
              toolInput.toolCallId,
            ]),
          );
        }
        return createPauseResult(pendingPause);
      }
      const decision = await options.pauseGate.evaluate(toolInput, signal);
      if (signal?.aborted) {
        throw abortError();
      }
      const pendingPauseAfterGate = options.pauseGate.controller.signal;
      if (pendingPauseAfterGate != null) {
        if (pendingPauseAfterGate.kind === 'tool_approval') {
          return createPauseResult(
            options.pauseGate.controller.rejectBatch([
              pendingPauseAfterGate.toolCall.toolCallId,
              toolInput.toolCallId,
            ]),
          );
        }
        return createPauseResult(pendingPauseAfterGate);
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
          if (decision.args != null) {
            executionInput = {
              ...validatePiToolExecutionInput(toolInput.name, toolInput.toolCallId, decision.args),
              turn: toolInput.turn,
            };
          }
          const pausedStep = await startPiToolStep(options, executionInput, now(), now);
          return createPauseResult(
            options.pauseGate.controller.request(
              toPauseToolCall(
                executionInput,
                {
                  toolCallId: pausedStep.toolCallId,
                  toolTurn: toolInput.turn,
                  stepIdentity: pausedStep.identity,
                  createdAt: pausedStep.createdAt,
                },
                {
                  allowedDecisions: decision.allowedDecisions,
                  ...(decision.description == null ? {} : { description: decision.description }),
                },
                isPiCodeExecutionToolName(executionInput.name)
                  ? options.getCodeSessionContext?.()
                  : undefined,
              ),
            ),
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

    return settlePiHostToolResult({
      identity,
      toolCallId,
      input: executionInput,
      hostResult,
      createdAt,
      now,
      handleHostEvent: options.handleHostEvent,
    });
  };
}
