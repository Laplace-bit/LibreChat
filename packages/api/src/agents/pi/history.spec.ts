import { HumanMessage } from '@librechat/agents/langchain/messages';
import { convertLibreChatHistoryToPi } from './history';

describe('convertLibreChatHistoryToPi', () => {
  it('preserves text and authorized inline image parts in their original prompt order', () => {
    const firstText = 'before the image';
    const imageData = 'YQ==';
    const lastText = 'after the image';
    const conversion = convertLibreChatHistoryToPi({
      messages: [
        new HumanMessage({
          content: [
            { type: 'text', text: firstText },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageData}` },
            },
            { type: 'text', text: lastText },
          ],
        }),
      ],
      model: { api: 'openai-responses', provider: 'openai', id: 'gpt-4o' },
      now: () => 1,
    });

    expect(conversion.prompt.content).toEqual([
      { type: 'text', text: firstText },
      { type: 'image', mimeType: 'image/png', data: imageData },
      { type: 'text', text: lastText },
    ]);
    expect(conversion.prompt.text).toBe(`${firstText}${lastText}`);
    expect(conversion.prompt.images).toEqual([
      { type: 'image', mimeType: 'image/png', data: imageData },
    ]);
  });

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
