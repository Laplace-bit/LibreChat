import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@librechat/agents/langchain/messages';
import type {
  ImageContent,
  JsonObject,
  JsonValue,
  Message,
  TextContent,
  ToolCall,
  ThinkingContent,
} from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type PiHistoryMessage = Exclude<Message, { role: 'system' }>;
export type PiHistoryModel = Pick<NonNullable<AgentSession['model']>, 'api' | 'provider' | 'id'>;
export type PiHistoryCompatibilityCode =
  | 'missing_current_user'
  | 'system_message_order'
  | 'unsupported_message'
  | 'unsupported_content'
  | 'provider_signature'
  | 'invalid_tool_call'
  | 'orphan_tool_result'
  | 'unresolved_tool_call';

export class PiHistoryCompatibilityError extends Error {
  constructor(
    readonly code: PiHistoryCompatibilityCode,
    message: string,
  ) {
    super(message);
    this.name = 'PiHistoryCompatibilityError';
  }
}

export interface PiCurrentPrompt {
  text: string;
  images: ImageContent[];
}

export interface PiHistoryConversion {
  systemPrompt: string;
  history: PiHistoryMessage[];
  prompt: PiCurrentPrompt;
}

type PiContentPart = TextContent | ImageContent;
type PiAssistantContentPart = TextContent | ThinkingContent | ToolCall;
type PendingToolCall = { name: string };

const UNSUPPORTED_SIGNATURE_FIELDS = [
  'thought_signature',
  'thoughtSignature',
  'thought_signatures',
  'thoughtSignatures',
  'thoughtSignatureV1',
  'signatures',
] as const;

function incompatible(code: PiHistoryCompatibilityCode, message: string): never {
  throw new PiHistoryCompatibilityError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseImageDataUrl(value: string): ImageContent | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) {
    return undefined;
  }

  const [, mimeType, data] = match;
  const normalizedData = data.replace(/[\r\n]/g, '');
  if (
    normalizedData.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalizedData)
  ) {
    return undefined;
  }

  return { type: 'image', mimeType, data: normalizedData };
}

function parseImageBlock(value: Record<string, unknown>): ImageContent | undefined {
  const rawImage = value.image_url;
  let imageUrl: unknown;
  if (typeof rawImage === 'string') {
    imageUrl = rawImage;
  } else if (isRecord(rawImage)) {
    imageUrl = rawImage.url;
  }
  if (typeof imageUrl === 'string') {
    return parseImageDataUrl(imageUrl);
  }

  const source = isRecord(value.source) ? value.source : value;
  const data = source.data;
  const mimeType = source.mimeType ?? source.mime_type ?? source.media_type;
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return undefined;
  }
  const dataUrl = data.startsWith('data:') ? data : `data:${mimeType};base64,${data}`;
  return parseImageDataUrl(dataUrl);
}

function convertContent(content: BaseMessage['content']): PiContentPart[] {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return incompatible('unsupported_content', 'Pi cannot represent this message content.');
  }

  const parts: PiContentPart[] = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') {
      return incompatible('unsupported_content', 'Pi cannot represent an untyped content block.');
    }

    if (rawPart.type === 'text') {
      if (typeof rawPart.text !== 'string') {
        return incompatible('unsupported_content', 'Pi cannot represent a non-text text block.');
      }
      if (rawPart.text.length > 0) {
        parts.push({ type: 'text', text: rawPart.text });
      }
      continue;
    }

    if (rawPart.type === 'image' || rawPart.type === 'image_url') {
      const image = parseImageBlock(rawPart);
      if (!image) {
        return incompatible(
          'unsupported_content',
          'Pi history only accepts inline base64 images that were already authorized by the host.',
        );
      }
      parts.push(image);
      continue;
    }

    return incompatible(
      'unsupported_content',
      `Pi history cannot safely represent the '${rawPart.type}' content block.`,
    );
  }

  return parts;
}

