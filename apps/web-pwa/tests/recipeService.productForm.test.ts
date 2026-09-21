import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Recipe,
  CanonItem,
  IngredientGroup,
  ProductForm,
  ShoppingBehavior,
} from '@salt/domain';

// The product-form add path (issues #500/#518/#521). buildRecipeAddPlan collapses
// a parent's form rows to ONE row per recipe, and the correctness of the shopping
// count depends entirely on the losers' demand riding onto the survivor as
// `formDemand` — drop it and the display layer can never recover the per-form sum.
// The pure aggregation is covered in @salt/domain; this pins the ADD-TIME
// plumbing that feeds it, which was previously untested.

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

// ─── The SAME form on two lines SUMS (issue #521's beef-stock case) ──────────

describe('buildRecipeAddPlan — same form on two lines', () => {
  beforeEach(() => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-cube')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-stock', 'beef stock', 'canon-cube', 'ml', 500),
    ]);
  });

  it('carries BOTH lines demand onto the one surviving row', () => {
    // Braise 400 ml + gravy 400 ml against a 500 ml cube.
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-cube', 'beef stock', 400, 'ml'),
        formIngredient('i2', 'canon-cube', 'beef stock', 400, 'ml'),
      ]),
      2, // base servings — scale 1
    );

    expect(rows).toHaveLength(1);
    // Both demands survive the collapse, sharing a formId so they SUM downstream.
    expect(rows[0]!.formDemand).toEqual([
      { formId: 'form-stock', parentCount: 0.8 },
      { formId: 'form-stock', parentCount: 0.8 },
    ]);
  });

  it('shows the recipe true count (2 cubes), not the winning row own count (1)', () => {
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-cube', 'beef stock', 400, 'ml'),
        formIngredient('i2', 'canon-cube', 'beef stock', 400, 'ml'),
      ]),
      2,
    );
    expect(rows[0]!.amount).toBe(2);
    expect(rows[0]!.unit).toBe('count');
  });

  it('rounds ONCE on the sum: 200 ml + 200 ml of a 500 ml cube is 1, not 2', () => {
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-cube', 'beef stock', 200, 'ml'),
        formIngredient('i2', 'canon-cube', 'beef stock', 200, 'ml'),
      ]),
      2,
    );
    expect(rows[0]!.amount).toBe(1);
  });
});

// ─── DISTINCT forms of one parent still MAX (issue #500, unchanged) ──────────

describe('buildRecipeAddPlan — distinct forms of one parent', () => {
  beforeEach(() => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-juice', 'lime juice', 'canon-lime', 'ml', 30),
      makeForm('form-zest', 'lime zest', 'canon-lime', 'g', 5),
    ]);
  });

  it('collapses to one row at the MAX, carrying every form demand', () => {
    // 60 ml juice = 2 limes; 15 g zest = 3 limes. One lime gives both → 3.
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-lime', 'lime juice', 60, 'ml'),
        formIngredient('i2', 'canon-lime', 'lime zest', 15, 'g'),
      ]),
      2,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(3);
    // The LOSING row's demand (juice) rides along — dropping it would make the
    // cross-recipe sum unrecoverable at display time.
    expect(rows[0]!.formDemand).toEqual([
      { formId: 'form-juice', parentCount: 2 },
      { formId: 'form-zest', parentCount: 3 },
    ]);
  });
});

// ─── The original recipe wording rides onto the survivor (issue #528) ────────
//
// The collapsed row is labelled with the PARENT product ("Lime (3 count)"), which
// is deliberately far from the recipe's own wording, and mentions neither of the
// lines that justified the count. `originalText` carries that wording alongside
// the label — as well as, never instead of. Persisted onto the shopping item at
// commit (#528 Phase 2) so the list shows the same wording under its "Lime ×3".

describe('buildRecipeAddPlan — originalText', () => {
  it("carries the losers' wording onto the survivor, winner first", () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-juice', 'lime juice', 'canon-lime', 'ml', 30),
      makeForm('form-zest', 'lime zest', 'canon-lime', 'g', 5),
    ]);

    // 60 ml juice = 2 limes; 15 g zest = 3 limes → zest WINS, though juice is
    // first in source order. The winner's own line leads; the loser follows.
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-lime', 'lime juice', 60, 'ml'),
        formIngredient('i2', 'canon-lime', 'lime zest', 15, 'g'),
      ]),
      2,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.originalText).toEqual(['15 g lime zest', '60 ml lime juice']);
  });

  it('keeps source order behind the winner across three lines', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-juice', 'lime juice', 'canon-lime', 'ml', 30),
      makeForm('form-zest', 'lime zest', 'canon-lime', 'g', 5),
    ]);

    // juice 30 ml = 1; zest 15 g = 3 (winner); juice 60 ml = 2. The two losing
    // juice lines keep their source order behind the winning zest line.
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-lime', 'lime juice', 30, 'ml'),
        formIngredient('i2', 'canon-lime', 'lime zest', 15, 'g'),
        formIngredient('i3', 'canon-lime', 'lime juice', 60, 'ml'),
      ]),
      2,
    );

    expect(rows[0]!.originalText).toEqual([
      '15 g lime zest',
      '30 ml lime juice',
      '60 ml lime juice',
    ]);
  });

  it('de-duplicates identical wording', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-cube')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-stock', 'beef stock', 'canon-cube', 'ml', 500),
    ]);

    // Two lines worded identically ("400 ml beef stock") — both count toward the
    // amount, but listing the same line twice tells the reviewer nothing.
    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-cube', 'beef stock', 400, 'ml'),
        formIngredient('i2', 'canon-cube', 'beef stock', 400, 'ml'),
      ]),
      2,
    );

    expect(rows[0]!.originalText).toEqual(['400 ml beef stock']);
    // De-duplicating the WORDING must not touch the demand behind the count.
    expect(rows[0]!.formDemand).toHaveLength(2);
    expect(rows[0]!.amount).toBe(2);
  });

  it('leaves ordinary rows without originalText', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([
      makeCanonItem('canon-lime'),
      makeCanonItem('canon-salt'),
    ]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-juice', 'lime juice', 'canon-lime', 'ml', 30),
    ]);

    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-lime', 'lime juice', 60, 'ml'),
        formIngredient('i2', 'canon-salt', 'salt', 5, 'g'),
      ]),
      2,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.originalText).toEqual(['60 ml lime juice']);
    expect(rows[1]!.originalText).toBeUndefined();
  });

  it('carries no originalText when the recipe has no form rows at all', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-salt')]);
    const rows = buildRecipeAddPlan(
      makeRecipe([formIngredient('i1', 'canon-salt', 'salt', 5, 'g')]),
      2,
    );
    expect(rows[0]!.originalText).toBeUndefined();
  });
});

