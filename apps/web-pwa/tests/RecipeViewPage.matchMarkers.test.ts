import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type { CanonItem, Ingredient, ProductForm, Recipe } from '@salt/domain';
import { recipeMatchIssueCount } from '@salt/domain';

// Row match markers (issue #867). The list card counts a recipe's silently-wrong
// lines; opening that recipe used to show you nothing, because the row asked a
// narrower question — `hasLiveCanonMatch`, which never reads product forms — so a
// line with a live canon and no bridging form passed it and got no marker.
//
// The two markers are deliberately different glyphs because the remedies differ:
// ✗ runs the match, ⚠ opens the sheet that explains what the line actually buys.

const {
  mockRecipes,
  mockCanonItems,
  mockIsLoadingAisles,
  mockProductForms,
  mockIsLoadingProductForms,
  mockGuidedPlan,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly unknown[]>([]),
    mockCanonItems: makeStore<readonly unknown[]>([]),
    mockIsLoadingAisles: makeStore<boolean>(false),
    mockProductForms: makeStore<readonly unknown[]>([]),
    mockIsLoadingProductForms: makeStore<boolean>(false),
    mockGuidedPlan: makeStore<unknown>(null),
    mockIsLoading: makeStore<boolean>(false),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockSessions: makeStore<readonly unknown[]>([]),
    mockEquipment: makeStore<unknown>(null),
  };
});

// `router` joins the mock for issue #1314: the page reads `router.querystring`
// live to find the `?serves=` it is being read at. An empty querystring is "as
// written", which is what every assertion in this suite assumes.
vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { querystring: '' },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: { email: 'cook@test' } } }));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: mockIsLoadingAisles,
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: mockProductForms,
  isLoadingProductForms: mockIsLoadingProductForms,
}));
vi.mock('../src/lib/guidedPlanService.js', () => ({
  guidedPlan: mockGuidedPlan,
  initGuidedPlanSync: vi.fn(() => () => {}),
}));
vi.mock('../src/lib/formulaService.js', () => ({
  formula: {
    subscribe: (fn: (value: unknown) => void) => {
      fn(null);
      return () => {};
    },
  },
  initFormulaSync: vi.fn(() => () => {}),
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({ defaultListId: mockDefaultListId }));
vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  createChatSession: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  // The equipment pictogram store `kitIcons` reads (issue #954). Empty here: these
  // fixtures name no owned appliance, so every kit label falls through to the tool
  // vocabulary exactly as it did before.
  equipmentIcons: {
    subscribe(fn: (v: Map<string, never>) => void) {
      fn(new Map<string, never>());
      return () => {};
    },
  },
}));
vi.mock('../src/lib/clipboardImage.js', () => ({
  clipboardImageReadSupported: () => false,
  readClipboardImage: vi.fn(),
  imageFromClipboardData: vi.fn(),
}));
vi.mock('../src/lib/recipeService.js', () => ({
  // Issue #1319 Phase 7: the page claims an import's stashed draft so a
  // just-imported recipe paints before the Firestore listener delivers it, and
  // it owns the meal attach the retired editor's save used to make.
  takeImportedDraft: vi.fn().mockReturnValue(null),
  attachComponentToMeal: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoading,
  removeRecipe: vi.fn(),
  canonicaliseIngredients: vi.fn(),
  matchIngredient: vi.fn(),
  persistRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  stashImportedDraft: vi.fn(),
  authorRecipeTraced: vi.fn(),
  regenerateRecipeImage: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reviseRecipeSceneBrief: vi.fn(),
  startOverRecipeSceneBrief: vi.fn(),
  setRecipeImageUpload: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  buildRecipeAddPlan: vi.fn().mockReturnValue([]),
  buildMadeSubRows: vi.fn().mockReturnValue([]),
  commitRecipeAddPlan: vi.fn(),
  recipeAddPlanItemCount: vi.fn().mockReturnValue(0),
}));

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { matchIngredient } from '../src/lib/recipeService.js';

const RECIPE_ID = 'recipe-1';

