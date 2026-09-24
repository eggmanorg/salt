import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyRecipe, newStep } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { EnrichmentFailureDoc } from '@salt/domain/schemas';

// The Equipment tab's third state (issue #1419, Phase 1).
//
// Until this existed a recipe whose kit inference GAVE UP was byte-for-byte a
// recipe nobody had ever asked — `kit: []`, no tab — so the page showed two tabs
// and quietly said "this dish needs no equipment" about a dish it had simply
// failed to read. Four production recipes sat like that for up to twelve days
// (#1418), and nothing on screen could have told anyone.
//
// Three properties, each stated as the failure it prevents:
//
//   1. A RECORDED FAILURE IS VISIBLE, and distinct from "needs nothing". Revert
//      the tab gate to `kit.length > 0 || editing` and the first case goes red:
//      the page is back to saying something untrue.
//   2. THE RETRY IS WHERE THE MISSING THING IS. The Redo kit action already
//      existed, three taps deep in an overflow menu nobody had reason to open.
//   3. SALT RECORDS, NEVER POLICES. A record is information, never permission:
//      cooking, planning, shopping and editing are exactly as they are on a
//      recipe with a full kit list, and no dialog appears. Make the marker gate
//      ANY of them and the last case goes red.
//
// The failure records arrive through the REAL `enrichmentFailureService` and the
// real `subscribeEnrichmentFailures` seam, not a stubbed store — so what is
// proved here is the read path the running app uses.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockFormula,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
  mockEquipmentIcons,
  failureSink,
  mockRedoRecipeKit,
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
    mockEquipment: makeStore<{ items: readonly { id: string; name: string }[] } | null>({
      items: [],
    }),
    mockEquipmentIcons: makeStore<Map<string, { thumbnail: string | null }>>(new Map()),
    // The one seam the failure records arrive through, exactly as the kit suite
    // does for the tool vocabulary.
    failureSink: {
      push: null as null | ((f: Map<string, EnrichmentFailureDoc>) => void),
    },
    mockRedoRecipeKit: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: { querystring: '' } }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' } },
}));
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
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  subscribeKitchenTools: vi.fn(() => () => {}),
  subscribeEnrichmentFailures: vi.fn(
    (onFailures: (f: Map<string, EnrichmentFailureDoc>) => void) => {
      failureSink.push = onFailures;
      return () => {};
    },
  ),
}));
vi.mock('../src/lib/chatService.js', () => ({
  consumeSaveIntent: vi.fn().mockResolvedValue(false),
  sessions: mockSessions,
  createChatSession: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  equipmentIcons: mockEquipmentIcons,
  setBorrowedPictureFor: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/clipboardImage.js', () => ({
  clipboardImageReadSupported: () => false,
  readClipboardImage: vi.fn(),
  imageFromClipboardData: vi.fn(),
}));

vi.mock('../src/lib/recipeService.js', () => ({
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
  redoRecipeKit: mockRedoRecipeKit,
  reviseRecipeSceneBrief: vi.fn(),
  startOverRecipeSceneBrief: vi.fn(),
  setRecipeImageUpload: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  buildRecipeAddPlan: vi.fn().mockReturnValue([]),
  buildMadeSubRows: vi.fn().mockReturnValue([]),
  commitRecipeAddPlan: vi.fn(),
  recipeAddPlanItemCount: vi.fn().mockReturnValue(0),
}));

import {
  initEnrichmentFailureSync,
  __resetEnrichmentFailureServiceForTest,
} from '../src/lib/enrichmentFailureService.js';
import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';

const RECIPE_ID = 'r-bacon';

const NOW = '2026-09-05T00:00:00.000Z';

/** The real builder (UT-C2), so the fixture cannot drift from the entity. */
function baconRecipe(overrides: Partial<Recipe> = {}): Recipe {
  const base = emptyRecipe(RECIPE_ID, NOW);
  return {
    ...base,
    title: 'Home-Cured Streaky Bacon',
    steps: [newStep('step-1', 'Rub the cure into the belly.')],
    metadata: { ...base.metadata, servings: 4 },
    updatedAt: NOW,
    ...overrides,
  };
}

