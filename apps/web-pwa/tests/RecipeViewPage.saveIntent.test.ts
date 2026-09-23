/**
 * The save-intent handoff on the recipe page, where it goes wrong (issue #1505).
 *
 * `RecipeViewPage.saveNewRecipe.test.ts` already pins what the ask DOES once it
 * opens — the two words it offers, the leg each answer takes, the feature gate,
 * and Finding 1's "a request that was already sitting there is nobody's". This
 * file pins the two things that were wrong about WHEN and ON WHAT it asks:
 *
 *  1. THE CHAT THE REQUEST WAS RECORDED ON ANSWERS IT, not whichever chat the
 *     selector happens to be showing when the dialog is answered. The dialog
 *     stays up while the page is fully live, so switching chats underneath it is
 *     an ordinary thing to do — and before the fix, "Update recipe" then proposed
 *     an amendment built from the wrong transcript.
 *  2. IT NEVER ASKS OVER A CONVERSATION THAT IS NOT ON SCREEN, and a request
 *     this page asked for — the chef's reply to a message sent from it (#1494)
 *     — is left ARMED on the document rather than taken, so it is still there
 *     to ask about once the conversation comes back into view. (It is NOT a
 *     hand-off to the full `/chat/:id` page — that page drops a request it did
 *     not ask for exactly as this one does; see the comment on
 *     `saveChoiceOpen` in `RecipeViewPage.svelte`, #1533 review, Finding 2.) A
 *     request this page did NOT ask for is a different case entirely — see the
 *     dedicated regression tests below for Finding 1 and #1494 — and is cleared
 *     on the spot regardless of visibility, since it is never asked about
 *     either way.
 *
 * jsdom answers `matches: false` to every media query, so `docked` — and with it
 * `chatPaneShown` — is false unless `window.matchMedia` is stubbed. That is the
 * whole reason this file stubs it: the visibility gate under test reads it, and
 * an unstubbed suite would be testing the hidden case by accident.
 *
 * The seams are narrower than `saveNewRecipe`'s on purpose: `recipeAmend` and
 * `chatRecipeAuthor` are mocked at the module, so the assertion can be made
 * directly against the MESSAGES each leg was handed — which is the observable
 * the wrong-session bug is about, and one no testid can see.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { ChatSessionDoc } from '@salt/domain/schemas';

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
  flagOn,
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
    flagOn: { value: true },
  };
});

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  router: { querystring: '' },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' } },
}));
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
  saveRecipeDoc: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  isObservabilityFeatureEnabled: (key: string) => (key === 'chat-save' ? flagOn.value : true),
  areObservabilityFeatureFlagsSettled: () => true,
  onObservabilityFeatureFlags: () => () => {},
  BREAD_FLAG_KEY: 'bread',
  LIBRARY_FLAG_KEY: 'library',
  CHAT_SAVE_FLAG_KEY: 'chat-save',
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  createChatSession: vi.fn(),
  sendMessage: vi.fn(),
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  consumeSaveIntent: vi.fn().mockResolvedValue(true),
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
// The two legs the ask routes into, mocked at the module so the TRANSCRIPT each
// one is handed is directly observable. Nothing here is about what either leg
// then does — `saveNewRecipe.test.ts` and `recipeAmend`'s own suites hold that.
vi.mock('../src/lib/recipeAmend.js', () => ({
  proposeRecipeAmendment: vi.fn(),
  applyRecipeAmendment: vi.fn(),
}));
vi.mock('../src/lib/chatRecipeAuthor.js', () => ({
  authorRecipeFromChat: vi.fn(),
}));
vi.mock('../src/lib/recipeService.js', () => ({
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
  currentMemberName: vi.fn(() => 'Daniel'),
  stampRecipeAttribution: <T>(recipe: T) => recipe,
  flushRecipeWrites: vi.fn().mockResolvedValue(undefined),
  getRecipeSnapshot: vi.fn(() => undefined),
  applyRecipeOptimistically: <T>(recipe: T) => recipe,
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
import { consumeSaveIntent, sendMessage } from '../src/lib/chatService.js';
import { proposeRecipeAmendment } from '../src/lib/recipeAmend.js';
import { authorRecipeFromChat } from '../src/lib/chatRecipeAuthor.js';
import { recipeChatPanePrefs } from '../src/lib/recipeChatPanePrefs.svelte.js';

const RECIPE_ID = 'lamb';
const OFFLINE = { kind: 'NetworkError', reason: 'offline' } as const;

/** Complete `MediaQueryList` stub — the shape the house pattern expects. */
function fullStub(matches: boolean): typeof window.matchMedia {
  return ((query: string) => ({
    media: query,
    matches,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const LAMB: Recipe = {
  ...emptyRecipe(RECIPE_ID, '2026-01-01T00:00:00.000Z'),
  title: 'Slow-roast Lamb',
};

function turn(id: string, role: 'user' | 'assistant', text: string) {
  return { id, role, text, createdAt: '2026-08-13T10:00:00.000Z' } as const;
}

// Two conversations about the same dish, with transcripts that cannot be
// mistaken for one another — the whole point of the first pair of tests is which
// one of these the librarian is handed.
const CHAT_A_MESSAGES = [
  turn('a1', 'user', 'make it for eight'),
  turn('a2', 'assistant', 'Scale the shoulder to 2.5kg.'),
];
// Chat A as the flow writes it back after this page sent `ASK` on it: the words
// verbatim, then the chef's reply — which is what the save request names.
const ASK = 'save that as a recipe';
const CHAT_A_ASKED = [
  ...CHAT_A_MESSAGES,
  turn('a3', 'user', ASK),
  turn('a4', 'assistant', 'Which would you like?'),
];
const CHAT_B_MESSAGES = [
  turn('b1', 'user', 'what would go with this?'),
  turn('b2', 'assistant', 'A fennel, orange and olive salad.'),
];

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  // `createdAt` is "now" so no fixture is accidentally read-only (issue #1270)
  // under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-a',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: RECIPE_ID,
    basedOnRecipeId: null,
    title: 'Chat A',
    messages: [...CHAT_A_MESSAGES],
    createdAt: ts,
    updatedAt: '2026-08-13T12:00:00.000Z',
    reopenedAt: null,
    pendingSaveIntent: null,
    expiresAt: '9999-12-31T23:59:59.999Z',
    ...overrides,
  };
}

/** `chatsForRecipe` sorts newest-first, so A is the page's opening selection. */
function chatA(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return makeSession(overrides);
}
function chatB(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return makeSession({
    id: 'session-b',
    title: 'Chat B',
    messages: [...CHAT_B_MESSAGES],
    updatedAt: '2026-08-13T09:00:00.000Z',
    ...overrides,
  });
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  flagOn.value = true;
  // Room for the docked column, and the cook wants one — `chatPaneShown` true,
  // which is the visible case. The hidden cases below say so explicitly.
  window.matchMedia = fullStub(true);
  recipeChatPanePrefs.on = true;
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockGuidedPlan._set(null);
  mockRecipes._set([LAMB]);
  mockSessions._set([]);
  vi.mocked(consumeSaveIntent).mockResolvedValue(true);
  vi.mocked(sendMessage).mockResolvedValue({ kind: 'ok', value: makeSession() });
  vi.mocked(proposeRecipeAmendment).mockResolvedValue({ kind: 'err', error: OFFLINE });
  vi.mocked(authorRecipeFromChat).mockResolvedValue({ kind: 'err', error: OFFLINE });
});

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  recipeChatPanePrefs.on = true;
  document.body.innerHTML = '';
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Type `ASK` into a conversation's composer and send it — the docked column's
 * unless `surface` names another (on a phone the hidden column is still
 * mounted, so the drawer's has to be picked out).
 */
async function sendFromPage(surface: HTMLElement = document.body): Promise<void> {
  const on = within(surface);
  await fireEvent.input(on.getByTestId('chat-input'), { target: { value: ASK } });
  await fireEvent.click(on.getByTestId('chat-send-btn'));
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
}

/** Chat A's reply to `ASK` arrives, carrying the save request. */
function deliverReplyToA(chats: readonly ChatSessionDoc[]): void {
  mockSessions._set(
    chats.map((c) =>
      c.id === 'session-a' ? { ...c, messages: [...CHAT_A_ASKED], pendingSaveIntent: 'a4' } : c,
    ),
  );
}

/**
 * Render on UNARMED chats, SEND from this page on Chat A (the opening
 * selection), then deliver the chef's reply with the request on it — the shape
 * of a real request arriving while the page that asked is open (#1494). A
 * request this page did not ask for is Finding 1's and Finding A's case, which
 * must never open the ask.
 */
async function renderAndArm(chats: readonly ChatSessionDoc[]): Promise<void> {
  mockSessions._set(chats);
  renderPage();
  await sendFromPage();
  deliverReplyToA(chats);
}

describe('RecipeViewPage — the ask is answered on the chat it was recorded on (#1505)', () => {
  async function armAThenSelectB(): Promise<void> {
    await renderAndArm([chatA(), chatB()]);
    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());

    // The dialog does not freeze the page, so picking a different conversation
    // while it is up is an ordinary thing to do — and it is what used to move
    // the answer onto the wrong transcript.
    await fireEvent.click(screen.getByText('Chat B').closest('button')!);
    await tick();
  }

  it('proposes the update from the requesting chat, not the one selected since', async () => {
    await armAThenSelectB();

    await fireEvent.click(screen.getByTestId('chat-save-intent-update'));

    await waitFor(() => expect(proposeRecipeAmendment).toHaveBeenCalled());
    // Chat A's transcript — the one the chef was asked on. Before the fix this
    // was Chat B's, because both handlers re-read `activeSession` at call time.
    expect(vi.mocked(proposeRecipeAmendment).mock.calls[0]?.[1]).toEqual(CHAT_A_ASKED);
  });

  it('authors the new dish from the requesting chat, not the one selected since', async () => {
    await armAThenSelectB();

    await fireEvent.click(screen.getByTestId('chat-save-intent-new'));

    await waitFor(() => expect(authorRecipeFromChat).toHaveBeenCalled());
    expect(vi.mocked(authorRecipeFromChat).mock.calls[0]?.[0]).toMatchObject({
      messages: CHAT_A_ASKED,
      basedOnRecipeId: null,
    });
  });

  // Naming one chat means that chat OR NOTHING — it never falls back to the one
  // on screen, which would be the same wrong-transcript bug wearing a fallback.
  it('does nothing at all when the requesting chat is gone by the time it is answered', async () => {
    await renderAndArm([chatA(), chatB()]);
    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());

    mockSessions._set([chatB()]);
    await tick();

    await fireEvent.click(screen.getByTestId('chat-save-intent-update'));
    await tick();

    expect(proposeRecipeAmendment).not.toHaveBeenCalled();
    expect(authorRecipeFromChat).not.toHaveBeenCalled();
  });

  // The other half of the same change, and the one a fix threading a captured
  // session through could easily break: the MENU items carry no session and must
  // keep meaning "whatever is on screen when you press it".
  it('still answers the menu items on whatever chat is selected', async () => {
    mockSessions._set([chatA(), chatB()]);
    renderPage();
    await tick();
    await fireEvent.click(screen.getByText('Chat B').closest('button')!);
    await tick();

    await fireEvent.click(screen.getByTestId('sidebar-chat-actions-menu'));
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-apply-changes-btn')).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByTestId('sidebar-apply-changes-btn'));

    await waitFor(() => expect(proposeRecipeAmendment).toHaveBeenCalled());
    expect(vi.mocked(proposeRecipeAmendment).mock.calls[0]?.[1]).toEqual(CHAT_B_MESSAGES);
  });
});

