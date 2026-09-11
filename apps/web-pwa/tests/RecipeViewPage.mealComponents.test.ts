import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// Adding another dish to a meal (issue #752, Phase 3).
//
// The meal page grows the same four ways in that the recipe list's New menu
// offers — import a link, photograph a page, chat one up, write it out — and the
// only thing they add is the meal's id on the URL they navigate to. That id IS
// the feature: it is what the far end reads to know what the new dish is for, and
// it lives nowhere else, so a reload at any hop keeps it.
//
// The surface is gated on the card, i.e. on the document already having
// components. Turning an ordinary recipe INTO a meal stays in the editor's
// picker, where Phase 1 put it.

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
    mockEquipment: makeStore<{ items: readonly { name: string }[] } | null>({ items: [] }),
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
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' }, signOut: vi.fn() },
}));
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
  // The two import dialogs the meal's New menu mounts.
  importRecipeFromUrl: vi.fn(),
  urlImportMessage: vi.fn(() => 'nope'),
  isSignedOutFailure: vi.fn(() => false),
  stashPendingImportUrl: vi.fn(),
  importRecipeFromPhoto: vi.fn(),
  photoImportMessage: vi.fn(() => 'nope'),
}));

import { push } from 'svelte-spa-router';
import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { importRecipeFromUrl, stashImportedDraft } from '../src/lib/recipeService.js';

const MEAL_ID = 'roast';

function makeEntry(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    id: MEAL_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Sunday roast',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 4,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CHICKEN = makeEntry({ id: 'chicken', title: 'Roast chicken' });
const MEAL = makeEntry({ componentRecipeIds: ['chicken'] });

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockGuidedPlan._set(null);
  mockFormula._set(null);
  mockRecipes._set([MEAL, CHICKEN]);
});

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

function renderPage(id = MEAL_ID) {
  return render(RecipeViewPage, { props: { params: { id } } });
}

async function openNewMenu(): Promise<void> {
  await fireEvent.click(screen.getByTestId('meal-component-new-btn'));
}

describe('RecipeViewPage — adding a dish to a meal', () => {
  it('offers the four ways in, and only on a meal', async () => {
    renderPage();
    await openNewMenu();

    for (const testid of [
      'meal-component-new-import',
      'meal-component-new-import-photo',
      'meal-component-new-chat',
      'meal-component-new-manual',
    ]) {
      expect(await screen.findByTestId(testid)).toBeInTheDocument();
    }
  });

  it('does not offer it on an ordinary recipe', () => {
    // This surface adds ANOTHER dish to something already built from dishes. A
    // recipe becomes a meal in the editor's picker, not here.
    mockRecipes._set([makeEntry(), CHICKEN]);
    renderPage();

    expect(screen.queryByTestId('meal-component-new-btn')).toBeNull();
  });

  it('opens the blank editor carrying the meal', async () => {
    renderPage();
    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-manual'));

    expect(push).toHaveBeenCalledWith(`/recipes/new?meal=${MEAL_ID}`);
  });

  it('opens chat carrying the meal', async () => {
    // /chat is a LIST — the session is a second hop — so the id has to survive
    // that hop too, which is exactly why it rides the URL.
    renderPage();
    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-chat'));

    expect(push).toHaveBeenCalledWith(`/chat?meal=${MEAL_ID}`);
  });

  it('imports a link and opens the new recipe’s editor carrying the meal', async () => {
    const imported = makeEntry({ id: 'imported-9', title: 'Onion gravy' });
    vi.mocked(importRecipeFromUrl).mockResolvedValue({ kind: 'ok', value: imported });
    renderPage();
    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-import'));

    // `fireEvent` for the typing: bits-ui focus traps inside a Dialog eat
    // `userEvent` keystrokes in these suites.
    const input = await screen.findByTestId('recipe-import-url-input');
    await fireEvent.input(input, { target: { value: 'https://example.com/gravy' } });
    await fireEvent.click(screen.getByTestId('recipe-import-url-btn'));

    // The callable has already persisted the recipe (issue #616), so this opens
    // THAT recipe's editor — with the meal on it.
    await waitFor(() => expect(stashImportedDraft).toHaveBeenCalledWith(imported));
    expect(push).toHaveBeenCalledWith(`/recipes/imported-9/edit?meal=${MEAL_ID}`);
  });

  it('opens the photo-capture dialog from the same menu', async () => {
    renderPage();
    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-import-photo'));

    // The capture flow itself is RecipeImportPhotoDialog's own suite; what this
    // page owns is the way in and the landing, and the landing is shared with
    // the URL path above.
    expect(await screen.findByTestId('recipe-import-photo-dialog')).toBeInTheDocument();
  });
});
