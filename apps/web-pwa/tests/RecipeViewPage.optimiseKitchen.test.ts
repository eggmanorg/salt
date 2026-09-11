import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// "Optimise for my kitchen": a canned USER turn, not a new capability. The button
// drops a well-written prompt into the recipe's chat and everything downstream —
// the streamed reply, "Review changes", the diff — behaves exactly as it does for
// a hand-typed request. These tests cover what is genuinely new: the gate on an
// empty manifest, the no-session bootstrap, and the content contract of the prompt.

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
    mockEquipment: makeStore<{ items: readonly { name: string }[] } | null>(null),
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
import { createChatSession, sendMessage } from '../src/lib/chatService.js';

const RECIPE_ID = 'recipe-1';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    producesCanonId: null,
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Test Recipe',
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
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  // createdAt is "now", not a fixed date, so this session is never accidentally
  // read-only (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: RECIPE_ID,
    title: 'Recipe chat',
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  } as ChatSessionDoc;
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
  mockRecipes._set([makeRecipe()]);
  mockSessions._set([]);
  mockEquipment._set({ items: [{ name: 'Sage Pizzaiolo' }] });
  vi.mocked(sendMessage).mockResolvedValue({ kind: 'ok', value: makeSession() });
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

// Optimise lives in the ⋮ menu, which since #735 is the ONLY surface it has at any
// width. bits-ui renders PopoverContent lazily and portals it, so the menu has to
// be opened first and the items are reached through `screen`, not the container.
async function clickOverflowItem(testid: string): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
  await waitFor(() => expect(screen.getByTestId(testid)).toBeInTheDocument());
  await fireEvent.click(screen.getByTestId(testid));
}

describe('RecipeViewPage — optimise for my kitchen', () => {
  it('is hidden when the household owns no equipment', async () => {
    // With an empty manifest the server injects no kit section, so the prompt would
    // ask the chef to re-work the method around nothing.
    mockEquipment._set({ items: [] });
    renderPage();

    await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
    // Duplicate is unconditional, so it is the reliable signal that the menu is
    // actually mounted — an assertion about what is MISSING would otherwise pass
    // against a menu that never opened.
    await waitFor(() =>
      expect(screen.getByTestId('recipe-duplicate-menu-item')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('recipe-optimise-kitchen-menu-item')).toBeNull();
  });

  it('sends the canned prompt as an ordinary user turn on the existing session', async () => {
    const session = makeSession();
    mockSessions._set([session]);
    renderPage();

    await clickOverflowItem('recipe-optimise-kitchen-menu-item');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // Straight through sendMessage — no new callable, no special handling.
    expect(vi.mocked(sendMessage).mock.calls[0]![0]).toMatchObject({ id: session.id });
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('bootstraps a session and sends on the object createChatSession returned', async () => {
    // `activeSession` is $derived off the sessions store, which has not repopulated
    // by the time the send fires — the returned session is the only usable handle.
    const created = makeSession({ id: 'session-new' });
    vi.mocked(createChatSession).mockResolvedValue({ kind: 'ok', value: created });
    renderPage();

    await clickOverflowItem('recipe-optimise-kitchen-menu-item');

    await waitFor(() =>
      // The seed title comes from the dish (issue #696) — "Test Recipe chat".
      expect(createChatSession).toHaveBeenCalledWith('uid-1', RECIPE_ID, 'Test Recipe'),
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0]).toMatchObject({ id: 'session-new' });
  });

  it('raises the drawer so the turn streams somewhere visible', async () => {
    // Below the seam the chat column is not on screen, so a turn streamed into it would
    // arrive where the user cannot see it. The drawer is where a chat goes now (#696).
    mockSessions._set([makeSession()]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(queryByTestId('recipe-chat-drawer')).toBeNull();
    await clickOverflowItem('recipe-optimise-kitchen-menu-item');

    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());
  });

  it('asks for a method-only rewrite, timings that move with it, and proportionality', async () => {
    mockSessions._set([makeSession()]);
    renderPage();

    await clickOverflowItem('recipe-optimise-kitchen-menu-item');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(sendMessage).mock.calls[0]![1];
    // Ingredients held: an ingredient rewrite would put every ingredient back
    // through canon matching for nothing.
    expect(prompt).toMatch(/method only/i);
    expect(prompt).toMatch(/ingredients/i);
    expect(prompt).toMatch(/servings/i);
    // Timings and temperatures have to move with the method.
    expect(prompt).toMatch(/timings and temperatures/i);
    // Leaving a step alone is a valid outcome.
    expect(prompt).toMatch(/proportionate/i);
    // A readable account of the change, before the diff.
    expect(prompt).toMatch(/what you changed and why/i);
    // The household's manifest is injected server-side — never hardcode kit here.
    expect(prompt).not.toMatch(/pizzaiolo|anova|magimix|kuhn rikon/i);
  });

  it('leaves the composer untouched — the canned prompt never lands in the input box', async () => {
    mockSessions._set([makeSession()]);
    vi.mocked(sendMessage).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    } as Awaited<ReturnType<typeof sendMessage>>);
    const { getAllByPlaceholderText } = renderPage();

    await clickOverflowItem('recipe-optimise-kitchen-menu-item');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    // Even on failure: the composer restores hand-typed text, not a canned paragraph.
    // Every composer on the page — the drawer's and the column's — stays empty.
    await waitFor(() =>
      expect(
        // Matched loosely: the composer's placeholder also advertises `/remember`
        // (issue #816), and this assertion is about what is IN the boxes.
        getAllByPlaceholderText(/^Message the chef…/).map(
          (el) => (el as HTMLTextAreaElement).value,
        ),
      ).not.toContain(expect.stringContaining('re-work it')),
    );
  });
});
