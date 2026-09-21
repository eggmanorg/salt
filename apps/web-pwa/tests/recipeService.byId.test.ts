import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { Recipe } from '@salt/domain';

// The id-indexed recipe store (issue #940, Phase 3).
//
// The planner resolved a day's `recipeIds` with `recipes.find(...)` per id, per
// row, re-run on every week snapshot. `recipesById` is the index that replaces
// those scans, and what it has to guarantee is narrow but absolute: it must
// track the array it is derived from — adds, edits and deletes alike — and it
// must answer `undefined` for an id that is not there, because a plan pointing
// at a deleted recipe is ordinary and must render without that row rather than
// break.
//
// The recipes store is module-internal singleton state with no reset seam and
// seeded recipes accumulate across tests (see recipeService.makeOrBuy.test.ts),
// so every fixture id is namespaced per test.

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn(),
}));

// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  startUserActionSpan: vi.fn(),
}));

vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));
vi.mock('../src/lib/productFormService.js', () => ({ getProductFormsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import { recipes, recipesById, initRecipeSync, persistRecipe } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

let ns = 0;
function nsId(id: string): string {
  return `t${ns}-${id}`;
}

function recipe(id: string, opts: { componentRecipeIds?: string[] } = {}): Recipe {
  return {
    cureCategory: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title: id,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: opts.componentRecipeIds ?? [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    // Fresh, monotonically-increasing stamp so a re-seed of the same id is never
    // rejected by the store's stale-echo guard.
    updatedAt: new Date().toISOString(),
  };
}

/** Seed the in-memory recipes store via the (mocked) subscription seam. */

function seedRecipes(list: Recipe[]): void {
  (fs.subscribeRecipes as ReturnType<typeof vi.fn>).mockImplementation(
    (onNext: (r: Recipe[]) => void) => {
      onNext(list);
      return () => {};
    },
  );
  initRecipeSync();
}

beforeEach(() => {
  vi.clearAllMocks();
  ns++;
  fs.saveRecipeDoc.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('recipesById', () => {
  it('indexes what the array holds', () => {
    const roast = nsId('roast');
    const pie = nsId('pie');
    seedRecipes([recipe(roast), recipe(pie)]);

    const index = get(recipesById);
    expect(index.get(roast)?.id).toBe(roast);
    expect(index.get(pie)?.id).toBe(pie);
    // Same objects, not copies — the planner renders straight off them.
    expect(index.get(roast)).toBe(get(recipes).find((r) => r.id === roast));
  });

  it('answers undefined for an id that is not there', () => {
    const roast = nsId('roast');
    seedRecipes([recipe(roast)]);

    // A plan pointing at a since-deleted recipe is ordinary, not an error: the
    // planner skips the row. A throwing or defaulting lookup would render a
    // broken row instead.
    expect(get(recipesById).get(nsId('never-existed'))).toBeUndefined();
  });

  it('tracks an add and an edit', async () => {
    const roast = nsId('roast');
    const pie = nsId('pie');
    seedRecipes([recipe(roast)]);
    expect(get(recipesById).has(pie)).toBe(false);

    // Add, via a snapshot — how the store actually changes in production.
    seedRecipes([recipe(roast), recipe(pie)]);
    expect(get(recipesById).has(pie)).toBe(true);

    // Edit, via a local optimistic write.
    const edited: Recipe = { ...recipe(pie), title: 'Steak pie' };
    await persistRecipe(edited);
    expect(get(recipesById).get(pie)?.title).toBe('Steak pie');
  });

  // Removal is deliberately NOT asserted through a snapshot here, and the reason
  // matters more than the coverage: `applySnapshot` keeps any recipe it has ever
  // stamped in `latestLocalEdit`, so a snapshot cannot express a delete in this
  // harness at all — that is `recipeService`'s own optimistic-store contract, not
  // this index's. What the index owes the planner on a removed recipe is the
  // `undefined` above; because it is `derived` from the array by construction,
  // there is no separate removal path in it to drift. The test below pins that
  // construction directly.

  it('stays in step with the array it is derived from', () => {
    const ids = [nsId('a'), nsId('b'), nsId('c')];
    seedRecipes(ids.map((id) => recipe(id)));

    // The index is not allowed to drift from `recipes` — every consumer that
    // still reads the array has to agree with every consumer that reads this.
    const index = get(recipesById);
    expect(index.size).toBe(get(recipes).length);
    for (const r of get(recipes)) expect(index.get(r.id)).toBe(r);
  });
});
