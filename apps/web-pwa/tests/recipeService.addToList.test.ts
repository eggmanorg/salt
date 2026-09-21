import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { Recipe, CanonItem, IngredientGroup, ShoppingBehavior } from '@salt/domain';

// ─── Mock firebase-sync ──────────────────────────────────────────────────────
vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
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
import { buildRecipeAddPlan, commitRecipeAddPlan } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCanonItem(
  id: string,
  shoppingBehavior: ShoppingBehavior,
  largeQuantityThreshold?: number,
): CanonItem {
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
    ...(largeQuantityThreshold !== undefined ? { largeQuantityThreshold } : {}),
    updatedAt: '',
  };
}

function makeGroup(items: IngredientGroup['items']): IngredientGroup {
  return { id: 'g1', name: null, items };
}

function makeRecipe(groups: IngredientGroup[], servings: number | null = 2): Recipe {
  return {
    cureCategory: null,
    image: null,
    createdBy: '',
    lastEditedBy: '',
    kind: 'recipe',
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    id: 'recipe-1',
    schemaVersion: 1,
    title: 'Test Recipe',
    description: null,
    ingredients: groups,
    steps: [],
    metadata: {
      servings,
      tags: [],
    },
    source: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const gramIngredient = {
  quantity: { type: 'single' as const, value: 200 },
  unit: 'g' as const,
  item: 'flour',
  preparation: [],
  notes: null,
  displayText: null,
};

function weightIngredient(grams: number) {
  return {
    quantity: { type: 'single' as const, value: grams },
    unit: 'g' as const,
    item: 'flour',
    preparation: [],
    notes: null,
    displayText: null,
  };
}

// A line the recipe wrote as a range — "400–500 g tomatoes". One of the two
// shapes that made issue #917 a live fork rather than a latent one.
const rangeIngredient = {
  quantity: { type: 'range' as const, min: 400, max: 500 },
  unit: 'g' as const,
  item: 'tomatoes',
  preparation: [],
  notes: null,
  displayText: null,
};

// Count/item-based ingredient (e.g. "2 eggs") — no metric unit, so unit is null
// (see recipe schema: unit is null for count/item-based ingredients).
const countIngredient = {
  quantity: { type: 'single' as const, value: 2 },
  unit: null,
  item: 'eggs',
  preparation: [],
  notes: null,
  displayText: null,
};

// Parsed ingredient carrying preparation, a parenthetical note, and a friendly
// displayText — exercises the clean-name mapping: item → rawText, notes → notes,
// preparation dropped, displayText ignored (scaled metric wins).
const prepNotesIngredient = {
  quantity: { type: 'single' as const, value: 400 },
  unit: 'g' as const,
  item: 'tomatoes',
  preparation: ['drained'],
  notes: 'preferably San Marzano',
  displayText: '1 tin',
};

function matchedIngredient(id: string, canonId: string, parsed: unknown) {
  return {
    id,
    rawText: '2 cups flour',
    parsed: parsed as never,
    canonId,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveShoppingListItem.mockResolvedValue({ kind: 'ok', value: undefined });
  mockGetCanonItemsSnapshot.mockReturnValue([]);
});

// ─── buildRecipeAddPlan ────────────────────────────────────────────────────────

describe('buildRecipeAddPlan', () => {
  it("matched 'needed' ingredient → add on, check off, canon name + scaled amount", () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'needed')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', gramIngredient)]),
    ]);

    const rows = buildRecipeAddPlan(recipe, 2); // servings == base, scale 1
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ingredientId: 'i1',
      name: 'canon-flour',
      fromCanon: true,
      matched: true,
      canonId: 'canon-flour',
      amount: 200,
      unit: 'g',
      add: true,
      check: false,
    });
  });

  it("matched 'check' ingredient → add and check on", () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'check')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', gramIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);
    expect(rows[0]).toMatchObject({ add: true, check: true });
  });

  it("matched 'stocked' under threshold → neither; over threshold → add on", () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'stocked', 500)]);

    const under = buildRecipeAddPlan(
      makeRecipe([makeGroup([matchedIngredient('i1', 'canon-flour', weightIngredient(100))])]),
      2,
    );
    expect(under[0]).toMatchObject({ add: false, check: false });

    const over = buildRecipeAddPlan(
      makeRecipe([makeGroup([matchedIngredient('i1', 'canon-flour', weightIngredient(750))])]),
      2,
    );
    expect(over[0]).toMatchObject({ add: true, check: false });
  });

  it('unmatched ingredient → add on, check off, raw-text name, matched false', () => {
    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: 'some unknown thing',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);
    expect(rows[0]).toMatchObject({
      name: 'some unknown thing',
      fromCanon: false,
      matched: false,
      canonId: null,
      add: true,
      check: false,
    });
  });

  it('dangling match (canon deleted) → treated as unmatched', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([]); // canon-flour absent
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', countIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);
    expect(rows[0]).toMatchObject({ matched: false, canonId: null, add: true, check: false });
  });

  it('scales amount by servings', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'needed')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', countIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 4); // base 2 → scale 2
    expect(rows[0]!.amount).toBe(4);
  });

  it('buys a range at the top of it, so the shop is never short', () => {
    // "400–500 g tomatoes" is bought as 500 g, not 400 (the old behaviour) and
    // not 450. `quantityToNumber` in `@salt/domain` owns the choice and argues
    // it; this pins that the shopping list is the consumer that runs it (issue
    // #917). Under-buying is a dinner that cannot be cooked; over-buying is a bit
    // left in the cupboard.
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'needed')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', rangeIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2); // servings == base, scale 1
    expect(rows[0]!.amount).toBe(500);
    expect(rows[0]!.unit).toBe('g');
  });

  it('carries parsed.item as itemText and parsed.notes as notes, dropping preparation', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-tomatoes', 'needed')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-tomatoes', prepNotesIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);
    expect(rows[0]).toMatchObject({ itemText: 'tomatoes', notes: 'preferably San Marzano' });
    // Preparation ("drained") is intentionally dropped from both name and notes.
    expect(rows[0]!.notes).not.toContain('drained');
  });

  it('falls back to the raw line for itemText when the ingredient is unparsed', () => {
    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: 'some unknown thing',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);
    expect(rows[0]).toMatchObject({ itemText: 'some unknown thing', notes: '' });
  });
});

