import { buildAgentPromptParts } from '../tail';

export interface PiPromptAgent {
  provider?: string;
  instructions?: string | null;
  additional_instructions?: string | null;
  toolContextMap?: Record<string, unknown>;
  dynamicToolContextMap?: Record<string, unknown>;
  model_parameters?: { promptCache?: boolean };
}

export interface PiPromptSummary {
  text: string;
  tokenCount: number;
}

/**
 * Builds the one system prompt Pi needs from the same host-owned instruction
 * fields AgentContext consumes, plus LibreChat's existing cross-run summary.
 */
export function buildPiSystemPrompt(input: {
  agent: PiPromptAgent;
  summary?: PiPromptSummary;
}): string {
  const { agent, summary } = input;
  const parts = buildAgentPromptParts({
    toolContextMap: agent.toolContextMap,
    instructions: agent.instructions,
    dynamicToolContextMap: agent.dynamicToolContextMap,
    additionalInstructions: agent.additional_instructions,
    provider: agent.provider ?? '',
    promptCache: agent.model_parameters?.promptCache === true,
  });
  const summaryInstruction =
    summary?.text == null || summary.text.length === 0
      ? ''
      : `## Conversation Summary\n\n${summary.text}`;

  return [parts.instructions, parts.additionalInstructions ?? '', summaryInstruction]
    .filter(Boolean)
    .join('\n\n');
}
