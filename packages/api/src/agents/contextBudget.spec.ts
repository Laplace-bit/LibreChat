import { computeEffectiveMaxContextTokens } from './contextBudget';

describe('computeEffectiveMaxContextTokens', () => {
  it('clamps the initialized context cap by the reserve ratio', () => {
    expect(computeEffectiveMaxContextTokens(0.1, 10_000, 9_500)).toBe(9_000);
  });

  it('preserves a stricter initialized cap', () => {
    expect(computeEffectiveMaxContextTokens(0.1, 10_000, 8_000)).toBe(8_000);
  });

  it('keeps the initialized cap when the ratio or base budget is unavailable', () => {
    expect(computeEffectiveMaxContextTokens(undefined, 10_000, 9_500)).toBe(9_500);
    expect(computeEffectiveMaxContextTokens(0.1, undefined, 9_500)).toBe(9_500);
  });
});
