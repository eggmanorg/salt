import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Recipe,
  CanonItem,
  IngredientGroup,
  ProductForm,
  ShoppingBehavior,
} from '@salt/domain';

// `measureNote` carries a line's ORIGINAL non-metric measure ("6 cloves") onto the
// shopping row, so a line the parser flattened to grams still says what to reach
// for in the shop. These pin the gate that keeps it honest: the string is a frozen
// parse-time rendering with nothing to multiply, so a SCALED add must drop it
// rather than state a quantity that is no longer true.

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

import { buildRecipeAddPlan, commitRecipeAddPlan } from '../src/lib/recipeService.js';
import * as fs from '@salt/firebase-sync';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCanonItem(
  id: string,
  shoppingBehavior: ShoppingBehavior = 'needed',
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

function makeForm(
  id: string,
  matcher: string,
  parentCanonId: string,
  formUnit: 'ml' | 'g' | 'count',
  amountPerParent: number,
): ProductForm {
  return {
    id,
    schemaVersion: 1,
    matchers: [matcher],
    parentCanonId,
    thumbnail: null,
    label: matcher,
    yield: { formUnit, amountPerParent },
    updatedAt: '',
  };
}

function formIngredient(
  id: string,
  canonId: string,
  item: string,
  amount: number,
  unit: 'ml' | 'g' | null,
) {
  return {
    id,
    rawText: `${amount} ${unit ?? ''} ${item}`.trim(),
    parsed: {
      quantity: { type: 'single' as const, value: amount },
      unit,
      item,
      preparation: [],
      notes: null,
      displayText: null,
    } as never,
    canonId,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function makeRecipe(items: IngredientGroup['items']): Recipe {
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
    ingredients: [{ id: 'g1', name: null, items }],
    steps: [],
    metadata: {
      servings: 2,
      tags: [],
    },
    source: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCanonItemsSnapshot.mockReturnValue([]);
  mockGetProductFormsSnapshot.mockReturnValue([]);
});

// ─── The scale gate ─────────────────────────────────────────────────────────

// "18 g garlic, peeled (6 cloves)" — the parse flattens to grams and keeps the
// shopper-friendly measure as displayText.
function garlic() {
  return {
    id: 'i1',
    rawText: '6 cloves garlic, peeled',
    parsed: {
      quantity: { type: 'single' as const, value: 18 },
      unit: 'g' as const,
      item: 'garlic',
      preparation: ['peeled'],
      notes: null,
      displayText: '6 cloves',
    } as never,
    canonId: 'canon-garlic',
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

describe('buildRecipeAddPlan — measureNote', () => {
  beforeEach(() => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-garlic')]);
  });

  it('carries the original measure on an unscaled add', () => {
    const rows = buildRecipeAddPlan(makeRecipe([garlic()]), 2); // base servings → scale 1

    expect(rows[0]!.measureNote).toBe('6 cloves');
    expect(rows[0]!.amount).toBe(18);
  });

  it('drops it on a SCALED add rather than stating a stale count', () => {
    // Doubled: 36 g is right, "6 cloves" is not — and the string cannot be
    // multiplied, so the row shows the amount alone.
    const rows = buildRecipeAddPlan(makeRecipe([garlic()]), 4);

    expect(rows[0]!.amount).toBe(36);
    expect(rows[0]!.measureNote).toBeUndefined();
    expect('measureNote' in rows[0]!).toBe(false);
  });

  it('drops it when scaled DOWN too', () => {
    const rows = buildRecipeAddPlan(makeRecipe([garlic()]), 1);

    expect(rows[0]!.amount).toBe(9);
    expect('measureNote' in rows[0]!).toBe(false);
  });

  it('leaves the key absent for a line that was already metric', () => {
    // displayText is null when the source needed no re-expression.
    const rows = buildRecipeAddPlan(
      makeRecipe([formIngredient('i1', 'canon-garlic', 'garlic', 18, 'g')]),
      2,
    );

    expect('measureNote' in rows[0]!).toBe(false);
  });
});

describe('commitRecipeAddPlan — measureNote', () => {
  beforeEach(() => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-garlic')]);
  });

  it('writes the note through to the shopping item', async () => {
    const recipe = makeRecipe([garlic()]);
    const rows = buildRecipeAddPlan(recipe, 2);

    await commitRecipeAddPlan(recipe, 'list-1', 2, rows);

    const saved = vi.mocked(fs.saveShoppingListItem).mock.calls[0]![1];
    expect(saved.measureNote).toBe('6 cloves');
  });

  it('writes NO measureNote key on a scaled add', async () => {
    // Firestore rejects an explicit `undefined`, and a doc carrying the stale
    // string would read back as fact — the key must be absent.
    const recipe = makeRecipe([garlic()]);
    const rows = buildRecipeAddPlan(recipe, 4);

    await commitRecipeAddPlan(recipe, 'list-1', 4, rows);

    const saved = vi.mocked(fs.saveShoppingListItem).mock.calls[0]![1];
    expect('measureNote' in saved).toBe(false);
  });
});
