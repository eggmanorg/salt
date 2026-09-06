import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

const NOW = '2026-08-01T00:00:00.000Z';

// Back goes where you came from, and "Save as recipe" leaves the conversation
// attached to the dish it produced (issue #696).

const { mockSessions, mockIsLoading, mockRecipes, mockRouter } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockRecipes: makeStore<readonly Recipe[]>([]),
    // Stands in for the address bar. Setting it is how this suite says "a meal
    // sent you here" (issue #752, Phase 3) — there is nowhere else the id could
    // come from, which is the whole point of the phase.
    mockRouter: { querystring: undefined as string | undefined },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), pop: vi.fn(), router: mockRouter }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
// `RecipeChangeSummary` reads the phase feature key since #1212, so this mock is
// now on `featureGate.ts`'s import path and must carry everything it names.
vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  BREAD_FLAG_KEY: 'bread',
  isObservabilityFeatureEnabled: () => false,
  areObservabilityFeatureFlagsSettled: () => true,
  onObservabilityFeatureFlags: () => () => {},
}));
vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  isLoadingSessions: mockIsLoading,
  sendMessage: vi.fn(),
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reopenChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  authorRecipeTraced: vi.fn(),
  attachComponentToMeal: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // Identity — attribution (#845) has its own suite; this one is about the page.
  stampRecipeAttribution: <T>(recipe: T) => recipe,
}));
// Reached through `applyRecipeAmendment`, not by this page (issue #918) — which
// is the point of the suite at the bottom of this file.
vi.mock('../src/lib/guidedPlanService.js', () => ({
  discardGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import ChatSessionPage from '../src/routes/chat/ChatSessionPage.svelte';
import { claimRecipe, sendMessage, reopenChatSession } from '../src/lib/chatService.js';
import { attachComponentToMeal, authorRecipeTraced } from '../src/lib/recipeService.js';
import { addToast } from '../src/lib/toastStore.js';
import { discardGuidedPlan } from '../src/lib/guidedPlanService.js';
import { push } from 'svelte-spa-router';

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  // createdAt is "now", not a fixed date, so this session is never accidentally
  // read-only (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [
      { id: 'm1', role: 'user', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', text: 'hi', createdAt: '2026-01-01T00:00:01.000Z' },
    ],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '2026-01-15T00:00:00.000Z',
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
  vi.mocked(attachComponentToMeal).mockResolvedValue({ kind: 'ok', value: undefined });
  // No in-app history behind the current entry, so `goBack` takes its fallback
  // route (what these tests assert). See src/lib/nav.ts.
  window.history.replaceState(null, '', '#/');
});

function renderPage(id = 'session-1') {
  return render(ChatSessionPage, { props: { params: { id } } });
}

describe('ChatSessionPage — where back goes', () => {
  it('falls back to the recipe when the chat belongs to one', async () => {
    mockSessions._set([makeSession({ recipeId: 'recipe-1' })]);
    const { getByRole } = renderPage();

    await fireEvent.click(getByRole('button', { name: 'Back' }));

    expect(push).toHaveBeenCalledWith('/recipes/recipe-1');
  });

  it('falls back to the chat list for a general chat', async () => {
    mockSessions._set([makeSession({ recipeId: null })]);
    const { getByRole } = renderPage();

    await fireEvent.click(getByRole('button', { name: 'Back' }));

    expect(push).toHaveBeenCalledWith('/chat');
  });
});

describe('ChatSessionPage — save as recipe', () => {
  it('leaves the conversation attached to the recipe it produced', async () => {
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: emptyRecipe('recipe-new', NOW),
    });
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(claimRecipe).toHaveBeenCalledWith('session-1', 'recipe-new'));
    expect(push).toHaveBeenCalledWith('/recipes/recipe-new');
  });

  it('does not claim when the recipe never saved', async () => {
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
    expect(claimRecipe).not.toHaveBeenCalled();
  });

  // The toast names what the librarian actually wrote (issue #765). ONE button
  // still, exactly as before — the model has already worked out which kind it is,
  // so splitting "Save as recipe" into two would ask the user a question that is
  // already answered. The words come from KIND_COPY, never from a comparison.
  it.each([
    ['recipe', 'Recipe created'],
    ['cocktail', 'Cocktail created'],
  ] as const)('says the right thing after saving a %s', async (kind, toast) => {
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: { ...emptyRecipe('recipe-new', NOW), kind },
    });
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(toast, 'success'));
  });
});

