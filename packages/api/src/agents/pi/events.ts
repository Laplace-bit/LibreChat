import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes, UsageEvents } from 'librechat-data-provider';
import type { Agents, TContextUsageEvent } from 'librechat-data-provider';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';

export type PiContentType = 'text' | 'think';

export interface PiMessageStepIdentity {
  id: string;
  index: number;
  messageId: string;
  runId: string;
  agentId: string;
}

export interface PiMessageStepIdentityInput {
  assistantMessageSequence: number;
  piContentIndex: number;
  contentType: PiContentType;
}

export interface PiContentEventTranslatorOptions {
  /** The host supplies job-scoped IDs and offsets; Pi never owns product identities. */
  createStepIdentity(input: PiMessageStepIdentityInput): PiMessageStepIdentity;
  /** Host-owned billing attribution; Pi's provider id is deliberately not authoritative. */
  usageAttribution?: { provider?: string; agentId?: string; runId?: string };
  now?: () => number;
}

export type PiHostContentEvent =
  | { event: GraphEvents.ON_RUN_STEP; data: Agents.RunStep }
  | { event: GraphEvents.ON_MESSAGE_DELTA; data: Agents.MessageDeltaEvent }
  | { event: GraphEvents.ON_REASONING_DELTA; data: Agents.ReasoningDeltaEvent }
  | { event: GraphEvents.ON_RUN_STEP_CLOSED; data: Agents.RunStepClosedEvent };

export interface PiHostUsageEvent {
  event: typeof UsageEvents.ON_TOKEN_USAGE;
  data: UsageMetadata;
}

export interface PiHostContextUsageEvent {
  event: typeof UsageEvents.ON_CONTEXT_USAGE;
  data: TContextUsageEvent;
}

export type PiHostEvent = PiHostContentEvent | PiHostUsageEvent | PiHostContextUsageEvent;

export class PiRuntimeResponseError extends Error {
  readonly code = 'PI_RESPONSE_UNSUPPORTED';

  constructor() {
    super('The Pi response could not be represented by the current agent runtime.');
    this.name = 'PiRuntimeResponseError';
  }
}

interface PiContentStep {
  identity: PiMessageStepIdentity;
  contentType: PiContentType;
  createdAt: number;
}

interface AssistantMessageState {
  sequence: number;
  contentSteps: Map<string, PiContentStep>;
}

function stepKey(contentIndex: number, contentType: PiContentType): string {
  return `${contentIndex}:${contentType}`;
}

function closeContentSteps(
  message: AssistantMessageState,
  status: Agents.RunStepClosedStatus,
  closedAt: number,
): PiHostContentEvent[] {
  const closedEvents: PiHostContentEvent[] = [];
  for (const step of message.contentSteps.values()) {
    closedEvents.push({
      event: GraphEvents.ON_RUN_STEP_CLOSED,
      data: {
        id: step.identity.id,
        index: step.identity.index,
        type: StepTypes.MESSAGE_CREATION,
        status,
        created_at: step.createdAt,
        closed_at: closedAt,
        runId: step.identity.runId,
        agentId: step.identity.agentId,
      },
    });
  }
  return closedEvents;
}

function asTokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PiRuntimeResponseError();
  }
  return value;
}

function translateAssistantUsage(
  message: AssistantMessage,
  attribution: PiContentEventTranslatorOptions['usageAttribution'],
): PiHostUsageEvent {
  const { input, output, cacheRead, cacheWrite, totalTokens, reasoning } = message.usage;
  const inputTokens = asTokenCount(input);
  const outputTokens = asTokenCount(output);
  const cacheReadTokens = asTokenCount(cacheRead);
  const cacheWriteTokens = asTokenCount(cacheWrite);
  const total = asTokenCount(totalTokens);
  if (
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens !== total ||
    (reasoning !== undefined && asTokenCount(reasoning) > outputTokens)
  ) {
    throw new PiRuntimeResponseError();
  }

  return {
    event: UsageEvents.ON_TOKEN_USAGE,
    data: {
      input_tokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      output_tokens: outputTokens,
      total_tokens: total,
      model: message.model,
      provider: attribution?.provider ?? message.provider,
      ...(attribution?.agentId == null ? {} : { agentId: attribution.agentId }),
      ...(attribution?.runId == null ? {} : { runId: attribution.runId }),
      ...(cacheReadTokens === 0 && cacheWriteTokens === 0
        ? {}
        : {
            input_token_details: {
              ...(cacheReadTokens === 0 ? {} : { cache_read: cacheReadTokens }),
            },
            ...(cacheWriteTokens === 0 ? {} : { cache_write_tokens: cacheWriteTokens }),
          }),
      ...(reasoning === undefined ? {} : { output_token_details: { reasoning } }),
    },
  };
}

