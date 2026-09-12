import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { appendCacheBuster, emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// This is issue #933's characterisation net for the "hero URL" rule — one of
// eight identical copies of `appendCacheBuster(recipe.image.url,
// recipe.imageRequestedAt ?? recipe.updatedAt)` scattered across web-pwa, here
// at RecipeViewPage's TOP-LEVEL recipe hero (`recipe-hero-image`). It must stay
// green, UNMODIFIED, once all eight collapse onto one shared `@salt/domain`
// function. Expectations are computed by calling the REAL `appendCacheBuster`
// rather than hand-encoding a query string.
//
// Thirteen `vi.mock` calls, matching every other RecipeViewPage suite
// (kind.test.ts, imageBrief.test.ts, components.test.ts, ...): the page
// subscribes to this many services just to mount at all, and narrowing that
// seam is a #913-scale refactor of the page itself — out of scope for a
// characterisation test (UT-B1).

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockFormula,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string }[]>([]),
    mockGuidedPlan: makeStore<unknown>(null),
    mockFormula: makeStore<unknown>(null),
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
  formula: mockFormula,
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

const RECIPE_ID = 'hero-recipe';

function heroRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    ...emptyRecipe(RECIPE_ID, '2026-01-01T00:00:00.000Z'),
    title: 'Hero Recipe',
    updatedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
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
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([]);
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — hero URL rule at the top-level hero (issue #933 characterisation)', () => {
  it.each([
    { name: 'busts with imageRequestedAt when present', imageRequestedAt: 999 },
    {
      name: 'falls back to updatedAt when imageRequestedAt is absent',
      imageRequestedAt: undefined,
    },
  ])('$name', ({ imageRequestedAt }) => {
    const url = 'https://example.com/hero-recipe.webp';
    const r = heroRecipe({
      image: { url, source: 'ai' },
      ...(imageRequestedAt !== undefined ? { imageRequestedAt } : {}),
    });
    mockRecipes._set([r]);
    renderPage();

    expect(screen.getByTestId('recipe-hero-image')).toHaveAttribute(
      'src',
      appendCacheBuster(url, imageRequestedAt ?? r.updatedAt),
    );
  });

  it('renders no hero at all when the recipe has no image', () => {
    mockRecipes._set([heroRecipe({ image: null })]);
    renderPage();

    expect(screen.queryByTestId('recipe-hero')).toBeNull();
    expect(screen.queryByTestId('recipe-hero-image')).toBeNull();
  });
});