// "Save as new recipe" (issue #798): the counterpart on a chat that is ATTACHED
// to a dish. The pair either side of it is the point — "Review changes" folds the
// conversation into this dish, this makes it a different one — so what these
// tests pin is the two things that keep them apart: create mode with no base, and
// no claim.
describe('ChatSessionPage — save as NEW recipe', () => {
  it('is offered on an attached chat, and the general-chat save is not', () => {
    mockSessions._set([makeSession({ recipeId: 'lamb' })]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('chat-save-new-recipe-btn')).toBeInTheDocument();
    // The two are counterparts, never both: one is for a chat with no dish, the
    // other for a chat with one.
    expect(queryByTestId('chat-save-recipe-btn')).toBeNull();
    // …and it sits beside the review gate, which is untouched.
    expect(getByTestId('chat-apply-changes-btn')).toBeInTheDocument();
  });

  it('is not offered on a general chat', () => {
    mockSessions._set([makeSession({ recipeId: null })]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('chat-save-new-recipe-btn')).toBeNull();
  });

  it('waits for the chef to have replied — an empty conversation has nothing to author', () => {
    mockSessions._set([
      makeSession({
        recipeId: 'lamb',
        messages: [
          { id: 'm1', role: 'user', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    ]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('chat-save-new-recipe-btn')).toBeNull();
  });

  it('authors in create mode with no base, and leaves the conversation on the dish it came from', async () => {
    // The load-bearing pair. `basedOnRecipeId` would put the librarian in
    // variation mode and carry the lamb's ingredients into the salad;
    // `claimRecipe` would move this conversation off the lamb's chat card.
    mockSessions._set([makeSession({ recipeId: 'lamb', basedOnRecipeId: 'older-dish' })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: emptyRecipe('salad', NOW),
    });
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-new-recipe-btn'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/salad'));
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect(input.recipeId).toBeUndefined();
    // `null` even though the session HAS a base — an accompaniment is not a variation.
    expect(input.basedOnRecipeId).toBeNull();
    expect(claimRecipe).not.toHaveBeenCalled();
  });
});

// A variation chat (issue #763): started from a dish it is not attached to. Two
// things carry the journey on this page — the chip that says which dish, and the
// base id reaching the librarian so the new recipe carries forward everything the
// conversation never mentioned.
describe('ChatSessionPage — a variation chat', () => {
  function pilaf(): Recipe {
    return { ...emptyRecipe('pilaf', NOW), title: 'Chorizo & Red Pepper Pilaf' };
  }

  it('shows the Based on chip, and taps through to the dish it started from', async () => {
    mockRecipes._set([pilaf()]);
    mockSessions._set([makeSession({ basedOnRecipeId: 'pilaf' })]);
    const { getByTestId } = renderPage();

    const chip = getByTestId('chat-based-on-chip');
    expect(chip.textContent).toContain('Based on: Chorizo & Red Pepper Pilaf');

    await fireEvent.click(chip);
    expect(push).toHaveBeenCalledWith('/recipes/pilaf');
  });

  it('shows no chip on an ordinary chat', () => {
    mockRecipes._set([pilaf()]);
    mockSessions._set([makeSession()]);
    const { queryByTestId } = renderPage();

    expect(queryByTestId('chat-based-on-chip')).toBeNull();
  });

  it('drops the chip when the base recipe has been deleted, and still offers Save', () => {
    // Rule 10 on the client side: the base going away degrades the variation to
    // an ordinary chat rather than breaking the page or blocking the save.
    mockRecipes._set([]);
    mockSessions._set([makeSession({ basedOnRecipeId: 'pilaf' })]);
    const { queryByTestId, getByTestId } = renderPage();

    expect(queryByTestId('chat-based-on-chip')).toBeNull();
    expect(getByTestId('chat-save-recipe-btn')).toBeInTheDocument();
  });

  it('grounds the librarian on the base without handing it a recipe to edit', async () => {
    // `basedOnRecipeId` set, `recipeId` NOT — which is what keeps this on the
    // create path: a new dish with its own name, its own hero and no "makes"
    // link, and the original left untouched.
    mockRecipes._set([pilaf()]);
    mockSessions._set([makeSession({ basedOnRecipeId: 'pilaf' })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: emptyRecipe('recipe-new', NOW),
    });
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(authorRecipeTraced).toHaveBeenCalled());
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect(input.basedOnRecipeId).toBe('pilaf');
    expect(input.recipeId).toBeUndefined();
    // The conversation ends up on the NEW dish, not the one it started from.
    await waitFor(() => expect(claimRecipe).toHaveBeenCalledWith('session-1', 'recipe-new'));
  });
});

// ─── A dish invented for a meal (issue #752, Phase 3) ────────────────────────
// The chat path into a meal is TWO hops — /chat, then /chat/{id} — so the meal's
// id has to survive a navigation. It rides the querystring, which is why a reload
// on either hop keeps it, and why nothing here holds it in module memory.
//
// Both save buttons take the same door: whichever one produced the dish, if a
// meal sent us here the dish is hung off it and the meal is where we land.

describe('ChatSessionPage — saving a dish back onto a meal', () => {
  const SAVED = {
    kind: 'ok' as const,
    value: { ...emptyRecipe('recipe-new', NOW), title: 'Onion gravy' },
  };

  it('attaches the dish to the meal and lands back on the meal', async () => {
    mockRouter.querystring = 'meal=roast';
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue(SAVED);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(attachComponentToMeal).toHaveBeenCalledWith('roast', 'recipe-new'));
    // The claim is untouched — the conversation still belongs to the dish it
    // produced, exactly as it does without a meal.
    expect(claimRecipe).toHaveBeenCalledWith('session-1', 'recipe-new');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/roast'));
    expect(push).not.toHaveBeenCalledWith('/recipes/recipe-new');
  });

  it('does the same from "Save as new recipe" on an attached chat', async () => {
    mockRouter.querystring = 'meal=roast';
    mockSessions._set([makeSession({ recipeId: 'lamb' })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue(SAVED);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-new-recipe-btn'));

    await waitFor(() => expect(attachComponentToMeal).toHaveBeenCalledWith('roast', 'recipe-new'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/roast'));
  });

  it('keeps the recipe, and says so, when the meal has been deleted meanwhile', async () => {
    mockRouter.querystring = 'meal=roast';
    vi.mocked(attachComponentToMeal).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'recipe', id: 'roast' },
    });
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue(SAVED);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    // The dish was written and must not be lost to a failed attach.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/recipe-new'));
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/no longer/i), 'destructive');
  });

  it('behaves exactly as before when no meal sent us here', async () => {
    mockSessions._set([makeSession({ recipeId: null })]);
    vi.mocked(authorRecipeTraced).mockResolvedValue(SAVED);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-save-recipe-btn'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/recipes/recipe-new'));
    expect(attachComponentToMeal).not.toHaveBeenCalled();
  });
});

