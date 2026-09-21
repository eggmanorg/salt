import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { emptyRecipe } from '@salt/domain';
import type { Recipe, CanonItem, Ingredient, ShoppingBehavior } from '@salt/domain';

// Buy-or-make at add-to-list (Phase 2). Exercises buildRecipeAddPlan's producer
// flagging + the "make" fan-out in commitRecipeAddPlan.
//
// The recipes store is module-internal singleton state with no test-reset seam,
// so seeded recipes accumulate across tests. Every fixture id is namespaced per
// test (see `nsId` + the beforeEach counter) so any leakage is inert — a leaked
// recipe can never share a canonId with the test currently running.

// ─── Mock firebase-sync ──────────────────────────────────────────────────────
vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));

// ─── Mock canonService ───────────────────────────────────────────────────────
const { mockGetCanonItemsSnapshot } = vi.hoisted(() => ({
  mockGetCanonItemsSnapshot: vi.fn(() => [] as CanonItem[]),
}));
vi.mock('../src/lib/canonService.js', () => ({
  getCanonItemsSnapshot: mockGetCanonItemsSnapshot,
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  buildRecipeAddPlan,
  buildMadeSubRows,
  commitRecipeAddPlan,
  recipeAddPlanItemCount,
  initRecipeSync,
} from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

// Mirror the sheet's `setMake`: flip a row to Make and eagerly build its nested
// sub-entries (the count/commit now WALK that structure rather than re-expanding
// the producer themselves). Producer-dependent tests set `producerId` before
// calling this so the sub-rows reflect the chosen producer.
function selectMake(rows: ReturnType<typeof buildRecipeAddPlan>, ingredientId: string) {
  const row = rows.find((r) => r.ingredientId === ingredientId)!;
  row.make = true;
  row.subRows = buildMadeSubRows(row);
  return row;
}

// Mirror the sheet's `setMadeServings`: bump a made header's per-header servings
// and live-rescale its sub-entries (min-1 clamp is UI-side, so pass ≥ 1 here).
function stepMadeServings(row: ReturnType<typeof buildRecipeAddPlan>[number], servings: number) {
  row.madeServings = servings;
  row.subRows = buildMadeSubRows(row);
}

const subAmount = (
  row: ReturnType<typeof buildRecipeAddPlan>[number],
  ingredientId: string,
): number | undefined => row.subRows!.find((s) => s.ingredientId === ingredientId)!.amount;

// Per-test id namespace so the accumulating recipes store can't cross-contaminate.
let ns = 0;
const nsId = (base: string) => `${base}#${ns}`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function canon(id: string, shoppingBehavior: ShoppingBehavior = 'needed'): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name: id,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior,
    updatedAt: '',
  };
}

