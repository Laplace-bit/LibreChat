import { HumanMessage, SystemMessage } from '@librechat/agents/langchain/messages';
import type { PiModelBinding } from './session';
import { projectPiContextUsage } from './contextUsage';

const model = {
  api: 'openai-responses',
  provider: 'openai',
  id: 'gpt-4o-mini',
  contextWindow: 8192,
  maxTokens: 512,
} as PiModelBinding['model'];

describe('projectPiContextUsage', () => {
  it('projects host instructions and messages into the shared pre-invoke budget shape', () => {
    const snapshot = projectPiContextUsage({
      messages: [new SystemMessage('system guidance'), new HumanMessage('user question')],
      model,
      tokenCounter: (message) => (message._getType() === 'system' ? 18 : 27),
      runId: 'response-1',
      agentId: 'agent-1',
      provider: 'openAI',
      calibrationRatio: 1.25,
    });

    expect(snapshot).toEqual({
      runId: 'response-1',
      agentId: 'agent-1',
      model: 'gpt-4o-mini',
      provider: 'openAI',
      breakdown: {
        maxContextTokens: 8192,
        instructionTokens: 18,
        systemMessageTokens: 18,
        dynamicInstructionTokens: 0,
        toolSchemaTokens: 0,
        summaryTokens: 0,
        toolCount: 0,
        messageCount: 1,
        messageTokens: 27,
        availableForMessages: 7764,
      },
      contextBudget: 7782,
      effectiveInstructionTokens: 18,
      prePruneContextTokens: 34,
      remainingContextTokens: 7727,
      calibrationRatio: 1.25,
    });
  });

  it('omits a snapshot when model limits or message counts cannot be measured', () => {
    expect(
      projectPiContextUsage({
        messages: [new HumanMessage('user question')],
        model: { ...model, contextWindow: undefined } as unknown as PiModelBinding['model'],
        tokenCounter: () => 1,
        runId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();

    expect(
      projectPiContextUsage({
        messages: [new HumanMessage('user question')],
        model,
        tokenCounter: () => Number.NaN,
        runId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
  });
});