describe('RecipeViewPage — it does not ask over a conversation that is off screen (#1505)', () => {
  /** Ask from the docked column, then switch the pane off before the reply lands. */
  async function askThenHidePane(): Promise<void> {
    mockSessions._set([chatA()]);
    renderPage();
    await sendFromPage();
    recipeChatPanePrefs.on = false;
    await tick();
    deliverReplyToA([chatA()]);
    await tick();
  }

  it('stays quiet, and leaves the request armed, with the chat pane switched off', async () => {
    await askThenHidePane();

    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
    // NOT TAKEN, which is the half that makes this safe rather than merely quiet:
    // the request survives on the document for the surface that can show it.
    expect(consumeSaveIntent).not.toHaveBeenCalled();
  });

  it('stays quiet on the phone with the drawer closed', async () => {
    // No room for a column, and nothing raised over the recipe: the chat list at
    // the foot of the page is not the conversation.
    window.matchMedia = fullStub(false);
    mockSessions._set([chatA()]);
    renderPage();
    // Asked from the drawer, which is then put away before the reply lands.
    await fireEvent.click(screen.getByText('Chat A').closest('button')!);
    await sendFromPage(await screen.findByTestId('recipe-chat-drawer'));
    await fireEvent.click(screen.getByTestId('recipe-chat-drawer-close'));
    await tick();
    deliverReplyToA([chatA()]);
    await tick();

    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
    expect(consumeSaveIntent).not.toHaveBeenCalled();
  });

  it('asks as soon as the conversation comes back on screen', async () => {
    await askThenHidePane();
    expect(consumeSaveIntent).not.toHaveBeenCalled();

    // Bringing the pane back is the same act as tapping the chat in the list.
    recipeChatPanePrefs.show();

    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());
    expect(consumeSaveIntent).toHaveBeenCalledTimes(1);
  });

  // #1533 review, blocking Finding 1: this is the case `renderAndArm` cannot
  // reach — every other test in this file asks from the page first. Here the
  // request is on the document BEFORE the page ever mounts,
  // and the pane
  // is hidden from the start: the mount config 4 of 5 users are in, and
  // desktop with the pane switched off. Before the fix, the hidden mount run
  // still recorded the session as "seen" without clearing anything, so the
  // very next run — triggered by nothing more than the pane opening, with no
  // new activity on the chat at all — read that stale bookkeeping as a live
  // arrival and popped "Save which one?" over a days-old request.
  it('clears a request already sitting there when the page mounts hidden, and never asks about it once the pane opens', async () => {
    recipeChatPanePrefs.on = false;
    mockSessions._set([chatA({ pendingSaveIntent: 'a2' })]);
    renderPage();

    // Cleared on sight — Finding 1's rule does not wait for a surface to ask
    // with, because a first-observation request is never asked about anyway.
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();

    // Opening the pane afterwards re-runs the effect on the same session, with
    // nothing new having arrived — this must not be mistaken for a live
    // arrival just because bookkeeping changed.
    recipeChatPanePrefs.show();
    await tick();
    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
    expect(consumeSaveIntent).toHaveBeenCalledTimes(1);
  });
});

