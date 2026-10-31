import { TitleMethod } from '@librechat/agents';
import type { RunTitleOptions } from '@librechat/agents';
import { createAgentConversationTitleGenerator } from './title';

const baseInput: RunTitleOptions & { runId: string } = {
  provider: 'openAI',
  inputText: 'What changed in the production line?',
  contentParts: [{ type: 'text', text: 'The sensor drifted after the update.' }],
  titlePrompt: 'Conversation: {convo}',
  titlePromptTemplate: 'User: {input}\nAssistant: {output}',
  clientOptions: { model: 'gpt-4o-mini' },
  chainOptions: {
    runName: 'TitleRun',
    configurable: { thread_id: 'conversation-1', user_id: 'user-1' },
  },
  titleMethod: TitleMethod.COMPLETION,
  runId: 'response-1',
};

describe('generateAgentConversationTitle', () => {
  it('uses the completion title path and forwards title callbacks, identity and conversation text', async () => {
    const invoke = jest.fn().mockResolvedValue({ content: '  Sensor Drift  ' });
    const createModel = jest.fn(() => ({ invoke }));
    const generateTitle = createAgentConversationTitleGenerator({ createModel });

    await expect(generateTitle(baseInput)).resolves.toEqual({ title: 'Sensor Drift' });

    expect(createModel).toHaveBeenCalledWith({
      provider: baseInput.provider,
      clientOptions: baseInput.clientOptions,
    });
    expect(invoke).toHaveBeenCalledWith(
      'Conversation: User: What changed in the production line?\nAssistant: The sensor drifted after the update.',
      expect.objectContaining({
        run_id: 'response-1',
        runId: 'response-1',
        runName: 'TitleRun',
        configurable: { thread_id: 'conversation-1', user_id: 'user-1' },
      }),
    );
  });

  it.each([TitleMethod.FUNCTIONS, TitleMethod.STRUCTURED])(
    'uses structured output for the %s title method',
    async (titleMethod) => {
      const invoke = jest.fn().mockResolvedValue({ language: 'English', title: 'Sensor Drift' });
      const withStructuredOutput = jest.fn(() => ({ invoke }));
      const generateTitle = createAgentConversationTitleGenerator({
        createModel: () => ({ invoke: jest.fn(), withStructuredOutput }),
      });

      await expect(generateTitle({ ...baseInput, titleMethod })).resolves.toEqual({
        language: 'English',
        title: 'Sensor Drift',
      });

      expect(withStructuredOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ language: expect.anything() }),
        }),
      );
      expect(invoke).toHaveBeenCalledWith(
        'Conversation: User: What changed in the production line?\nAssistant: The sensor drifted after the update.',
        expect.objectContaining({ run_id: 'response-1' }),
      );
    },
  );

  it('uses the title-only schema when language detection is disabled', async () => {
    const invoke = jest.fn().mockResolvedValue({ title: 'Sensor Drift' });
    const withStructuredOutput = jest.fn(() => ({ invoke }));
    const generateTitle = createAgentConversationTitleGenerator({
      createModel: () => ({ invoke: jest.fn(), withStructuredOutput }),
    });

    await expect(
      generateTitle({ ...baseInput, skipLanguage: true, titleMethod: TitleMethod.STRUCTURED }),
    ).resolves.toEqual({ title: 'Sensor Drift' });
    expect(withStructuredOutput).toHaveBeenCalledWith(
      expect.not.objectContaining({
        properties: expect.objectContaining({ language: expect.anything() }),
      }),
    );
  });

  it('ignores non-text response parts when formatting a title transcript', async () => {
    const invoke = jest.fn().mockResolvedValue({ content: 'Sensor Drift' });
    const generateTitle = createAgentConversationTitleGenerator({
      createModel: () => ({ invoke }),
    });

    await generateTitle({
      ...baseInput,
      contentParts: [
        { type: 'reasoning', reasoning: 'private reasoning' },
        { type: 'text', text: 'Answer text' },
      ] as RunTitleOptions['contentParts'],
    });

    expect(invoke.mock.calls[0][0]).toContain('Assistant: \nAnswer text');
    expect(invoke.mock.calls[0][0]).not.toContain('private reasoning');
  });
});
