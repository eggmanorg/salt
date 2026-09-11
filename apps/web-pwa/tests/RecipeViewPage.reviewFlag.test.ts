import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe, Step } from '@salt/domain';

// Unreviewed-import banner (issue #616). A URL-imported recipe is persisted by
// the callable with needs_approval set — raw AI output nobody has read. The
// recipe is fully live regardless; the banner only says so, and "Mark reviewed"
// clears it in place for an import that needs no edits.

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
// The guided-plan store (issue #751). `null` is its LOADED-AND-EMPTY state — the
// one that keeps the "Cook, guided" half of the Cook button off a recipe nobody
// has written a plan for. `undefined` (not loaded) would keep it off too, so a
// suite that never sets this proves nothing about the button; the ranking suite
// sets it deliberately.
vi.mock('../src/lib/guidedPlanService.js', () => ({
  guidedPlan: mockGuidedPlan,
  initGuidedPlanSync: vi.fn(() => () => {}),
  discardGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
// #812: the page subscribes to the recipe's formula to decide whether to offer
// "Bake a batch" and a link to the formula screen. `null` is loaded-and-there-is-
// none, which is what every recipe in this file is — so neither entry appears and
// nothing else on the page changes.
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
}));

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { persistRecipe, queueRecipeEdit, flushRecipeWrites } from '../src/lib/recipeService.js';
import { discardGuidedPlan } from '../src/lib/guidedPlanService.js';
import { addToast } from '../src/lib/toastStore.js';

const RECIPE_ID = 'recipe-1';

// Shared by the blank-row suite and the exit-from-edit-mode suite below — one
// step with real words, so a freshly `Add step`-ed second row is the only
// thing either suite's assertions can be about.
const WITH_A_STEP = { steps: [{ id: 'step-1', text: 'Mix the dough', note: null, timer: null }] };

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    producesCanonId: null,
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Imported Carbonara',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: { type: 'url', url: 'https://example.com/carbonara' },
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

describe('RecipeViewPage — unreviewed import', () => {
  it('shows the banner on a recipe flagged needs_approval', () => {
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-unreviewed-banner')).toBeTruthy();
  });

  it('shows nothing on a reviewed recipe', () => {
    mockRecipes._set([makeRecipe()]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-unreviewed-banner')).toBeNull();
  });

  it('renders the recipe normally — the flag never gates use', () => {
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    const { getByTestId } = renderPage();

    // Cook is the proof: an unreviewed recipe is fully usable, not a draft.
    expect(getByTestId('recipe-view')).toBeTruthy();
    expect(getByTestId('recipe-cook-button')).toBeTruthy();
  });

  it('drops the flag entirely when marked reviewed (absent, not false)', async () => {
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-mark-reviewed-button'));

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(persistRecipe).mock.calls[0]![0];
    expect('needs_approval' in saved).toBe(false);
    // The rest of the recipe rides along untouched — persistRecipe writes the
    // whole document.
    expect(saved.id).toBe(RECIPE_ID);
    expect(saved.title).toBe('Imported Carbonara');
  });

  // Done is the deliberate act that says "I have read this" (issue #1319), and it
  // routes through the very same `handleMarkReviewed` the banner's own button
  // uses — a fourth clearing site is what this deliberately is not.
  it('clears the flag when edit mode is left, not when a field is changed', async () => {
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    // Mid-edit the recipe is still flagged: reading it is not the same as having
    // read it, and a keystroke must not mark it checked.
    expect(queryByTestId('recipe-unreviewed-banner')).toBeTruthy();
    expect(persistRecipe).not.toHaveBeenCalled();

    await fireEvent.click(getByTestId('recipe-done-button'));

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    expect('needs_approval' in vi.mocked(persistRecipe).mock.calls[0]![0]).toBe(false);
  });

  it('writes nothing on Done when the recipe was never flagged', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-done-button'));

    await waitFor(() => expect(flushRecipeWrites).toHaveBeenCalled());
    expect(persistRecipe).not.toHaveBeenCalled();
  });

  it('surfaces a failed write instead of silently leaving it flagged', async () => {
    vi.mocked(persistRecipe).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    } as never);
    mockRecipes._set([makeRecipe({ needs_approval: true })]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-mark-reviewed-button'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'destructive'));
  });
});

