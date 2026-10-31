import { HumanMessage } from '@librechat/agents/langchain/messages';
import { convertLibreChatHistoryToPi } from './history';

describe('convertLibreChatHistoryToPi', () => {
  it('preserves a host-injected skill prime before the current user prompt', () => {
    const skillBody = 'Check the machine isolation log before recommending work.';
    const conversion = convertLibreChatHistoryToPi({
      messages: [
        new HumanMessage({
          content: skillBody,
          additional_kwargs: {
            isMeta: true,
            source: 'skill',
            skillName: 'machine-safety',
          },
        }),
        new HumanMessage('What should I review?'),
      ],
      model: { api: 'openai-responses', provider: 'openai', id: 'gpt-4o' },
      now: () => 1,
    });

    expect(conversion.history).toEqual([
      {
        role: 'user',
        content: skillBody,
        timestamp: 1,
      },
    ]);
    expect(conversion.prompt.text).toBe('What should I review?');
  });
});
