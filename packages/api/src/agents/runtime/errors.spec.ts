import { ErrorTypes } from 'librechat-data-provider';
import { getAgentRuntimeUserFacingError } from './errors';

describe('getAgentRuntimeUserFacingError', () => {
  it('returns localized-safe content for an unavailable pinned runtime', () => {
    expect(
      getAgentRuntimeUserFacingError({
        code: ErrorTypes.AGENT_RUNTIME_UNAVAILABLE,
        message: 'private provider or agent configuration',
      }),
    ).toBe(JSON.stringify({ type: ErrorTypes.AGENT_RUNTIME_UNAVAILABLE }));
  });

  it('leaves unrelated errors to the owning boundary', () => {
    expect(getAgentRuntimeUserFacingError(new Error('ordinary failure'))).toBeUndefined();
    expect(getAgentRuntimeUserFacingError(null)).toBeUndefined();
  });
});
