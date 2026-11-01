import { resolvePiRegenerationUser } from './regeneration';

describe('resolvePiRegenerationUser', () => {
  const user = { messageId: 'user-1', parentMessageId: 'parent-1', isCreatedByUser: true };

  it('returns the persisted branch head only when its identity and lineage match', () => {
    expect(resolvePiRegenerationUser([user], 'user-1', 'parent-1')).toBe(user);
    expect(() => resolvePiRegenerationUser([], 'user-1', 'parent-1')).toThrow();
    expect(() => resolvePiRegenerationUser([user], 'other-user', 'parent-1')).toThrow();
    expect(() => resolvePiRegenerationUser([user], 'user-1', 'other-parent')).toThrow();
    expect(() =>
      resolvePiRegenerationUser([{ ...user, isCreatedByUser: false }], 'user-1', 'parent-1'),
    ).toThrow();
  });
});