// The mode itself (issue #1319). "Nothing is tappable by accident" is a promise
// about READ mode, so it is asserted there rather than inferred from the
// presence of a boolean.
describe('RecipeViewPage — edit mode', () => {
  it('offers Edit but nothing editable until it is pressed', () => {
    mockRecipes._set([makeRecipe({ notes: 'Use guanciale' })]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('recipe-edit-mode-button')).toBeTruthy();
    expect(queryByTestId('recipe-done-button')).toBeNull();
    expect(queryByTestId('recipe-edit-title')).toBeNull();
    expect(queryByTestId('recipe-edit-notes')).toBeNull();
  });

  // Issue #1324 review, finding 1: `/recipes/:id` is one route, so a "Made
  // from" tap on a dish card reuses THIS component instance and only moves
  // `params.id` — simulated here by re-rendering with a different id, exactly
  // what svelte-spa-router does. Left open, edit mode (and the draft still
  // holding the old recipe's text) would carry onto the new document, and one
  // keystroke there writes recipe A's title onto recipe B.
  it('leaves edit mode and drops the draft when the route moves to a different recipe', async () => {
    const recipeA = makeRecipe({ id: RECIPE_ID, title: 'Carbonara' });
    const recipeB = makeRecipe({ id: 'recipe-2', title: 'Ragu' });
    mockRecipes._set([recipeA, recipeB]);
    const { getByTestId, queryByTestId, rerender } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), {
      target: { value: "Carbonara, A's unsaved edit" },
    });

    await rerender({ params: { id: 'recipe-2' } });

    // Neither edit mode nor the open title editor (still showing A's unsaved
    // text) may have followed the navigation onto B.
    expect(queryByTestId('recipe-title-input')).toBeNull();
    expect(queryByTestId('recipe-done-button')).toBeNull();
    expect(getByTestId('recipe-edit-mode-button')).toBeTruthy();

    // Opening the title editor on B for real must show B's own title, not a
    // leftover draft from A.
    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    expect((getByTestId('recipe-title-input') as HTMLInputElement).value).toBe('Ragu');
  });

  // Round 2 of the #1324 review: svelte-spa-router rebuilds `componentParams`
  // from a fresh `match()` object on every hashchange, INCLUDING a
  // querystring-only one — `setServings`'s own
  // `push('/recipes/<same id>?serves=N')` is exactly this shape. The page must
  // not mistake that for a navigation to a different recipe and drop the
  // editor out from under someone mid-edit.
  it('stays in edit mode across a rerender that carries the same id (a querystring-only navigation)', async () => {
    mockRecipes._set([makeRecipe({ title: 'Carbonara' })]);
    const { getByTestId, queryByTestId, rerender } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    expect(getByTestId('recipe-done-button')).toBeTruthy();

    // A fresh `params` object, but the SAME id — the shape `setServings` and
    // the scaled notice's Reset button push.
    await rerender({ params: { id: RECIPE_ID } });

    expect(getByTestId('recipe-done-button')).toBeTruthy();
    expect(queryByTestId('recipe-edit-mode-button')).toBeNull();
  });

  // The action row is at its budget at every width (#735), so Done REPLACES the
  // cluster rather than joining it: while you are editing, Cook, Shop and Plan
  // are not what you are doing.
  it('replaces the whole action cluster with Done while editing', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));

    expect(getByTestId('recipe-done-button')).toBeTruthy();
    for (const id of [
      'recipe-cook-button',
      'recipe-add-to-list-button',
      'recipe-add-to-planner-button',
      'recipe-actions-overflow',
      'recipe-edit-mode-button',
    ]) {
      expect(queryByTestId(id)).toBeNull();
    }
  });

  it('puts the pencils away again on Done', async () => {
    mockRecipes._set([makeRecipe({ notes: 'Use guanciale' })]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    expect(getByTestId('recipe-edit-notes')).toBeTruthy();

    await fireEvent.click(getByTestId('recipe-done-button'));

    await waitFor(() => expect(queryByTestId('recipe-edit-notes')).toBeNull());
    expect(getByTestId('recipe-cook-button')).toBeTruthy();
  });

  it('renames the recipe from its own heading', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'Carbonara' } });

    const written = vi.mocked(queueRecipeEdit).mock.calls.at(-1)![0];
    expect(written.title).toBe('Carbonara');
  });

  // A recipe must have a name, so an emptied box is not written — and it is not
  // an error either, because you are mid-word. The box keeps what you typed and
  // the document keeps its last real name until you finish.
  it('does not write an emptied title, and does not complain about it', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: '   ' } });

    expect(queueRecipeEdit).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it.each([{ key: 'Enter' }, { key: 'Escape' }])(
    'finishes with the heading on $key, keeping what was typed',
    async ({ key }) => {
      mockRecipes._set([makeRecipe()]);
      const { getByTestId, queryByTestId } = renderPage();

      await fireEvent.click(getByTestId('recipe-edit-mode-button'));
      await fireEvent.click(getByTestId('recipe-edit-title'));
      await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'Cacio' } });
      await fireEvent.keyDown(getByTestId('recipe-title-input'), { key });

      expect(queryByTestId('recipe-title-input')).toBeNull();
      expect(vi.mocked(queueRecipeEdit).mock.calls.at(-1)![0].title).toBe('Cacio');
    },
  );

  it('ignores a keystroke that is neither of those', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.keyDown(getByTestId('recipe-title-input'), { key: 'a' });

    expect(getByTestId('recipe-title-input')).toBeTruthy();
  });

  it('closes the heading when it loses focus', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.blur(getByTestId('recipe-title-input'));

    expect(queryByTestId('recipe-title-input')).toBeNull();
  });

  it('says nothing at all when the write succeeds', async () => {
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'Cacio' } });

    await waitFor(() => expect(queueRecipeEdit).toHaveBeenCalled());
    expect(addToast).not.toHaveBeenCalled();
  });

  // The pin for "a burst of keystrokes raises at most one toast". The coalescer
  // hands every edit in one window the SAME promise
  // (`recipeService.coalescedEdit.test.ts` pins that), and this is the half that
  // turns that identity into a single message: without the comparison, three
  // keystrokes against one failed write would shout three times.
  it('says a failed write once per coalesced burst, not once per keystroke', async () => {
    const failed = Promise.resolve({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    vi.mocked(queueRecipeEdit).mockReturnValue(failed as never);
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    const input = getByTestId('recipe-title-input');
    for (const value of ['Carbonar', 'Carbonara', 'Carbonara!']) {
      await fireEvent.input(input, { target: { value } });
    }

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(vi.mocked(queueRecipeEdit).mock.calls.length).toBe(3);
    expect(vi.mocked(addToast).mock.calls.length).toBe(1);
  });

  // The boundary of that claim, stated because the sentence above is not "one
  // toast per edit session": a SECOND failed burst is a second toast, and should
  // be — by then the first message has been and gone, and silence would read as
  // a write that worked.
  it('says it again for a second failed burst', async () => {
    vi.mocked(queueRecipeEdit).mockReturnValue(
      Promise.resolve({
        kind: 'err',
        error: { kind: 'StorageError', reason: 'unavailable' },
      }) as never,
    );
    mockRecipes._set([makeRecipe()]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'Carbonar' } });
    await waitFor(() => expect(vi.mocked(addToast).mock.calls.length).toBe(1));

    // A fresh window means a fresh promise, which is a burst the page has not
    // spoken about yet.
    vi.mocked(queueRecipeEdit).mockReturnValue(
      Promise.resolve({
        kind: 'err',
        error: { kind: 'StorageError', reason: 'unavailable' },
      }) as never,
    );
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'Carbonara' } });

    await waitFor(() => expect(vi.mocked(addToast).mock.calls.length).toBe(2));
  });
});

