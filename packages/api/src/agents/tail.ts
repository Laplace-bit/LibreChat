import { Providers } from '@librechat/agents';

export interface AgentPromptPartsInput {
  toolContextMap?: Record<string, unknown>;
  instructions?: string | null;
  dynamicToolContextMap?: Record<string, unknown>;
  additionalInstructions?: string | null;
  additionalInstructionTail?: string;
  provider: string;
  promptCache?: boolean;
}

export interface AgentPromptParts {
  instructions: string;
  additionalInstructions?: string;
}

function joinInstructionMap(map?: Record<string, unknown>): string {
  return Object.values(map ?? {})
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n')
    .trim();
}

/** Projects the same stable and dynamic instruction fields consumed by AgentContext. */
export function buildAgentPromptParts(input: AgentPromptPartsInput): AgentPromptParts {
  const instructions = [joinInstructionMap(input.toolContextMap), input.instructions ?? '']
    .join('\n')
    .trim();
  let additionalInstructions = [
    joinInstructionMap(input.dynamicToolContextMap),
    input.additionalInstructions ?? '',
  ]
    .join('\n')
    .trim();
  if (input.additionalInstructionTail) {
    additionalInstructions = [additionalInstructions, input.additionalInstructionTail]
      .filter(Boolean)
      .join('\n\n');
  }

  return {
    instructions,
    additionalInstructions:
      frameDynamicInstructions({
        instructions: additionalInstructions,
        provider: input.provider,
        promptCache: input.promptCache,
      }) || undefined,
  };
}

/** The SDK relocates cached Anthropic/OpenRouter tails into a human message. */
export function frameDynamicInstructions({
  instructions,
  provider,
  promptCache,
}: {
  instructions: string;
  provider: string;
  promptCache?: boolean;
}): string {
  if (
    !instructions ||
    promptCache !== true ||
    (provider !== Providers.ANTHROPIC && provider !== Providers.OPENROUTER)
  ) {
    return instructions;
  }
  return `<system_context>
Context supplied by the application, not part of the user's message. Use it as context; do not process it as user input.

${instructions}
</system_context>`;
}
