import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe, type Recipe } from '@salt/domain';

// Issue #1141 — switching the chef-chat column off, and what that costs the page.
//
// The observable is `chatPaneShown = docked && recipeChatPanePrefs.on`. jsdom
// reports `matches: false` for every media query, so `docked` is stubbed true here
// exactly as `RecipeViewPage.docked.test.ts` does; without that stub none of this
// is reachable and the phone path is all that runs.
//
// Four properties, each of which the feature is a defect without:
//   - the default is chat-ON, so an untouched page renders exactly as it did;
//   - switching it off RELOCATES the one `recipe-chat-list` to the foot of the
//     recipe rather than removing it — never two on the page, and never zero;
//   - the preference is a module singleton, so it survives unmount/remount (i.e.
//     navigating between recipes) and is NOT page-local `$state`;
//   - `fill` comes off with the pane (ui-spec-v07 §1.6: one pane is not a fill).
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

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
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
import { recipeChatPanePrefs } from '../src/lib/recipeChatPanePrefs.svelte.js';
import type { ChatSessionDoc } from '@salt/domain/schemas';

const RECIPE_ID = 'recipe-1';
const SEEDED_AT = '2026-01-01T00:00:00.000Z';

function renderPage() {
  // `emptyRecipe` rather than a hand-rolled literal (UT-C2): the page's own
  // fields are irrelevant here — every assertion below is about the chat pane.
  mockRecipes._set([{ ...emptyRecipe(RECIPE_ID, SEEDED_AT), title: 'Bare Recipe' }]);
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

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  // createdAt is "now", not a fixed date, so this session is never accidentally
  // read-only (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: RECIPE_ID,
    title: 'Bare Recipe chat',
    messages: [],
    basedOnRecipeId: null,
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '9999-12-31T23:59:59.999Z',
    ...overrides,
  };
}

/**
 * `DetailPage`'s root, whose `h-full min-h-0` IS `fill` (ui-spec-v07 §1.2) — the
 * prop is not otherwise observable from rendered output.
 */
function detailPageRoot(): HTMLElement {
  return screen.getByRole('heading', { name: 'Bare Recipe' }).closest('section')!;
}

function toggle(): HTMLElement {
  return screen.getByTestId('recipe-chat-pane-toggle');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([]);
  mockGuidedPlan._set(null);
  mockSessions._set([]);
  // The singleton is module state and therefore shared across every test in this
  // file — resetting it here is what keeps each one independent.
  recipeChatPanePrefs.on = true;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipeViewPage — switching the chef-chat pane off (#1141)', () => {
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    // Two columns' worth of room. Everything below is about the OTHER half of
    // `chatPaneShown`, so `docked` is held true throughout.
    window.matchMedia = fullStub(true);
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('defaults to chat-on: the list docks, the page fills, and the button offers to hide', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    expect(chatListIsDocked()).toBe(true);
    expect(detailPageRoot().className).toContain('h-full');
    expect(toggle()).toHaveAccessibleName('Hide chef chat');
  });

  it('switching it off relocates the one chat list to the foot of the recipe and drops `fill`', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    await user.click(toggle());

    await waitFor(() => expect(chatListIsDocked()).toBe(false));
    // Relocated, not removed and not duplicated — the page's standing invariant.
    expect(screen.getAllByTestId('recipe-chat-list')).toHaveLength(1);
    // One pane is not a `fill` (ui-spec-v07 §1.6), and the gate that drives the
    // grid's classes is the one that drives the prop (§1.4).
    expect(detailPageRoot().className).not.toContain('h-full');
    expect(toggle()).toHaveAccessibleName('Show chef chat');
  });

  it('hides the column without unmounting it, so the conversation is not torn down', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    await user.click(toggle());
    await waitFor(() => expect(chatListIsDocked()).toBe(false));

    // Still in the DOM, but with the `split:flex` that reveals it withdrawn — the
    // thing that keeps `ChatThread` mounted, and with it the transcript's scroll
    // position and anything half-typed in the composer.
    const sidebar = screen.getByTestId('recipe-chat-sidebar');
    expect(sidebar.className).toContain('hidden');
    expect(sidebar.className).not.toContain('split:flex');
  });

  it('is a session preference, not page state: it survives an unmount and remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    await user.click(toggle());
    await waitFor(() => expect(chatListIsDocked()).toBe(false));

    // Navigating to another recipe and back is exactly this.
    unmount();
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    expect(chatListIsDocked()).toBe(false);
    expect(toggle()).toHaveAccessibleName('Show chef chat');
  });

  it('selecting a conversation from the relocated list brings the pane back on it', async () => {
    const user = userEvent.setup();
    mockSessions._set([makeSession({ id: 'session-7', title: 'Halving it' })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    await user.click(toggle());
    await waitFor(() => expect(chatListIsDocked()).toBe(false));

    // The failure mode this guards: a recipe where tapping a chat does nothing.
    await user.click(screen.getByTestId('recipe-chat-list-item'));

    await waitFor(() => expect(chatListIsDocked()).toBe(true));
    expect(detailPageRoot().className).toContain('h-full');
  });
});

describe('RecipeViewPage — the pane toggle is inert on a phone (#1141)', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('renders no toggle below the seam, where the chat is already a dismissible drawer', async () => {
    window.matchMedia = fullStub(false);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('recipe-chat-list')).toBeInTheDocument());
    expect(chatListIsDocked()).toBe(false);
    expect(screen.queryByTestId('recipe-chat-pane-toggle')).toBeNull();
  });
});
