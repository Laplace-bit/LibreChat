import type { TContextUsageEvent } from 'librechat-data-provider';

/**
 * Add placement metadata when the host's context breakdown can prove where the
 * summary is counted. Older SDK snapshots retain their old interpretation.
 */
export function annotateContextSummaryPlacement(snapshot: TContextUsageEvent): TContextUsageEvent {
  if (snapshot?.breakdown == null) {
    return snapshot;
  }
  const {
    instructionTokens,
    systemMessageTokens,
    dynamicInstructionTokens,
    toolSchemaTokens,
    summaryTokens,
  } = snapshot.breakdown;
  if (
    !Number.isSafeInteger(instructionTokens) ||
    !Number.isSafeInteger(systemMessageTokens) ||
    !Number.isSafeInteger(dynamicInstructionTokens) ||
    !Number.isSafeInteger(toolSchemaTokens) ||
    !Number.isSafeInteger(summaryTokens) ||
    instructionTokens < 0 ||
    systemMessageTokens < 0 ||
    dynamicInstructionTokens < 0 ||
    toolSchemaTokens < 0 ||
    summaryTokens <= 0
  ) {
    return snapshot;
  }

  const summaryOverhead =
    instructionTokens - systemMessageTokens - dynamicInstructionTokens - toolSchemaTokens;
  if (summaryOverhead === summaryTokens) {
    return { ...snapshot, summaryPlacement: 'user_message' };
  }
  if (summaryOverhead === 0) {
    return { ...snapshot, summaryPlacement: 'system_prompt' };
  }
  return snapshot;
}