function ingredient(id: string, item: string, canonId: string | null): Ingredient {
  return {
    id,
    rawText: item,
    parsed:
      canonId !== null
        ? {
            quantity: { type: 'single', value: 100 },
            unit: 'g',
            item,
            preparation: [],
            notes: null,
            displayText: null,
          }
        : null,
    canonId,
    matchState: canonId !== null ? 'matched' : 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function recipe(
  id: string,
  opts: {
    title?: string;
    servings?: number;
    producesCanonId?: string | null;
    ingredients?: Ingredient[];
  } = {},
): Recipe {
  return {
    ...emptyRecipe(id, '2026-01-01T00:00:00.000Z'),
    title: opts.title ?? id,
    ingredients: [{ id: `${id}-grp`, name: null, items: opts.ingredients ?? [] }],
    metadata: {
      servings: opts.servings ?? 2,
      tags: [],
    },
    producesCanonId: opts.producesCanonId ?? null,
    // Fresh, monotonically-increasing stamp so a re-seed of the same id is never
    // rejected by the store's stale-echo guard.
    updatedAt: new Date().toISOString(),
  };
}

// Seed the in-memory recipes store via the (mocked) subscription seam.
function seedRecipes(list: Recipe[]): void {
  (fs.subscribeRecipes as ReturnType<typeof vi.fn>).mockImplementation(
    (onNext: (r: Recipe[]) => void) => {
      onNext(list);
      return () => {};
    },
  );
  initRecipeSync();
}

function savedItems() {
  return (fs.saveShoppingListItem as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  ns++;
  fs.saveShoppingListItem.mockResolvedValue({ kind: 'ok', value: undefined });
  mockGetCanonItemsSnapshot.mockReturnValue([]);
});

// ─── buildRecipeAddPlan: producer flagging ───────────────────────────────────

describe('buildRecipeAddPlan — buy-or-make flagging', () => {
  it('flags a row whose ingredient canonId has a producing recipe', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([recipe(nsId('r-mayo'), { title: 'Homemade Mayo', producesCanonId: canonMayo })]);

    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);

    expect(rows[0]!.producers.map((r) => r.id)).toEqual([nsId('r-mayo')]);
    expect(rows[0]!.make).toBe(false); // default buy
    expect(rows[0]!.producerId).toBe(nsId('r-mayo'));
  });

  it('shows no producer for an ingredient nobody makes', () => {
    const canonSalt = nsId('canon-salt');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonSalt)]);
    seedRecipes([recipe(nsId('r-mayo'), { producesCanonId: nsId('canon-mayo') })]);

    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-salt', 'salt', canonSalt)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    expect(rows[0]!.producers).toEqual([]);
    expect(rows[0]!.producerId).toBeNull();
  });

  it('excludes the recipe being added from its own producer candidates', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    const other = recipe(nsId('r-other-mayo'), { producesCanonId: canonMayo });
    // The parent both produces canonMayo AND lists a canonMayo ingredient.
    const parent = recipe(nsId('r-self'), {
      producesCanonId: canonMayo,
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    seedRecipes([parent, other]);

    const rows = buildRecipeAddPlan(parent, 2);
    expect(rows[0]!.producers.map((r) => r.id)).toEqual([nsId('r-other-mayo')]);
  });

  it('lists every candidate when more than one recipe produces the item', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo-a'), { producesCanonId: canonMayo }),
      recipe(nsId('r-mayo-b'), { producesCanonId: canonMayo }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    expect(rows[0]!.producers.map((r) => r.id)).toEqual([nsId('r-mayo-a'), nsId('r-mayo-b')]);
    expect(rows[0]!.producerId).toBe(nsId('r-mayo-a')); // seeded to first candidate
  });
});

// ─── commitRecipeAddPlan: make fan-out ───────────────────────────────────────

describe('commitRecipeAddPlan — make fan-out', () => {
  it('Buy (default) adds the single item, not the producer ingredients', async () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-egg', 'egg yolk', nsId('canon-egg'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2); // make stays false

    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    const items = savedItems();
    expect(items).toHaveLength(1);
    expect(items[0].rawText).toBe('mayonnaise');
    expect(items[0].canonId).toBe(canonMayo);
  });

  it('Make fans out the producer ingredients at its base servings with the producer SourceRef', async () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    const mayo = recipe(nsId('r-mayo'), {
      title: 'Homemade Mayo',
      servings: 4,
      producesCanonId: canonMayo,
      ingredients: [
        ingredient('m-egg', 'egg yolk', nsId('canon-egg')),
        ingredient('m-oil', 'oil', nsId('canon-oil')),
      ],
    });
    seedRecipes([mayo]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo'); // user chose "Make"

    const result = await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    expect(result).toEqual({ kind: 'ok', value: undefined });

    const items = savedItems();
    // The single mayo item is NOT written; the producer's ingredients are.
    expect(items.map((i) => i.rawText).sort()).toEqual(['egg yolk', 'oil']);
    expect(items.some((i) => i.rawText === 'mayonnaise')).toBe(false);
    // Every fanned-out item carries the producer's SourceRef at its base servings.
    for (const item of items) {
      expect(item.sources).toEqual([
        { kind: 'recipe', recipeId: nsId('r-mayo'), servings: 4, label: 'Homemade Mayo' },
      ]);
    }
  });

  it('is one level deep — a producer ingredient that itself has a producer is added plain, not expanded', async () => {
    const canonMayo = nsId('canon-mayo');
    const canonEgg = nsId('canon-egg');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    const eggProducer = recipe(nsId('r-egg'), {
      producesCanonId: canonEgg,
      ingredients: [ingredient('e-hen', 'a whole hen', nsId('canon-hen'))],
    });
    const mayo = recipe(nsId('r-mayo'), {
      producesCanonId: canonMayo,
      ingredients: [ingredient('m-egg', 'egg yolk', canonEgg)],
    });
    seedRecipes([mayo, eggProducer]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo');

    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    const items = savedItems();
    // The egg (a producer ingredient) is added as a plain item; the hen (its
    // producer's ingredient) is NOT — recursion stops after one level.
    expect(items.map((i) => i.rawText)).toEqual(['egg yolk']);
    expect(items.some((i) => i.rawText === 'a whole hen')).toBe(false);
  });

  it('mixes a made row with a normal bought row in the same commit', async () => {
    const canonMayo = nsId('canon-mayo');
    const canonSalt = nsId('canon-salt');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo), canon(canonSalt)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-egg', 'egg yolk', nsId('canon-egg'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [
        ingredient('i-mayo', 'mayonnaise', canonMayo),
        ingredient('i-salt', 'salt', canonSalt),
      ],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo');

    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    const items = savedItems();
    // egg yolk from the fan-out + salt bought directly; no single "mayonnaise".
    expect(items.map((i) => i.rawText).sort()).toEqual(['egg yolk', 'salt']);
    const salt = items.find((i) => i.rawText === 'salt')!;
    expect(salt.sources[0]).toMatchObject({ kind: 'recipe', recipeId: nsId('r-salad') });
  });
});