/** Deliver the recorded failures, through the subscription the app really uses. */
function setFailures(...ids: string[]): void {
  failureSink.push?.(
    new Map(
      ids.map((id) => [
        id,
        {
          enrichment: 'recipeKit',
          subjectId: RECIPE_ID,
          subjectLabel: 'Home-Cured Streaky Bacon',
          reason: 'timeout',
          failedAt: 1_757_030_400_000,
        } satisfies EnrichmentFailureDoc,
      ]),
    ),
  );
}

afterEach(() => {
  cleanup();
  __resetEnrichmentFailureServiceForTest();
  failureSink.push = null;
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockGuidedPlan._set(null);
  mockFormula._set(null);
  mockEquipment._set({ items: [] });
  mockEquipmentIcons._set(new Map());
  mockRecipes._set([baconRecipe()]);
  // App.svelte subscribes once; this is that subscription.
  initEnrichmentFailureSync();
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('a recipe whose kit inference gave up says so', () => {
  it('shows the Equipment tab with plain words, where an unasked recipe shows none', async () => {
    renderPage();
    // Before the record lands: indistinguishable from "needs nothing", which is
    // exactly the state this issue is about — and still the correct render for a
    // recipe that genuinely has no kit.
    expect(screen.queryByTestId('recipe-kit-failed')).toBeNull();
    expect(screen.queryByRole('tab', { name: /Equipment/ })).toBeNull();

    setFailures(`recipeKit_${RECIPE_ID}`);

    await waitFor(() => {
      expect(screen.getByTestId('recipe-kit-failed')).toBeTruthy();
    });
    expect(screen.getByTestId('recipe-kit-failed').textContent).toContain("Couldn't work this out");
  });

  it('is scoped to the recipe it names — another recipe’s failure changes nothing', async () => {
    renderPage();
    failureSink.push?.(
      new Map([
        [
          'recipeKit_some-other-recipe',
          {
            enrichment: 'recipeKit',
            subjectId: 'some-other-recipe',
            subjectLabel: 'Something else',
            reason: 'timeout',
            failedAt: 1,
          } satisfies EnrichmentFailureDoc,
        ],
      ]),
    );
    await Promise.resolve();
    expect(screen.queryByTestId('recipe-kit-failed')).toBeNull();
  });

  it('offers Redo kit where the missing list would have been', async () => {
    renderPage();
    setFailures(`recipeKit_${RECIPE_ID}`);
    const redo = await screen.findByTestId('recipe-kit-failed-redo');

    await fireEvent.click(redo);
    expect(mockRedoRecipeKit).toHaveBeenCalledWith(RECIPE_ID);
  });

  it('clears the moment the record goes, with no reload', async () => {
    renderPage();
    setFailures(`recipeKit_${RECIPE_ID}`);
    await screen.findByTestId('recipe-kit-failed');

    // The trigger deleted the row on its next success; the subscription delivers
    // the emptied collection.
    failureSink.push?.(new Map());
    await waitFor(() => {
      expect(screen.queryByTestId('recipe-kit-failed')).toBeNull();
    });
  });
});

describe('Salt records, never polices', () => {
  // THE PIN for the binding constraint. A recorded failure is a note on the
  // fridge, never a locked door: it must not gate cooking, planning, shopping or
  // editing, and it must not raise a confirmation of any kind.
  it('gates nothing and confirms nothing', async () => {
    renderPage();
    setFailures(`recipeKit_${RECIPE_ID}`);
    await screen.findByTestId('recipe-kit-failed');

    for (const id of [
      'recipe-cook-button',
      'recipe-add-to-planner-button',
      'recipe-add-to-list-button',
      'recipe-edit-mode-button',
    ]) {
      const el = screen.getByTestId(id) as HTMLButtonElement;
      expect(el.disabled, `${id} must not be disabled by a recorded failure`).toBe(false);
      expect(el.getAttribute('aria-disabled')).not.toBe('true');
    }

    // No dialog of any kind was raised by the record landing.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
