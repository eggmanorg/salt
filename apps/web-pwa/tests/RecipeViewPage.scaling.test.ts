import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe, type Ingredient, type Recipe } from '@salt/domain';

// Reading a recipe for a different number of people (issue #1314, Phase 1).
//
// What these pin is the whole of the page's half of it: the Serves pill is a
// control rather than a label, the amounts restate, the page says what it did and
// what it did not do, and the review sheet opens already set to the same number.
//
// It is a VIEW. Nothing here writes: `persistRecipe` must stay untouched through
// every one of these, because the recipe document is family-shared and permanent
// and a reading control must not edit it.
//
// The mock preamble is the one every RecipeViewPage suite carries; `router` is
// mutable here because the chosen number lives in `?serves=` and nowhere else.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
  mockRouter,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string }[]>([]),
    mockGuidedPlan: makeStore<unknown>(null),
    mockIsLoading: makeStore<boolean>(false),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockSessions: makeStore<readonly unknown[]>([]),
    mockEquipment: makeStore<unknown>(null),
    // svelte-spa-router's `router` is a rune-backed state object; the page reads
    // `router.querystring` live to find the `?serves=` it is being read at.
    mockRouter: { querystring: '' as string | undefined },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: mockRouter }));
vi.mock('../src/lib/featureGate.js', () => ({
  // Bread stays on, which is what the real (unkeyed) gate answers — this suite is
  // not about bread and nothing here should change what it shows.
  breadGate: {
    subscribe: (fn: (v: unknown) => void) => (fn({ enabled: true, settled: true }), () => {}),
  },
  featureGate: () => ({
    subscribe: (fn: (v: unknown) => void) => (fn({ enabled: true, settled: true }), () => {}),
  }),
  isFeatureEnabled: () => true,
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: { email: 'cook@test' } } }));
// #867: the ingredient rows gate their ✗/⚠ markers on canon AND product forms
// having landed, so both stores must read loaded here or no marker ever renders.
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: {
    subscribe(fn: (v: boolean) => void) {
      fn(false);
      return () => {};
    },
  },
}));
vi.mock('../src/lib/productFormService.js', () => {
  const loaded = <T>(v: T) => ({
    subscribe(fn: (x: T) => void) {
      fn(v);
      return () => {};
    },
  });
  return { productForms: loaded([]), isLoadingProductForms: loaded(false) };
});
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
  stampRecipeAttribution: <T>(recipe: T) => recipe,
}));

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { push } from 'svelte-spa-router';
import { persistRecipe, buildRecipeAddPlan } from '../src/lib/recipeService.js';

