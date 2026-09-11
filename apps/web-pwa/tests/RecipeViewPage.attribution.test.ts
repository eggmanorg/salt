import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// The "Added by … · edited by …" chip (issue #845). Audit only — it says who did
// what and gates nothing, so every test here is about what the chip READS.
//
// The fixture is deliberately bare: no description, no times, no tags, no
// "makes" link. Two nested `{#if}`s decide whether the meta Card and the chip row
// render at all, and a recipe like this one is what catches a chip that was added
// to only one of them.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
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

const RECIPE_ID = 'recipe-1';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    kit: [],
    producesCanonId: null,
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Bare Recipe',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
    ...overrides,
  };
}

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
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — attribution chip', () => {
  it('reads "Added by X" when the creator is the only one to have touched it', () => {
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel', lastEditedBy: 'Daniel' })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-attribution-chip').textContent).toBe('Added by Daniel');
  });

  it('names the editor too once somebody else has saved it', () => {
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel', lastEditedBy: 'Kate' })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-attribution-chip').textContent).toBe(
      'Added by Daniel · edited by Kate',
    );
  });

  it('says nothing about editing when only the creator is on record', () => {
    mockRecipes._set([makeRecipe({ createdBy: 'Daniel' })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-attribution-chip').textContent).toBe('Added by Daniel');
  });

  // "everyone is a Pendery": a household shares a surname, so the chip reads the
  // first name only. The split is at RENDER — the document still holds the
  // verbatim `Member.name`, which is what the list's "Added by me" `===` needs.
  it('reads the first name only, on both halves', () => {
    mockRecipes._set([makeRecipe({ createdBy: 'Kate Pendery', lastEditedBy: 'Daniel Pendery' })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-attribution-chip').textContent).toBe(
      'Added by Kate · edited by Daniel',
    );
  });

  // The comparison that decides whether the second half appears stays on the
  // FULL stored names. Truncate it and these two — a real possibility on any
  // roster — would read as one person who never edited anything.
  it('still names both when two people share a first name', () => {
    mockRecipes._set([makeRecipe({ createdBy: 'Kate Pendery', lastEditedBy: 'Kate Ashworth' })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-attribution-chip').textContent).toBe(
      'Added by Kate · edited by Kate',
    );
  });

  // Every recipe in the library predates the field. They render exactly as
  // before, chip and all its scaffolding absent — not "Added by nobody".
  it('shows no chip at all on a recipe with no attribution on record', () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('recipe-view')).toBeTruthy();
    expect(queryByTestId('recipe-attribution-chip')).toBeNull();
  });

  // An editor but no creator cannot happen through any write path — `createdBy`
  // is filled on the same save that fills `lastEditedBy` — but a hand-edited
  // document should not produce a chip that starts "Added by ".
  it('shows no chip when only lastEditedBy is set', () => {
    mockRecipes._set([makeRecipe({ lastEditedBy: 'Kate' })]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-attribution-chip')).toBeNull();
  });
});
