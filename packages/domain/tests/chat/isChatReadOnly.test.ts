import { describe, it, expect } from 'vitest';
import { isChatReadOnly, CHAT_READ_ONLY_AFTER_MS } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The two-day quiet clock (issue #1270), pinned against the adversarial cases:
// exactly on the boundary, before a reopen, and after one.
describe('isChatReadOnly', () => {
  function session(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
    return {
      id: 'sess-1',
      schemaVersion: 1,
      ownerUid: 'uid-1',
      recipeId: null,
      basedOnRecipeId: null,
      title: 'New chat',
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      reopenedAt: null,
      expiresAt: '2026-01-15T00:00:00.000Z',
      ...overrides,
    };
  }

  it('is not read-only inside the two-day window from createdAt', () => {
    const now = new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + CHAT_READ_ONLY_AFTER_MS);
    expect(isChatReadOnly(session(), now)).toBe(false);
  });

  it('is read-only the instant it passes two days from createdAt', () => {
    const now = new Date(
      new Date('2026-01-01T00:00:00.000Z').getTime() + CHAT_READ_ONLY_AFTER_MS + 1,
    );
    expect(isChatReadOnly(session(), now)).toBe(true);
  });

  it('measures from reopenedAt once set, ignoring the original createdAt', () => {
    const reopenedAt = '2026-06-01T00:00:00.000Z';
    const now = new Date(new Date(reopenedAt).getTime() + 1000);
    // createdAt is months in the past — would be read-only on its own — but the
    // reopen restarts the clock (issue #1270, Q2 follow-up).
    expect(isChatReadOnly(session({ reopenedAt }), now)).toBe(false);
  });

  it('goes read-only again two days after a reopen', () => {
    const reopenedAt = '2026-06-01T00:00:00.000Z';
    const now = new Date(new Date(reopenedAt).getTime() + CHAT_READ_ONLY_AFTER_MS + 1);
    expect(isChatReadOnly(session({ reopenedAt }), now)).toBe(true);
  });
});