function translateAgentEnd(
  event: Extract<AgentSessionEvent, { type: 'agent_end' }>,
  options: PiContentEventTranslatorOptions,
): PiHostUsageEvent[] {
  const translated: PiHostUsageEvent[] = [];
  for (const message of event.messages) {
    if (message.role !== 'assistant') {
      continue;
    }

    if (
      event.willRetry !== true &&
      (message.stopReason === 'error' ||
        message.stopReason === 'length' ||
        message.stopReason === 'deferred' ||
        (message.stopReason === 'toolUse' &&
          message.content.some((part) => part.type === 'toolCall')))
    ) {
      throw new PiRuntimeResponseError();
    }
    translated.push(translateAssistantUsage(message, options.usageAttribution));
  }
  return translated;
}

function createRunStep(step: PiContentStep): Agents.RunStep {
  const { identity, contentType, createdAt } = step;
  return {
    id: identity.id,
    runId: identity.runId,
    agentId: identity.agentId,
    type: StepTypes.MESSAGE_CREATION,
    index: identity.index,
    stepDetails: {
      type: StepTypes.MESSAGE_CREATION,
      message_creation: {
        message_id: identity.messageId,
        content_type: contentType,
        ...(contentType === ContentTypes.TEXT ? { phase: 'final_answer' as const } : {}),
      },
    },
    created_at: createdAt,
    status: 'in_progress',
  };
}

function translateContentDelta(
  message: AssistantMessageState,
  piContentIndex: number,
  contentType: PiContentType,
  delta: string,
  options: PiContentEventTranslatorOptions,
  now: () => number,
): PiHostContentEvent[] {
  if (delta.length === 0) {
    return [];
  }

  const key = stepKey(piContentIndex, contentType);
  let step = message.contentSteps.get(key);
  const events: PiHostContentEvent[] = [];
  if (!step) {
    const createdAt = now();
    step = {
      identity: options.createStepIdentity({
        assistantMessageSequence: message.sequence,
        piContentIndex,
        contentType,
      }),
      contentType,
      createdAt,
    };
    message.contentSteps.set(key, step);
    events.push({
      event: GraphEvents.ON_RUN_STEP,
      data: createRunStep(step),
    });
  }

  if (contentType === ContentTypes.TEXT) {
    events.push({
      event: GraphEvents.ON_MESSAGE_DELTA,
      data: {
        id: step.identity.id,
        delta: { content: [{ type: ContentTypes.TEXT, text: delta }] },
      },
    });
  } else {
    events.push({
      event: GraphEvents.ON_REASONING_DELTA,
      data: {
        id: step.identity.id,
        delta: { content: [{ type: ContentTypes.THINK, think: delta }] },
      },
    });
  }
  return events;
}

/**
 * Translate Pi's streamed text and reasoning blocks into the host event contract.
 * Tool calls, usage, citations, attachments, and errors require separate host
 * mappings and deliberately do not become product events here.
 */
export function createPiContentEventTranslator(
  options: PiContentEventTranslatorOptions,
): (event: AgentSessionEvent) => PiHostEvent[] {
  const now = options.now ?? Date.now;
  let assistantMessageSequence = 0;
  let currentMessage: AssistantMessageState | undefined;

  return (event) => {
    if (event.type === 'message_start') {
      const previousEvents = currentMessage
        ? closeContentSteps(currentMessage, 'completed', now())
        : [];
      currentMessage =
        event.message.role === 'assistant'
          ? { sequence: assistantMessageSequence++, contentSteps: new Map() }
          : undefined;
      return previousEvents;
    }

    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (!currentMessage) {
        return [];
      }
      let status: Agents.RunStepClosedStatus;
      switch (event.message.stopReason) {
        case 'aborted':
          status = 'cancelled';
          break;
        case 'error':
        case 'length':
        case 'deferred':
        case 'toolUse':
          status = 'failed';
          break;
        default:
          status = 'completed';
      }
      const completed = closeContentSteps(currentMessage, status, now());
      currentMessage = undefined;
      return completed;
    }

    if (event.type === 'agent_end') {
      return translateAgentEnd(event, options);
    }

    if (event.type === 'agent_settled') {
      if (!currentMessage) {
        return [];
      }
      const status = event.aborted ? 'cancelled' : 'completed';
      const closed = closeContentSteps(currentMessage, status, now());
      currentMessage = undefined;
      return closed;
    }

    if (event.type !== 'message_update' || event.message.role !== 'assistant' || !currentMessage) {
      return [];
    }

    const messageEvent = event.assistantMessageEvent;
    if (messageEvent.type === 'text_delta') {
      return translateContentDelta(
        currentMessage,
        messageEvent.contentIndex,
        ContentTypes.TEXT,
        messageEvent.delta,
        options,
        now,
      );
    }
    if (messageEvent.type === 'thinking_delta') {
      return translateContentDelta(
        currentMessage,
        messageEvent.contentIndex,
        ContentTypes.THINK,
        messageEvent.delta,
        options,
        now,
      );
    }
    return [];
  };
}
