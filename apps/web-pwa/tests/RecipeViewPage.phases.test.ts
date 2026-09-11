import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Recipe, RecipePhase } from '@salt/domain';

// The planning timeline on the recipe page (issue #1122). What these pin is the
// two states of `metadata.phases` and the swap the timeline paid for: Prep / Cook
// / Total are gone from this page for everyone, with no flag and no fallback
// (issue #1213), and so is the #878 ribbon that used to sit beside the strip.
//
// The width arithmetic is NOT here — it is `tests/phaseTimeline.test.ts`, against
// the pure module, where a cap can be asserted in numbers instead of in pixels.
//
// The mock preamble is the one every RecipeViewPage suite carries.

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

const PHASES = [
  { label: 'Mix & knead', handsOnMinutes: 15, handsOffMinutes: 0 },
  { label: 'First rise', handsOnMinutes: 0, handsOffMinutes: 90 },
  { label: 'Bake', handsOnMinutes: 2, handsOffMinutes: 35 },
];

// The viewed recipe is the MEAL, with one dish under it, so the "Made from" row's
// time can be read. `RECIPE_ID` is what the page opens.
function meal(component: Recipe): readonly Recipe[] {
  return [makeRecipe({ title: 'Sunday Roast', componentRecipeIds: [component.id] }), component];
}

function dish(over: Partial<Recipe['metadata']>): Recipe {
  return makeRecipe({
    id: 'dish-1',
    title: 'Roast Potatoes',
    metadata: { ...makeRecipe().metadata, ...over },
  });
}

function withThreeFields(phases: RecipePhase[] | undefined): Recipe {
  return makeRecipe({
    metadata: {
      ...makeRecipe().metadata,
      servings: 4,
      ...(phases === undefined ? {} : { phases, timingSummary: null }),
    },
  });
}

function withPhases(): Recipe {
  return makeRecipe({
    metadata: {
      ...makeRecipe().metadata,
      phases: PHASES,
      timingSummary: 'About 17 minutes of you, spread over 2½ hours.',
    },
  });
}

