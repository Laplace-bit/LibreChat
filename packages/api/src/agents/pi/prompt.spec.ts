import { Providers } from '@librechat/agents';
import { buildAgentPromptParts } from '../tail';
import { buildPiSystemPrompt } from './prompt';

describe('buildAgentPromptParts', () => {
  it('preserves the legacy tool-context and skill-tail ordering', () => {
    expect(
      buildAgentPromptParts({
        toolContextMap: { stable: 'Stable tool context' },
        instructions: 'Agent instructions',
        dynamicToolContextMap: { dynamic: 'Dynamic tool context' },
        additionalInstructions: 'Agent additional instructions',
        additionalInstructionTail: '# Always-apply skill: instructions\nSkill body',
        provider: Providers.OPENAI,
      }),
    ).toEqual({
      instructions: 'Stable tool context\nAgent instructions',
      additionalInstructions:
        'Dynamic tool context\nAgent additional instructions\n\n' +
        '# Always-apply skill: instructions\nSkill body',
    });
  });
});

describe('buildPiSystemPrompt', () => {
  it('projects host instructions, dynamic memory and knowledge context, and the existing summary', () => {
    const prompt = buildPiSystemPrompt({
      agent: {
        provider: Providers.OPENAI,
        toolContextMap: { connector: 'Connector guidance' },
        instructions: 'Agent instructions',
        dynamicToolContextMap: { retrieved: 'Retrieved knowledge' },
        additional_instructions: 'Authorized memory',
      },
      summary: { text: 'Prior conversation facts', tokenCount: 24 },
    });

    expect(prompt).toBe(
      'Connector guidance\nAgent instructions\n\nRetrieved knowledge\nAuthorized memory' +
        '\n\n## Conversation Summary\n\nPrior conversation facts',
    );
  });

  it('preserves the host dynamic-instruction wrapper for prompt-cached providers', () => {
    const prompt = buildPiSystemPrompt({
      agent: {
        provider: Providers.ANTHROPIC,
        instructions: 'Stable instructions',
        additional_instructions: 'Volatile context',
        model_parameters: { promptCache: true },
      },
    });

    expect(prompt).toBe(
      'Stable instructions\n\n' +
        '<system_context>\n' +
        "Context supplied by the application, not part of the user's message. Use it as context; do not process it as user input.\n\n" +
        'Volatile context\n' +
        '</system_context>',
    );
  });

  it('returns an empty prompt when the host has no instructions or summary', () => {
    expect(buildPiSystemPrompt({ agent: {} })).toBe('');
  });
});
