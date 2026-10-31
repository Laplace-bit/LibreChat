import { Constants } from 'librechat-data-provider';
import type { TContextUsageEvent } from 'librechat-data-provider';
import { deriveTokenUsageView, pendingToBranchUsage } from '../view';
import { buildIndex, clearIndex } from '../registry';
import { EMPTY_BRANCH, EMPTY_USAGE } from '../types';

describe('pendingToBranchUsage', () => {
  it('normalizes counts and marks cost known only when every event carried one', () => {
    const usage = pendingToBranchUsage({
      input: 10,
      output: -3,
      cacheWrite: 1,
      cacheRead: 2,
      eventCount: 2,
      costUSD: 0.5,
      costKnown: true,
    });
    expect(usage).toMatchObject({ input: 10, output: 0, cacheWrite: 1, cacheRead: 2, cost: 0.5 });
    expect(usage.costKnown).toBe(true);
  });

  it('reports zero cost for a non-positive or non-finite figure', () => {
    const base = {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      eventCount: 1,
      costKnown: false,
    };
    expect(pendingToBranchUsage({ ...base, costUSD: Number.NaN }).cost).toBe(0);
    expect(pendingToBranchUsage({ ...base, costUSD: 0 }).costKnown).toBe(false);
  });
});

describe('deriveTokenUsageView summary accounting', () => {
  const conversationKey = 'summary-placement';

  afterEach(() => {
    clearIndex(conversationKey);
  });

  it('does not add an instruction-embedded summary to the gauge twice', () => {
    const snapshot: TContextUsageEvent & { anchorMessageId: string } = {
      runId: 'run-1',
      summaryPlacement: 'system_prompt',
      breakdown: {
        maxContextTokens: 1000,
        instructionTokens: 100,
        systemMessageTokens: 100,
        dynamicInstructionTokens: 0,
        toolSchemaTokens: 0,
        summaryTokens: 25,
        toolCount: 0,
        messageCount: 1,
        messageTokens: 60,
        availableForMessages: 900,
      },
      contextBudget: 1000,
      remainingContextTokens: 840,
      effectiveInstructionTokens: 100,
      anchorMessageId: 'a1',
    };
    const branchTotals = { ...EMPTY_BRANCH, tailId: 'a1', containsAnchor: true };
    buildIndex(conversationKey, []);

    const view = deriveTokenUsageView({
      snapshot: null,
      isSubmitting: false,
      turnInProgress: false,
      activeResponseId: null,
      branchTotals,
      branchUsage: EMPTY_USAGE,
      totalUsage: EMPTY_USAGE,
      hasUsage: true,
      liveTokens: 0,
      limits: {},
      branchSnapshot: snapshot,
      snapshotsByAnchor: new Map(),
      subagentUsage: EMPTY_USAGE,
      conversationKey,
      modelOverhead: 0,
    });

    expect(view.usedTokens).toBe(160);
  });
});
