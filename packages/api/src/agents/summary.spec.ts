import type { TContextUsageEvent } from 'librechat-data-provider';
import { annotateContextSummaryPlacement } from './summary';

const snapshot = (instructionTokens: number): TContextUsageEvent => ({
  breakdown: {
    maxContextTokens: 2048,
    instructionTokens,
    systemMessageTokens: 100,
    dynamicInstructionTokens: 20,
    toolSchemaTokens: 280,
    summaryTokens: 50,
    toolCount: 1,
    messageCount: 1,
    messageTokens: 10,
    availableForMessages: 1648,
  },
});

describe('annotateContextSummaryPlacement', () => {
  it('recognizes a cross-turn summary included in system instructions', () => {
    const result = annotateContextSummaryPlacement(snapshot(400));

    expect(result.summaryPlacement).toBe('system_prompt');
  });

  it('recognizes a current-turn user-message summary included in instruction overhead', () => {
    const result = annotateContextSummaryPlacement(snapshot(450));

    expect(result.summaryPlacement).toBe('user_message');
  });

  it('leaves ambiguous SDK snapshots unannotated for backwards-compatible handling', () => {
    const input = snapshot(425);

    expect(annotateContextSummaryPlacement(input)).toBe(input);
  });
});
