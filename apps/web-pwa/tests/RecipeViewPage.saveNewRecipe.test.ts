import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
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
  offered: [],
};
// The chef declared BOTH kinds on this reply (#1299), so both actions are offered.
// These suites are about what the buttons DO and where they render, not about the
// gate — `RecipeViewPage.chatOffers.test.ts` is the one that drives the gate.
const ASSISTANT_TURN = {
  id: 'm2',
  role: 'assistant' as const,
  text: 'A fennel, orange and olive salad.',
  createdAt: '2026-08-13T10:00:01.000Z',
  offered: ['dish-change' as const, 'new-dish' as const],
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

// Issue #1299 moved these two out of the chat card's header and into the transcript.
// The comments on `ChatThread.svelte` and on `reviewChangesAction` state that as an
// absolute — "under the NEWEST chef reply", "no chat header writes to the dish" — so it
// is pinned here rather than left as a sentence. Placement is the whole deliverable of
// that phase and it is exactly what a testid-only assertion cannot see.
describe('RecipeViewPage — where the chat actions render (#1299)', () => {
  const LATER_USER_TURN = {
    id: 'm3',
    role: 'user' as const,
    text: 'and a drink?',
    createdAt: '2026-08-13T10:00:02.000Z',
    offered: [],
  };
  const LATER_ASSISTANT_TURN = {
    id: 'm4',
    role: 'assistant' as const,
    text: 'A dry amontillado.',
    createdAt: '2026-08-13T10:00:03.000Z',
    offered: ['dish-change' as const, 'new-dish' as const],
  };

  it('puts the row inside the transcript, immediately after the NEWEST reply', () => {
    mockSessions._set([
      makeSession([USER_TURN, ASSISTANT_TURN, LATER_USER_TURN, LATER_ASSISTANT_TURN]),
    ]);
    const { getByTestId, getAllByTestId } = renderPage();

    // One row, not one per reply: there are two assistant turns on this session.
    // Asked of the DOCKED COLUMN, not the document (PR #1303 review). The row's
    // testid comes from `ChatThread`, which both this column and the drawer
    // render, and below the seam the column stays mounted-and-hidden while the
    // drawer opens — so a document-wide count says "one" only for as long as
    // nothing opens the drawer, which is not the claim being made here. The
    // per-surface count is; see the drawer test below for the other half.
    const rows = within(getByTestId('recipe-chat-sidebar')).getAllByTestId('chat-reply-actions');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Inside the message list, and the sibling right after the last reply — the two
    // halves of "under the newest chef reply" that a testid lookup alone would miss.
    expect(getByTestId('chat-messages').contains(row)).toBe(true);
    const replies = getAllByTestId('chat-message-assistant');
    expect(row.previousElementSibling).toBe(replies[replies.length - 1]);

    // Both buttons are in it, and they say what they do.
    expect(row.contains(getByTestId('sidebar-apply-changes-btn'))).toBe(true);
    expect(row.contains(getByTestId('sidebar-save-new-recipe-btn'))).toBe(true);
    expect(getByTestId('sidebar-apply-changes-btn').textContent).toContain('Review changes');
    expect(getByTestId('sidebar-save-new-recipe-btn').textContent).toContain('Save as new recipe');
  });

  it('renders neither action anywhere outside the transcript', () => {
    mockSessions._set([makeSession([USER_TURN, ASSISTANT_TURN])]);
    const { getByTestId } = renderPage();

    // "No chat header contains a control that writes to a recipe" — asked of the whole
    // document rather than of one header element, so a copy left behind in the card
    // header, the page header or anywhere else is caught by the same assertion.
    const transcript = getByTestId('chat-messages');
    for (const testid of ['sidebar-apply-changes-btn', 'sidebar-save-new-recipe-btn']) {
      const found = document.querySelectorAll(`[data-testid="${testid}"]`);
      expect(found).toHaveLength(1);
      expect(transcript.contains(found[0]!)).toBe(true);
    }
  });

  it('gives the drawer its own row, under its own newest reply', async () => {
    // What the count above cannot say on its own (PR #1303 review). Below the
    // seam the docked column is `hidden` rather than unmounted, so opening the
    // drawer puts TWO `ChatThread`s on the page and `chat-reply-actions` is one
    // testid rendered by both. That is by design — the row is the shared
    // component's, and the BUTTONS carry per-surface testids for exactly this
    // reason — but it means "one row" is only ever a per-surface claim, and a
    // document-wide assertion would have gone red the first time a test opened
    // the drawer.
    mockSessions._set([makeSession([USER_TURN, ASSISTANT_TURN])]);
    const { getByTestId, getAllByTestId } = renderPage();

    await fireEvent.click(getByTestId('recipe-chat-list-item'));
    await waitFor(() => expect(getByTestId('recipe-chat-drawer')).toBeInTheDocument());

    // Two surfaces, two rows — and each holds its own surface's buttons, which is
    // what makes the shared testid safe rather than ambiguous.
    expect(getAllByTestId('chat-reply-actions')).toHaveLength(2);

    for (const [surface, review, save] of [
      ['recipe-chat-sidebar', 'sidebar-apply-changes-btn', 'sidebar-save-new-recipe-btn'],
      ['recipe-chat-drawer', 'drawer-apply-changes-btn', 'drawer-save-new-recipe-btn'],
    ] as const) {
      const scope = within(getByTestId(surface));
      const rows = scope.getAllByTestId('chat-reply-actions');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.contains(scope.getByTestId(review))).toBe(true);
      expect(rows[0]!.contains(scope.getByTestId(save))).toBe(true);
    }
  });
});

