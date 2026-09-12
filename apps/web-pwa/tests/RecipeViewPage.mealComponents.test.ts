import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// Adding another dish to a meal (issue #752 Phase 3; issue #1319 Phase 7).
//
// The meal page grows the same ways in that the recipe list's New menu offers,
// which since #1319 Phase 6 is THREE and not four: a dish for a meal is a recipe
// like any other, and a recipe arrives by URL, by photo or by chat. Hand-authoring
// went with the editor, so "Manual" went with it here.
//
// WHERE THE ATTACH HAPPENS IS WHAT #1319 PHASE 7 MOVED, and it is the substance of
// this suite. The editor's SAVE used to be the trigger, reading the meal's id off
// `?meal=` — a querystring that had to survive every hop because the save was a
// whole navigation away. With no save left:
//
//   - the two IMPORTS attach at CREATION. Their callable has already persisted the
//     dish (#616), so it exists the moment the dialog hands it back; there is
//     nothing for the id to survive, and those two paths stop carrying `?meal=`.
//   - CHAT still carries it, because its dish does not exist until the
//     conversation produces one. `ChatSessionPage` owns that end and is untouched.
//
// The cases below are the relocated contract of `RecipeEditPage.mealReturn.test.ts`,
// rewritten against the surface that now owns it rather than deleted: the attach is
// made, it is idempotent, and a meal deleted meanwhile must not cost the user the
// dish they just imported.
//
// THE MENU IS GATED ON PRESENCE; THE CARD AROUND IT NO LONGER IS (issue #1343).
// Turning an ordinary recipe into a meal now DOES have a home on this page — the
// card mounts on capability in edit mode and offers a dashed `+ Dishes` slot — but
// this menu is deliberately not that door. Its three entries start a dish for a
// meal that already exists: two import over the network and the third navigates
// away, and the two import dialogs they open are mounted further down the page on
// the very same `showComponents` read.
//
// That is one predicate written in two files, which is what the last describe
// block below is for. What those cases pin is that the menu and the dialogs answer
// the same way about the same document in both modes; they do not — and no test
// can — prove the two expressions are textually the same, so a change to either
// gate has to be made against them.

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
  // The attach, which issue #1319 Phase 7 moved onto this page.
  attachComponentToMeal: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  stashImportedDraft: vi.fn(),
  takeImportedDraft: vi.fn().mockReturnValue(null),
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
import {
  attachComponentToMeal,
  importRecipeFromUrl,
  persistRecipe,
  stashImportedDraft,
} from '../src/lib/recipeService.js';
import { addToast } from '../src/lib/toastStore.js';

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
  vi.mocked(attachComponentToMeal).mockResolvedValue({ kind: 'ok', value: undefined });
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

function renderPage(id = MEAL_ID) {
  return render(RecipeViewPage, { props: { params: { id } } });
}

async function openNewMenu(): Promise<void> {
  await fireEvent.click(screen.getByTestId('meal-component-new-btn'));
}

/**
 * Drive the URL-import dialog to completion, the way a cook does.
 *
 * `fireEvent` for the typing: bits-ui focus traps inside a Dialog eat `userEvent`
 * keystrokes in these suites.
 */
async function importALink(): Promise<void> {
  await openNewMenu();
  await fireEvent.click(await screen.findByTestId('meal-component-new-import'));
  const input = await screen.findByTestId('recipe-import-url-input');
  await fireEvent.input(input, { target: { value: 'https://example.com/gravy' } });
  await fireEvent.click(screen.getByTestId('recipe-import-url-btn'));
}