// ─── A servings count that cannot be a scaling base (issue #1123) ────────────
//
// `metadata.servings ?? 1` guarded a MISSING count and let a 0 through, so a
// recipe stored at 0 — which the librarian used to accept from the model, and
// the editor used to store from a typed "0" — divided by it. The review sheet
// seeds its stepper from the recipe's own base, so both halves were reachable:
// 0/0 = NaN on open, 1/0 = Infinity after one press of +. A NaN amount is then
// REJECTED by ShoppingListItemSchema on the way back in, so the row does not
// come back at all.

describe('buildRecipeAddPlan — an unusable stored servings count', () => {
  const plan = (servings: number | null, target: number) => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'needed')]);
    return buildRecipeAddPlan(
      makeRecipe([makeGroup([matchedIngredient('i1', 'canon-flour', gramIngredient)])], servings),
      target,
    );
  };

  it('scales a 0-servings recipe exactly as one that states no servings at all', () => {
    expect(plan(0, 4)).toEqual(plan(null, 4));
    expect(plan(0, 4)[0]).toMatchObject({ amount: 800, unit: 'g' });
  });

  it('produces a finite amount at every target the sheet can seed', () => {
    // 0 is what the sheet seeded from a 0-servings recipe before the stepper was
    // touched; 1 is one press of + away.
    for (const target of [0, 1, 2, 4]) {
      const amount = plan(0, target)[0]?.amount;
      expect(Number.isFinite(amount)).toBe(true);
    }
  });

  it('treats a negative count as unstated too', () => {
    expect(plan(-2, 4)).toEqual(plan(null, 4));
  });

  it('leaves a real servings count alone', () => {
    expect(plan(2, 4)[0]).toMatchObject({ amount: 400, unit: 'g' });
  });
});

// ─── commitRecipeAddPlan ─────────────────────────────────────────────────────

describe('commitRecipeAddPlan', () => {
  it('writes only add=true rows, carrying needsCheck from check', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'check')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', countIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2); // add+check both true

    const result = await commitRecipeAddPlan(recipe, 'list-1', 2, rows);
    expect(result).toEqual({ kind: 'ok', value: undefined });
    expect(fs.saveShoppingListItem).toHaveBeenCalledOnce();
    const saved = fs.saveShoppingListItem.mock.calls[0]![1];
    expect(saved.canonId).toBe('canon-flour');
    expect(saved.matchState).toBe('matched');
    expect(saved.needsCheck).toBe(true);
    // rawText is the parser's clean item name (parsed.item), not the raw line.
    expect(saved.rawText).toBe('eggs');
    expect(saved.notes).toBe('');
  });

  it('skips rows the user left as add=false', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour', 'stocked', 500)]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-flour', weightIngredient(100))]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2); // stocked, under threshold → add false

    const result = await commitRecipeAddPlan(recipe, 'list-1', 2, rows);
    expect(result).toEqual({ kind: 'ok', value: undefined });
    expect(fs.saveShoppingListItem).not.toHaveBeenCalled();
  });

  it('writes parsed.item as rawText and parsed.notes as notes, dropping preparation', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-tomatoes', 'needed')]);
    const recipe = makeRecipe([
      makeGroup([matchedIngredient('i1', 'canon-tomatoes', prepNotesIngredient)]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);

    await commitRecipeAddPlan(recipe, 'list-1', 2, rows);
    const saved = fs.saveShoppingListItem.mock.calls[0]![1];
    // Clean item name, not the raw line and not the "1 tin" displayText.
    expect(saved.rawText).toBe('tomatoes');
    expect(saved.notes).toBe('preferably San Marzano');
    // Scaled metric amount/unit remains the quantity source of truth.
    expect(saved.amount).toBe(400);
    expect(saved.unit).toBe('g');
    // Preparation and displayText never leak into the written text.
    expect(saved.rawText).not.toContain('drained');
    expect(saved.rawText).not.toContain('tin');
    expect(saved.notes).not.toContain('drained');
  });

  it('records the recipe source on written items', async () => {
    const recipe = makeRecipe([
      makeGroup([
        {
          id: 'i1',
          rawText: 'salt',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ]),
    ]);
    const rows = buildRecipeAddPlan(recipe, 3);
    await commitRecipeAddPlan(recipe, 'list-1', 3, rows);
    const saved = fs.saveShoppingListItem.mock.calls[0]![1];
    expect(saved.sources).toEqual([
      { kind: 'recipe', recipeId: 'recipe-1', servings: 3, label: 'Test Recipe' },
    ]);
  });
});
