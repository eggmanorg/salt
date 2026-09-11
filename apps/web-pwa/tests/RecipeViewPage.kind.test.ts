import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// What an outing's page does NOT offer (issue #637). "Things that don't apply
// simply aren't offered": no Cook, no Shop, no Ingredients card, no Method card,
// no Serves/Prep/Cook/Total.
//
// It also carries the action RANKING (Cook / Shop / Plan filled and inline;
// Chat / Optimise / Duplicate / Edit / Delete in the ⋮ menu, which since #735 is
// their ONLY surface at any width), since what an entry offers and how loudly it
// offers it are the same markup. jsdom applies no media queries, so a width-gated
// second markup site would be visible to these assertions — which is what makes
// "the demoted five have no inline site" a real assertion rather than a hopeful one.
//
// The hero and the regenerate dialog are deliberately NOT gated: an outing's
// picture is the whole point of the entry, so this file also pins that they
// survive.

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
    // Non-null so the equipment-gated "Optimise" button is offered on its own
    // terms — otherwise its absence would prove nothing.
    mockEquipment: makeStore<{ items: readonly { name: string }[] } | null>({
      items: [{ name: 'Sage Pizzaiolo' }],
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
// `uid` as well as `email`: "Make a variation" opens a chat session, which is
// owner-scoped, so the handler returns early without one.
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' } },
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
// The guided-plan store (issue #751). `null` is its LOADED-AND-EMPTY state — the
// one that keeps the "Cook, guided" half of the Cook button off a recipe nobody
// has written a plan for. `undefined` (not loaded) would keep it off too, so a
// suite that never sets this proves nothing about the button; the ranking suite
// sets it deliberately.
vi.mock('../src/lib/guidedPlanService.js', () => ({
  guidedPlan: mockGuidedPlan,
  initGuidedPlanSync: vi.fn(() => () => {}),
}));
// The formula store (issue #812). `null` is its LOADED-AND-EMPTY state, which is
// what nearly every recipe in Salt is, and it keeps both bread-scaling entries out
// of the ⋮ menu. Settable here — unlike the other suites, this file is where the
// presence gate itself is proved, so it has to be able to put a formula on a
// recipe without changing the recipe's `kind`.
vi.mock('../src/lib/formulaService.js', () => ({
  formula: mockFormula,
  initFormulaSync: vi.fn(() => () => {}),
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

import { push } from 'svelte-spa-router';
import { createChatSession } from '../src/lib/chatService.js';
import { persistRecipe, stashImportedDraft } from '../src/lib/recipeService.js';
import { addToast } from '../src/lib/toastStore.js';
import { clearEditOnArrival, takeEditOnArrival } from '../src/routes/recipes/editOnArrival.js';
import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';

const RECIPE_ID = 'entry-1';

function makeEntry(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    producesCanonId: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Test Recipe',
    description: 'A short description.',
    ingredients: [
      {
        id: 'group-1',
        name: null,
        items: [
          {
            id: 'ing-1',
            rawText: '2 eggs',
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ],
    steps: [{ id: 'step-1', text: 'Do the thing.', note: null, timer: null }],
    metadata: {
      servings: 4,
      tags: ['weeknight'],
    },
    source: null,
    notes: null,
    componentRecipeIds: [],
    kit: [],
    image: { url: 'https://example.com/hero.webp', source: 'ai' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// An outing carries no ingredients, no steps and no timings — but the metadata
// fields are set here anyway, so an assertion that the chips are absent proves
// the CAPABILITY gate rather than merely an empty document.
function makeOuting(): Recipe {
  return makeEntry({
    kind: 'outing',
    title: 'Takeaway — Indian',
    description: 'Curry from the place on the corner.',
    ingredients: [],
    steps: [],
  });
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
  // Loaded, and there is no plan — the default a recipe has until someone writes
  // one. Reset per test so a suite that sets a plan cannot leak it into the next.
  mockGuidedPlan._set(null);
  // Same three-state store, same reason (issue #812): loaded, and there is no
  // formula. Nearly every recipe in Salt is this.
  mockFormula._set(null);
  // Module state, so it has to be cleared explicitly or a duplicate in one test
  // leaves the next page opening in edit mode (issue #1319 Phase 7).
  clearEditOnArrival();
});

const RECIPE_UPDATED_AT = '2026-08-01T09:00:00.000Z';

/** A guided plan for this recipe, as the store would hold it. */
function makePlan(over: Record<string, unknown> = {}) {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtSave: RECIPE_UPDATED_AT,
    prep: [],
    stepNotes: [],
    createdAt: RECIPE_UPDATED_AT,
    updatedAt: RECIPE_UPDATED_AT,
    ...over,
  };
}

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

// The ⋮ menu's contents only exist in the DOM once it is open (bits-ui renders
// PopoverContent lazily), so it has to be opened before it can be asserted on.
// DELETE is the unconditional item, which makes it the reliable signal that the
// menu is actually mounted — an assertion about what is MISSING would otherwise
// pass against a menu that never opened. It used to be Edit; issue #1319 Phase 7
// removed that item, because editing is the icon button in the action row, on the
// page it edits. Since #735 this menu is the ONLY surface the demoted actions
// have, at any width.
async function openOverflowMenu(): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
  await waitFor(() => expect(screen.getByTestId('recipe-delete-menu-item')).toBeInTheDocument());
}

// The ⋮ menu read top to bottom: each item by its test id, each divider as
// 'separator'. Grouping is a fact about ORDER and ADJACENCY, which a
// getByTestId-per-item assertion cannot see — it would pass just as happily
// against the flat list this replaced, or against a menu whose dividers had
// drifted a row (issue #784).
function overflowMenuLayout(): string[] {
  const menu = screen.getByTestId('recipe-delete-menu-item').parentElement;
  expect(menu).not.toBeNull();
  return [...menu!.children].map((el) =>
    el.getAttribute('role') === 'separator'
      ? 'separator'
      : (el.getAttribute('data-testid') ?? el.tagName.toLowerCase()),
  );
}

describe('RecipeViewPage — a recipe keeps everything', () => {
  beforeEach(() => {
    mockRecipes._set([makeEntry()]);
  });

  it('offers Cook, Shop and Plan inline, with Chat and Optimise in the ⋮ menu', async () => {
    renderPage();

    expect(screen.getByTestId('recipe-cook-button')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-to-list-button')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-to-planner-button')).toBeInTheDocument();

    await openOverflowMenu();
    expect(screen.getByTestId('recipe-ask-amend-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-optimise-kitchen-menu-item')).toBeInTheDocument();
  });

  // The ranking, asserted as markup rather than trusted to the comment above it:
  // the three key actions are the only inline buttons, they are all filled, and
  // none of them is width-gated — so they are what the eye lands on at any width,
  // phone or desktop, and everything else is behind the ⋮ (#735).
  it('ranks Cook, Shop and Plan above the rest — the only inline actions, at every width', () => {
    renderPage();

    for (const id of [
      'recipe-cook-button',
      'recipe-add-to-list-button',
      'recipe-add-to-planner-button',
    ]) {
      const button = screen.getByTestId(id);
      expect(button).toHaveClass('salt-button--solid');
      expect(button.className).not.toContain('hidden');
    }

    // The demoted five have NO inline site left: one menu now serves every width,
    // so there is no second, divergent markup surface to keep in step.
    for (const id of [
      'recipe-ask-amend-button',
      'recipe-optimise-kitchen-button',
      'recipe-duplicate-button',
      'recipe-edit-button',
      'recipe-delete-button',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // And the trigger itself is never width-gated — Duplicate must be reachable
    // on a laptop, which is the whole reason the menu was promoted.
    expect(screen.getByTestId('recipe-actions-overflow').className).not.toContain('hidden');
  });

  // The second half of that ranking, one level down (#784): inside the ⋮ the
  // items are grouped by what they DO to the dish — work on it, make a second
  // one from it, manage the document — and the dividers are the only thing
  // saying so. Pinned as markup for the same reason the row above is: a comment
  // cannot fail.
  it('groups the ⋮ menu into work-on-it / make-something-new / manage, with dividers', async () => {
    renderPage();
    await openOverflowMenu();

    expect(overflowMenuLayout()).toEqual([
      'recipe-ask-amend-menu-item',
      'recipe-optimise-kitchen-menu-item',
      // Refresh sits beside Optimise (#784): both re-run a model over this dish
      // in place, and they are the two halves of the pair — Optimise reworks the
      // method around the kit, Refresh re-applies the writing rules.
      'recipe-refresh-menu-item',
      // "Redo kit" (#882) is the third of the same kind — re-run a model over this
      // dish in place — so it joins the pair rather than starting a group.
      'recipe-redo-kit-menu-item',
      'recipe-guided-plan-menu-item',
      'separator',
      'recipe-make-variation-menu-item',
      'recipe-duplicate-menu-item',
      'separator',
      'recipe-delete-menu-item',
    ]);
  });

  // ─── "Cook, guided" (issue #751, Phase 2) ────────────────────────────────────
  // The second half of the Cook control. Everything about it is conditional on
  // there being a plan to be guided by, and nothing about it moves the other
  // three: the row still reads Cook · Shop · Plan · ⋮.

  it('offers no guided cook on a recipe with no plan', () => {
    renderPage();
    expect(screen.getByTestId('recipe-cook-button')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-cook-guided-button')).toBeNull();
  });

  it('offers no guided cook while the plan store has not resolved', () => {
    // `undefined`, not `null`. The conservative side, same as `showCooking`: a
    // button that appears and then vanishes is worse than one that arrives late.
    mockGuidedPlan._set(undefined);
    renderPage();
    expect(screen.queryByTestId('recipe-cook-guided-button')).toBeNull();
  });

  it('adds a guided half to the Cook button when the recipe has a plan', async () => {
    mockGuidedPlan._set(makePlan());
    renderPage();

    const guided = screen.getByTestId('recipe-cook-guided-button');
    // Inline and filled, like the Cook it belongs to — it is the same act.
    expect(guided).toHaveClass('salt-button--solid');
    expect(guided.className).not.toContain('hidden');
    expect(guided).toHaveAccessibleName('Cook, guided');
    // Reviewed plans carry no flag at all.
    expect(screen.queryByTestId('recipe-cook-guided-unreviewed-dot')).toBeNull();
    // The plan EDITOR stays in the ⋮ menu — writing a plan is not cooking.
    await openOverflowMenu();
    expect(screen.getByTestId('recipe-guided-plan-menu-item')).toBeInTheDocument();
  });

  it('goes to the guided cook route, not the plain one', async () => {
    mockGuidedPlan._set(makePlan());
    renderPage();

    await fireEvent.click(screen.getByTestId('recipe-cook-guided-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);
  });

  it('flags an unread plan without gating anything', async () => {
    mockGuidedPlan._set(makePlan({ needs_approval: true }));
    renderPage();

    const guided = screen.getByTestId('recipe-cook-guided-button');
    expect(screen.getByTestId('recipe-cook-guided-unreviewed-dot')).toBeInTheDocument();
    // Used-but-flagged: the words are in the accessible name, and the button is
    // as pressable as ever.
    expect(guided).toHaveAccessibleName(/not checked yet/i);
    expect(guided).not.toBeDisabled();
    await fireEvent.click(guided);
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);
  });

  it('leaves the plain Cook button exactly where it was', async () => {
    mockGuidedPlan._set(makePlan());
    renderPage();

    await fireEvent.click(screen.getByTestId('recipe-cook-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);
  });

  // Serves is the whole of the cooking fact row now. Prep / Cook / Total were
  // retired by issue #1213 and the phase timeline states the timing instead; this
  // fixture stores all three and must show none of them.
  it('shows the Ingredients and Method cards and the Serves chip', () => {
    renderPage();

    expect(screen.getByText('Ingredients')).toBeInTheDocument();
    expect(screen.getByText('Method')).toBeInTheDocument();
    expect(screen.getByText('Serves 4')).toBeInTheDocument();
    expect(screen.queryByText('Prep 10 min')).toBeNull();
    expect(screen.queryByText('Cook 20 min')).toBeNull();
    expect(screen.queryByText('Total 30 min')).toBeNull();
  });
});

describe('RecipeViewPage — an outing offers only what applies', () => {
  beforeEach(() => {
    mockRecipes._set([makeOuting()]);
  });

  it('offers no Cook and no Shop', () => {
    renderPage();

    expect(screen.queryByTestId('recipe-cook-button')).toBeNull();
    expect(screen.queryByTestId('recipe-add-to-list-button')).toBeNull();
  });

  it('offers no guided cook even if a plan somehow exists — capability wins', () => {
    // A plan for an outing should never be written, but the gate must not depend
    // on that: guided cook rides on `isCookable`, exactly as Cook does.
    mockGuidedPlan._set(makePlan());
    renderPage();

    expect(screen.queryByTestId('recipe-cook-guided-button')).toBeNull();
  });

  it('offers no Chat and no Optimise', async () => {
    renderPage();

    // Opened first, so the absences below are real and not just an unmounted menu.
    await openOverflowMenu();
    expect(screen.queryByTestId('recipe-ask-amend-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-optimise-kitchen-menu-item')).toBeNull();
  });

  it('drops the Ingredients and Method cards outright, not just their contents', () => {
    renderPage();

    expect(screen.queryByText('Ingredients')).toBeNull();
    expect(screen.queryByText('Method')).toBeNull();
    // The inner guards would have rendered these if only the contents were gated.
    expect(screen.queryByText('No ingredients.')).toBeNull();
    expect(screen.queryByText('No steps.')).toBeNull();
  });

  it('drops the Serves chip', () => {
    renderPage();

    expect(screen.queryByText('Serves 4')).toBeNull();
  });

  it('keeps Duplicate and Delete, so the ⋮ menu never opens onto nothing', async () => {
    renderPage();

    expect(screen.getByTestId('recipe-actions-overflow')).toBeInTheDocument();

    await openOverflowMenu();
    // Unconditional for every kind: what an entry IS never decides whether it can
    // be copied or deleted. Edit left this menu in issue #1319 Phase 7 — it is the
    // icon button in the action row, on the page it edits — so these two are what
    // keep the menu from opening onto nothing.
    expect(screen.getByTestId('recipe-duplicate-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-delete-menu-item')).toBeInTheDocument();
  });

  // An outing empties the ⋮ menu's whole first group, so the divider that would
  // have followed it must go too — otherwise the menu opens with a rule across
  // the top, separating nothing from everything (#784).
  it('opens with an item, not a divider, when the first group is empty', async () => {
    renderPage();
    await openOverflowMenu();

    expect(overflowMenuLayout()).toEqual([
      'recipe-duplicate-menu-item',
      'separator',
      'recipe-delete-menu-item',
    ]);
  });

  it('keeps the hero, its description and the Regenerate control', () => {
    renderPage();

    expect(screen.getByTestId('recipe-hero')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-image-regenerate')).toBeInTheDocument();
    expect(screen.getByText('Curry from the place on the corner.')).toBeInTheDocument();
  });

  it('keeps Plan — a night off is still a night that gets planned', () => {
    renderPage();

    // The outing's only key action, and it is inline: a phone showing a takeaway
    // gets one button and the ⋮, not an empty row.
    expect(screen.getByTestId('recipe-add-to-planner-button')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-to-planner-button').className).not.toContain('hidden');
  });
});

// "Plan" asks the same question the planner's own picker asks, so it answers with
// the same predicate — `isPlannable`, never the kind. A cocktail is cookable and
// shoppable but is not dinner, which makes it the case that pulls the two apart:
// everything else on the page stays, and only this goes.
describe('RecipeViewPage — a cocktail is not offered for a night', () => {
  beforeEach(() => {
    mockRecipes._set([makeEntry({ kind: 'cocktail', title: 'Negroni' })]);
  });

  it('offers no Plan, while keeping Cook and Shop', () => {
    renderPage();

    expect(screen.getByTestId('recipe-cook-button')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-to-list-button')).toBeInTheDocument();
    // Plan only ever renders inline, so this one absence covers every width.
    expect(screen.queryByTestId('recipe-add-to-planner-button')).toBeNull();
  });
});

// Duplicate (issue #735). The what-carries policy is `duplicateRecipe`'s and is
// pinned field-by-field in the domain suite; what belongs here is the wiring —
// that the action hands the copy to the EXISTING stash seam and routes to the
// blank-recipe editor, writing nothing.
describe('RecipeViewPage — duplicate', () => {
  async function duplicate(): Promise<void> {
    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('recipe-duplicate-menu-item'));
  }

  /** The copy as the one `persistRecipe` call composed it. */
  function copy(): Recipe {
    return vi.mocked(persistRecipe).mock.calls[0]![0];
  }

  // Issue #1319 Phase 7 changed this deliberately. #735 could promise "nothing is
  // written" because the copy was an unsaved draft the editor painted; with the
  // editor retired there is no surface in this app that edits a document which does
  // not exist, so Duplicate writes first and lands you on what it made, editing it.
  it('writes the copy and lands on it in edit mode', async () => {
    mockRecipes._set([makeEntry()]);
    renderPage();

    await duplicate();

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    expect(copy().title).toBe('Test Recipe (copy)');
    expect(copy().id).not.toBe(RECIPE_ID);
    expect(copy().steps).toEqual(makeEntry().steps);
    expect(push).toHaveBeenCalledWith(`/recipes/${copy().id}`);
    // Never the retired editor, and never the old bare create route.
    expect(push).not.toHaveBeenCalledWith('/recipes/new');
    // No stash: `persistRecipe` applies the copy to the store synchronously, so the
    // page it lands on already has the document. The stash is only for the imports,
    // whose write happened on the server.
    expect(stashImportedDraft).not.toHaveBeenCalled();
  });

  it('asks the page it lands on to open in edit mode', async () => {
    mockRecipes._set([makeEntry()]);
    renderPage();

    await duplicate();

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    // The request is what makes "lands on the duplicate's own page, EDITING it"
    // true rather than merely intended; consuming it here proves it was made for
    // this exact id.
    expect(takeEditOnArrival(copy().id)).toBe(true);
  });

  it('writes one copy however fast the item is pressed twice', async () => {
    // Without the busy guard a double tap is two documents, and the second is
    // indistinguishable from the first — there is no Save step left to catch it.
    let settle: (v: { kind: 'ok'; value: undefined }) => void = () => {};
    vi.mocked(persistRecipe).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    mockRecipes._set([makeEntry()]);
    renderPage();

    await duplicate();
    await duplicate();

    expect(persistRecipe).toHaveBeenCalledTimes(1);
    settle({ kind: 'ok', value: undefined });
  });

  it('goes nowhere and says so when the write fails (Rule 10)', async () => {
    vi.mocked(persistRecipe).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    mockRecipes._set([makeEntry()]);
    renderPage();

    await duplicate();

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'destructive'));
    expect(push).not.toHaveBeenCalledWith(expect.stringMatching(/^\/recipes\/(?!recipe-1$)/));
  });

  it.each(['recipe', 'outing', 'cocktail', 'placeholder'] as const)(
    'is offered for a %s, and the copy is the same kind',
    async (kind) => {
      mockRecipes._set([makeEntry({ kind })]);
      renderPage();

      await duplicate();

      await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
      expect(copy().kind).toBe(kind);
    },
  );
});

// "Make a variation" (issue #763). Gated on `isAuthorable` — "can the librarian
// WRITE this kind?" — and never on the kind itself. #765 is the proof that gate
// was the right one: the librarian learned to write cocktails, the `cocktail` row
// flipped in `capabilities.ts`, and this page inherited the change with no edit of
// its own. The per-kind case below is what would have gone red had it not.
describe('RecipeViewPage — make a variation', () => {
  beforeEach(() => {
    vi.mocked(createChatSession).mockResolvedValue({
      kind: 'ok',
      value: { id: 'session-9' },
    } as never);
  });

  it('opens a new chat that holds this dish as its base, and leaves for it', async () => {
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('recipe-make-variation-menu-item'));

    // A chat that STARTS FROM this recipe without BELONGING to it: `recipeId`
    // null, base id fourth. That is what keeps it off this page's chat list.
    await waitFor(() =>
      expect(createChatSession).toHaveBeenCalledWith('uid-1', null, 'Test Recipe', RECIPE_ID),
    );
    // Away to the chat, because the conversation is about a different dish.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/chat/session-9'));
    // Nothing is written to the recipe collection on the way out.
    expect(persistRecipe).not.toHaveBeenCalled();
  });

  it.each([
    ['recipe', true],
    ['cocktail', true],
    ['outing', false],
    ['placeholder', false],
  ] as const)('is offered for a %s: %s', async (kind, offered) => {
    mockRecipes._set([makeEntry({ kind })]);
    renderPage();

    await openOverflowMenu();

    if (offered) {
      expect(screen.getByTestId('recipe-make-variation-menu-item')).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId('recipe-make-variation-menu-item')).toBeNull();
    }
  });
});

// ─── Bread scaling: PRESENCE, not kind (issue #812, phase 1 of epic #778) ───────
//
// This suite lives in the kind file on purpose: the whole file is about what an
// entry offers and why, and these two entries are the one pair here that is NOT
// decided by the kind. There is no `bread` kind and there will not be one
// (docs/formulas-schedules-batches.md) — a loaf is an ordinary `recipe` — so what
// turns them on is the FORMULA DOCUMENT existing, and nothing else.
//
// The sharpest evidence is the pair below: the same recipe, the same `kind`, the
// store flipping from `null` to a formula, and the menu changing with it. If either
// entry were ever re-gated on the kind, the second test goes red while the first
// stays green.
describe('RecipeViewPage — bread scaling is gated on the formula, never the kind', () => {
  /** The overnight tin's formula, as the store would hold it. */
  function makeFormula() {
    return {
      recipeId: RECIPE_ID,
      schemaVersion: 1,
      components: [{ ingredientId: 'ing-1', percent: 100, inBasis: true }],
      referenceYield: {
        kind: 'target',
        shape: { count: 1, unitDoughGrams: 900 },
      },
    };
  }

  it('offers neither entry on a recipe with no formula', async () => {
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();

    expect(screen.queryByTestId('recipe-bake-batch-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-formula-menu-item')).toBeNull();
  });

  it('offers neither while the formula is still loading', async () => {
    // `undefined` is not-loaded, and it must read as "no" rather than as "yes": an
    // entry that appears and then vanishes is worse than one that arrives late.
    mockFormula._set(undefined);
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();

    expect(screen.queryByTestId('recipe-bake-batch-menu-item')).toBeNull();
    expect(screen.queryByTestId('recipe-formula-menu-item')).toBeNull();
  });

  it('offers both once the recipe has one, with the kind untouched', async () => {
    mockFormula._set(makeFormula());
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();

    expect(screen.getByTestId('recipe-bake-batch-menu-item')).toBeInTheDocument();
    // The formula screen shipped in #806 with no entry point anywhere. This is it.
    expect(screen.getByTestId('recipe-formula-menu-item')).toBeInTheDocument();
  });

  it('puts both in group one, after the guided plan and above the first divider', async () => {
    mockFormula._set(makeFormula());
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();

    // Adjacency, not mere presence: group one is "work on THIS dish", and starting a
    // run is desk work of the same kind as writing the guided plan — not a way of
    // producing a second recipe (group two) or of editing the document (group
    // three). Frequency orders the pair: the bake is weekly, the formula monthly.
    expect(overflowMenuLayout()).toEqual([
      'recipe-ask-amend-menu-item',
      'recipe-optimise-kitchen-menu-item',
      'recipe-refresh-menu-item',
      'recipe-redo-kit-menu-item',
      'recipe-guided-plan-menu-item',
      'recipe-bake-batch-menu-item',
      'recipe-formula-menu-item',
      'separator',
      'recipe-make-variation-menu-item',
      'recipe-duplicate-menu-item',
      'separator',
      'recipe-delete-menu-item',
    ]);
  });

  it('offers them on an entry no capability would allow, and keeps the divider honest', async () => {
    // An outing is neither cookable nor authorable, so group one is empty on one
    // today — and a divider with nothing above it is a rule across the top of the
    // menu. A formula is presence rather than a capability, so it can fill that
    // group on its own, which is exactly why the divider's gate had to learn about
    // it. (Nobody will write a formula for a takeaway; the point is that the gate
    // asks about the DOCUMENT, and the outing is the cleanest way to prove it.)
    mockFormula._set(makeFormula());
    mockRecipes._set([makeOuting()]);
    renderPage();

    await openOverflowMenu();

    expect(overflowMenuLayout()).toEqual([
      'recipe-bake-batch-menu-item',
      'recipe-formula-menu-item',
      'separator',
      'recipe-duplicate-menu-item',
      'separator',
      'recipe-delete-menu-item',
    ]);
  });

  it('sends the formula entry to the formula screen', async () => {
    mockFormula._set(makeFormula());
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('recipe-formula-menu-item'));

    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/formula`);
  });

  it('opens the scale sheet rather than navigating, and writes nothing', async () => {
    // The sheet is the one place a scaled number appears before a batch exists, and
    // it must not touch the recipe: closing it leaves the dish exactly as it was.
    mockFormula._set(makeFormula());
    mockRecipes._set([makeEntry()]);
    renderPage();

    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('recipe-bake-batch-menu-item'));

    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
    expect(persistRecipe).not.toHaveBeenCalled();
  });
});