// ─── The corrected count drives the stocked threshold ────────────────────────

describe('buildRecipeAddPlan — stocked parent threshold', () => {
  it('re-decides Add against the summed count, not the under-stated row count', () => {
    // Stocked cubes, threshold 1: one 400 ml line alone (1 cube) stays off the
    // list, but two lines are 2 cubes — over the threshold, so buy them.
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-cube', 'stocked', 1)]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-stock', 'beef stock', 'canon-cube', 'ml', 500),
    ]);

    const one = buildRecipeAddPlan(
      makeRecipe([formIngredient('i1', 'canon-cube', 'beef stock', 400, 'ml')]),
      2,
    );
    expect(one[0]!.amount).toBe(1);
    expect(one[0]!.add).toBe(false);

    const two = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-cube', 'beef stock', 400, 'ml'),
        formIngredient('i2', 'canon-cube', 'beef stock', 400, 'ml'),
      ]),
      2,
    );
    expect(two[0]!.amount).toBe(2);
    expect(two[0]!.add).toBe(true);
  });
});

// ─── Ordinary rows are untouched ─────────────────────────────────────────────

describe('buildRecipeAddPlan — non-form rows', () => {
  it('leaves same-canon rows alone and sets no formDemand', () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-flour')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-stock', 'beef stock', 'canon-cube', 'ml', 500),
    ]);

    const rows = buildRecipeAddPlan(
      makeRecipe([
        formIngredient('i1', 'canon-flour', 'flour', 200, 'g'),
        formIngredient('i2', 'canon-flour', 'flour', 300, 'g'),
      ]),
      2,
    );

    // Combining ordinary same-canon rows stays a display concern — no collapse.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.formDemand).toBeUndefined();
    expect(rows[1]!.formDemand).toBeUndefined();
  });
});

// Phase 2: the wording only survives to the aisle if the COMMIT writes it. The
// review sheet already showed it in-memory; without this the shopper standing in
// front of the limes still can't tell what the three are for.
describe('commitRecipeAddPlan — originalText', () => {
  beforeEach(() => {
    (fs.saveShoppingListItem as ReturnType<typeof vi.fn>).mockClear();
  });

  it('writes the recipe wording onto the product-form item', async () => {
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([
      makeForm('form-juice', 'lime juice', 'canon-lime', 'ml', 30),
      makeForm('form-zest', 'lime zest', 'canon-lime', 'g', 5),
    ]);
    const recipe = makeRecipe([
      formIngredient('i1', 'canon-lime', 'lime juice', 60, 'ml'),
      formIngredient('i2', 'canon-lime', 'lime zest', 15, 'g'),
    ]);
    const rows = buildRecipeAddPlan(recipe, 2);

    await commitRecipeAddPlan(recipe, 'list-1', 2, rows);

    const saved = vi.mocked(fs.saveShoppingListItem).mock.calls[0]![1];
    expect(saved.originalText).toEqual(['15 g lime zest', '60 ml lime juice']);
    // Display context only — the count and demand it rides with are unchanged.
    expect(saved.amount).toBe(3);
    expect(saved.unit).toBe('count');
  });

  it('writes NO originalText field for an ordinary non-form item', async () => {
    // The field must stay absent (not [], not null) on every ordinary row, so
    // those docs read back exactly as they do today.
    mockGetCanonItemsSnapshot.mockReturnValue([makeCanonItem('canon-lime')]);
    mockGetProductFormsSnapshot.mockReturnValue([]);
    const recipe = makeRecipe([formIngredient('i1', 'canon-lime', 'limes', 2, null)]);
    const rows = buildRecipeAddPlan(recipe, 2);

    await commitRecipeAddPlan(recipe, 'list-1', 2, rows);

    const saved = vi.mocked(fs.saveShoppingListItem).mock.calls[0]![1];
    expect(saved.originalText).toBeUndefined();
    expect('originalText' in saved).toBe(false);
  });
});