// A count-sold canon carrying a form for something else: the shape that makes an
// unbridged line genuinely wrong, and the live `Lemon` / `Lemon zest` pair.
const LEMON: CanonItem = {
  embedding: null,
  id: 'canon-lemon',
  schemaVersion: 5,
  name: 'lemon',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

// Count-sold with no form at all — the bay-leaf class #867 silenced.
const BAY_LEAVES: CanonItem = { ...LEMON, id: 'canon-bay', name: 'Bay Leaves' };

const LEMON_ZEST: ProductForm = {
  id: 'form-lemon-zest',
  schemaVersion: 1,
  matchers: [],
  parentCanonId: 'canon-lemon',
  thumbnail: null,
  label: 'Lemon zest',
  yield: { formUnit: 'g', amountPerParent: 5 },
  updatedAt: '2026-08-19T00:00:00.000Z',
};

function line(over: Partial<Ingredient> & { id: string }): Ingredient {
  return {
    rawText: '1 tbsp fresh lemon juice',
    parsed: {
      quantity: { type: 'single', value: 15 },
      unit: 'ml',
      item: 'fresh lemon juice',
      preparation: [],
      notes: null,
      displayText: '1 tbsp',
    },
    canonId: 'canon-lemon',
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
    ...over,
  } as Ingredient;
}

function makeRecipe(items: Ingredient[]): Recipe {
  return {
    kind: 'recipe',
    producesCanonId: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Lemony Thing',
    description: null,
    ingredients: [{ id: 'group-1', name: null, items }],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: { type: 'manual' },
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRecipes._set([]);
  mockCanonItems._set([LEMON, BAY_LEAVES]);
  mockIsLoadingAisles._set(false);
  mockProductForms._set([LEMON_ZEST]);
  mockIsLoadingProductForms._set(false);
  mockIsLoading._set(false);
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — ingredient match markers', () => {
  it('marks a matched-but-mis-bought line with ⚠, not the unmatched ✗', () => {
    mockRecipes._set([makeRecipe([line({ id: 'ing-juice' })])]);
    const { getAllByTestId, queryByTestId } = renderPage();

    expect(getAllByTestId('match-state-mismatched')).toHaveLength(1);
    expect(queryByTestId('match-state-unmatched')).toBeNull();
  });

  it('leaves a never-matched line on the ✗ — its remedy is still a match', () => {
    mockRecipes._set([makeRecipe([line({ id: 'ing-new', canonId: null, matchState: 'pending' })])]);
    const { getAllByTestId, queryByTestId } = renderPage();

    expect(getAllByTestId('match-state-unmatched')).toHaveLength(1);
    expect(queryByTestId('match-state-mismatched')).toBeNull();
  });

  it('leaves a dangling canon on the ✗ — nothing is matched any more', () => {
    mockRecipes._set([makeRecipe([line({ id: 'ing-gone', canonId: 'canon-deleted' })])]);
    const { getAllByTestId, queryByTestId } = renderPage();

    expect(getAllByTestId('match-state-unmatched')).toHaveLength(1);
    expect(queryByTestId('match-state-mismatched')).toBeNull();
  });

  it('says nothing about a line matched to a canon with no forms of its own', () => {
    // The false positive #867 removed: bay leaf is correctly matched, and no
    // product form for it should ever exist.
    const bay = line({
      id: 'ing-bay',
      rawText: '2 bay leaves',
      canonId: 'canon-bay',
      parsed: {
        quantity: { type: 'single', value: 1 },
        unit: 'g',
        item: 'bay leaf',
        preparation: [],
        notes: null,
        displayText: '2',
      },
    });
    mockRecipes._set([makeRecipe([bay])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('match-state-mismatched')).toBeNull();
    expect(queryByTestId('match-state-unmatched')).toBeNull();
  });

  it('marks exactly as many rows as the card counts', () => {
    // The whole point of sharing one predicate: if the pip says N, N rows carry a
    // marker. Two wrong lines and one clean one, counted by the same query the
    // list card uses.
    const clean = line({
      id: 'ing-zest',
      rawText: '1 tsp lemon zest',
      parsed: {
        quantity: { type: 'single', value: 5 },
        unit: 'g',
        item: 'lemon zest',
        preparation: [],
        notes: null,
        displayText: '1 tsp',
      },
    });
    const recipe = makeRecipe([line({ id: 'ing-a' }), line({ id: 'ing-b' }), clean]);
    mockRecipes._set([recipe]);

    const cardCount = recipeMatchIssueCount(
      recipe,
      new Map([
        [LEMON.id, LEMON],
        [BAY_LEAVES.id, BAY_LEAVES],
      ]),
      [LEMON_ZEST],
    );
    expect(cardCount).toBe(2);

    const { getAllByTestId } = renderPage();
    expect(getAllByTestId('match-state-mismatched')).toHaveLength(cardCount);
  });

  it('marks nothing at all while canon is still loading', () => {
    mockIsLoadingAisles._set(true);
    mockRecipes._set([
      makeRecipe([line({ id: 'ing-juice' }), line({ id: 'ing-new', canonId: null })]),
    ]);
    const { queryByTestId } = renderPage();

    // Not even the ✗: an empty canon makes every matched line look dangling, so an
    // ungated row flashes a warning it takes back a moment later.
    expect(queryByTestId('match-state-mismatched')).toBeNull();
    expect(queryByTestId('match-state-unmatched')).toBeNull();
  });

  it('marks nothing at all while product forms are still loading', () => {
    mockIsLoadingProductForms._set(true);
    mockRecipes._set([makeRecipe([line({ id: 'ing-juice' })])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('match-state-mismatched')).toBeNull();
    expect(queryByTestId('match-state-unmatched')).toBeNull();
  });

  it('labels the ⚠ for a screen reader and leaves the row inspect target alone', () => {
    mockRecipes._set([makeRecipe([line({ id: 'ing-juice' })])]);
    const { getByTestId } = renderPage();

    const marker = getByTestId('match-state-mismatched');
    expect(marker.getAttribute('aria-label')).toBeTruthy();
    // Sibling of the row button, not nested inside it.
    expect(marker.closest('[data-testid="recipe-view-ingredient-inspect"]')).toBeNull();
    expect(getByTestId('recipe-view-ingredient-inspect')).toBeTruthy();
  });

  // ─── The three-clause readiness gate (issue #1055 characterisation) ──────────
  // `matchMarkersKnown` is `!$isLoadingAisles && !$isLoadingProductForms &&
  // $canonItems.length > 0` — character-identical to `matchIssuesKnown` on
  // `RecipeListPage`, under a different name. They must agree exactly, or the
  // card counts three problems and the recipe you open shows none, which is the
  // defect issue #867 was filed for.
  //
  // Prose was all that held them: this file asserted the two loading clauses and
  // never `mockCanonItems._set([])`, so `&& $canonItems.length > 0` could be
  // deleted from the page with this whole suite still green. The counterpart
  // table is in `RecipeListPage.test.ts`, which had the mirror-image hole.
  describe('readiness gate — every clause closes it', () => {
    it.each([
      ['isLoadingAisles is still true', (): void => mockIsLoadingAisles._set(true)],
      ['isLoadingProductForms is still true', (): void => mockIsLoadingProductForms._set(true)],
      ['canon has not landed yet', (): void => mockCanonItems._set([])],
    ])('marks no row at all while %s', (_clause, closeTheGate) => {
      closeTheGate();
      mockRecipes._set([
        makeRecipe([line({ id: 'ing-juice' }), line({ id: 'ing-new', canonId: null })]),
      ]);
      const { queryByTestId } = renderPage();

      expect(queryByTestId('match-state-mismatched')).toBeNull();
      expect(queryByTestId('match-state-unmatched')).toBeNull();
      expect(queryByTestId('match-state-no-amount')).toBeNull();
    });

    it('marks rows as soon as all three clauses are satisfied', () => {
      // The control the three rows above need: without it they would pass on a
      // fixture that never marks anything, and the table would be vacuous.
      mockRecipes._set([
        makeRecipe([line({ id: 'ing-juice' }), line({ id: 'ing-new', canonId: null })]),
      ]);
      const { getAllByTestId } = renderPage();

      expect(getAllByTestId('match-state-mismatched')).toHaveLength(1);
      expect(getAllByTestId('match-state-unmatched')).toHaveLength(1);
    });
  });
});

// ─── no amount (issue #949) ──────────────────────────────────────────────────

describe('RecipeViewPage — a line with no amount', () => {
  // The state a batch-authored line could be stored in: canon-matched, and
  // holding no parsed quantity at all. It read as healthy, contributed nothing to
  // the shopping list, and could not be scaled — and the ✗ keys on matchState, so
  // the list offered no way in. Twelve such rows are in production.
  const noAmount = line({ id: 'ing-nuts', rawText: '125 g gingernuts', parsed: null });

  it('marks it, and not with the unmatched ✗', () => {
    mockRecipes._set([makeRecipe([noAmount])]);
    const { getAllByTestId, queryByTestId } = renderPage();

    expect(getAllByTestId('match-state-no-amount')).toHaveLength(1);
    expect(queryByTestId('match-state-unmatched')).toBeNull();
    expect(queryByTestId('match-state-mismatched')).toBeNull();
  });

  it('repairs the row from the marker in one tap', async () => {
    // The same repair that today needs you to know which row to open.
    vi.mocked(matchIngredient).mockResolvedValue({
      kind: 'ok',
      value: { ...noAmount, parsed: line({ id: 'x' }).parsed },
    } as never);
    mockRecipes._set([makeRecipe([noAmount])]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('match-state-no-amount'));

    expect(vi.mocked(matchIngredient)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(matchIngredient).mock.calls[0]![0]).toMatchObject({ id: 'ing-nuts' });
  });

  it('labels the marker for a screen reader and keeps it out of the row button', () => {
    mockRecipes._set([makeRecipe([noAmount])]);
    const { getByTestId } = renderPage();

    const marker = getByTestId('match-state-no-amount');
    expect(marker.getAttribute('aria-label')).toBeTruthy();
    expect(marker.closest('[data-testid="recipe-view-ingredient-inspect"]')).toBeNull();
  });

  it('marks nothing while canon is still loading', () => {
    mockIsLoadingAisles._set(true);
    mockRecipes._set([makeRecipe([noAmount])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('match-state-no-amount')).toBeNull();
  });

  it('leaves a freshly assembled unparsed line on the ✗ instead', () => {
    // What Phase 1 now writes: no canon match claimed, so the line is already
    // visible and this marker would be a second word for the same thing.
    mockRecipes._set([
      makeRecipe([line({ id: 'ing-fresh', parsed: null, canonId: null, matchState: 'pending' })]),
    ]);
    const { getAllByTestId, queryByTestId } = renderPage();

    expect(getAllByTestId('match-state-unmatched')).toHaveLength(1);
    expect(queryByTestId('match-state-no-amount')).toBeNull();
  });
});