function convertSystemContent(content: BaseMessage['content']): string {
  const parts = convertContent(content);
  return parts
    .map((part) => {
      if (part.type !== 'text') {
        return incompatible('unsupported_content', 'System messages must contain text only.');
      }
      return part.text;
    })
    .join('');
}

function convertAssistantContent(message: AIMessage): PiAssistantContentPart[] {
  if (typeof message.content === 'string') {
    return message.content.length === 0 ? [] : [{ type: 'text', text: message.content }];
  }
  if (!Array.isArray(message.content)) {
    return incompatible('unsupported_content', 'Pi cannot represent this assistant message.');
  }

  const parts: PiAssistantContentPart[] = [];
  for (const rawPart of message.content) {
    if (!isRecord(rawPart) || typeof rawPart.type !== 'string') {
      return incompatible('unsupported_content', 'Pi cannot represent an untyped assistant block.');
    }
    if (rawPart.type === 'text') {
      if (typeof rawPart.text !== 'string') {
        return incompatible(
          'unsupported_content',
          'Pi cannot represent a non-text assistant block.',
        );
      }
      if (rawPart.text.length > 0) {
        parts.push({ type: 'text', text: rawPart.text });
      }
      continue;
    }
    if (rawPart.type === 'thinking' && typeof rawPart.thinking === 'string') {
      parts.push({ type: 'thinking', thinking: rawPart.thinking });
      continue;
    }
    return incompatible(
      'unsupported_content',
      `Pi history cannot safely represent the '${rawPart.type}' assistant block.`,
    );
  }
  return parts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isJsonValue(item, ancestors))
    : isPlainRecord(value) && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isPlainRecord(value)) {
    return false;
  }
  return isJsonValue(value, new WeakSet());
}

function isProviderSignature(value: unknown): boolean {
  return isRecord(value) && UNSUPPORTED_SIGNATURE_FIELDS.some((field) => value[field] != null);
}

function containsProviderSignature(value: unknown): boolean {
  if (isProviderSignature(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsProviderSignature(item));
  }
  return isRecord(value) && Object.values(value).some((item) => containsProviderSignature(item));
}

function contentHasProviderSignature(content: BaseMessage['content']): boolean {
  return containsProviderSignature(content);
}

function parseToolCall(value: unknown): { id: string; name: string; arguments: JsonObject } {
  if (!isRecord(value)) {
    return incompatible('invalid_tool_call', 'A stored tool call is not an object.');
  }

  const rawFunction = isRecord(value.function) ? value.function : undefined;
  const id = value.id;
  const name = rawFunction?.name ?? value.name;
  const rawArguments = rawFunction?.arguments ?? value.args ?? value.arguments;
  let argumentsValue: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      argumentsValue = JSON.parse(rawArguments);
    } catch {
      return incompatible('invalid_tool_call', 'A stored tool call has invalid JSON arguments.');
    }
  }

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof name !== 'string' ||
    name.length === 0 ||
    !isJsonObject(argumentsValue)
  ) {
    return incompatible(
      'invalid_tool_call',
      'A stored tool call lacks a valid id, name, or object arguments.',
    );
  }

  return { id, name, arguments: argumentsValue };
}

function hasProviderSignature(message: AIMessage): boolean {
  return (
    isProviderSignature(message.additional_kwargs) || contentHasProviderSignature(message.content)
  );
}

function assertNoPendingToolCalls(pendingToolCalls: Map<string, PendingToolCall>): void {
  if (pendingToolCalls.size > 0) {
    return incompatible(
      'unresolved_tool_call',
      'Pi cannot continue a transcript that ends with an unfinished tool call.',
    );
  }
}

function convertPromptContent(content: PiContentPart[]): PiCurrentPrompt {
  const images: ImageContent[] = [];
  const text: string[] = [];
  let imageStarted = false;
  for (const part of content) {
    if (part.type === 'image') {
      imageStarted = true;
      images.push(part);
      continue;
    }
    if (imageStarted && part.text.length > 0) {
      return incompatible(
        'unsupported_content',
        'The Pi prompt adapter cannot preserve text that follows an inline image.',
      );
    }
    text.push(part.text);
  }

  const promptText = text.join('');
  if (promptText.length === 0 && images.length === 0) {
    return incompatible('unsupported_content', 'The current user message is empty.');
  }
  return { text: promptText, images };
}

