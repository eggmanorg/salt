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
  queueRecipeEdit: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  flushRecipeWrites: vi.fn().mockResolvedValue(undefined),
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

  it('carries the number into the cook', async () => {
    // Tap Cook on a recipe scaled to six and the mise list and the per-step amounts
    // are the six-serving ones. The scale rides the same `?serves=` the recipe page
    // is reading.
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-cook-button'));

    expect(vi.mocked(push)).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook?serves=6`);
  });

  it('leaves the Cook link exactly as it was when nothing is scaled', async () => {
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-cook-button'));

    expect(vi.mocked(push)).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);
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

// ─── Entering edit mode clears the active scale (issue #1324, Daniel's call) ──
//
// "When editing you should never be working with the scaled recipe — it should
// revert to the normal saved recipe." There are TWO halves and both are needed,
// but only ONE test below is sensitive to the render half specifically — stated
// exactly, not rounded up, per CLAUDE.md rule 12 (issue #1324 review, should-fix
// 3, correcting an earlier claim of two in the PR body and the Phase 4 handoff
// comment):
//
//   the URL   — pressing Edit pushes `/recipes/:id` with no `serves` param,
//               through the same call the Reset button already makes. Pinned by
//               `cleans the ?serves= out of the URL when Edit is pressed` and
//               `pushes nothing when there was no scale to clear`, below — both
//               assert on `push` and never read `scaling` at all.
//   the pin   — `scaling.active` is held at `scaling.base` while `editing`, so a
//               `?serves=` arriving any other way (the back button landing on the
//               entry the push just created, a hand-typed URL) cannot re-create
//               the state this decision forbids. The mocked router keeps its
//               `?serves=6` throughout these, which is exactly that case. Only
//               `puts the amounts and the scaled line back to as written, router
//               or no router` is sensitive to THIS clause: removing it is what
//               turns that one test red. `shows the stored count as a box you
//               can type in` reaches the edit branch through `{#if editing}`,
//               which short-circuits before `scaling` is read at all, so it
//               proves nothing about the pin either way.
//
// The "amounts scaled" line and the ingredient amounts are NOT edited to achieve
// any of this — they follow `isScaled` on their own, which is why they are what
// these assert on.
//
// A third, separate route closes the SAME URL back out again once `editing`
// goes false and the pin above no longer applies — `leaves the scale cleared
// after Done`, at the foot of this block, pins that one on its own.
describe('RecipeViewPage — editing is never a scaled view', () => {
  it('cleans the ?serves= out of the URL when Edit is pressed', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    expect(vi.mocked(push)).toHaveBeenCalledWith('/recipes/recipe-1');
  });

  it('pushes nothing when there was no scale to clear', async () => {
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });

  it('puts the amounts and the scaled line back to as written, router or no router', async () => {
    // The router still says `serves=6` after the push — jsdom has no real
    // history and the mock never changes. That is the point: this is the PIN,
    // and removing the `editing` clause from `scaling` turns it red.
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    expect(amountsText()).toContain('300g');
    expect(amountsText()).not.toContain('450g');
    expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
  });

  // Issue #1319's Phase 5 outcome, in its own words: "what you type into a line
  // is what is stored — there is no state where the box shows one number and the
  // list shows another." It is the SAME pin as the case above, asserted where the
  // ingredients panel can actually be held to it: the list must read as written
  // AND the line's own box must hold the stored `rawText`, at the same moment,
  // with the router still saying `serves=6`. Nothing here hand-clears that
  // querystring (standing requirement 4), and removing the `editing` clause from
  // the `scaling` derivation turns it red — the list goes to 450g while the box
  // goes on holding "300g strong white flour".
  it('never lets the box and the list disagree about the amount', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));
    await userEvent.click(screen.getAllByTestId('recipe-edit-ingredient')[0]!);

    // The stored line, which is the only thing an edit can write.
    expect((screen.getByTestId('recipe-edit-ingredient-field') as HTMLInputElement).value).toBe(
      '300g strong white flour',
    );
    // And the rest of the list beside it, at the same moment, as written.
    expect(amountsText()).toContain('3');
    expect(amountsText()).not.toContain('4½');
    expect(screen.queryByTestId('recipe-scaled-notice')).toBeNull();
  });

  // The other half of the gesture collision, pinned through the page because the
  // mode is the page's: in read mode the line is the inspector's button, and the
  // moment Edit is pressed it is not a control at all.
  it('takes the line’s own tap away in edit mode and gives it back on Done', async () => {
    mockRecipes._set([servesFour()]);
    renderPage();

    expect(screen.queryAllByTestId('recipe-view-ingredient-inspect')).toHaveLength(2);

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));
    expect(screen.queryByTestId('recipe-view-ingredient-inspect')).toBeNull();
    expect(screen.queryAllByTestId('recipe-view-ingredient-text')).toHaveLength(2);

    await userEvent.click(screen.getByTestId('recipe-done-button'));
    await waitFor(() =>
      expect(screen.queryAllByTestId('recipe-view-ingredient-inspect')).toHaveLength(2),
    );
  });

  it('shows the stored count as a box you can type in, not the scale picker', async () => {
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    expect(screen.queryByTestId('recipe-servings-chip')).toBeNull();
    await userEvent.click(screen.getByTestId('recipe-edit-servings'));
    expect((screen.getByTestId('recipe-servings-input') as HTMLInputElement).value).toBe('4');
  });

  // ASSUMPTION, and Daniel has not ruled on it (#1324 Decisions): leaving edit
  // mode leaves the scale CLEARED. Done does not resurrect the number you had
  // been reading at. If he rules the other way, this test is the one line that
  // changes.
  it('leaves the scale cleared after Done, rather than resurrecting it', async () => {
    // `push` is mocked and never actually rewrites `router.querystring`, so
    // leaving it untouched from here on IS the back button: it is exactly the
    // shape of landing on the history entry `startEditing`'s own push created —
    // `editing` stays true across that (#1326's id-keyed reset effect), the URL
    // still reads `serves=6`, and nothing in this test hand-clears it to
    // manufacture the state under test (issue #1324 review, should-fix 1 — the
    // previous version of this test zeroed `mockRouter.querystring` by hand
    // right before Done, which reached the assertions through a fixture rather
    // than through the route a back button actually takes).
    mockRouter.querystring = 'serves=6';
    mockRecipes._set([servesFour()]);
    renderPage();

    await userEvent.click(screen.getByTestId('recipe-edit-mode-button'));
    vi.mocked(push).mockClear();

    await userEvent.click(screen.getByTestId('recipe-done-button'));

    // Done has to make the exact same clearing call Edit does, closing the same
    // route on the way out that `startEditing` closes on the way in. Without it
    // `finishEditing` pushes nothing at all here — the router is left at
    // `serves=6` and the number the reviewer flagged rides back in on it.
    expect(vi.mocked(push)).toHaveBeenCalledWith('/recipes/recipe-1');
  });
});
