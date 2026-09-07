import { describe, it, expect } from 'vitest';
import { latestChefOffers, offersDishChange, offersNewDish } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The gate behind every recipe action under a chef's reply (issue #1299). Three
// surfaces ask it, so it is one pure function rather than three predicates — and
// what these tests pin is the two claims its header states as absolutes: NEWEST
// reply only, and FAIL CLOSED.

function session(
  messages: readonly {
    role: 'user' | 'assistant';
    offered?: ChatSessionDoc['messages'][number]['offered'];
  }[],
): ChatSessionDoc {
  return {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: 'lamb',
    basedOnRecipeId: null,
    title: 'Lamb chat',
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      role: m.role,
      text: `turn ${i}`,
      createdAt: `2026-08-01T00:00:0${i}.000Z`,
      offered: m.offered ?? [],
    })),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    reopenedAt: null,
    expiresAt: '2026-08-15T00:00:00.000Z',
  };
}

describe('latestChefOffers — the newest reply only', () => {
  it('reads the LAST assistant turn, not the first', () => {
    // The failure this catches is a forward scan: an older reply that offered
    // something would keep its buttons alive under a plain answer given since.
    const doc = session([
      { role: 'user' },
      { role: 'assistant', offered: ['dish-change', 'new-dish'] },
      { role: 'user' },
      { role: 'assistant', offered: [] },
    ]);

    expect(latestChefOffers(doc)).toEqual([]);
    expect(offersDishChange(doc)).toBe(false);
    expect(offersNewDish(doc)).toBe(false);
  });

  it('is not confused by a user turn after the reply', () => {
    const doc = session([
      { role: 'user' },
      { role: 'assistant', offered: ['dish-change'] },
      { role: 'user' },
    ]);

    expect(offersDishChange(doc)).toBe(true);
  });

  it('answers each kind separately — the pair no longer shares a gate', () => {
    const changeOnly = session([{ role: 'assistant', offered: ['dish-change'] }]);
    const dishOnly = session([{ role: 'assistant', offered: ['new-dish'] }]);

    expect([offersDishChange(changeOnly), offersNewDish(changeOnly)]).toEqual([true, false]);
    expect([offersDishChange(dishOnly), offersNewDish(dishOnly)]).toEqual([false, true]);
  });
});

describe('latestChefOffers — fail closed', () => {
  it('offers nothing for a conversation the chef has not answered yet', () => {
    expect(latestChefOffers(session([{ role: 'user' }]))).toEqual([]);
  });

  it('offers nothing for an empty conversation', () => {
    expect(latestChefOffers(session([]))).toEqual([]);
  });

  it('offers nothing when there is no conversation at all', () => {
    // Both spellings: the recipe page holds `activeSession` as possibly
    // undefined, the chat page as null.
    expect(latestChefOffers(null)).toEqual([]);
    expect(latestChefOffers(undefined)).toEqual([]);
  });

  it('offers nothing when the chef declared nothing on its newest reply', () => {
    const doc = session([{ role: 'user' }, { role: 'assistant' }]);

    expect(offersDishChange(doc)).toBe(false);
    expect(offersNewDish(doc)).toBe(false);
  });

  it('ignores a kind this build does not know, and keeps the ones it does', () => {
    // The other half of the deploy-skew answer (PR #1303 review).
    // `MessageSchema.offered` stores plain strings so that a third kind added
    // after this bundle shipped cannot fail the message and drop the whole
    // conversation out of the chat list. THIS is where the cost lands instead: a
    // word this build has no button for gates nothing, while the kinds it does
    // know are unaffected.
    const doc = session([{ role: 'assistant', offered: ['sous-vide-it', 'new-dish'] }]);

    expect(latestChefOffers(doc)).toEqual(['new-dish']);
    expect(offersNewDish(doc)).toBe(true);
    expect(offersDishChange(doc)).toBe(false);
  });
});
