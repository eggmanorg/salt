import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { Recipe } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';
import { withEffectRoot } from './support/effectRoot.svelte.js';

/**
 * Which number a cook screen is cooking for, and what it writes down (issue #1314).
 *
 * Tested here rather than through either cook page because this is the whole of the
 * rule and it is shared by both of them: the URL wins and is pinned onto the
 * session, a resume with no link reads the session back, and an unscalable recipe
 * ignores the parameter entirely. Driving it from a page would need that page's
 * whole mock preamble to assert a rule neither page owns.
 */

const { mockRouter, mockPersist } = vi.hoisted(() => ({
  // svelte-spa-router's `router` is a rune-backed state object; the factory reads
  // `router.querystring` live.
  mockRouter: { querystring: '' as string | undefined },
  mockPersist: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
}));

vi.mock('svelte-spa-router', () => ({ router: mockRouter, push: vi.fn() }));
vi.mock('../src/lib/cookSessionService.js', () => ({ persistCookSession: mockPersist }));

const { createCookServings } = await import('../src/routes/recipes/cookServings.svelte.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function recipeServing(servings: number | null): Recipe {
  return {
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Pancakes',
    description: null,
    ingredients: [],
    steps: [],
    metadata: { servings, tags: [] },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

function session(servings: number | null): CookSessionDoc {
  return {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    recipeUpdatedAtAtStart: '2026-01-01T00:00:00.000Z',
    checkedIngredientIds: [],
    completedStepIds: [],
    activeTimers: [],
    checkedPrepIds: [],
    serveAt: null,
    servings,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRouter.querystring = '';
});

describe('createCookServings — which number wins', () => {
  it('cooks as written when nothing says otherwise', () => {
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(null) }),
      (s) => {
        expect(s.base).toBe(4);
        expect(s.active).toBe(4);
        expect(s.scale).toBe(1);
        expect(s.isScaled).toBe(false);
      },
    );
  });

  it('takes the number from the link it was opened on', () => {
    mockRouter.querystring = 'serves=6';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(null) }),
      (s) => {
        expect(s.active).toBe(6);
        expect(s.scale).toBe(1.5);
        expect(s.isScaled).toBe(true);
      },
    );
  });

  it('RESUME: reads the session when the URL carries no link', () => {
    // The whole point of storing it. Reopening the same recipe on another device
    // finds the same session (the id is deterministic) and must show the same
    // amounts, with no link to carry them.
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(6) }),
      (s) => {
        expect(s.active).toBe(6);
        expect(s.isScaled).toBe(true);
      },
    );
  });

  it('lets the link override what the session remembers', () => {
    mockRouter.querystring = 'serves=8';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(6) }),
      (s) => expect(s.active).toBe(8),
    );
  });

  it('BACK-COMPAT: a session written before the field opens unscaled', () => {
    // `servings` reads back null through the schema default, which is "as written".
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(null) }),
      (s) => {
        expect(s.scale).toBe(1);
        expect(s.isScaled).toBe(false);
      },
    );
  });

  it('cannot scale a recipe with no usable servings count, and ignores the link', () => {
    // `usableServings` (issue #1123): null and 0 are both refused as a base.
    mockRouter.querystring = 'serves=6';
    for (const stated of [null, 0]) {
      withEffectRoot(
        () =>
          createCookServings({ recipe: () => recipeServing(stated), session: () => session(null) }),
        (s) => {
          expect(s.base).toBeNull();
          expect(s.active).toBeNull();
          expect(s.scale).toBe(1);
          expect(s.isScaled).toBe(false);
        },
      );
    }
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('is inert while the recipe or the session is still loading', () => {
    withEffectRoot(
      () => createCookServings({ recipe: () => null, session: () => null }),
      (s) => {
        expect(s.scale).toBe(1);
        expect(s.active).toBeNull();
      },
    );
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

describe('createCookServings — pinning the scale onto the session', () => {
  it('writes the number the cook opened with, as a whole document', () => {
    mockRouter.querystring = 'serves=6';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(null) }),
      () => {
        expect(mockPersist).toHaveBeenCalledTimes(1);
        // Whole-document, exactly as the tick lists write — a client `setDoc`
        // rewrites the entire cook session (CLAUDE.md, LWW), so every other field
        // must ride along untouched.
        expect(mockPersist).toHaveBeenCalledWith({ ...session(null), servings: 6 });
      },
    );
  });

  it('writes once, not again on every snapshot that follows', () => {
    mockRouter.querystring = 'serves=6';
    let current = session(null);
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => current }),
      () => {
        expect(mockPersist).toHaveBeenCalledTimes(1);
        // The write comes back as a snapshot; nothing further is owed.
        current = session(6);
        flushSync();
        expect(mockPersist).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('does not write on a resume — arriving with no link is a read', () => {
    // Otherwise every cook ever started would take a write on open for a value it
    // already had.
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(6) }),
      () => expect(mockPersist).not.toHaveBeenCalled(),
    );
  });

  it('stores "as written" as null rather than as the recipe’s own number', () => {
    // A session recording 4 against a recipe later edited to serve 6 would claim a
    // scale nobody chose.
    mockRouter.querystring = 'serves=4';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(6) }),
      () => expect(mockPersist).toHaveBeenCalledWith({ ...session(6), servings: null }),
    );
  });

  it('writes nothing when the session already agrees with the link', () => {
    mockRouter.querystring = 'serves=6';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(6) }),
      () => expect(mockPersist).not.toHaveBeenCalled(),
    );
  });

  it('ignores a nonsense link rather than pinning it', () => {
    mockRouter.querystring = 'serves=abc';
    withEffectRoot(
      () => createCookServings({ recipe: () => recipeServing(4), session: () => session(null) }),
      (s) => {
        expect(s.active).toBe(4);
        expect(mockPersist).not.toHaveBeenCalled();
      },
    );
  });
});