// The gate #1299's third phase put on the docked column's two actions: what the
// chef DECLARED its newest reply offered, not whether it replied. Fail closed.
describe('RecipeViewPage — the chat actions follow what the chef offered (#1299)', () => {
  function reply(offered: ('dish-change' | 'new-dish')[]): ChatSessionDoc {
    return makeSession([
      { ...USER_TURN, text: 'why is my crumb tight?', offered: [] },
      { ...ASSISTANT_TURN, text: 'Under-proved.', offered },
    ]);
  }

  it('offers nothing, and draws no row, after a plain answer', () => {
    mockSessions._set([reply([])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('sidebar-apply-changes-btn')).toBeNull();
    expect(queryByTestId('sidebar-save-new-recipe-btn')).toBeNull();
    // Not an empty row: an empty `role="group"` labelled "What to do with this
    // reply" would be announced to a screen reader with nothing inside it.
    expect(queryByTestId('chat-reply-actions')).toBeNull();
  });

  // The #798 pair shares a ROW, not a gate — these two fail if it is wired back
  // to one condition.
  it('offers Review changes alone for a proposed change to this dish', () => {
    mockSessions._set([reply(['dish-change'])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('sidebar-apply-changes-btn')).not.toBeNull();
    expect(queryByTestId('sidebar-save-new-recipe-btn')).toBeNull();
  });

  it('offers Save as new recipe alone for something to serve alongside', () => {
    mockSessions._set([reply(['new-dish'])]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('sidebar-save-new-recipe-btn')).not.toBeNull();
    expect(queryByTestId('sidebar-apply-changes-btn')).toBeNull();
  });

  it('follows the NEWEST reply, so an older offer does not linger', () => {
    mockSessions._set([
      makeSession([
        { ...USER_TURN, offered: [] },
        { ...ASSISTANT_TURN, offered: ['dish-change'] },
        { ...USER_TURN, id: 'm3', text: 'why?', offered: [] },
        { ...ASSISTANT_TURN, id: 'm4', text: 'Sugar holds water.', offered: [] },
      ]),
    ]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('sidebar-apply-changes-btn')).toBeNull();
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