// ─── The blank row you never typed into (issue #1319, Phase 4) ─────────────────
// A row added and left empty is KEPT while you are editing — pruning on a
// keystroke would delete it out from under you — and dropped when you press Done,
// which is already the one deliberate boundary in the flow. The rule itself is
// `blankRows.ts`; what is pinned here is the FLOW, which is why every case below
// presses `Add step` in the UI rather than planting a blank step in a fixture
// (standing requirement 4 — a fixture-planted row pins the filter, not Done).
//
// These cases live in this file rather than in one of their own because Done's
// obligations are already pinned here, and because a second RecipeViewPage suite
// would breach UT-B1 on its twelve mocked seams for no new coverage.
//
// For the flow to mean anything, `queueRecipeEdit` has to behave like the real one
// in the single respect it depends on: it applies to the store SYNCHRONOUSLY, so
// the page's `recipe` — and therefore what Done prunes — carries the row the cook
// just added. A mock that resolves and writes nothing would make every case below
// pass with the prune deleted.
describe('RecipeViewPage — the blank row you never typed into', () => {
  beforeEach(() => {
    vi.mocked(queueRecipeEdit).mockImplementation((next: Recipe) => {
      mockRecipes._set([next]);
      return Promise.resolve({ kind: 'ok', value: undefined });
    });
  });

  /** The steps as the last write composed them. */
  function writtenSteps(): readonly Step[] {
    return vi.mocked(queueRecipeEdit).mock.calls.at(-1)![0].steps;
  }

  async function startEditing(): Promise<void> {
    renderPage();
    await fireEvent.click(screen.getByTestId('recipe-edit-mode-button'));
  }

  async function pressDone(): Promise<void> {
    await fireEvent.click(screen.getByTestId('recipe-done-button'));
    await waitFor(() => expect(screen.queryByTestId('recipe-done-button')).toBeNull());
  }

  it('keeps a freshly added step while you are still editing', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();

    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));

    expect(writtenSteps()).toHaveLength(2);
    expect(screen.getAllByTestId('recipe-view-step')).toHaveLength(2);
  });

  it('drops it on Done — the step the test itself added, not one a fixture planted', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();
    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));
    expect(writtenSteps()).toHaveLength(2);

    await pressDone();

    expect(writtenSteps().map((s) => s.text)).toEqual(['Mix the dough']);
  });

  it('keeps the step once it has words in it', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();
    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));
    await fireEvent.click(screen.getAllByTestId('recipe-edit-step')[1]!);
    await fireEvent.input(screen.getByTestId('recipe-edit-step-field'), {
      target: { value: 'Shape the loaf' },
    });

    await pressDone();

    expect(writtenSteps().map((s) => s.text)).toEqual(['Mix the dough', 'Shape the loaf']);
  });

  it('keeps a wordless step that carries a note — somebody wrote that deliberately', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();
    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));
    await fireEvent.click(screen.getAllByTestId('recipe-edit-step-note')[1]!);
    await fireEvent.input(screen.getByTestId('recipe-edit-step-note-field'), {
      target: { value: 'Ask Nan about the hydration' },
    });

    await pressDone();

    expect(writtenSteps()).toHaveLength(2);
    expect(writtenSteps()[1]!.text).toBe('');
  });

  it('writes nothing at all on Done when there is no blank row to drop', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();

    await pressDone();

    expect(queueRecipeEdit).not.toHaveBeenCalled();
  });

  // #1336 review, blocking 3: the same argument that keeps a wordless step
  // carrying a note applies to one carrying a timer — a cook set that
  // deliberately too, and dropping it would lose it just as silently.
  it('keeps a wordless step that carries a timer — a cook set that deliberately', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();
    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));
    await fireEvent.click(screen.getAllByTestId('recipe-edit-step-timer')[1]!);
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '30' },
    });
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-label'), {
      target: { value: 'rest' },
    });

    await pressDone();

    expect(writtenSteps()).toHaveLength(2);
    expect(writtenSteps()[1]!.timer).toEqual({ durationMinutes: 30, description: 'rest' });
  });

  // #1336 review, should-fix 4, adjudicated up because it is coupled to
  // blocking 3: once a timer protects a step from the prune, a persisted
  // 0-minute timer would keep a wordless step alive too. `RecipeMethodRail`'s
  // own collapse-to-null is what keeps that from ever reaching this page.
  it('drops a wordless step whose + Timer was typed into and abandoned', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    await startEditing();
    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));
    await fireEvent.click(screen.getAllByTestId('recipe-edit-step-timer')[1]!);
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '5' },
    });
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '' },
    });

    await pressDone();

    // No timer ever really existed by the time Done ran, and the step has no
    // words and no note either — the phantom "0 min" chip this used to leave
    // behind never gets the chance to render.
    expect(writtenSteps()).toHaveLength(1);
  });
});

