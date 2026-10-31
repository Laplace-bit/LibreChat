/**
 * Below this context budget a summarization cycle cannot make progress: the
 * summary allocation rounds down to a handful of tokens, the rewritten history
 * still overflows, and the graph re-triggers summarization on every step until
 * the recursion limit aborts the run. Keep the floor shared with runtime
 * projections so context snapshots use the same effective cap as the graph.
 */
export const MIN_SUMMARIZATION_CONTEXT_TOKENS = 1024;

/**
 * Applies `reserveRatio` against the pre-ratio base context budget, falling
 * back to the pre-computed `maxContextTokens` from initializeAgent.
 */
export function computeEffectiveMaxContextTokens(
  reserveRatio: number | undefined,
  baseContextTokens: number | undefined,
  maxContextTokens: number | undefined,
): number | undefined {
  if (reserveRatio == null || reserveRatio <= 0 || reserveRatio >= 1 || baseContextTokens == null) {
    return maxContextTokens;
  }
  const ratioComputed = Math.max(
    MIN_SUMMARIZATION_CONTEXT_TOKENS,
    Math.round(baseContextTokens * (1 - reserveRatio)),
  );
  return Math.min(maxContextTokens ?? ratioComputed, ratioComputed);
}