describe('RecipeViewPage — a request it could not clear on first sight (#1494)', () => {
  // #1494, Finding B, and the #1536 review's named hazard: a first look that
  // could not clear the request (`consumeSaveIntent` declining while the
  // `chatSave` flag is still in flight) must not mark the chat as "been here".
  // Before the fix it did, so the next snapshot — flag landed, the same
  // days-old request still armed — popped "Save which one?" over it.
  it('does not ask about a request it could not clear the first time, once the flag lands', async () => {
    vi.mocked(consumeSaveIntent).mockResolvedValueOnce(false);
    mockSessions._set([chatA({ pendingSaveIntent: 'a2' })]);
    renderPage();
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(1));

    // A later snapshot of the same chat, the request still armed.
    mockSessions._set([chatA({ pendingSaveIntent: 'a2', title: 'Chat A, renamed' })]);
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(2));
    await tick();

    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
  });
});

describe('RecipeViewPage — a request this page did not ask for (#1494, Finding A)', () => {
  // The real device sequence after being away: Firestore's persistent cache
  // delivers its stale copy first (nothing pending), then the server's copy
  // with the request already armed. Snapshot for snapshot that is exactly a live
  // arrival, so only "did this page send the message it answers?" tells them
  // apart — and here it sent nothing.
  it('does not ask about a request delivered as a stale cached snapshot, then the server copy', async () => {
    mockSessions._set([chatA()]);
    renderPage();
    await tick();

    deliverReplyToA([chatA()]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(1));
    await tick();
    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
  });
});