/**
 * Convert the server-authorized, formatted LibreChat transcript into Pi's
 * structured session history. The last user message remains the live prompt;
 * preceding user/assistant/tool records become in-memory Pi history entries.
 */
export function convertLibreChatHistoryToPi(input: {
  messages: BaseMessage[];
  model: PiHistoryModel;
  baseSystemPrompt?: string;
  now?: () => number;
}): PiHistoryConversion {
  const { messages, model } = input;
  const now = input.now ?? Date.now;
  const systemPrompts: string[] = [];
  const history: PiHistoryMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const seenToolCallIds = new Set<string>();
  let conversationStarted = false;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || !HumanMessage.isInstance(lastMessage)) {
    return incompatible(
      'missing_current_user',
      'Pi requires a current user message to start a run.',
    );
  }
  const currentUser = lastMessage;

  const historicalMessages = messages.slice(0, -1);
  for (const message of historicalMessages) {
    if (SystemMessage.isInstance(message)) {
      if (conversationStarted) {
        return incompatible(
          'system_message_order',
          'Pi history cannot move a system message that follows conversation content.',
        );
      }
      systemPrompts.push(convertSystemContent(message.content));
      continue;
    }

    conversationStarted = true;
    if (HumanMessage.isInstance(message)) {
      assertNoPendingToolCalls(pendingToolCalls);
      const content = convertContent(message.content);
      history.push({
        role: 'user',
        content: typeof message.content === 'string' ? message.content : content,
        timestamp: now(),
      });
      continue;
    }

    if (AIMessage.isInstance(message)) {
      assertNoPendingToolCalls(pendingToolCalls);
      if (hasProviderSignature(message)) {
        return incompatible(
          'provider_signature',
          'This transcript contains provider-specific thought signatures that Pi cannot preserve.',
        );
      }
      if (message.invalid_tool_calls?.length) {
        return incompatible('invalid_tool_call', 'This transcript contains an invalid tool call.');
      }
      const content = convertAssistantContent(message);
      const calls =
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0
          ? message.tool_calls
          : message.additional_kwargs.tool_calls;
      const toolCalls = Array.isArray(calls) ? calls.map(parseToolCall) : [];
      for (const call of toolCalls) {
        if (seenToolCallIds.has(call.id)) {
          return incompatible('invalid_tool_call', 'This transcript repeats a tool call id.');
        }
        seenToolCallIds.add(call.id);
        pendingToolCalls.set(call.id, { name: call.name });
        content.push({
          type: 'toolCall',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      history.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp: now(),
      });
      continue;
    }

    if (ToolMessage.isInstance(message)) {
      const pending = pendingToolCalls.get(message.tool_call_id);
      if (!pending) {
        return incompatible(
          'orphan_tool_result',
          'This transcript contains a tool result without its assistant tool call.',
        );
      }
      if (message.name != null && message.name !== pending.name) {
        return incompatible(
          'orphan_tool_result',
          'A tool result name does not match its tool call.',
        );
      }
      const content = convertContent(message.content);
      history.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id,
        toolName: message.name ?? pending.name,
        content,
        isError: message.status === 'error',
        timestamp: now(),
      });
      pendingToolCalls.delete(message.tool_call_id);
      continue;
    }

    return incompatible(
      'unsupported_message',
      `Pi history cannot safely represent the '${message.getType()}' message.`,
    );
  }

  assertNoPendingToolCalls(pendingToolCalls);
  const prompt = convertPromptContent(convertContent(currentUser.content));
  const baseSystemPrompt = input.baseSystemPrompt?.trim();
  const systemPrompt = [...(baseSystemPrompt ? [baseSystemPrompt] : []), ...systemPrompts]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return { systemPrompt, history, prompt };
}
