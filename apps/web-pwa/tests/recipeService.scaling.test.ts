import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanonItem, IngredientGroup, ProductForm, Recipe } from '@salt/domain';
import { scaleQuantity, quantityToNumber } from '@salt/domain';

// ─── The one boundary that must not blur (issue #1314, CLAUDE.md Rule 12) ─────
//
// There are now two ways an ingredient amount gets multiplied:
//
//   DRAWING — `scaleQuantity`, which rounds for a human ("450g", "4½"). Used only
//             by `IngredientText`.
//   BUYING  — `buildRecipeAddPlan`, which multiplies at full float precision and
//             feeds the canon and product-form pack maths.
//
// The issue claims these never become one. That claim is worth nothing as a
// sentence in a header, so it is asserted here, against the real plan builder: for
// an amount where the two answers DIFFER, the plan must produce the exact one. Put
// `scaleQuantity` into `buildRecipeAddPlan` — or into anything it calls — and
// these go red.
//
// The other half of the pin lives in `packages/domain/tests/recipe/scaleQuantity.test.ts`,
// which asserts the display rounding genuinely moves the number (so "they differ"
// cannot quietly become vacuous). It cannot assert this half: the plan builder is
// an app module the domain package must not import (CLAUDE.md Rule 6).

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
}));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  startUserActionSpan: vi.fn(() => ({ traceparent: undefined, end: vi.fn() })),
}));

const { mockGetCanonItemsSnapshot } = vi.hoisted(() => ({
  mockGetCanonItemsSnapshot: vi.fn(() => [] as CanonItem[]),
}));
vi.mock('../src/lib/canonService.js', () => ({
  getCanonItemsSnapshot: mockGetCanonItemsSnapshot,
}));

const { mockGetProductFormsSnapshot } = vi.hoisted(() => ({
  mockGetProductFormsSnapshot: vi.fn(() => [] as ProductForm[]),
}));
vi.mock('../src/lib/productFormService.js', () => ({
  getProductFormsSnapshot: mockGetProductFormsSnapshot,
}));

import { buildRecipeAddPlan } from '../src/lib/recipeService.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function canonItem(id: string): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name: id,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

function ingredient(
  id: string,
  canonId: string,
  item: string,
  amount: number,
  unit: 'g' | 'ml' | null,
): IngredientGroup['items'][number] {
  return {
    id,
    rawText: `${amount}${unit ?? ''} ${item}`,
    parsed: {
      quantity: { type: 'single' as const, value: amount },
      unit,
      item,
      preparation: [],
      notes: null,
      displayText: null,
    },
    canonId,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function recipeOf(items: IngredientGroup['items'], servings: number): Recipe {
  return {
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
    ingredients: [{ id: 'g1', name: null, items }],
    steps: [],
    metadata: { servings, tags: [] },
    source: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProductFormsSnapshot.mockReturnValue([]);
  mockGetCanonItemsSnapshot.mockReturnValue([canonItem('canon-flour'), canonItem('canon-egg')]);
});

describe('buildRecipeAddPlan does not buy the figure the screen draws', () => {
  it('buys a measured amount at the exact factor, not the rounded display figure', () => {
    // 33g at 6/4 servings. Exactly 49.5g; the screen says 50g, because 49.5 is not
    // a figure a domestic scale shows.
    const recipe = recipeOf([ingredient('i1', 'canon-flour', 'flour', 33, 'g')], 4);
    const drawn = quantityToNumber(scaleQuantity({ type: 'single', value: 33 }, 6 / 4, 'g'));
    expect(drawn).toBe(50);

    const rows = buildRecipeAddPlan(recipe, 6);

    expect(rows[0]!.amount).toBe(49.5);
    expect(rows[0]!.amount).not.toBe(drawn);
  });

  it('buys a count at the exact factor, not the nearest half', () => {
    // 3 eggs at 5/4 servings is 3.75. The screen says 4, because "3.75 eggs"
    // asserts a precision the scaling never had — and 4 is not what the shop should
    // be told to buy off a recipe that needs three and three quarters.
    const recipe = recipeOf([ingredient('i2', 'canon-egg', 'egg', 3, null)], 4);
    const drawn = quantityToNumber(scaleQuantity({ type: 'single', value: 3 }, 5 / 4, null));
    expect(drawn).toBe(4);

    const rows = buildRecipeAddPlan(recipe, 5);

    expect(rows[0]!.amount).toBe(3.8);
    expect(rows[0]!.amount).not.toBe(drawn);
  });

  it('is unchanged at the recipe’s own servings', () => {
    const recipe = recipeOf([ingredient('i1', 'canon-flour', 'flour', 33, 'g')], 4);
    expect(buildRecipeAddPlan(recipe, 4)[0]!.amount).toBe(33);
  });
});
