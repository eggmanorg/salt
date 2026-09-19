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
 *  4. THE FEATURE KEY IS A REAL GATE on this side too: with it off, a document
 *     carrying a request is ignored entirely.
 *  5. AN ATTACHED CHAT IGNORES IT, and leaves it on the document. Two things
 *     could be meant there and choosing between them is phase 2; nothing is
 *     thrown away before the surface that can use it exists.
 *
 * A separate file from `ChatSessionPage.test.ts` because that suite mocks the
 * feature gate OFF wholesale, which is exactly the state four of these five
 * cases are not about.
 *
 * The seams are narrower than that suite's, and deliberately (UT-B1): mocking
 * `recipeAmend` — which this page reaches only through the update leg, untouched
 * here — takes `@salt/firebase-sync` and `guidedPlanService` out of the import
 * graph with it, and the REAL toast store is read rather than spied, because
 * "what did it say" is a question the store itself answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

const { mockSessions, mockIsLoading, mockRecipes, mockRouter, flagOn } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockRouter: { querystring: undefined as string | undefined },
      // The `chat-save` flag, switchable per test. Everything under `featureGate`
      // reads through this one function.
      flagOn: { value: true },
    };
  },
);

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), pop: vi.fn(), router: mockRouter }));
vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  BREAD_FLAG_KEY: 'bread',
  LIBRARY_FLAG_KEY: 'library',
  CHAT_SAVE_FLAG_KEY: 'chat-save',
  isObservabilityFeatureEnabled: (key: string) => key === 'chat-save' && flagOn.value,
  areObservabilityFeatureFlagsSettled: () => true,
  onObservabilityFeatureFlags: () => () => {},
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
import { claimRecipe, consumeSaveIntent } from '../src/lib/chatService.js';
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { toasts } from '../src/lib/toastStore.js';
import { push } from 'svelte-spa-router';

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
  flagOn.value = true;
  mockIsLoading._set(false);
  mockRecipes._set([]);
  mockRouter.querystring = undefined;
  vi.mocked(consumeSaveIntent).mockResolvedValue(true);
  vi.mocked(authorRecipeTraced).mockResolvedValue({ kind: 'ok', value: SAVED });
  window.history.replaceState(null, '', '#/');
});

function renderPage(id = 'session-1') {
  return render(ChatSessionPage, { props: { params: { id } } });
}

describe('ChatSessionPage — a save the chef was asked for', () => {
  it('runs the same leg the Save button runs, and lands on the recipe', async () => {
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2', basedOnRecipeId: 'base-1' })]);

    renderPage();

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
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2' })]);

    renderPage();

    await waitFor(() => expect(consumeSaveIntent).toHaveBeenCalled());
    expect(vi.mocked(consumeSaveIntent).mock.calls[0]?.[0]).toMatchObject({ id: 'session-1' });
  });

  it('saves nothing when the request was already taken by someone else', async () => {
    vi.mocked(consumeSaveIntent).mockResolvedValue(false);
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2' })]);

    renderPage();

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

  it('ignores a recorded request entirely with the feature key off', async () => {
    flagOn.value = false;
    mockSessions._set([makeSession({ pendingSaveIntent: 'm2' })]);

    renderPage();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumeSaveIntent).not.toHaveBeenCalled();
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });

  it('leaves an attached chat alone, request and all — that is phase 2', async () => {
    // Two things could be meant on a dish, so this page does not guess. It also
    // does not CLEAR the request: nothing is thrown away before the surface that
    // can offer the choice exists.
    mockSessions._set([makeSession({ recipeId: 'recipe-1', pendingSaveIntent: 'm2' })]);

    renderPage();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumeSaveIntent).not.toHaveBeenCalled();
    expect(authorRecipeTraced).not.toHaveBeenCalled();
  });
});