// The send record (`lastSent` in `chatThreadState.svelte.ts`) is what
// `askedHere` reads to decide a request is this page's to act on. Issue
// #1561 (campaign #1552): nothing pinned that it is written BEFORE the send
// call returns, nor that it survives a failed send — either regression would
// silently drop a genuine save request while every existing test in this file
// still passes, because they all deliver the reply strictly after `sendFromPage`
// has already awaited the call.
describe('RecipeViewPage — the send record that gates "asked here" (#1561)', () => {
  it('records the send before the call returns, so a reply arriving while it is still in flight is still recognised', async () => {
    mockSessions._set([chatA()]);
    renderPage();

    // Hold `sendMessage` open so the reply can land while this page's own send
    // is still awaiting it.
    let resolveSend!: (v: Awaited<ReturnType<typeof sendMessage>>) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(
      new Promise<Awaited<ReturnType<typeof sendMessage>>>((resolve) => {
        resolveSend = resolve;
      }),
    );

    await fireEvent.input(screen.getByTestId('chat-input'), { target: { value: ASK } });
    await fireEvent.click(screen.getByTestId('chat-send-btn'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    // The chef's reply, carrying the request, arrives on the subscription
    // while `send`'s own promise is still unresolved.
    deliverReplyToA([chatA()]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());

    // Let the held call settle so nothing is left dangling.
    resolveSend({ kind: 'ok', value: chatA() });
  });

  it('keeps the send record when the send fails, so a reply that lands anyway still saves', async () => {
    mockSessions._set([chatA()]);
    renderPage();
    vi.mocked(sendMessage).mockResolvedValueOnce({ kind: 'err', error: OFFLINE });

    await sendFromPage();

    // The reply lands at the same slot the failed send would have produced.
    deliverReplyToA([chatA()]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());
  });
});