const RECIPE_ID = 'recipe-1';
const SEEDED_AT = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([]);
  mockGuidedPlan._set(null);
  mockRouter.querystring = '';
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function ingredient(
  id: string,
  item: string,
  amount: number,
  unit: 'g' | 'ml' | null,
  displayText: string | null = null,
): Ingredient {
  return {
    id,
    rawText: `${amount}${unit ?? ''} ${item}`,
    parsed: {
      quantity: { type: 'single', value: amount },
      unit,
      item,
      preparation: [],
      notes: null,
      displayText,
    },
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const INGREDIENTS = [
  ingredient('i1', 'strong white flour', 300, 'g', '2 cups'),
  ingredient('i2', 'egg', 3, null),
];

// `emptyRecipe` rather than a hand-rolled literal (UT-C2): nothing in this suite
// depends on a field the real builder does not already set correctly.
function pancakes(servings: number | null): Recipe {
  const base = emptyRecipe(RECIPE_ID, SEEDED_AT);
  return {
    ...base,
    title: 'Pancakes',
    ingredients: [{ id: 'g1', name: null, items: INGREDIENTS }],
    metadata: { ...base.metadata, servings },
  };
}

function servesFour(): Recipe {
  return pancakes(4);
}

function amountsText(): string {
  return screen
    .getAllByTestId('recipe-view-ingredient')
    .map((li) => li.textContent ?? '')
    .join(' | ');
}

describe('RecipeViewPage — scaling the amounts', () => {
  it('draws the recipe as written when nothing asks otherwise', () => {
    mockRecipes._set([servesFour()]);
    renderPage();

    expect(screen.getByTestId('recipe-servings-chip').textContent).toContain('Serves 4');
    expect(amountsText()).toContain('300g');
    expect(amountsText()).toContain('3');
    // The source's own second measure is only true at the stated amount, so it is
    // shown here and nowhere else.
    expect(amountsText()).toContain('2 cups');
    expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
  });

  it('leaves the other facts beside it as plain, un-tappable pills', () => {
    // The Serves pill LEAVES the fact row's tint scheme because it is the one
    // entry you can act on. Its neighbours must not follow it: `Chip
    // variant="fact"` is a `<span>` by ui-spec-v09 §8.23.8 and stays one.
    mockRecipes._set([{ ...pancakes(4), createdBy: 'Ada Lovelace' }]);
    renderPage();

    const attribution = screen.getByTestId('recipe-attribution-chip');
    expect(attribution.tagName).toBe('SPAN');
    expect(attribution.textContent).toContain('Ada');
    // And the one that IS a control is a button, in the same row.
    expect(screen.getByTestId('recipe-servings-chip').tagName).toBe('BUTTON');
  });

  it('restates every amount at the number in the URL', () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    expect(screen.getByTestId('recipe-servings-chip').textContent).toContain('Serves 6');
    const amounts = amountsText();
    expect(amounts).toContain('450g');
    // 3 eggs × 1.5 — a cook reads "4½".
    expect(amounts).toContain('4½');
    // "2 cups" restates the UNSCALED amount and is false the moment anything moves.
    expect(amounts).not.toContain('2 cups');
  });

  it('says what changed and what did not, naming both numbers', () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    const notice = screen.getByTestId('recipe-scaled-notice').textContent ?? '';
    expect(notice).toContain('6');
    expect(notice).toContain('4');
    // The honest half: a tin that fitted four still fits four.
    expect(notice).toMatch(/method/i);
    expect(notice).toMatch(/timings/i);
  });

  it('resets to as written in one tap, and leaves a clean URL', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-scaled-reset'));

    expect(vi.mocked(push)).toHaveBeenCalledWith('/recipes/recipe-1');
  });

  it('offers other numbers from the pill, and asks for one by URL', async () => {
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-servings-chip'));
    await waitFor(() => expect(screen.getByRole('option', { name: '6' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('option', { name: '6' }));

    expect(vi.mocked(push)).toHaveBeenCalledWith('/recipes/recipe-1?serves=6');
  });

  it('writes nothing — this is a view, not an edit', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-servings-chip'));
    await waitFor(() => expect(screen.getByRole('option', { name: '8' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('option', { name: '8' }));

    // The recipe document is family-shared and permanent. A reading control that
    // saved would change the recipe for the whole household, off a view.
    expect(vi.mocked(persistRecipe)).not.toHaveBeenCalled();
  });

  it('seeds the review sheet with the number being read', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-add-to-list-button'));

    // The sheet builds its plan from the seeded servings. `buildRecipeAddPlan` is
    // the BUYING path and computes from the exact factor — the figures on screen
    // are rounded for reading and are not what it is handed.
    await waitFor(() =>
      expect(vi.mocked(buildRecipeAddPlan)).toHaveBeenCalledWith(expect.anything(), 6),
    );
  });

  describe('a recipe with no usable servings count', () => {
    it('shows an inert pill for a null count, exactly as today', () => {
      mockRecipes._set([pancakes(null)]);
      renderPage();

      // No Serves fact at all when there is no count — that is today's behaviour
      // and scaling does not add one.
      expect(screen.queryByTestId('recipe-servings-chip')).toBeNull();
      expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
    });

    it('leaves a stored 0 inert, and ignores a ?serves= aimed at it', () => {
      // `usableServings` (issue #1123): 0 is not a scaling base — dividing by it
      // is how a shopping list was once scaled by Infinity.
      mockRouter.querystring = 'serves=6';
      mockRecipes._set([pancakes(0)]);
      renderPage();

      const chip = screen.queryByTestId('recipe-servings-chip');
      expect(chip).toBeNull();
      expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
      expect(amountsText()).toContain('300g');
    });
  });

  it('ignores a nonsense ?serves= rather than painting a nonsense page', () => {
    mockRouter.querystring = 'serves=abc';
    mockRecipes._set([servesFour()]);
    renderPage();

    expect(screen.getByTestId('recipe-servings-chip').textContent).toContain('Serves 4');
    expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
    expect(amountsText()).toContain('300g');
  });
});
