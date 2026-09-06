import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// "Save as new recipe" on the recipe page's chat (issue #798). You are on the
// lamb, you ask what would go with it, and you keep the answer as a dish of its
// own. What is pinned here is the half a screenshot cannot show: the lamb is not
// written to, and the librarian is called in create mode with no base — variation
// mode would carry the lamb's ingredients into the salad.

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
    mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
    mockEquipment: makeStore<unknown>(null),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
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
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({ defaultListId: mockDefaultListId }));
vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
// The feature-flag reads are here because this suite stubs the whole adapter and
// the page now reads the bread gate (issue #831). "Never initialised" is what the
// real adapter reports under vitest, so these stubs say the same thing: nothing is
// gated, and this suite's subject is unaffected.
vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  isObservabilityFeatureEnabled: () => true,
  areObservabilityFeatureFlagsSettled: () => true,
  onObservabilityFeatureFlags: () => () => {},
  // `featureGate.ts` reads the PostHog flag key from the adapter (issue #1054);
  // nothing here asserts on it, but the whole-module mock must supply it.
  BREAD_FLAG_KEY: 'bread',
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  createChatSession: vi.fn(),
  sendMessage: vi.fn(),
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
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
  // Identity — attribution (#845) has its own suite; this one is about the page.
  stampRecipeAttribution: <T>(recipe: T) => recipe,
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
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { claimRecipe } from '../src/lib/chatService.js';
import { saveRecipe } from '@salt/firebase-sync';
import { push } from 'svelte-spa-router';

const RECIPE_ID = 'lamb';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    producesCanonId: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Slow-roast Lamb Shoulder',
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 6,
      tags: ['sunday'],
    },
    source: { type: 'manual' },
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSession(messages: ChatSessionDoc['messages']): ChatSessionDoc {
  // createdAt is "now", not a fixed date, so this session is never accidentally
  // read-only (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: RECIPE_ID,
    basedOnRecipeId: null,
    title: 'Lamb chat',
    messages,
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '2026-01-15T00:00:00.000Z',
  };
}

const USER_TURN = {
  id: 'm1',
  role: 'user' as const,
  text: 'what would go with this?',
  createdAt: '2026-08-13T10:00:00.000Z',
};
const ASSISTANT_TURN = {
  id: 'm2',
  role: 'assistant' as const,
  text: 'A fennel, orange and olive salad.',
  createdAt: '2026-08-13T10:00:01.000Z',
};

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveRecipe).mockResolvedValue({ kind: 'ok', value: undefined });
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([makeRecipe()]);
  mockSessions._set([]);
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — when the button is offered', () => {
  it('shows nothing until the chef has replied', () => {
    mockSessions._set([makeSession([USER_TURN])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('sidebar-save-new-recipe-btn')).toBeNull();
    // The gate is shared with "Review changes" — neither can author an empty
    // conversation, and they appear together.
    expect(queryByTestId('sidebar-apply-changes-btn')).toBeNull();
  });

  it('appears once there is an assistant turn, beside the review gate', () => {
    mockSessions._set([makeSession([USER_TURN, ASSISTANT_TURN])]);
    const { getByTestId } = renderPage();

    expect(getByTestId('sidebar-save-new-recipe-btn')).toBeInTheDocument();
    expect(getByTestId('sidebar-apply-changes-btn')).toBeInTheDocument();
  });
});

describe('RecipeViewPage — saving the conversation as a new dish', () => {
  it('authors in create mode with no base, saves a second recipe and goes to it', async () => {
    mockSessions._set([makeSession([USER_TURN, ASSISTANT_TURN])]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: { ...emptyRecipe('salad', '2026-01-01T00:00:00.000Z'), title: 'Fennel Salad' },
    });
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('sidebar-save-new-recipe-btn'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/salad'));
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    // Neither id: `recipeId` is edit mode (it would return the lamb), and
    // `basedOnRecipeId` is variation mode (it would put the lamb's shoulder joint
    // in the salad).
    expect(input.recipeId).toBeUndefined();
    expect(input.basedOnRecipeId).toBeNull();

    // The dish on the page is never written to — the only save is the new one.
    expect(saveRecipe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRecipe).mock.calls[0]![0].id).toBe('salad');
    // The conversation stays listed on the lamb; the salad has no chat of its own.
    expect(claimRecipe).not.toHaveBeenCalled();
  });

  it('stays on the recipe when the librarian fails, and writes nothing', async () => {
    mockSessions._set([makeSession([USER_TURN, ASSISTANT_TURN])]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('sidebar-save-new-recipe-btn'));

    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
    expect(saveRecipe).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
