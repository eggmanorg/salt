import { describe, it, expect } from 'vitest';
import { makeFreshSession } from '@salt/domain';
import { CookSessionSchema } from '@salt/domain/schemas';

// A brand-new cook session (issue #556). Everything empty, both timestamps taken
// from the INJECTED `nowIso` — the module never reads a clock (CLAUDE.md Rule 1).

const ARGS = {
  id: 'recipe-1_uid-1',
  ownerUid: 'uid-1',
  recipeId: 'recipe-1',
  recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
  nowIso: '2026-07-22T18:30:00.000Z',
};

describe('makeFreshSession', () => {
  it('builds a session with nothing ticked, nothing done and no timers', () => {
    expect(makeFreshSession(ARGS)).toEqual({
      id: 'recipe-1_uid-1',
      schemaVersion: 1,
      ownerUid: 'uid-1',
      recipeId: 'recipe-1',
      recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
      checkedIngredientIds: [],
      checkedPrepIds: [],
      completedStepIds: [],
      activeTimers: [],
      // …and no serve time (issue #752): a fresh session never carries one, not
      // even a meal's — the cook plan writes it on the first set.
      serveAt: null,
      servings: null,
      createdAt: '2026-07-22T18:30:00.000Z',
      updatedAt: '2026-07-22T18:30:00.000Z',
    });
  });

  it('stamps the SAME injected instant on createdAt and updatedAt', () => {
    const session = makeFreshSession(ARGS);
    expect(session.createdAt).toBe(ARGS.nowIso);
    expect(session.updatedAt).toBe(ARGS.nowIso);
  });

  it('takes the drift baseline from the recipe, not from now', () => {
    // These must not be conflated: the banner compares the LIVE recipe against
    // this baseline, so seeding it with `nowIso` would never fire.
    const session = makeFreshSession(ARGS);
    expect(session.recipeUpdatedAtAtStart).toBe('2026-07-01T09:00:00.000Z');
    expect(session.recipeUpdatedAtAtStart).not.toBe(session.createdAt);
  });

  it('produces a document that satisfies CookSessionSchema', () => {
    // The trust boundary this doc is about to cross is a Firestore write.
    expect(CookSessionSchema.safeParse(makeFreshSession(ARGS)).success).toBe(true);
  });

  it('gives each session its own array instances', () => {
    // Shared array references would let one session's ticks leak into another.
    const a = makeFreshSession(ARGS);
    const b = makeFreshSession(ARGS);
    expect(a.checkedIngredientIds).not.toBe(b.checkedIngredientIds);
    expect(a.checkedPrepIds).not.toBe(b.checkedPrepIds);
    expect(a.completedStepIds).not.toBe(b.completedStepIds);
    expect(a.activeTimers).not.toBe(b.activeTimers);
  });

  it('reads no clock — identical args produce identical output', () => {
    expect(makeFreshSession(ARGS)).toEqual(makeFreshSession(ARGS));
  });
});