// ─── recipeAddPlanItemCount: preview count matches the committed write ─────────
// The review sheet's "Add N to list" footer uses this; a Make row must count the
// producer's fanned-out ingredients, not 1, so the preview matches what commit
// actually writes.

describe('recipeAddPlanItemCount — footer preview count', () => {
  it('counts a Buy row as 1', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-egg', 'egg yolk', nsId('canon-egg'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2); // make stays false → Buy
    expect(recipeAddPlanItemCount(rows)).toBe(1);
  });

  it('counts a Make row as the producer fan-out size, and matches the committed write', async () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [
          ingredient('m-egg', 'egg yolk', nsId('canon-egg')),
          ingredient('m-oil', 'oil', nsId('canon-oil')),
        ],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo'); // user chose "Make"

    // Preview: the two producer ingredients, not the single mayo row.
    expect(recipeAddPlanItemCount(rows)).toBe(2);

    // …and it equals what commit actually writes.
    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    expect(savedItems()).toHaveLength(recipeAddPlanItemCount(rows));
  });

  it('sums a Make row and a Buy row', () => {
    const canonMayo = nsId('canon-mayo');
    const canonSalt = nsId('canon-salt');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo), canon(canonSalt)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [
          ingredient('m-egg', 'egg yolk', nsId('canon-egg')),
          ingredient('m-oil', 'oil', nsId('canon-oil')),
        ],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [
        ingredient('i-mayo', 'mayonnaise', canonMayo),
        ingredient('i-salt', 'salt', canonSalt),
      ],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo'); // 2 from fan-out
    // + 1 for the salt Buy row = 3.
    expect(recipeAddPlanItemCount(rows)).toBe(3);
  });

  it('excludes rows the user removed (add:false)', () => {
    const canonSalt = nsId('canon-salt');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonSalt)]);
    seedRecipes([]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-salt', 'salt', canonSalt)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    rows[0]!.add = false;
    expect(recipeAddPlanItemCount(rows)).toBe(0);
  });

  it('resolves an unknown producerId back to the first candidate (matches commit)', async () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-egg', 'egg yolk', nsId('canon-egg'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    rows[0]!.producerId = 'does-not-exist'; // find() misses → falls back to producers[0]
    selectMake(rows, 'i-mayo'); // builds sub-rows from the fallback producer
    // producers[0] (r-mayo) fans out one ingredient → 1, same as commit does.
    expect(recipeAddPlanItemCount(rows)).toBe(1);
    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    expect(savedItems()).toHaveLength(recipeAddPlanItemCount(rows));
  });

  it('counts a Make row with an empty-fan-out producer as 0 (matches commit)', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    // Producer exists but lists no ingredients, so the fan-out writes nothing.
    seedRecipes([recipe(nsId('r-mayo'), { producesCanonId: canonMayo })]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    selectMake(rows, 'i-mayo');
    expect(recipeAddPlanItemCount(rows)).toBe(0);
  });
});

// ─── Nested made sub-entries (buy-or-make sheet, Phase 1) ─────────────────────
// Make eagerly builds the linked recipe's ingredients as NESTED sub-rows on the
// row itself, each individually add/check-able, at the producer's base servings.

