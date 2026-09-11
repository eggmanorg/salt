import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';

// Issue #933 characterisation net. `RecipeViewPage` carries a guarded
// `matchMedia` `$effect` (byte-identical to the one in `CatalogPage` and
// `MealPlanWeekPage`) that a later phase will extract into one shared helper.
// This file pins every failure path the extraction must preserve — today none of
// them is tested anywhere.
//
// Asserted through rendered output: with no chat session selected, the recipe's
// chat list (`recipe-chat-list`, from `RecipeChatList`) renders EITHER at the
// foot of the recipe (`!docked`) OR inside `recipe-chat-sidebar` (`docked`) — one
// place or the other, never both, per the page's own comment at RecipeViewPage.svelte:2777-2779.
// `recipe-chat-sidebar` itself is unconditional in the DOM (it is CSS, not
// `docked`, that hides it below the breakpoint), so location — not presence — is
// the observable the guarded effect controls.

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

function renderPage() {
  mockRecipes._set([makeRecipe()]);
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

/** Complete `MediaQueryList` stub — the shape the house pattern expects. */
function fullStub(
  matches: boolean,
  addEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
  removeEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
): typeof window.matchMedia {
  return ((query: string) => ({
    media: query,
    matches,
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Is the recipe's chat list rendered INSIDE the docked sidebar column? */
function chatListIsDocked(): boolean {
  const sidebar = screen.getByTestId('recipe-chat-sidebar');
  return within(sidebar).queryByTestId('recipe-chat-list') !== null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([]);
  mockGuidedPlan._set(null);
  mockSessions._set([]);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipeViewPage — the docked-chat media query, failure paths (#933)', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  // UT-D1/D2: these four differ only in the `matchMedia` stub, and each row
  // names the failure path it stands for.
  it.each([
    [
      'matches: true, full listener API — the chat list docks into the sidebar (the positive control every other row depends on)',
      () => {
        window.matchMedia = fullStub(true);
      },
      true,
    ],
    [
      'matchMedia missing entirely — falls back to the foot of the recipe, no throw',
      () => {
        window.matchMedia = undefined as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'matchMedia throws on call — falls back to the foot of the recipe, no throw',
      () => {
        window.matchMedia = (() => {
          throw new Error('matchMedia is not supported here');
        }) as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'MediaQueryList with no addEventListener, matches: true — the one-shot read still docks',
      () => {
        window.matchMedia = ((query: string) => ({
          media: query,
          matches: true,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
      },
      true,
    ],
  ] as const)('%s', async (_label, setUp, expectDocked) => {
    setUp();
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    expect(chatListIsDocked()).toBe(expectDocked);
  });

  it('subscribes the query’s change listener, follows it live, and unsubscribes the SAME handler on unmount', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    // Starts undocked so the live flip (not just the initial read) is what
    // proves the listener works.
    window.matchMedia = fullStub(false, addEventListener, removeEventListener);

    const { unmount } = renderPage();

    await waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function)),
    );
    const onChange = addEventListener.mock.calls[0]![1] as (e: MediaQueryListEvent) => void;

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    expect(chatListIsDocked()).toBe(false);

    // Fire the captured handler — the observable fact is the rendering flips,
    // with no remount.
    onChange({ matches: true } as MediaQueryListEvent);
    await waitFor(() => expect(chatListIsDocked()).toBe(true));

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', onChange);
  });
});
