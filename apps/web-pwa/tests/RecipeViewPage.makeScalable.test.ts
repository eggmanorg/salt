import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// An entry point for a recipe's FIRST formula (issue #823, phase 01.5 of #778).
//
// Three menu states, and they are mutually exclusive by construction:
//   no formula + looks like it has a basis → "Make it scalable"
//   no formula + an ordinary dinner        → nothing (the menu as it was)
//   a formula                              → "Bake a batch" + "Formula" (#812)
//
// What is being pinned is the GATE, not the guess — the guess is the domain's own
// `looksScalable` and has its own unit tests. What this page owns is asking it
// with the right entries (canon name leading, the raw line behind it) and letting
// the answer decide whether the trip is offered at all.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockFormula,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
  mockBreadGate,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string; name: string }[]>([]),
    mockGuidedPlan: makeStore<unknown>(null),
    mockFormula: makeStore<unknown>(null),
    mockIsLoading: makeStore<boolean>(false),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockSessions: makeStore<readonly unknown[]>([]),
    mockEquipment: makeStore<{ items: readonly { name: string }[] } | null>({ items: [] }),
    mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
      enabled: true,
      settled: true,
    }),
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
// The bread gate (issue #831). Mocked rather than left to the real module because
// the real one reads uninitialised observability and therefore always says "on" —
// which is what keeps every OTHER bread suite passing untouched, and exactly why
// the gated case has to say so explicitly.
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({ defaultListId: mockDefaultListId }));
vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // The bake sheet subscribes to `batches` while it is open, for the kitchen
  // temperature prefill (issue #1286). This page opens that sheet.
  subscribeBatches: vi.fn(() => vi.fn()),
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
  importRecipeFromUrl: vi.fn(),
  urlImportMessage: vi.fn(() => 'nope'),
  isSignedOutFailure: vi.fn(() => false),
  stashPendingImportUrl: vi.fn(),
  importRecipeFromPhoto: vi.fn(),
  photoImportMessage: vi.fn(() => 'nope'),
}));

import { push } from 'svelte-spa-router';
import { initFormulaSync } from '../src/lib/formulaService.js';
import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';

const RECIPE_ID = 'loaf';

function ing(over: { id: string; rawText: string; canonId?: string | null }) {
  return {
    id: over.id,
    rawText: over.rawText,
    parsed: null,
    canonId: over.canonId ?? null,
    matchState: 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function makeEntry(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Overnight white tin loaf',
    description: null,
    ingredients: [],
    steps: [{ id: 'step-1', text: 'Mix.', note: null, timer: null }],
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

function withIngredients(items: ReturnType<typeof ing>[], overrides: Partial<Recipe> = {}): Recipe {
  return makeEntry({
    ...overrides,
    ingredients: [{ id: 'group-1', name: null, items }],
  } as Partial<Recipe>);
}

// The loaf as it reads before canon has resolved anything: the line itself says
// "flour", which is why the item is there on first paint in practice.
const LOAF = withIngredients([
  ing({ id: 'ing-flour', rawText: '500 g strong white bread flour' }),
  ing({ id: 'ing-water', rawText: '350 g water' }),
  ing({ id: 'ing-salt', rawText: '10 g salt' }),
]);

// A loaf whose flour reads as flour ONLY through canon — the case the derivation
// warns can appear a beat late.
const CANON_ONLY_LOAF = withIngredients([
  ing({ id: 'ing-flour', rawText: '500 g type 55', canonId: 'canon-flour' }),
  ing({ id: 'ing-water', rawText: '350 g water', canonId: 'canon-water' }),
]);

const CURRY = withIngredients([
  ing({ id: 'ing-chicken', rawText: '600 g chicken thighs' }),
  ing({ id: 'ing-onion', rawText: '2 onions, sliced' }),
  ing({ id: 'ing-cream', rawText: '100 ml double cream' }),
]);

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockGuidedPlan._set(null);
  mockFormula._set(null);
  mockRecipes._set([LOAF]);
  mockBreadGate._set({ enabled: true, settled: true });
});

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

async function openOverflow(id = RECIPE_ID): Promise<void> {
  render(RecipeViewPage, { props: { params: { id } } });
  await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
}

describe('RecipeViewPage — an entry point for the first formula', () => {
  it('offers "Make it scalable" on a loaf that has no formula', async () => {
    await openOverflow();

    expect(await screen.findByTestId('recipe-make-scalable-menu-item')).toHaveTextContent(
      'Make it scalable',
    );
  });

  it('lands on that recipe’s formula screen', async () => {
    // The screen #806 already shipped, unchanged: it makes its own basis guess on
    // arrival, which is the same one that put this item on the menu.
    await openOverflow();
    await fireEvent.click(await screen.findByTestId('recipe-make-scalable-menu-item'));

    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/formula`);
  });

  it('offers nothing extra on an ordinary dinner', async () => {
    // The whole point of gating: baker's percentages stay off the weeknight curry.
    mockRecipes._set([CURRY]);
    await openOverflow();

    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-formula-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-bake-batch-menu-item')).toBeNull();
  });

  it('reads the canon name, not just the line', async () => {
    // Canon LEADS in the guess, so a line that says nothing about flour still
    // offers the trip once its canon item has landed.
    mockRecipes._set([CANON_ONLY_LOAF]);
    mockCanonItems._set([
      { id: 'canon-flour', name: 'strong white flour' },
      { id: 'canon-water', name: 'water' },
    ]);
    await openOverflow();

    expect(await screen.findByTestId('recipe-make-scalable-menu-item')).toBeInTheDocument();
  });

  it('gives way to "Bake a batch" and "Formula" once a formula exists', async () => {
    // Mutually exclusive by construction — the first-formula item does not linger
    // beside the two it exists to lead to.
    mockFormula._set({ recipeId: RECIPE_ID, components: [] });
    await openOverflow();

    expect(await screen.findByTestId('recipe-bake-batch-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-formula-menu-item')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
  });

  it('offers none of the three when bread is gated, and reads no formula at all', async () => {
    // Issue #831. Bread is still being built, so for anyone outside the test group
    // the recipe's ⋮ is the menu it was before #812 — not a greyed-out entry, not a
    // "coming soon", just absent. The subscription is gated too: a person who can
    // never open a formula has no reason to spend a listener reading `formulas/*`.
    mockBreadGate._set({ enabled: false, settled: true });
    mockFormula._set({ recipeId: RECIPE_ID, components: [] });
    await openOverflow();

    expect(screen.queryByTestId('recipe-bake-batch-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-formula-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
    expect(initFormulaSync).not.toHaveBeenCalled();
  });

  it('never offers it on an entry with no ingredients', async () => {
    // An outing has none by definition, so the guess is empty and the gate is shut
    // without anything here asking what `kind` it is.
    mockRecipes._set([makeEntry({ kind: 'outing', title: 'Chippy', steps: [] })]);
    await openOverflow();

    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
  });
});
