/**
 * Asking the chef to save a recipe (issue #1480) — the browser half.
 *
 * The claim this pins, in both directions, is the one CLAUDE.md Rule 12 demands
 * of this feature: a recognised request REACHES the one create implementation,
 * and nothing else does.
 *
 *  1. A request the chef recorded runs `authorRecipeFromChat` — the SAME leg the
 *     floppy-disc button runs, with `session.basedOnRecipeId`, followed by the
 *     claim, the `KIND_COPY` toast and the navigation. Not a copy of the button's
 *     behaviour: the button's own handler.
 *  2. An ordinary conversation runs nothing.
 *  3. IT IS TAKEN, NOT READ. The request is cleared from the document before the
 *     save starts, so a second surface, a re-render or a reload cannot run it
 *     again — and a save that fails costs a button press rather than repeating
 *     itself.
 *  4. ONLY THE PAGE THAT ASKED ACTS (#1494). A request is eligible to fire
 *     only when it names the chef's reply to a message sent from THIS page.
 *     Everything else is cleared, never acted on: one already on the document
 *     when the page opens (review of #1490, Finding 1), one the page could not
 *     clear the first time (the `chatSave` flag still in flight — #1494,
 *     Finding B), and one delivered as a stale cached snapshot with nothing
 *     pending followed by the server's armed copy (#1494, Finding A) — a shape
 *     that is indistinguishable, snapshot for snapshot, from a live arrival.
 *     Without this, reopening a conversation writes a recipe with no
 *     interaction at all.
 *  5. AN ATTACHED CHAT IS ASKED, in the menu's own two words, and neither handler
 *     runs until one is picked. Dismissing writes nothing.
 *
 * THE `chatSave` FEATURE KEY IS NOT THIS FILE'S TO PROVE (issue #1512). The gate
 * moved inside `consumeSaveIntent`, the one seam every surface goes through, and
 * is pinned there (`chatService.saveIntent.test.ts`). `consumeSaveIntent` is
 * fully mocked here, so a page-level "key off" case could only assert against
 * that mock — a test that passes whatever the real gate does. What this file
 * still proves is the half that matters from the page: every path REACHES the
 * seam, and honours a `false` from it exactly as it honours "somebody else took
 * it" — the two are the same observable thing from here.
 *
 * A separate file from `ChatSessionPage.test.ts` because that suite mocks the
 * feature gate OFF wholesale, which is exactly the state these cases are not
 * about.
 *
 * The seams are narrower than that suite's, and deliberately (UT-B1): mocking
 * `recipeAmend` — which this page reaches only through the update leg, untouched
 * here — takes `@salt/firebase-sync` and `guidedPlanService` out of the import
 * graph with it, and the REAL toast store is read rather than spied, because
 * "what did it say" is a question the store itself answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

const { mockSessions, mockIsLoading, mockRecipes, mockRouter } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockRouter: { querystring: undefined as string | undefined },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), pop: vi.fn(), router: mockRouter }));
vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  isLoadingSessions: mockIsLoading,
  sendMessage: vi.fn(),
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reopenChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  consumeSaveIntent: vi.fn(async () => true),
}));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  // The seam `chatRecipeAuthor` reaches through — the create leg under test.
  authorRecipeTraced: vi.fn(),
  attachComponentToMeal: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  currentMemberName: vi.fn(() => 'Daniel'),
  stashImportedDraft: vi.fn(),
}));
// The UPDATE leg, which this phase does not touch and this page only reaches
// from the menu. Mocked at the module rather than under it, which is what keeps
// `@salt/firebase-sync` and `guidedPlanService` out of the graph entirely.
vi.mock('../src/lib/recipeAmend.js', () => ({
  proposeRecipeAmendment: vi.fn(),
  applyRecipeAmendment: vi.fn(),
}));

import ChatSessionPage from '../src/routes/chat/ChatSessionPage.svelte';
import { claimRecipe, consumeSaveIntent, sendMessage } from '../src/lib/chatService.js';
import { proposeRecipeAmendment } from '../src/lib/recipeAmend.js';
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { toasts } from '../src/lib/toastStore.js';
import { push } from 'svelte-spa-router';

// The propose leg is not this suite's subject — that it is REACHED is. A failure
// is the cheapest answer that proves the call happened and leaves nothing open.
const OFFLINE = { kind: 'NetworkError', reason: 'offline' } as const;

const SAVED: Recipe = {
  ...emptyRecipe('recipe-new', '2026-09-19T00:00:00.000Z'),
  title: 'Negroni Sbagliato',
};

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [
      { id: 'm1', role: 'user', text: 'create a recipe from this', createdAt: ts },
      { id: 'm2', role: 'assistant', text: 'Saving that now.', createdAt: ts },
    ],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    pendingSaveIntent: null,
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoading._set(false);
  mockRecipes._set([]);
  mockRouter.querystring = undefined;
  vi.mocked(consumeSaveIntent).mockResolvedValue(true);
  vi.mocked(sendMessage).mockResolvedValue({ kind: 'ok', value: makeSession() });
  vi.mocked(proposeRecipeAmendment).mockResolvedValue({ kind: 'err', error: OFFLINE });
  vi.mocked(authorRecipeTraced).mockResolvedValue({ kind: 'ok', value: SAVED });
  window.history.replaceState(null, '', '#/');
});

function renderPage(id = 'session-1') {
  return render(ChatSessionPage, { props: { params: { id } } });
}

const ASK = 'save that as a recipe';

/** Type `text` into this page's composer and send it. */
async function sendFromPage(text = ASK): Promise<void> {
  await fireEvent.input(screen.getByTestId('chat-input'), { target: { value: text } });
  await fireEvent.click(screen.getByTestId('chat-send-btn'));
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
}

