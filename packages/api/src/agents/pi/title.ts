import { PromptTemplate, TitleMethod, initializeModel } from '@librechat/agents';
import type { RunTitleOptions } from '@librechat/agents';

const DEFAULT_TITLE_PROMPT = `Analyze this conversation and provide:
1. The detected language of the conversation
2. A concise title in the detected language (5 words or less, no punctuation or quotation)

{convo}`;

const DEFAULT_COMPLETION_TITLE_PROMPT = `Provide a concise, 5-word-or-less title for the conversation, using title case conventions. Only return the title itself.

Conversation:
{convo}`;

const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'A concise title for the conversation in 5 words or less, without punctuation or quotation',
    },
  },
  required: ['title'],
} as const;

const COMBINED_TITLE_SCHEMA = {
  type: 'object',
  properties: {
    language: {
      type: 'string',
      description: 'The detected language of the conversation',
    },
    title: {
      type: 'string',
      description:
        'A concise title for the conversation in 5 words or less, without punctuation or quotation',
    },
  },
  required: ['language', 'title'],
} as const;

type TitleModelCallOptions = RunTitleOptions['chainOptions'];

interface PiTitleChatModel {
  invoke(input: string, options?: TitleModelCallOptions): Promise<unknown>;
  withStructuredOutput?(schema: typeof TITLE_SCHEMA | typeof COMBINED_TITLE_SCHEMA): {
    invoke(input: string, options?: TitleModelCallOptions): Promise<unknown>;
  };
}

export interface GenerateAgentConversationTitleInput extends RunTitleOptions {
  /** Stable host response id. Pi does not create a LangChain Run for a turn. */
  runId: string;
}

export interface GenerateAgentConversationTitleDependencies {
  createModel?(input: {
    provider: RunTitleOptions['provider'];
    clientOptions: RunTitleOptions['clientOptions'];
  }): PiTitleChatModel;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractCompletionTitle(value: unknown): string {
  const content = asRecord(value)?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        !Array.isArray(part) &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string',
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

function createTitleModel({
  provider,
  clientOptions,
}: {
  provider: RunTitleOptions['provider'];
  clientOptions: RunTitleOptions['clientOptions'];
}): PiTitleChatModel {
  return initializeModel({ provider, clientOptions }) as unknown as PiTitleChatModel;
}

/**
 * Generate a conversation title through the already-authorized host provider.
 * This mirrors the three title methods supported by Run.generateTitle without
 * constructing a second AgentRun or a LangGraph graph for a Pi turn.
 */
export function createAgentConversationTitleGenerator(
  dependencies: GenerateAgentConversationTitleDependencies = {},
): (input: GenerateAgentConversationTitleInput) => Promise<{
  language?: string;
  title?: string;
}> {
  const createModel = dependencies.createModel ?? createTitleModel;

  return async (input) => {
    const response = input.contentParts
      .map((part) => (part?.type === 'text' ? part.text : ''))
      .join('\n');
    const conversation = await PromptTemplate.fromTemplate(
      input.titlePromptTemplate ?? 'User: {input}\nAI: {output}',
    ).format({ input: input.inputText, output: response });
    const model = createModel({ provider: input.provider, clientOptions: input.clientOptions });
    const invokeConfig = {
      ...input.chainOptions,
      run_id: input.runId,
      runId: input.runId,
      runName: input.chainOptions?.runName ?? 'LibreChat Title',
      tags: [...new Set([...(input.chainOptions?.tags ?? []), 'librechat', 'title'])],
    };
    const titleMethod = input.titleMethod ?? TitleMethod.COMPLETION;

    if (titleMethod === TitleMethod.COMPLETION) {
      const titlePrompt = await PromptTemplate.fromTemplate(
        input.titlePrompt ?? DEFAULT_COMPLETION_TITLE_PROMPT,
      ).format({ convo: conversation });
      const completion = await model.invoke(titlePrompt, invokeConfig);
      return { title: extractCompletionTitle(completion) };
    }

    if (typeof model.withStructuredOutput !== 'function') {
      throw new TypeError('The configured title model does not support structured output.');
    }
    const titlePrompt = await PromptTemplate.fromTemplate(
      input.titlePrompt ?? DEFAULT_TITLE_PROMPT,
    ).format({ convo: conversation });
    const skipLanguage = input.skipLanguage === true;
    const structuredModel = model.withStructuredOutput(
      skipLanguage ? TITLE_SCHEMA : COMBINED_TITLE_SCHEMA,
    );
    const result = asRecord(await structuredModel.invoke(titlePrompt, invokeConfig));
    const title = typeof result?.title === 'string' ? result.title : '';
    if (skipLanguage) {
      return { title };
    }
    return {
      language: typeof result?.language === 'string' ? result.language : 'English',
      title,
    };
  };
}

export const generateAgentConversationTitle: ReturnType<
  typeof createAgentConversationTitleGenerator
> = createAgentConversationTitleGenerator();
