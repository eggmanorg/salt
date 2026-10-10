import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// An entry point for a recipe's FIRST formula (issue #823, re-gated by #1646).
//
// Three menu states, and they are mutually exclusive by construction:
//   no formula + a Bread or Cured meat label → "Make it scalable"
//   no formula + any other label             → nothing (the menu as it was)
//   a formula, whatever the label            → "Bake a batch" + "Formula" (#812)
//
// What is being pinned is the GATE, not the table — which kinds are offered a
// formula is the domain's `offersFormula` and has its own unit tests. What this
// page owns is asking it of the recipe's label, and letting presence win.

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
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // The bake sheet subscribes to `batches` while it is open, for the kitchen
  // temperature prefill (issue #1286). This page opens that sheet.
  subscribeBatches: vi.fn(() => vi.fn()),
}));
vi.mock('../src/lib/chatService.js', () => ({
  // Issue #1480: the recipe page and the full chat page read the save request
  // the chef recorded. Never fires here — no fixture carries one — but the
  // whole-module mock has to carry every export the page names.
  consumeSaveIntent: vi.fn().mockResolvedValue(false),
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
    cureCategory: null,
    fermentCategory: null,
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

const LOAF_ITEMS = [
  ing({ id: 'ing-flour', rawText: '500 g strong white bread flour' }),
  ing({ id: 'ing-water', rawText: '350 g water' }),
  ing({ id: 'ing-salt', rawText: '10 g salt' }),
];

const LOAF = withIngredients(LOAF_ITEMS, { kind: 'bread' });

const COPPA = withIngredients(
  [
    ing({ id: 'ing-neck', rawText: '2.4 kg pork neck' }),
    ing({ id: 'ing-salt', rawText: '60 g salt' }),
  ],
  { kind: 'cure', title: 'Coppa' },
);

const KRAUT = withIngredients(
  [
    ing({ id: 'ing-cabbage', rawText: '1 kg white cabbage' }),
    ing({ id: 'ing-salt', rawText: '20 g salt' }),
  ],
  { kind: 'ferment', title: 'Sauerkraut' },
);

// Says "flour" on every line it can — exactly what the retired keyword guess
// offered the door to. A plain recipe label now keeps it off.
const WAFFLES = withIngredients(
  [
    ing({ id: 'ing-flour', rawText: '250 g plain flour' }),
    ing({ id: 'ing-milk', rawText: '400 ml milk' }),
  ],
  { title: 'Waffles' },
);

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
  it('offers "Make it scalable" on a bread that has no formula', async () => {
    await openOverflow();

    expect(await screen.findByTestId('recipe-make-scalable-menu-item')).toHaveTextContent(
      'Make it scalable',
    );
  });

  it('offers it on a cured meat that has no formula', async () => {
    // The case the flour guess could never reach: nothing in a coppa says flour.
    mockRecipes._set([COPPA]);
    await openOverflow();

    expect(await screen.findByTestId('recipe-make-scalable-menu-item')).toBeInTheDocument();
  });

  it('offers it on a ferment that has no formula (#1656)', async () => {
    // The label decides: you weigh the cabbage, so the door opens from the basis.
    mockRecipes._set([KRAUT]);
    await openOverflow();

    expect(await screen.findByTestId('recipe-make-scalable-menu-item')).toBeInTheDocument();
  });

  it('lands on that recipe’s formula screen', async () => {
    await openOverflow();
    await fireEvent.click(await screen.findByTestId('recipe-make-scalable-menu-item'));

    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/formula`);
  });

  it('offers nothing extra on a plain recipe, even one that says flour', async () => {
    // The noise #1646 removed: waffles, cakes and gravy no longer see the door.
    mockRecipes._set([WAFFLES]);
    await openOverflow();

    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-formula-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-bake-batch-menu-item')).toBeNull();
  });

  it('offers nothing extra on an ordinary dinner', async () => {
    mockRecipes._set([CURRY]);
    await openOverflow();

    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
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

  it('keeps "Bake a batch" and "Formula" on a plain recipe that has a formula', async () => {
    // Presence wins over the label: a loaf relabelled plain Recipe, or one nobody
    // has labelled yet (East Midlands Crusty Cobs in production), keeps its doors.
    mockRecipes._set([withIngredients(LOAF_ITEMS, { kind: 'recipe' })]);
    mockFormula._set({ recipeId: RECIPE_ID, components: [] });
    await openOverflow();

    expect(await screen.findByTestId('recipe-bake-batch-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-formula-menu-item')).toBeInTheDocument();
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

  it('never offers it on a special', async () => {
    mockRecipes._set([makeEntry({ kind: 'special', title: 'Chippy', steps: [] })]);
    await openOverflow();

    expect(screen.queryByTestId('recipe-make-scalable-menu-item')).toBeNull();
  });
});
