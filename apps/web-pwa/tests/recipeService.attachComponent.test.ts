import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { Recipe } from '@salt/domain';

// Hanging a dish off a meal (issue #752, Phase 3) — the one write behind all
// four "start a recipe FROM a meal" paths.
//
// Three properties carry it, and none of them is about the wire: the meal is
// read from the IN-MEMORY store (so this costs no Firestore read and a deleted
// meal is a `NotFound`, not a throw), the ordering comes from the domain rather
// than from a push here, and a second attach of the same dish is a no-op — which
// is what lets the save path be gated on the URL alone.
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
import { attachComponentToMeal, initRecipeSync } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

let ns = 0;
function nsId(id: string): string {
  return `t${ns}-${id}`;
}

function recipe(
  id: string,
  opts: { elapsedMinutes?: number; componentRecipeIds?: string[] } = {},
): Recipe {
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
      // The phase strip is what `insertComponentByElapsedTime` ranks on (#1233).
      phases:
        opts.elapsedMinutes === undefined
          ? []
          : [{ label: 'Cook', handsOnMinutes: 0, handsOffMinutes: opts.elapsedMinutes }],
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

/** What the Nth `saveRecipeDoc` actually wrote. */
function saved(n = 0): Recipe {
  return fs.saveRecipeDoc.mock.calls[n]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  ns++;
  fs.saveRecipeDoc.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('attachComponentToMeal', () => {
  it('attaches the dish to the meal and persists the whole document', async () => {
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    seedRecipes([recipe(mealId), recipe(dishId, { elapsedMinutes: 20 })]);

    const result = await attachComponentToMeal(mealId, dishId);

    expect(result.kind).toBe('ok');
    // One write, and it is the MEAL that changed — the dish is untouched.
    expect(fs.saveRecipeDoc).toHaveBeenCalledTimes(1);
    expect(saved().id).toBe(mealId);
    expect(saved().componentRecipeIds).toEqual([dishId]);
  });

  it('puts the dish where the domain says, not on the end', async () => {
    // Longest-first is `insertComponentByElapsedTime`'s policy and it stays
    // there: the bird goes in before the potatoes, so a 90-minute dish attached
    // to a meal that already holds a 20-minute one lands FIRST.
    const mealId = nsId('roast');
    const gravy = nsId('gravy');
    const chicken = nsId('chicken');
    seedRecipes([
      recipe(mealId, { componentRecipeIds: [gravy] }),
      recipe(gravy, { elapsedMinutes: 20 }),
      recipe(chicken, { elapsedMinutes: 90 }),
    ]);

    await attachComponentToMeal(mealId, chicken);

    expect(saved().componentRecipeIds).toEqual([chicken, gravy]);
  });

  it('is idempotent — a second attach of the same dish adds nothing', async () => {
    // The property the save path is built on: presence of `?meal=` is the whole
    // gate, so re-saving an editor that still carries it must not double up.
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    seedRecipes([recipe(mealId), recipe(dishId, { elapsedMinutes: 20 })]);

    await attachComponentToMeal(mealId, dishId);
    const second = await attachComponentToMeal(mealId, dishId);

    expect(second.kind).toBe('ok');
    expect(saved(1).componentRecipeIds).toEqual([dishId]);
  });

  it('refuses to make a meal a component of itself', async () => {
    // Also the domain's answer (`canBeComponentOf`), folded into the insert so a
    // caller cannot bypass it. The write still happens — it is simply a no-op.
    const mealId = nsId('roast');
    seedRecipes([recipe(mealId)]);

    await attachComponentToMeal(mealId, mealId);

    expect(saved().componentRecipeIds).toEqual([]);
  });

  it('fails with NotFound, and writes nothing, when the meal is gone', async () => {
    // Deleted on another device while the user was off writing the dish. It
    // crosses the boundary as a Failure rather than throwing (Rule 10) so the
    // caller can keep the recipe that WAS saved instead of stranding it.
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    seedRecipes([recipe(dishId)]);

    const result = await attachComponentToMeal(mealId, dishId);

    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'recipe', id: mealId },
    });
    expect(fs.saveRecipeDoc).not.toHaveBeenCalled();
  });

  it('surfaces a persistence failure rather than reporting success', async () => {
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    seedRecipes([recipe(mealId), recipe(dishId)]);
    fs.saveRecipeDoc.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });

    const result = await attachComponentToMeal(mealId, dishId);

    expect(result.kind).toBe('err');
  });

  it('ranks a dish the store has not heard about yet by the elapsed time passed in, not as "no timing"', async () => {
    // Issue #1431 review, blocking. The chat and import doors call this in the
    // very next statement after the SERVER write settles — before the listener
    // can have delivered the new document back into the store — so `dishId`
    // below is deliberately absent from `seedRecipes`. Without the third
    // argument, `insertComponentByElapsedTime`'s lookup misses, reads as "no
    // strip" (Infinity) and sorts first regardless of how long the dish actually
    // takes; that is the bug, and it is what gets WRITTEN to the meal.
    const mealId = nsId('roast');
    const gravy = nsId('gravy');
    const chicken = nsId('chicken');
    seedRecipes([
      recipe(mealId, { componentRecipeIds: [gravy] }),
      recipe(gravy, { elapsedMinutes: 20 }),
      // `chicken` is NOT seeded — it stands in for the just-written dish the
      // store has not caught up with.
    ]);
    const justWritten = recipe(chicken, { elapsedMinutes: 5 });

    await attachComponentToMeal(mealId, chicken, justWritten);

    // 5 minutes is shorter than the already-attached 20-minute gravy, so the new
    // dish ranks AFTER it — not first, which is where a dangling lookup would
    // have put it.
    expect(saved().componentRecipeIds).toEqual([gravy, chicken]);
  });

  it('does not double-count a dish the store already holds', async () => {
    // A caller can pass `justWritten` defensively even once the listener has
    // caught up; the store's own copy is authoritative and nothing is appended
    // twice into the ranking list.
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    const already = recipe(dishId, { elapsedMinutes: 20 });
    seedRecipes([recipe(mealId), already]);

    await attachComponentToMeal(mealId, dishId, already);

    expect(saved().componentRecipeIds).toEqual([dishId]);
  });

  it('keeps every other field on the meal — the write is the same document', async () => {
    const mealId = nsId('roast');
    const dishId = nsId('gravy');
    const meal = { ...recipe(mealId), title: 'Sunday roast', notes: 'Carve at the table.' };
    seedRecipes([meal, recipe(dishId)]);

    await attachComponentToMeal(mealId, dishId);

    expect(saved().title).toBe('Sunday roast');
    expect(saved().notes).toBe('Carve at the table.');
  });
});