// Starter prompts (issue #878): the door out of a blank box. This page is not
// standing on a dish, so unless the conversation is a variation the openers are
// general — and whichever is pressed sends down the ordinary send path, so the
// turn is indistinguishable from the same sentence typed by hand.
describe('ChatSessionPage — starter prompts', () => {
  function emptySession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
    return makeSession({ messages: [], ...overrides });
  }

  it('offers general openers on an empty chat, and sends one as an ordinary turn', async () => {
    vi.mocked(sendMessage).mockResolvedValue({ kind: 'ok', value: emptySession() });
    mockSessions._set([emptySession()]);
    const { getAllByTestId, getByRole } = renderPage();

    expect(getAllByTestId('chat-starter').length).toBeGreaterThan(0);

    await fireEvent.click(getByRole('button', { name: 'What shall I cook tonight?' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [, text] = vi.mocked(sendMessage).mock.calls[0]!;
    expect(text).toMatch(/cook tonight/i);
  });

  it('asks about the dish instead when the chat is a variation of one', () => {
    mockRecipes._set([{ ...emptyRecipe('pilaf', NOW), title: 'Chorizo & Red Pepper Pilaf' }]);
    mockSessions._set([emptySession({ basedOnRecipeId: 'pilaf' })]);
    const { getAllByTestId } = renderPage();

    const labels = getAllByTestId('chat-starter').map((b) => b.textContent?.trim());
    expect(labels).toContain('Make it vegetarian');
    expect(labels).not.toContain('What shall I cook tonight?');
  });

  it('withdraws them the moment the conversation has anything in it', () => {
    mockSessions._set([makeSession()]);
    const { queryAllByTestId } = renderPage();

    expect(queryAllByTestId('chat-starter')).toHaveLength(0);
  });
});

// Applying an amendment from the chat page (issue #918).
//
// This surface is why the issue exists: the guided-plan check lived in the
// recipe page's apply handler and nowhere else, so the SAME amendment applied
// from here left the plan pointing at steps that no longer existed. The test is
// at the surface deliberately — the bug was never in the rule, it was in which
// door ran it.
describe('ChatSessionPage — applying an amendment decides the guided plan', () => {
  function pilafWithSteps(): Recipe {
    return {
      ...emptyRecipe('pilaf', NOW),
      title: 'Chorizo & Red Pepper Pilaf',
      steps: [
        { id: 'step-a', text: 'Fry the chorizo.', timer: null, note: null },
        { id: 'step-b', text: 'Add the rice.', timer: null, note: null },
      ],
    };
  }

  async function applyFromChat(getByTestId: (id: string) => HTMLElement) {
    await fireEvent.click(getByTestId('chat-apply-changes-btn'));
    await waitFor(() => expect(getByTestId('recipe-change-apply')).toBeInTheDocument());
    await fireEvent.click(getByTestId('recipe-change-apply'));
  }

  it('discards a plan whose steps the amendment re-minted', async () => {
    mockSessions._set([makeSession({ recipeId: 'pilaf' })]);
    mockRecipes._set([pilafWithSteps()]);
    // What the CF actually returns on an amend: fresh ids for every step.
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: {
        ...pilafWithSteps(),
        steps: [
          { id: 'fresh-1', text: 'Fry the chorizo hard.', timer: null, note: null },
          { id: 'fresh-2', text: 'Add the rice.', timer: null, note: null },
        ],
      },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    const { getByTestId } = renderPage();

    await applyFromChat(getByTestId);

    await waitFor(() => expect(discardGuidedPlan).toHaveBeenCalledExactlyOnceWith('pilaf'));
  });

  it('leaves a plan alone when the amendment kept every step id', async () => {
    mockSessions._set([makeSession({ recipeId: 'pilaf' })]);
    mockRecipes._set([pilafWithSteps()]);
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: { ...pilafWithSteps(), title: 'Chorizo & Red Pepper Pilaf (hot)' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    const { getByTestId } = renderPage();

    await applyFromChat(getByTestId);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Recipe updated!', 'success'));
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });
});

// Read-only after two days, with an explicit costed reopen (issue #1270).
describe('ChatSessionPage — a chat that has gone quiet', () => {
  const OLD = '2026-01-01T00:00:00.000Z'; // long past the real clock's two-day mark

  it('hides the composer and shows the reopen action instead', () => {
    mockSessions._set([makeSession({ createdAt: OLD, updatedAt: OLD })]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(queryByTestId('chat-input')).toBeNull();
    expect(getByTestId('chat-readonly-notice')).toBeInTheDocument();
    expect(getByTestId('chat-reopen-btn')).toBeInTheDocument();
  });

  it('warns about the cost before reopening, and restarts the clock on confirm', async () => {
    mockSessions._set([makeSession({ createdAt: OLD, updatedAt: OLD })]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-reopen-btn'));
    expect(getByTestId('chat-reopen-confirm')).toBeInTheDocument();

    await fireEvent.click(getByTestId('chat-reopen-confirm'));

    await waitFor(() =>
      expect(reopenChatSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'session-1' }),
      ),
    );
    await waitFor(() => expect(queryByTestId('chat-reopen-confirm')).toBeNull());
  });

  it('leaves the dialog open and toasts when the reopen write fails', async () => {
    vi.mocked(reopenChatSession).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
    mockSessions._set([makeSession({ createdAt: OLD, updatedAt: OLD })]);
    const { getByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-reopen-btn'));
    await fireEvent.click(getByTestId('chat-reopen-confirm'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Failed to reopen chat.', 'destructive'),
    );
    expect(getByTestId('chat-reopen-confirm')).toBeInTheDocument();
  });

  it('closes the dialog on Escape without reopening', async () => {
    mockSessions._set([makeSession({ createdAt: OLD, updatedAt: OLD })]);
    const { getByTestId, queryByTestId } = renderPage();

    await fireEvent.click(getByTestId('chat-reopen-btn'));
    expect(getByTestId('chat-reopen-confirm')).toBeInTheDocument();

    await fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(queryByTestId('chat-reopen-confirm')).toBeNull());
    expect(reopenChatSession).not.toHaveBeenCalled();
  });

  it('leaves a fresh chat writable', () => {
    mockSessions._set([makeSession()]);
    const { getByTestId, queryByTestId } = renderPage();

    expect(getByTestId('chat-input')).toBeInTheDocument();
    expect(queryByTestId('chat-readonly-notice')).toBeNull();
  });
});