describe('buildMadeSubRows — nested sub-entries', () => {
  it('builds the producer ingredients as nested rows at its base servings, seeded like master rows', () => {
    const canonMayo = nsId('canon-mayo');
    const canonOil = nsId('canon-oil');
    // Oil is a matched, "needed" canon item → its sub-row defaults add:true.
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo), canon(canonOil, 'needed')]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        servings: 4,
        producesCanonId: canonMayo,
        ingredients: [
          ingredient('m-egg', 'egg yolk', nsId('canon-egg')),
          ingredient('m-oil', 'oil', canonOil),
        ],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const mayo = selectMake(rows, 'i-mayo');

    expect(mayo.subRows).not.toBeNull();
    expect(mayo.subRows!.map((s) => s.ingredientId)).toEqual(['m-egg', 'm-oil']);
    // Amount scaled to the producer's OWN base servings (scale 1) — 100 as authored.
    const oilSub = mayo.subRows!.find((s) => s.ingredientId === 'm-oil')!;
    expect(oilSub.amount).toBe(100);
    expect(oilSub.unit).toBe('g');
    expect(oilSub.add).toBe(true); // matched 'needed' → default add
  });

  it('seeds sub-rows one level deep: no producers, make:false, subRows:null (cannot be re-made)', () => {
    const canonMayo = nsId('canon-mayo');
    const canonEgg = nsId('canon-egg');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    // A recipe that could ALSO make the egg sub-ingredient — must NOT surface on the sub-row.
    const eggProducer = recipe(nsId('r-egg'), { producesCanonId: canonEgg });
    const mayo = recipe(nsId('r-mayo'), {
      producesCanonId: canonMayo,
      ingredients: [ingredient('m-egg', 'egg yolk', canonEgg)],
    });
    seedRecipes([mayo, eggProducer]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const mayoRow = selectMake(rows, 'i-mayo');

    const eggSub = mayoRow.subRows!.find((s) => s.ingredientId === 'm-egg')!;
    expect(eggSub.producers).toEqual([]);
    expect(eggSub.make).toBe(false);
    expect(eggSub.subRows).toBeNull();
  });

  it('flipping Make back to Buy clears the nested sub-rows', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-egg', 'egg yolk', nsId('canon-egg'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const row = selectMake(rows, 'i-mayo');
    expect(row.subRows).not.toBeNull();

    // Mirror the sheet's setMake(row, false).
    row.make = false;
    row.subRows = null;
    expect(recipeAddPlanItemCount(rows)).toBe(1); // collapses to the single Buy line
  });

  it('unticking a sub-entry drops it from both the count and the committed write', async () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        producesCanonId: canonMayo,
        ingredients: [
          ingredient('m-egg', 'egg yolk', nsId('canon-egg')),
          ingredient('m-oil', 'oil', nsId('canon-oil')),
        ],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const mayo = selectMake(rows, 'i-mayo');
    expect(recipeAddPlanItemCount(rows)).toBe(2);

    // User unticks the oil sub-entry — only the ticked egg yolk should land.
    mayo.subRows!.find((s) => s.ingredientId === 'm-oil')!.add = false;
    expect(recipeAddPlanItemCount(rows)).toBe(1);

    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    expect(savedItems().map((i) => i.rawText)).toEqual(['egg yolk']);
  });
});

// ─── Made-header servings stepper (buy-or-make sheet, Phase 2) ─────────────────
// Each made header carries its OWN `madeServings`, defaulting to the linked
// producer's base (`metadata.servings ?? 1`) — never seeded from the master
// recipe's chosen servings or the required quantity. Stepping it live-rescales
// the header's sub-entry amounts (via `buildMadeSubRows`) and flows through to the
// committed amounts + stamped `SourceRef.servings`. Master servings and each made
// header's servings are fully independent.

