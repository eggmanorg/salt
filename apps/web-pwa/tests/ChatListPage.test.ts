import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// The chat list as a WAYPOINT (issue #752, Phase 3).
//
// "Chat with AI" on a meal lands here, not on a conversation: /chat is a list and
// the session is a second hop. That is precisely why the meal's id has to live in
// the URL — anything held in module memory would not survive the navigation, let
// alone a reload while the user reads the list.

const { mockSessions, mockIsLoading, mockRouter } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
    mockIsLoading: makeStore<boolean>(false),
    mockRouter: { querystring: undefined as string | undefined },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: mockRouter }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: { uid: 'uid-1' } } }));
vi.mock('../src/lib/chatService.js', () => ({
  // Issue #1480: the recipe page and the full chat page read the save request
  // the chef recorded. Never fires here — no fixture carries one — but the
  // whole-module mock has to carry every export the page names.
  consumeSaveIntent: vi.fn().mockResolvedValue(false),
  sessions: mockSessions,
  isLoadingSessions: mockIsLoading,
  createChatSession: vi.fn(),
  removeSession: vi.fn(),
}));

import ChatListPage from '../src/routes/chat/ChatListPage.svelte';
import { createChatSession } from '../src/lib/chatService.js';
import { push } from 'svelte-spa-router';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoading._set(false);
  mockSessions._set([]);
  mockRouter.querystring = undefined;
  vi.mocked(createChatSession).mockResolvedValue({
    kind: 'ok',
    value: { id: 'session-9' },
  } as Awaited<ReturnType<typeof createChatSession>>);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ChatListPage — starting a chat', () => {
  it('opens the new session', async () => {
    render(ChatListPage);

    await fireEvent.click(screen.getByTestId('chat-new-btn'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/chat/session-9'));
  });

  it('carries a meal through to the session it creates', async () => {
    mockRouter.querystring = 'meal=roast';
    render(ChatListPage);

    await fireEvent.click(screen.getByTestId('chat-new-btn'));

    // The second hop of the chat path. Nothing else about this page changes —
    // the session is created exactly as it always was.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/chat/session-9?meal=roast'));
    expect(createChatSession).toHaveBeenCalledWith('uid-1', null);
  });
});