// ─── The prune's other two doors (issue #1336 review, blocking 2) ──────────────
// Done is not the only way edit mode ends. A route change to a different
// recipe (the id-keyed `$effect`) and the page unmounting outright
// (`onDestroy`) both used to leave a blank step behind for good — the exact
// outcome #1319 rejected "never pruning" to prevent. These need a store that
// holds MORE THAN ONE recipe, and a `queueRecipeEdit` mock that updates only
// the one being written rather than replacing the whole array (the blank-row
// suite's own mock does the latter, which would silently delete the other
// fixture recipe on the very first edit).
describe('RecipeViewPage — the blank-row prune reaches every exit from edit mode', () => {
  beforeEach(() => {
    vi.mocked(queueRecipeEdit).mockImplementation((next: Recipe) => {
      mockRecipes._set(mockRecipes._get().map((r) => (r.id === next.id ? next : r)));
      return Promise.resolve({ kind: 'ok', value: undefined });
    });
  });

  function stepsOf(id: string): readonly Step[] {
    return mockRecipes._get().find((r) => r.id === id)!.steps;
  }

  it('drops a blank step when the route moves to a different recipe while editing (a "Made from" tap)', async () => {
    const other = makeRecipe({ id: 'recipe-2', title: 'Other' });
    mockRecipes._set([makeRecipe(WITH_A_STEP), other]);
    const { getByTestId, rerender } = render(RecipeViewPage, {
      props: { params: { id: RECIPE_ID } },
    });

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-step-add'));
    expect(stepsOf(RECIPE_ID)).toHaveLength(2);

    await rerender({ params: { id: 'recipe-2' } });

    expect(stepsOf(RECIPE_ID).map((s) => s.text)).toEqual(['Mix the dough']);
  });

  it('does nothing when the recipe left behind is already gone from the store (e.g. deleted elsewhere)', async () => {
    const other = makeRecipe({ id: 'recipe-2', title: 'Other' });
    mockRecipes._set([makeRecipe(WITH_A_STEP), other]);
    const { getByTestId, rerender } = render(RecipeViewPage, {
      props: { params: { id: RECIPE_ID } },
    });

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-step-add'));
    expect(stepsOf(RECIPE_ID)).toHaveLength(2);

    vi.mocked(queueRecipeEdit).mockClear();
    mockRecipes._set([other]);

    await rerender({ params: { id: 'recipe-2' } });

    expect(queueRecipeEdit).not.toHaveBeenCalled();
  });

  it('drops a blank step when the page unmounts entirely while still editing (Back, a nav tap, or New → Manual)', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    const { getByTestId, unmount } = render(RecipeViewPage, {
      props: { params: { id: RECIPE_ID } },
    });

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-step-add'));
    expect(stepsOf(RECIPE_ID)).toHaveLength(2);

    unmount();

    expect(stepsOf(RECIPE_ID).map((s) => s.text)).toEqual(['Mix the dough']);
  });
});