describe('made-header servings — default, live rescale, independence', () => {
  it('defaults madeServings to the producer base — not the master servings, not the required qty', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    // Producer's OWN base is 3; the parent lists 100g of it and is added at
    // master servings 10 — madeServings must ignore both and take the base (3).
    seedRecipes([
      recipe(nsId('r-mayo'), {
        servings: 3,
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-oil', 'oil', nsId('canon-oil'))],
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 10); // master servings 10
    expect(rows[0]!.madeServings).toBe(3); // producer base, not 10, not 100
  });

  it('stepping a made header live-rescales its sub-entry amounts', () => {
    const canonMayo = nsId('canon-mayo');
    const canonOil = nsId('canon-oil');
    // Oil matched so it carries a scaled amount (unmatched rows have none).
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo), canon(canonOil)]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        servings: 2, // base batch → default madeServings 2, scale 1
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-oil', 'oil', canonOil)], // 100g authored
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const mayo = selectMake(rows, 'i-mayo');
    expect(mayo.madeServings).toBe(2);
    expect(subAmount(mayo, 'm-oil')).toBe(100); // base batch, as authored

    stepMadeServings(mayo, 6); // 3× the producer's base of 2
    expect(mayo.madeServings).toBe(6);
    expect(subAmount(mayo, 'm-oil')).toBe(300);

    stepMadeServings(mayo, 1); // below base → scales down
    expect(subAmount(mayo, 'm-oil')).toBe(50);
  });

  it('threads the chosen madeServings into the committed amounts and SourceRef.servings', async () => {
    const canonMayo = nsId('canon-mayo');
    const canonOil = nsId('canon-oil');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo), canon(canonOil)]);
    const mayo = recipe(nsId('r-mayo'), {
      title: 'Homemade Mayo',
      servings: 2,
      producesCanonId: canonMayo,
      ingredients: [ingredient('m-oil', 'oil', canonOil)], // 100g at base 2
    });
    seedRecipes([mayo]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    const mayoRow = selectMake(rows, 'i-mayo');
    stepMadeServings(mayoRow, 4); // 2× base → oil 200g

    await commitRecipeAddPlan(parent, 'list-1', 2, rows);
    const items = savedItems();
    expect(items).toHaveLength(1);
    // Committed amount is the SCALED quantity…
    expect(items[0].amount).toBe(200);
    // …and the stamped SourceRef.servings is the CHOSEN madeServings, not the base.
    expect(items[0].sources).toEqual([
      { kind: 'recipe', recipeId: nsId('r-mayo'), servings: 4, label: 'Homemade Mayo' },
    ]);
  });

  it('master servings and made-header servings are independent (neither changes the other)', () => {
    const canonMayo = nsId('canon-mayo');
    const canonOil = nsId('canon-oil');
    const canonSalt = nsId('canon-salt');
    mockGetCanonItemsSnapshot.mockReturnValue([
      canon(canonMayo),
      canon(canonOil),
      canon(canonSalt),
    ]);
    seedRecipes([
      recipe(nsId('r-mayo'), {
        servings: 2,
        producesCanonId: canonMayo,
        ingredients: [ingredient('m-oil', 'oil', canonOil)], // 100g at base 2
      }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      // base servings 2 (fixture default); salt is a plain Buy row of 100g.
      ingredients: [
        ingredient('i-mayo', 'mayonnaise', canonMayo),
        ingredient('i-salt', 'salt', canonSalt),
      ],
    });

    // (a) Master servings does NOT touch a made header's sub-entry amounts:
    //     build the SAME plan at master 2 vs master 10 → oil sub amount identical.
    const rowsMaster2 = buildRecipeAddPlan(parent, 2);
    const mayo2 = selectMake(rowsMaster2, 'i-mayo');
    const rowsMaster10 = buildRecipeAddPlan(parent, 10);
    const mayo10 = selectMake(rowsMaster10, 'i-mayo');
    expect(subAmount(mayo2, 'm-oil')).toBe(100); // producer base, master-independent
    expect(subAmount(mayo10, 'm-oil')).toBe(100);
    expect(mayo10.madeServings).toBe(2);

    // (b) Stepping a made header does NOT touch the master-scaled Buy rows:
    //     salt (a sibling Buy row) keeps its master-2 amount while mayo is bumped.
    const saltRow = rowsMaster2.find((r) => r.ingredientId === 'i-salt')!;
    expect(saltRow.amount).toBe(100); // master 2 == parent base 2 → scale 1
    stepMadeServings(mayo2, 8);
    expect(subAmount(mayo2, 'm-oil')).toBe(400); // made bumped…
    expect(saltRow.amount).toBe(100); // …salt untouched
  });

  it('changing the producer resets madeServings to the new producer base', () => {
    const canonMayo = nsId('canon-mayo');
    mockGetCanonItemsSnapshot.mockReturnValue([canon(canonMayo)]);
    seedRecipes([
      recipe(nsId('r-mayo-a'), { servings: 2, producesCanonId: canonMayo }),
      recipe(nsId('r-mayo-b'), { servings: 6, producesCanonId: canonMayo }),
    ]);
    const parent = recipe(nsId('r-salad'), {
      ingredients: [ingredient('i-mayo', 'mayonnaise', canonMayo)],
    });
    const rows = buildRecipeAddPlan(parent, 2);
    expect(rows[0]!.madeServings).toBe(2); // seeded to first producer's base

    // Mirror the sheet's setProducer: switch to producer B (base 6) and re-default.
    const row = rows[0]!;
    row.producerId = nsId('r-mayo-b');
    row.madeServings = row.producers.find((r) => r.id === row.producerId)!.metadata.servings ?? 1;
    expect(row.madeServings).toBe(6);
  });
});
