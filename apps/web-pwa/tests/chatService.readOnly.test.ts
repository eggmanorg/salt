import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { CHAT_READ_ONLY_AFTER_MS } from '@salt/domain';

// Read-only after two days, with a costed reopen (issue #1270). `sendMessage`'s
// guard is defence-in-depth — the composer is the primary gate — and
// `reopenChatSession` is the one write "Make read-write" performs.

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

vi.mock('../src/lib/kitchenMemoryService.js', () => ({
  rememberNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

vi.mock('../src/lib/membersService.js', () => ({
  currentMember: {
    subscribe(fn: (m: unknown) => void) {
      fn({ id: 'm1', name: 'Kate', email: 'kate@example.com' });
      return () => {};
    },
  },
}));

import * as firebaseSync from '@salt/firebase-sync';
import { sendMessage, reopenChatSession } from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

function quietSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: new Date(Date.now() - CHAT_READ_ONLY_AFTER_MS - 1000).toISOString(),
    updatedAt: new Date(Date.now() - CHAT_READ_ONLY_AFTER_MS - 1000).toISOString(),
    reopenedAt: null,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('sendMessage — the read-only guard', () => {
  it('refuses a chat whose first message is more than two days old', async () => {
    const result = await sendMessage(quietSession(), 'still there?', () => {});

    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.error).toEqual({
      kind: 'ValidationError',
      code: 'CHAT_READ_ONLY',
    });
    expect(fs.streamChefChat).not.toHaveBeenCalled();
  });

  it('lets a reopened chat through, even though createdAt is old', async () => {
    fs.streamChefChat.mockResolvedValue({ kind: 'ok', value: 'still here!' });
    const session = quietSession({ reopenedAt: new Date().toISOString() });

    const result = await sendMessage(session, 'still there?', () => {});

    expect(result.kind).toBe('ok');
    expect(fs.streamChefChat).toHaveBeenCalledTimes(1);
  });
});

describe('reopenChatSession', () => {
  it('stamps reopenedAt and saves — the clock now runs from this moment', async () => {
    const session = quietSession();

    const result = await reopenChatSession(session);

    expect(result.kind).toBe('ok');
    const saved = fs.saveChatSession.mock.calls.at(-1)?.[0] as ChatSessionDoc;
    expect(saved.reopenedAt).not.toBeNull();
    expect(new Date(saved.reopenedAt!).getTime()).toBeGreaterThan(
      new Date(session.createdAt).getTime(),
    );
  });

  it('surfaces a failed write rather than pretending the chat reopened', async () => {
    fs.saveChatSession.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });

    const result = await reopenChatSession(quietSession());

    expect(result.kind).toBe('err');
  });
});