// ─── An in-place reword discards a stale guided-plan note (#1336 review,
// should-fix 6) ──────────────────────────────────────────────────────────────
// `applyRecipeAmendment` (recipeAmend.ts, untouched by this campaign) already
// enforces this rule for the chat path: a step that is gone, or present but
// reworded, invalidates any guided-plan note pinned to it. The rail is the
// other door a step's text can change through, and `handleInlineEdit` is
// where every inline write — the rail's included — already comes through, so
// that is where the same check now lives.
describe('RecipeViewPage — an in-place reword discards a stale guided-plan note', () => {
  // Explicit rather than relying on whatever a sibling describe's own
  // `beforeEach` last left `queueRecipeEdit` doing: this suite only needs the
  // write to resolve ok, never a store that reflects it.
  beforeEach(() => {
    vi.mocked(queueRecipeEdit).mockResolvedValue({ kind: 'ok', value: undefined });
  });

  it('discards the guided plan when a step is reworded in place', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-step'));
    await fireEvent.input(getByTestId('recipe-edit-step-field'), {
      target: { value: 'Mix the dough thoroughly' },
    });

    await waitFor(() => expect(discardGuidedPlan).toHaveBeenCalledWith(RECIPE_ID));
  });

  it('leaves the guided plan alone when an edit does not touch any step (e.g. the title)', async () => {
    mockRecipes._set([makeRecipe(WITH_A_STEP)]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-edit-mode-button'));
    await fireEvent.click(getByTestId('recipe-edit-title'));
    await fireEvent.input(getByTestId('recipe-title-input'), { target: { value: 'New Title' } });

    await waitFor(() => expect(queueRecipeEdit).toHaveBeenCalled());
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });
});
