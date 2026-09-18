import { describe, it, expect } from 'vitest';
import { chatExpiresAt, CHAT_TTL_MS, CHAT_RECIPE_TTL_MS } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The retention clock (issue #1430 phase 1 — moved here from firebase-sync so
// `chefChatFlow` can call it too). The two durations are pinned as literal day
// counts rather than against the exported constants: a test that re-derives the
// number it is checking from the same constant passes whatever that constant
// becomes, which is exactly the silent regression #1008 was.
describe('chatExpiresAt', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date('2026-01-01T00:00:00.000Z');

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

  it('gives a general chat a fortnight', () => {
    expect(chatExpiresAt(session(), now).toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(CHAT_TTL_MS).toBe(14 * DAY_MS);
  });

  it('gives a recipe-attached chat eighteen months', () => {
    expect(chatExpiresAt(session({ recipeId: 'recipe-1' }), now).getTime()).toBe(
      now.getTime() + 540 * DAY_MS,
    );
    expect(CHAT_RECIPE_TTL_MS).toBe(540 * DAY_MS);
  });

  it('switches on recipeId being non-null, not on it being a particular value', () => {
    // The empty string is a recipeId like any other: the field is nullable, and
    // `!== null` is the whole test. Pinned because a truthiness check here would
    // quietly demote such a chat to the fortnight.
    expect(chatExpiresAt(session({ recipeId: '' }), now).getTime()).toBe(
      now.getTime() + CHAT_RECIPE_TTL_MS,
    );
  });

  it('measures from the `now` it is given, never the wall clock', () => {
    // Hard rule 1: the domain reads no clock. Both writers pass their own, and
    // the flow's is minted once per turn — so a fixed `now` must give a fixed
    // answer.
    const later = new Date('2027-03-04T05:06:07.000Z');
    expect(chatExpiresAt(session(), later).getTime()).toBe(later.getTime() + CHAT_TTL_MS);
  });
});
