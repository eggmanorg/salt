import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type { Member, Recipe } from '@salt/domain';

// The per-person cook-mode default (issue #776).
//
// The Cook control keeps its shape whichever way the preference is set: a wide
// labelled half and an icon half that share a divider. What the preference decides
// is WHICH MODE EACH HALF GOES TO — which is the whole reason it is safe to have
// one at all, because standard cook mode stays one tap away for everybody.
//
// The case worth reading first is "guided by default, recipe has no plan": the
// wide button must NOT lead to the guided screen there. A default that puts a dead
// end where the obvious action was is worse than no default, so it falls back to
// standard and the icon half becomes the offer to write a plan.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
  mockCurrentMember,
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
    mockCurrentMember: makeStore<Member | null>(null),
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
vi.mock('../src/lib/membersService.js', () => ({ currentMember: mockCurrentMember }));
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
}));

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { push } from 'svelte-spa-router';

const RECIPE_ID = 'recipe-1';

function makeRecipe(): Recipe {
  return {
    producesCanonId: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Weeknight ragù',
    description: null,
    ingredients: [],
    steps: [{ id: 'step-1', text: 'Cook it.', timer: null, note: null }],
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
  };
}

function member(cookMode: 'standard' | 'guided'): Member {
  return {
    id: 'cook@test',
    schemaVersion: 1,
    name: 'Cook',
    email: 'cook@test',
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode,
    system: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const A_PLAN = { id: RECIPE_ID, recipeId: RECIPE_ID, prep: [], stepNotes: [] };

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
  mockRecipes._set([makeRecipe()]);
  mockGuidedPlan._set(null);
  mockCurrentMember._set(null);
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — which cook mode the Cook button opens', () => {
  it('opens standard for someone with no preference set', async () => {
    // Every member doc in production predates the field, so this is what the
    // whole household gets until somebody chooses otherwise. It has to be exactly
    // today's behaviour.
    mockGuidedPlan._set(A_PLAN);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);
    expect(getByTestId('recipe-cook-actions').dataset['primary']).toBe('standard');
  });

  it('opens guided for someone who prefers it, when there is a plan', async () => {
    mockCurrentMember._set(member('guided'));
    mockGuidedPlan._set(A_PLAN);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);
    expect(getByTestId('recipe-cook-actions').dataset['primary']).toBe('guided');
  });

  it('keeps STANDARD one tap away when guided leads', async () => {
    // The promise that makes a default safe to have at all.
    mockCurrentMember._set(member('guided'));
    mockGuidedPlan._set(A_PLAN);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-guided-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);
  });

  it('keeps GUIDED one tap away when standard leads', async () => {
    mockCurrentMember._set(member('standard'));
    mockGuidedPlan._set(A_PLAN);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-guided-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);
  });

  it('falls back to standard when guided is preferred but the recipe has no plan', async () => {
    // No dead ends. A default that opened the "there's no plan" screen every time
    // you cooked something unplanned would be worse than no default.
    mockCurrentMember._set(member('guided'));
    mockGuidedPlan._set(null);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);
    expect(getByTestId('recipe-cook-actions').dataset['primary']).toBe('standard');
  });

  it('still OFFERS guided on an unplanned recipe to someone who prefers it', async () => {
    // Which is the point: the person who wants guided is the person who wants to
    // be asked whether to write a plan.
    mockCurrentMember._set(member('guided'));
    mockGuidedPlan._set(null);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-cook-guided-button'));
    expect(push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);
  });

  it('offers nothing but standard on an unplanned recipe to everyone else', async () => {
    mockCurrentMember._set(member('standard'));
    mockGuidedPlan._set(null);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('recipe-cook-guided-button')).toBeNull();
  });

  it('drops the not-checked-yet dot from a half that is no longer guided', async () => {
    // The dot means "this plan is AI-written and unread". On a control where the
    // icon half opens STANDARD cook mode it would be a flag against the wrong
    // thing entirely.
    mockCurrentMember._set(member('guided'));
    mockGuidedPlan._set({ ...A_PLAN, needs_approval: true });
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('recipe-cook-guided-button').dataset['unreviewed']).toBe('false');
    expect(queryByTestId('recipe-cook-guided-unreviewed-dot')).toBeNull();
  });

  it('keeps the dot when the icon half IS guided', async () => {
    mockCurrentMember._set(member('standard'));
    mockGuidedPlan._set({ ...A_PLAN, needs_approval: true });
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-cook-guided-button').dataset['unreviewed']).toBe('true');
    expect(getByTestId('recipe-cook-guided-unreviewed-dot')).toBeTruthy();
  });
});
