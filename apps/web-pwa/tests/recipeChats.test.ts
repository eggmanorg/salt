import { describe, it, expect } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

import { chatsForRecipe } from '../src/routes/recipes/recipeChats.js';

// "Every chat about this dish" (issue #696) is a client-side filter over a store
// that is already loaded — no query, no index, no schema field. What matters is
// that it selects the right conversations and orders them the way the list reads:
// newest first.

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: 'recipe-1',
    title: 'Test chat',
    messages: [],
    basedOnRecipeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reopenedAt: null,
    expiresAt: '9999-12-31T23:59:59.999Z',
    ...overrides,
  };
}

describe('chatsForRecipe', () => {
  it('keeps only the chats attached to that recipe', () => {
    const mine = makeSession({ id: 'a' });
    const other = makeSession({ id: 'b', recipeId: 'recipe-2' });
    const general = makeSession({ id: 'c', recipeId: null });

    expect(chatsForRecipe([mine, other, general], 'recipe-1').map((s) => s.id)).toEqual(['a']);
  });

  it('orders newest first', () => {
    const oldest = makeSession({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' });
    const newest = makeSession({ id: 'new', updatedAt: '2026-03-01T00:00:00.000Z' });
    const middle = makeSession({ id: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' });

    expect(chatsForRecipe([oldest, newest, middle], 'recipe-1').map((s) => s.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('does not mutate the store array it was handed', () => {
    // The sessions store is shared; sorting it in place would reorder every other
    // consumer as a side effect of rendering one recipe.
    const sessions = [
      makeSession({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeSession({ id: 'new', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    chatsForRecipe(sessions, 'recipe-1');

    expect(sessions.map((s) => s.id)).toEqual(['old', 'new']);
  });

  it('returns nothing for a recipe with no chats', () => {
    expect(chatsForRecipe([makeSession({ recipeId: 'recipe-2' })], 'recipe-1')).toEqual([]);
  });
});