describe('RecipeViewPage — the phase strip', () => {
  it('lists each phase with its elapsed, hands-on and hands-off minutes', () => {
    mockRecipes._set([withPhases()]);
    const { getByTestId } = renderPage();

    const strip = getByTestId('recipe-phases').textContent ?? '';
    expect(strip).toContain('Mix & knead');
    expect(strip).toContain('First rise');
    expect(strip).toContain('Bake');
    // Elapsed is derived here and stored nowhere: 2 + 35.
    expect(strip).toContain('37 min');
    // And the totals line, which is the same sum over the whole strip.
    expect(strip).toContain('2 hr 22 min');
    expect(strip).toContain('17 min');
  });

  it('shows the one-line summary above the strip', () => {
    mockRecipes._set([withPhases()]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-timing-summary').textContent?.trim()).toBe(
      'About 17 minutes of you, spread over 2½ hours.',
    );
  });

  it('draws a block per phase and a legend row per phase', () => {
    mockRecipes._set([withPhases()]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-phase-timeline-bar').children).toHaveLength(PHASES.length);
    expect(getByTestId('recipe-phase-legend').children).toHaveLength(PHASES.length);
    // The bar is decoration and says so; the legend carries the whole of it.
    expect(getByTestId('recipe-phase-timeline-bar').getAttribute('aria-hidden')).toBe('true');
  });

  // The compression is the one thing a reader cannot recover from the numbers, so
  // it is stated in words beside the block it is true of. The 90-minute rise is
  // over the cap; nothing else here is.
  it('says in words which block was drawn shortened', () => {
    mockRecipes._set([withPhases()]);
    const { getAllByTestId, getByTestId } = renderPage();

    expect(getAllByTestId('recipe-phase-shortened')).toHaveLength(1);
    expect(getByTestId('recipe-phase-totals').textContent).toContain('not drawn to scale');
  });

  it('says nothing about scale when no wait was shortened', () => {
    mockRecipes._set([
      makeRecipe({
        metadata: {
          ...makeRecipe().metadata,
          phases: [{ label: 'Fry', handsOnMinutes: 12, handsOffMinutes: 8 }],
          timingSummary: null,
        },
      }),
    ]);
    const { queryByTestId, getByTestId } = renderPage();

    expect(queryByTestId('recipe-phase-shortened')).toBeNull();
    expect(getByTestId('recipe-phase-totals').textContent).not.toContain('not drawn to scale');
  });

  // The swap the timeline pays for (#1122's whole complaint is two accounts of the
  // same fact side by side). Nothing replaces the chips: the timeline states its
  // own total a few lines below, and a chip repeating it is the same defect again.
  it('drops the Prep / Cook / Total chips when the recipe has a strip', () => {
    mockRecipes._set([withThreeFields(PHASES)]);
    const { getByTestId, container } = renderPage();

    expect(getByTestId('recipe-phases')).toBeTruthy();
    expect(container.textContent).not.toContain('Prep 15 min');
    expect(container.textContent).not.toContain('Cook 30 min');
    expect(container.textContent).not.toContain('Total 45 min');
    // Serves is not a duration and is untouched by any of this.
    expect(container.textContent).toContain('Serves 4');
  });

  // The fallback is GONE, not merely unreached (issue #1213). A recipe that still
  // carries all three stored numbers and no strip shows none of them — which is
  // what makes "no screen shows a prep, cook or total time" checkable rather than
  // a claim about which fixtures happen to exist.
  it('shows no Prep / Cook / Total chip even for a recipe with no strip at all', () => {
    mockRecipes._set([withThreeFields(undefined)]);
    const { container, queryByTestId } = renderPage();

    expect(container.textContent).not.toContain('Prep 15 min');
    expect(container.textContent).not.toContain('Cook 30 min');
    expect(container.textContent).not.toContain('Total 45 min');
    expect(queryByTestId('recipe-phases')).toBeNull();
    expect(container.textContent).toContain('Serves 4');
  });

  // The migration case, and the reason `phases` is optional on the schema: a
  // recipe written before #1122 has no key at all and must read as it always did.
  it('renders nothing for a recipe with no phases stored, key on', () => {
    mockRecipes._set([makeRecipe()]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-phases')).toBeNull();
  });

  // The "Made from" row (issue #752) reads the same rule as everything else: the
  // phase sum when the dish has a strip, and nothing at all when it has none.
  it("shows a component's phase sum on the Made from row", () => {
    mockRecipes._set(meal(dish({ phases: PHASES, timingSummary: null })));
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-component-cook-time').textContent).toContain('2 hr 22 min');
  });

  // Issue #1213 removed the fallback and #1211 the field it fell back to: a dish
  // with no strip has no timing to show, so the row is absent entirely.
  it('shows no time on the Made from row when the component has no strip', () => {
    mockRecipes._set(meal(dish({})));
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-component-cook-time')).toBeNull();
  });

  it('renders nothing for a recipe whose stored strip is empty', () => {
    mockRecipes._set([
      makeRecipe({ metadata: { ...makeRecipe().metadata, phases: [], timingSummary: null } }),
    ]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-phases')).toBeNull();
  });

  // The #878 ribbon is DELETED, not suppressed (issue #1213). `cookShape` returned
  // non-null for any recipe with a timed step — the whole bread library this
  // feature targets — so while both existed the timeline's "X start to finish · Y
  // hands-on" sentence and the ribbon's identical sentence, built from different
  // numbers, printed as consecutive paragraphs. This fixture is the one with a
  // timed step and NO strip: the case the ribbon's own suppression condition let
  // through, so if the ribbon ever came back this is where it would show.
  const timedStep = {
    id: 'step-1',
    text: 'Cover and prove overnight',
    timer: { durationMinutes: 720, description: 'Prove' },
    note: null,
  };

  it('draws no #878 ribbon, for a recipe with a timed step and no strip', () => {
    mockRecipes._set([makeRecipe({ steps: [timedStep] })]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-cook-shape')).toBeNull();
  });

  it('draws no #878 ribbon beside a strip either', () => {
    mockRecipes._set([
      makeRecipe({
        steps: [timedStep],
        metadata: { ...makeRecipe().metadata, phases: PHASES, timingSummary: null },
      }),
    ]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('recipe-phase-totals').textContent).toContain('start to finish');
    expect(queryByTestId('recipe-cook-shape')).toBeNull();
  });
});
