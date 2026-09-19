import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The origin chat claims the recipe it produced (issue #696), and a chat started
// from a recipe is named after the dish. Both are one-line writes whose VALUE is
// entirely in when they do and do not happen.

vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  isReportableCategory: vi.fn(() => false),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeChatSessions: vi.fn(() => vi.fn()),
  saveChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  streamChefChat: vi.fn(),
  callGenerateChatTitle: vi.fn().mockResolvedValue({ kind: 'ok', value: '' }),
}));

// chatService reaches the kitchen-memory service for `/remember` (issue #816), and
// the real one drags in membersService → auth.svelte.ts → firebase.ts, which calls
// initFirebase() at module load. Mocked HERE rather than by widening the
// @salt/firebase-sync mock above: this suite is about titles and claims, and the
// narrower seam keeps it that way.
vi.mock('../src/lib/kitchenMemoryService.js', () => ({
  rememberNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

// chatService now reads the signed-in member's display NAME, to tell the chef who
// it is talking to (issue #816, phase 2). Mocked at the same seam and for the same
// reason as kitchenMemoryService above: the real module reaches auth.svelte.ts →
// firebase.ts, which calls initFirebase() at module load.
vi.mock('../src/lib/membersService.js', () => ({
  currentMember: {
    subscribe(fn: (m: unknown) => void) {
      fn({ id: 'm1', name: 'Kate', email: 'kate@example.com' });
      return () => {};
    },
  },
}));

import * as firebaseSync from '@salt/firebase-sync';
import { trackUsageEvent } from '@salt/observability';
import { claimRecipe, createChatSession, sessions } from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

function saved(): ChatSessionDoc[] {
  return fs.saveChatSession.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('createChatSession — seed title', () => {
  it('names a recipe chat after the dish', async () => {
    const result = await createChatSession('uid-1', 'recipe-1', 'Cauliflower Steaks');

    expect(result.kind).toBe('ok');
    expect(saved()[0]!.title).toBe('Cauliflower Steaks chat');
  });

  it('falls back to the old wording when no title is to hand', async () => {
    await createChatSession('uid-1', 'recipe-1');

    expect(saved()[0]!.title).toBe('Recipe chat');
  });

  it('leaves a general chat alone', async () => {
    await createChatSession('uid-1', null, 'Cauliflower Steaks');

    expect(saved()[0]!.title).toBe('New chat');
    expect(saved()[0]!.recipeId).toBeNull();
  });

  it('names a variation chat after the dish it starts from', async () => {
    await createChatSession('uid-1', null, 'Chorizo & Red Pepper Pilaf', 'recipe-1');

    expect(saved()[0]!.title).toBe('Chorizo & Red Pepper Pilaf variation');
  });

  it('falls back to neutral wording when the base dish has no title to hand', async () => {
    await createChatSession('uid-1', null, undefined, 'recipe-1');

    expect(saved()[0]!.title).toBe('Recipe variation');
  });
});

// A variation chat (issue #763) STARTS FROM a recipe without BELONGING to one.
// Keeping the two fields apart is what makes the journey work: it does not show
// in the base recipe's chat list, it keeps the ordinary 14-day expiry until it
// produces something, and when it does, it claims the NEW dish.
describe('createChatSession — a variation is not an attached chat', () => {
  it('records the base recipe without attaching the session to it', async () => {
    await createChatSession('uid-1', null, 'Chorizo & Red Pepper Pilaf', 'recipe-1');

    expect(saved()[0]!.basedOnRecipeId).toBe('recipe-1');
    expect(saved()[0]!.recipeId).toBeNull();
  });

  it('leaves an ordinary chat with no base recipe', async () => {
    await createChatSession('uid-1', null);
    await createChatSession('uid-1', 'recipe-1', 'Cauliflower Steaks');

    expect(saved()[0]!.basedOnRecipeId).toBeNull();
    expect(saved()[1]!.basedOnRecipeId).toBeNull();
  });

  it('claims the new recipe on save and keeps pointing at the original', async () => {
    const created = await createChatSession('uid-1', null, 'Pilaf', 'original');
    const id = created.kind === 'ok' ? created.value.id : '';
    fs.saveChatSession.mockClear();

    await claimRecipe(id, 'the-prawn-version');

    const session = get(sessions).find((s) => s.id === id)!;
    expect(session.recipeId).toBe('the-prawn-version');
    expect(session.basedOnRecipeId).toBe('original');
  });
});

describe('createChatSession — chat_context', () => {
  it('tells the three journeys apart', async () => {
    await createChatSession('uid-1', null);
    await createChatSession('uid-1', 'recipe-1', 'Cauliflower Steaks');
    await createChatSession('uid-1', null, 'Pilaf', 'recipe-2');

    const contexts = vi
      .mocked(trackUsageEvent)
      .mock.calls.filter(([name]) => name === 'chat.started')
      .map(([, props]) => (props as { chat_context: string }).chat_context);
    expect(contexts).toEqual(['blank', 'recipe', 'variation']);
  });
});

describe('claimRecipe', () => {
  it('attaches a general chat to the recipe it produced', async () => {
    const created = await createChatSession('uid-1', null);
    expect(created.kind).toBe('ok');
    const id = created.kind === 'ok' ? created.value.id : '';
    fs.saveChatSession.mockClear();

    const result = await claimRecipe(id, 'recipe-1');

    expect(result.kind).toBe('ok');
    expect(saved()[0]!.recipeId).toBe('recipe-1');
    expect(get(sessions).find((s) => s.id === id)!.recipeId).toBe('recipe-1');
  });

  it('never moves a link that already exists — first claim wins', async () => {
    const created = await createChatSession('uid-1', 'recipe-1', 'Cauliflower Steaks');
    const id = created.kind === 'ok' ? created.value.id : '';
    fs.saveChatSession.mockClear();

    const result = await claimRecipe(id, 'recipe-2');

    expect(result.kind).toBe('ok');
    expect(fs.saveChatSession).not.toHaveBeenCalled();
    expect(get(sessions).find((s) => s.id === id)!.recipeId).toBe('recipe-1');
  });

  it('is a no-op for a session the store has never seen', async () => {
    fs.saveChatSession.mockClear();

    const result = await claimRecipe('ghost', 'recipe-1');

    expect(result.kind).toBe('ok');
    expect(fs.saveChatSession).not.toHaveBeenCalled();
  });
});