describe('RecipeViewPage — adding a dish to a meal', () => {
  it('offers the three ways a recipe arrives, and only on a meal', async () => {
    renderPage();
    await openNewMenu();

    for (const testid of [
      'meal-component-new-import',
      'meal-component-new-import-photo',
      'meal-component-new-chat',
    ]) {
      expect(await screen.findByTestId(testid)).toBeInTheDocument();
    }
    // Hand-authoring is retired (issue #1319 Phase 6), here as everywhere else: a
    // typed dish would be the door the New menu closed, reopened on one screen.
    expect(screen.queryByTestId('meal-component-new-manual')).toBeNull();
  });

  it('does not offer it on an ordinary recipe', () => {
    // This surface adds ANOTHER dish to something already built from dishes. A
    // recipe becomes a meal through the card's own dashed slot and picker (issue
    // #1343), not through this menu.
    mockRecipes._set([makeEntry(), CHICKEN]);
    renderPage();

    expect(screen.queryByTestId('meal-component-new-btn')).toBeNull();
  });

  it('opens chat carrying the meal', async () => {
    // /chat is a LIST — the session is a second hop — so the id has to survive
    // that hop too, which is exactly why it rides the URL.
    renderPage();
    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-chat'));

    expect(push).toHaveBeenCalledWith(`/chat?meal=${MEAL_ID}`);
  });

  it('imports a link, attaches the dish as it lands, and opens the DISH', async () => {
    const imported = makeEntry({ id: 'imported-9', title: 'Onion gravy' });
    vi.mocked(importRecipeFromUrl).mockResolvedValue({ kind: 'ok', value: imported });
    renderPage();
    await importALink();

    // The attach is made HERE, not a navigation later off a querystring — which is
    // why the URL it pushes carries no `?meal=` at all.
    await waitFor(() => expect(attachComponentToMeal).toHaveBeenCalledWith(MEAL_ID, 'imported-9'));
    expect(push).toHaveBeenCalledWith('/recipes/imported-9');
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining('meal='));
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining('/edit'));
    // Still stashed: the document was written on the SERVER, so the page it lands
    // on may be ahead of the Firestore listener.
    expect(stashImportedDraft).toHaveBeenCalledWith(imported);
  });

  it('leaves the ordering and the duplicate rule to the domain', async () => {
    // "Adding the same dish twice attaches it once" is
    // `insertComponentByElapsedTime`'s answer inside `attachComponentToMeal`, so
    // this surface composes no `componentRecipeIds` of its own and writes the meal
    // through no other path. Asserted as the absence of a second write rather than
    // re-expressed here.
    const imported = makeEntry({ id: 'chicken', title: 'Roast chicken' });
    vi.mocked(importRecipeFromUrl).mockResolvedValue({ kind: 'ok', value: imported });
    renderPage();
    await importALink();

    await waitFor(() => expect(attachComponentToMeal).toHaveBeenCalledWith(MEAL_ID, 'chicken'));
    expect(attachComponentToMeal).toHaveBeenCalledTimes(1);
    expect(persistRecipe).not.toHaveBeenCalled();
  });

  it('keeps the dish, and says so, when the meal has been deleted meanwhile', async () => {
    // The dish is already saved on the server, so a failed attach must not strand
    // it: say what happened (Rule 10) and still go to what was imported.
    const imported = makeEntry({ id: 'imported-9', title: 'Onion gravy' });
    vi.mocked(importRecipeFromUrl).mockResolvedValue({ kind: 'ok', value: imported });
    vi.mocked(attachComponentToMeal).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'recipe', id: MEAL_ID },
    });
    renderPage();
    await importALink();

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addToast).mock.calls[0]![1]).toBe('destructive');
    expect(push).toHaveBeenCalledWith('/recipes/imported-9');
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

describe('RecipeViewPage — the card’s gate and the import dialogs’ gate', () => {
  it('gives an ordinary recipe the card in edit mode and withholds the New menu', async () => {
    mockRecipes._set([makeEntry(), CHICKEN]);
    renderPage();

    // Read mode: no card at all, so the menu's absence below cannot be mistaken
    // for the card simply not being there.
    expect(screen.queryByText('Made from')).toBeNull();

    await fireEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    // The conversion door #1343 opened — the card mounts on CAPABILITY…
    expect(screen.getByText('Made from')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-edit-components')).toHaveTextContent('+ Dishes');
    // …and the menu stays behind PRESENCE, with the dialogs it opens. Offered
    // here it would open a dialog this page has not mounted.
    expect(screen.queryByTestId('meal-component-new-btn')).toBeNull();
  });

  it('offers the menu on a meal in edit mode, and its dialog is mounted to receive it', async () => {
    // The other end of the same predicate: where the menu IS offered, pressing it
    // reaches a dialog that exists. The photo path is the one a jsdom test can
    // drive to a mounted dialog without a network.
    renderPage();
    await fireEvent.click(screen.getByTestId('recipe-edit-mode-button'));

    await openNewMenu();
    await fireEvent.click(await screen.findByTestId('meal-component-new-import-photo'));

    expect(await screen.findByTestId('recipe-import-photo-dialog')).toBeInTheDocument();
  });
});
