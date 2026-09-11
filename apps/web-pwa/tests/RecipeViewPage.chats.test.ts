import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The recipe is the home for its own conversations (issue #696): every chat about
// the dish is listed on it, "Chat" continues the most recent one rather than
// quietly starting a fourth, and a new one is named after the dish.

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

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { createChatSession } from '../src/lib/chatService.js';
import { push } from 'svelte-spa-router';

const RECIPE_ID = 'recipe-1';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    producesCanonId: null,
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Cauliflower Steaks',
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
    kit: [],
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
    title: 'Cauliflower Steaks chat',
    messages: [],
    basedOnRecipeId: null,
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '9999-12-31T23:59:59.999Z',
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
  mockRecipes._set([makeRecipe()]);
  mockSessions._set([]);
  mockEquipment._set({ items: [{ name: 'Sage Pizzaiolo' }] });
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

describe('RecipeViewPage — the chat list', () => {
  it('lists every chat about this dish, newest first', () => {
    mockSessions._set([
      makeSession({ id: 'old', title: 'Halving it', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeSession({ id: 'new', title: 'Air fryer', updatedAt: '2026-03-01T00:00:00.000Z' }),
      makeSession({ id: 'other-dish', recipeId: 'recipe-2', title: 'Not this one' }),
      makeSession({ id: 'general', recipeId: null, title: 'General' }),
    ]);
    const { getByTestId, getAllByTestId } = renderPage();

    expect(getByTestId('recipe-chat-list')).toBeInTheDocument();
    const titles = getAllByTestId('recipe-chat-list-item').map((el) => el.textContent);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('Air fryer');
    expect(titles[1]).toContain('Halving it');
  });

  it('shows the last thing said', () => {
    mockSessions._set([
      makeSession({
        messages: [
          { id: 'm1', role: 'user', text: 'halve it?', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'm2', role: 'assistant', text: 'Use one head.', createdAt: '2026-01-01T00:00:01Z' },
        ],
      }),
    ]);
    const { getByTestId } = renderPage();

    expect(getByTestId('recipe-chat-list-item').textContent).toContain('Use one head.');
  });

  it('opens the chat you tapped without leaving the recipe', async () => {
    mockSessions._set([makeSession({ id: 'session-7' })]);
    const { getByTestId, queryByTestId } = renderPage();
    expect(queryByTestId('recipe-chat-drawer')).toBeNull();

    await fireEvent.click(getByTestId('recipe-chat-list-item'));

    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it('still renders, with an invitation, when there are no chats yet', () => {
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('recipe-chat-list')).toBeInTheDocument();
    expect(queryByTestId('recipe-chat-list-item')).toBeNull();
  });
});

// The phone drawer's own header control (issue #1310). The docked column's is pinned in
// `RecipeViewPage.saveNewRecipe.test.ts`; this is the third surface, and it is a
// SEPARATE DOM node with its own trigger testid because both can be mounted at once —
// the column is merely `hidden` below `lg`. A shared testid asserted "exactly one" by a
// test that never mounted the second surface is the flaw #1304 named.
describe('RecipeViewPage — the chat drawer’s actions menu', () => {
  const REPLIED = [
    { id: 'm1', role: 'user' as const, text: 'halve it?', createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'm2',
      role: 'assistant' as const,
      text: 'Use one head.',
      createdAt: '2026-01-01T00:00:01Z',
    },
  ];

  async function openDrawer(messages: ChatSessionDoc['messages']): Promise<HTMLElement> {
    mockSessions._set([makeSession({ id: 'session-7', messages })]);
    const { getByTestId } = renderPage();
    await fireEvent.click(getByTestId('recipe-chat-list-item'));
    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());
    return getByTestId('recipe-chat-drawer');
  }

  it('offers both actions from the drawer’s own header, on its own trigger', async () => {
    const drawer = await openDrawer(REPLIED);

    // In the header, not in the transcript — and on the drawer's trigger, never the
    // column's, so the two surfaces stay individually addressable.
    const trigger = screen.getByTestId('drawer-chat-actions-menu');
    expect(drawer.contains(trigger)).toBe(true);
    expect(screen.queryByTestId('chat-reply-actions')).toBeNull();

    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('drawer-apply-changes-btn')).toBeInTheDocument());
    expect(screen.getByTestId('drawer-apply-changes-btn').textContent).toContain('Update recipe');
    expect(screen.getByTestId('drawer-save-new-recipe-btn').textContent).toContain(
      'Save as new recipe',
    );
  });

  it('draws no trigger at all before the chef has replied', async () => {
    await openDrawer([REPLIED[0]!]);

    expect(screen.queryByTestId('drawer-chat-actions-menu')).toBeNull();
  });
});

describe('RecipeViewPage — starting and continuing', () => {
  // The real createChatSession inserts optimistically before it resolves, which is what
  // lets the surface showing a chat switch to the new one straight away.
  function createsInto(id: string) {
    const created = makeSession({ id, updatedAt: '2026-12-01T00:00:00.000Z' });
    vi.mocked(createChatSession).mockImplementation(async () => {
      mockSessions._set([created]);
      return { kind: 'ok', value: created };
    });
    return created;
  }

  it('names a new chat after the dish', async () => {
    createsInto('session-new');
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-chat-new-btn'));

    await waitFor(() =>
      expect(createChatSession).toHaveBeenCalledWith('uid-1', RECIPE_ID, 'Cauliflower Steaks'),
    );
    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());
  });

  // "Chat" lives in the ⋮ menu, which since #735 is the ONLY surface it has at any
  // width. bits-ui renders PopoverContent lazily and portals it, so the menu has to
  // be opened first and the item is reached through `screen`, not the container.
  async function clickChatMenuItem(): Promise<void> {
    await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
    await waitFor(() =>
      expect(screen.getByTestId('recipe-ask-amend-menu-item')).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId('recipe-ask-amend-menu-item'));
  }

  it('"Chat" continues the most recent conversation instead of creating another', async () => {
    mockSessions._set([
      makeSession({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeSession({ id: 'newest', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    const { getByTestId } = renderPage();

    await clickChatMenuItem();

    expect(createChatSession).not.toHaveBeenCalled();
    // The newest conversation, raised over the recipe rather than replacing it.
    await waitFor(() =>
      expect(getByTestId('recipe-chat-drawer').textContent).toContain('Cauliflower Steaks chat'),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('"Chat" starts one when the dish has none', async () => {
    createsInto('session-first');
    const { getByTestId } = renderPage();

    await clickChatMenuItem();

    await waitFor(() =>
      expect(createChatSession).toHaveBeenCalledWith('uid-1', RECIPE_ID, 'Cauliflower Steaks'),
    );
    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());
  });
});