/**
 * `session` as the flow writes it back after a turn: the words sent, verbatim,
 * then the chef's reply — which is what the save request names.
 */
function withReply(session: ChatSessionDoc, asked = ASK): ChatSessionDoc {
  const ts = new Date().toISOString();
  return {
    ...session,
    messages: [
      ...session.messages,
      { id: 'm3', role: 'user', text: asked, createdAt: ts },
      { id: 'm4', role: 'assistant', text: 'Saving that now.', createdAt: ts },
    ],
    pendingSaveIntent: 'm4',
  };
}

// Only the page that asked acts on a request (#1494), so every test below that
// wants to pin the ACTING behaviour renders on an unarmed session, SENDS from
// the page, and only then delivers the chef's reply with the request on it —
// the shape of a real request arriving while the page that asked is open.
async function renderAndArm(
  overrides: Partial<ChatSessionDoc> = {},
  id = 'session-1',
): Promise<ReturnType<typeof renderPage>> {
  const before = makeSession({ ...overrides, id, pendingSaveIntent: null });
  mockSessions._set([before]);
  const rendered = renderPage(id);
  await sendFromPage();
  mockSessions._set([withReply(before)]);
  return rendered;
}

describe('ChatSessionPage — a save the chef was asked for', () => {
  it('runs the same leg the Save button runs, and lands on the recipe', async () => {
    await renderAndArm({ basedOnRecipeId: 'base-1' });

    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
    // `session.basedOnRecipeId`, exactly as `handleSaveAsRecipe` passes it — the
    // general leg grounds the librarian on the dish the chat started from.
    expect(vi.mocked(authorRecipeTraced).mock.calls[0]?.[0]).toMatchObject({
      basedOnRecipeId: 'base-1',
    });
    // And everything the button does afterwards: the conversation claims the dish
    // it invented, and you land on it.
    await waitFor(() => expect(claimRecipe).toHaveBeenCalledWith('session-1', 'recipe-new'));
    expect(push).toHaveBeenCalledWith('/recipes/recipe-new');
    expect(get(toasts).map((t) => t.message)).toContain('Recipe created');
  });

  it('takes the request before saving, so it cannot run twice', async () => {
    await renderAndArm();

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    expect(vi.mocked(consumeSaveIntent).mock.calls[0]?.[0]).toMatchObject({ id: 'session-1' });
  });

  it('saves nothing when the request was already taken by someone else', async () => {
    vi.mocked(consumeSaveIntent).mockResolvedValue(false);
    await renderAndArm();

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });

  it('saves nothing on an ordinary conversation', async () => {
    // The half of Rule 12 that stops "it only fires when asked" being a sentence
    // nothing can falsify.
    mockSessions._set([makeSession()]);

    renderPage();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumeSaveIntent).not.toHaveBeenCalled();
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });

  // Finding 1 (review of #1490): a request already armed the FIRST time this
  // page ever observes the session — a finished conversation, reopened days
  // later, that nobody is present for — must be cleared and never acted on.
  // Before the fix this ran the full save with no interaction at all; this is
  // the test that goes red without it.
  it('clears, but does not act on, a request already recorded when the page opens', async () => {
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2' })]);

    renderPage();

    // The clear still runs — an armed request left on the document forever is
    // its own bug — but nothing downstream of "taken" fires.
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(claimRecipe).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // #1494, Finding B. The first look at an already-armed request can fail to
  // clear it: `consumeSaveIntent` answers `false` and writes nothing while the
  // `chatSave` flag payload is still in flight. The request is still the same
  // days-old one when the next snapshot arrives with the flag landed — and
  // before the fix, that first run had already marked the page as "been here",
  // so the second read it as a live arrival and saved with no interaction.
  it('does not act on a request it could not clear the first time, once the flag lands', async () => {
    vi.mocked(consumeSaveIntent).mockResolvedValueOnce(false);
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2' })]);

    renderPage();
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(1));

    // Any later snapshot of the same conversation — here a title the flow
    // wrote — with the request still armed and the flag now on.
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2', title: 'Negroni' })]);
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(claimRecipe).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // Moving from one conversation to another keeps this page mounted, so what it
  // saw on the first says nothing about the second.
  it('does not carry "was here" from one conversation to the next', async () => {
    mockSessions._set([makeSession(), makeSession({ id: 'session-2', pendingSaveIntent: 'm2' })]);

    const { rerender } = renderPage('session-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await rerender({ params: { id: 'session-2' } });

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // #1494, Finding A — the real device sequence after being away. Firestore's
  // persistent cache delivers its stale copy first (nothing pending), then the
  // server's copy with the request already armed. Snapshot for snapshot that is
  // exactly what a live arrival looks like, which is why "seen with nothing
  // pending, then armed" could never tell the two apart. This page sent
  // nothing, so the request is not its to act on.
  it('does not act on a request delivered as a stale cached snapshot, then the server copy', async () => {
    const cached = makeSession();
    mockSessions._set([cached]);
    renderPage();
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockSessions._set([withReply(cached)]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(claimRecipe).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // The page sent something, but the request names the reply to a different
  // turn — another device's, landing where this page's reply would have.
  it('does not act on a request answering a message this page did not send', async () => {
    const before = makeSession();
    mockSessions._set([before]);
    renderPage();
    await sendFromPage('what wine goes with it?');

    mockSessions._set([withReply(before, 'save that as a recipe')]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });

  // The accepted cost of "only the page that asked": leave before the reply
  // lands and the page that comes back is a different page. The request is
  // dropped, and the person asks again.
  it('does not act on the reply to a message sent from an earlier visit to the page', async () => {
    const before = makeSession();
    mockSessions._set([before]);
    const first = renderPage();
    await sendFromPage();
    first.unmount();

    mockSessions._set([withReply(before)]);
    renderPage();

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });
});

// A request that resolves while a save is ALREADY RUNNING (issue #1505). It is
// cleared from the document before anything happens — the "taken, not read"
// contract above — so `handleSaveAsRecipe`'s `isSavingRecipe` guard used to drop
// it with nothing left anywhere saying it had ever been made.
//
// What the fix promises, and what these two pin between them, is exactly this
// much: the request is held and RUN when the in-flight save FAILS, and DROPPED
// when it succeeds — that save has already answered it, and a retry there would
// be a second dish to delete rather than a recovery.
describe('ChatSessionPage — a save the chef was asked for, while one is already running', () => {
  type LibrarianResult = Awaited<ReturnType<typeof authorRecipeTraced>>;

  /** Hold the librarian open so a save can be caught mid-flight. */
  function heldLibrarian(): (v: LibrarianResult) => void {
    let settle!: (v: LibrarianResult) => void;
    vi.mocked(authorRecipeTraced).mockReturnValueOnce(
      new Promise<LibrarianResult>((resolve) => {
        settle = resolve;
      }),
    );
    return (v) => settle(v);
  }

  /**
   * Press Save, catch it mid-flight, and let the chef's request land on top.
   * Returns the settle for the button's save.
   */
  async function raceAgainstTheButton(): Promise<(v: LibrarianResult) => void> {
    const before = makeSession();
    mockSessions._set([before]);
    renderPage();
    await sendFromPage();

    const settle = heldLibrarian();
    await fireEvent.click(screen.getByTestId('chat-save-recipe-btn'));
    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalledTimes(1));

    // The request arrives on the subscription while that save is still open.
    mockSessions._set([withReply(before)]);
    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    return settle;
  }

  it('runs the request once the in-flight save has failed, instead of losing it', async () => {
    const settle = await raceAgainstTheButton();

    // Still only the button's call — the request is held, not running alongside.
    expect(authorRecipeTraced).toHaveBeenCalledTimes(1);

    settle({ kind: 'err', error: OFFLINE } as LibrarianResult);

    // Before the fix this was where the request vanished: cleared from the
    // document, dropped by the guard, and recorded nowhere.
    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/recipe-new'));
  });

  it('drops the request when the in-flight save succeeded, rather than saving twice', async () => {
    const settle = await raceAgainstTheButton();

    settle({ kind: 'ok', value: SAVED } as LibrarianResult);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/recipe-new'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorRecipeTraced).toHaveBeenCalledTimes(1);
  });
});

describe('ChatSessionPage — a save the chef was asked for, on a chat about a dish', () => {
  // Two things could be meant standing on a dish, so the app asks instead of
  // guessing — in the same two words the floppy-disc menu uses (#1310).
  async function askAndWait() {
    // The dish the chat is attached to has to be in the store: "Update recipe"
    // proposes against the recipe it finds there and says "Recipe not found"
    // otherwise, which is a different path from the one under test.
    mockRecipes._set([{ ...emptyRecipe('recipe-1', '2026-09-19T00:00:00.000Z'), title: 'Lamb' }]);
    // Asked from this page (see `renderAndArm`) — a request already present at
    // mount is Finding 1's case and must not open this ask; that is pinned
    // separately below.
    const rendered = await renderAndArm({ recipeId: 'recipe-1' });
    await waitFor(() => expect(screen.getByTestId('chat-save-intent-dialog')).toBeInTheDocument());
    return rendered;
  }

  it('asks which was meant, and writes nothing while it is asking', async () => {
    await askAndWait();

    expect(screen.getByTestId('chat-save-intent-update').textContent).toContain('Update recipe');
    expect(screen.getByTestId('chat-save-intent-new').textContent).toContain('Save as new recipe');
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(proposeRecipeAmendment).not.toHaveBeenCalled();
  });

  it('routes "Update recipe" into the existing review gate, not into a write', async () => {
    await askAndWait();

    await fireEvent.click(screen.getByTestId('chat-save-intent-update'));

    // `proposeRecipeAmendment` produces a PENDING proposal; `applyRecipeAmendment`
    // is what writes, and the change summary's Apply is what calls it. Reaching
    // the first without the second is exactly the gate the menu route has.
    await waitFor(() => expect(proposeRecipeAmendment).toHaveBeenCalled());
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });

  it('routes "Save as new recipe" into an independent dish, with no base and no claim', async () => {
    await askAndWait();

    await fireEvent.click(screen.getByTestId('chat-save-intent-new'));

    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
    // `null`, even though this chat is attached: an accompaniment is not a
    // variation of the dish it accompanies, and a base would drag that dish's
    // ingredients into it.
    expect(vi.mocked(authorRecipeTraced).mock.calls[0]?.[0]).toMatchObject({
      basedOnRecipeId: null,
    });
    // And the conversation stays listed on the dish it is attached to.
    expect(claimRecipe).not.toHaveBeenCalled();
    expect(proposeRecipeAmendment).not.toHaveBeenCalled();
  });

  it('writes nothing when the question is dismissed unanswered', async () => {
    const { container } = await askAndWait();

    await fireEvent.keyDown(container.ownerDocument, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByTestId('chat-save-intent-dialog')).not.toBeInTheDocument(),
    );
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(proposeRecipeAmendment).not.toHaveBeenCalled();
  });

  it('does not ask at all when consumeSaveIntent says no', async () => {
    // Stands in for every reason it can say no — the feature key off, another
    // surface already took it — which are indistinguishable from here and are
    // `consumeSaveIntent`'s own tests to pin (`chatService.saveIntent.test.ts`).
    vi.mocked(consumeSaveIntent).mockResolvedValue(false);
    mockRecipes._set([{ ...emptyRecipe('recipe-1', '2026-09-19T00:00:00.000Z'), title: 'Lamb' }]);

    await renderAndArm({ recipeId: 'recipe-1' });

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
  });

  // Finding 1's attached-chat leg: a request already armed at mount must not
  // open the ask either, even though the session names a recipe.
  it('does not ask at all for a request already recorded when the page opens', async () => {
    mockRecipes._set([{ ...emptyRecipe('recipe-1', '2026-09-19T00:00:00.000Z'), title: 'Lamb' }]);
    mockSessions._set([makeSession({ recipeId: 'recipe-1', pendingSaveIntent: 'm2' })]);

    renderPage();

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('chat-save-intent-dialog')).toBeNull();
  });
});

// The send record (`lastSent` in `chatThreadState.svelte.ts`) is what
// `askedHere` reads to decide a request is this page's to act on. Issue
// #1561 (campaign #1552): nothing pinned that it is written BEFORE the send
// call returns, nor that it survives a failed send — either regression would
// silently drop a genuine save request while every existing test here still
// passes, because they all deliver the reply strictly after the call settles.
describe('ChatSessionPage — the send record that gates "asked here" (#1561)', () => {
  it('records the send before the call returns, so a reply arriving while it is still in flight is still recognised', async () => {
    mockSessions._set([makeSession()]);
    renderPage();

    // Hold `sendMessage` open so the reply can land while this page's own send
    // is still awaiting it — the comment on `chatThreadState.svelte.ts`'s
    // `send` says exactly this can happen (a reply arriving before the call
    // resolves).
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
    mockSessions._set([withReply(makeSession())]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());

    // Let the held call settle so nothing is left dangling.
    resolveSend({ kind: 'ok', value: withReply(makeSession()) });
  });

  it('keeps the send record when the send fails, so a reply that lands anyway still saves', async () => {
    mockSessions._set([makeSession()]);
    renderPage();
    vi.mocked(sendMessage).mockResolvedValueOnce({ kind: 'err', error: OFFLINE });

    await sendFromPage();

    // The reply lands at the same slot the failed send would have produced —
    // the flow writes the turn regardless of whether the stream reached this
    // page (a locked phone mid-reply), so this is still an answer to this send.
    mockSessions._set([withReply(makeSession())]);

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
  });
});
