/**
 * The browser stops writing the turn (issue #1430) — the two client-side things
 * that break if this is done naively.
 *
 *  1. THE SNAPSHOT GUARD NOW SITS BETWEEN TWO CLOCKS. `latestLocalEdit` drops any
 *     incoming document older than the newest LOCAL edit — a guard against an echo
 *     of our own write. After this change the turn's write is the SERVER's, and it
 *     carries the server's `updatedAt`. A browser running fast would therefore
 *     reject the only copy of the turn that exists, and it would look exactly like
 *     the bug being fixed. `awaitingServerWrite` takes the one snapshot the flow
 *     is about to send out of that comparison.
 *  2. THE TITLE FOLLOW-UP IS A WHOLE-DOCUMENT `setDoc`. Built from the captured
 *     `finalSession`, it puts the browser's copy of the turn back over the
 *     server's under LWW; sent before the flow's write has reached the store, it
 *     leaves the store showing the seed title over a document that has the real
 *     one. It must wait for that write, then compose onto what the store holds.
 *
 * Both are cases nothing else in the suite reaches, and both fail silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mocked } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  isReportableCategory: vi.fn(() => false),
}));

const { deliver } = vi.hoisted(() => ({
  deliver: { snapshot: (_sessions: unknown[]) => {} },
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeChatSessions: vi.fn((_uid: string, onSessions: (s: unknown[]) => void) => {
    deliver.snapshot = onSessions;
    return vi.fn();
  }),
  saveChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  streamChefChat: vi.fn().mockResolvedValue({ kind: 'ok', value: 'A pilaf, at a guess.' }),
  callGenerateChatTitle: vi.fn().mockResolvedValue({ kind: 'ok', value: 'Pilaf night' }),
}));

vi.mock('../src/lib/kitchenMemoryService.js', () => ({
  rememberNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

vi.mock('../src/lib/membersService.js', () => ({
  currentMember: {
    subscribe(fn: (m: unknown) => void) {
      fn({ id: 'm1', name: 'Kate' });
      return () => {};
    },
  },
}));

import * as firebaseSync from '@salt/firebase-sync';
import { sendMessage, initChatSync, getChatSessionsSnapshot } from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

// The browser's clock, a full day ahead of the server's. Not a contrived number:
// the guard compares ISO strings, so any skew larger than the turn's own duration
// has the same effect, and a day simply makes the assertion unambiguous.
const CLIENT_NOW = new Date('2026-09-19T10:00:00.000Z');
const SERVER_WROTE_AT = '2026-09-18T10:00:47.000Z';

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: CLIENT_NOW.toISOString(),
    updatedAt: CLIENT_NOW.toISOString(),
    reopenedAt: null,
    expiresAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

/** What the flow wrote: the same two turns, its own ids, the server's clock. */
function asTheFlowWroteIt(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return makeSession({
    messages: [
      { id: 'srv-1', role: 'user', text: 'what can I make?', createdAt: SERVER_WROTE_AT },
      {
        id: 'srv-2',
        role: 'assistant',
        text: 'A pilaf, at a guess.',
        createdAt: SERVER_WROTE_AT,
      },
    ],
    updatedAt: SERVER_WROTE_AT,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(CLIENT_NOW);
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.streamChefChat.mockResolvedValue({ kind: 'ok', value: 'A pilaf, at a guess.' });
  fs.callGenerateChatTitle.mockResolvedValue({ kind: 'ok', value: 'Pilaf night' });
  initChatSync('u1');
  deliver.snapshot([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chatService — the flow owns the turn', () => {
  it('accepts the flow write even though the browser clock runs a day fast', async () => {
    await sendMessage(makeSession(), 'what can I make?', () => {});

    deliver.snapshot([asTheFlowWroteIt()]);

    // Without the bypass, `updatedAt` a day behind the browser's stamp is read as
    // a stale echo and the only stored copy of the turn is thrown away.
    const shown = getChatSessionsSnapshot().find((s) => s.id === 'sess-1');
    expect(shown?.messages.map((m) => m.id)).toEqual(['srv-1', 'srv-2']);
  });

  it('still guards an ordinary stale snapshot once the flow write has landed', async () => {
    // The bypass is for ONE snapshot, not a licence. After the flow's write has
    // been accepted, a local edit is protected exactly as it was before.
    await sendMessage(makeSession(), 'what can I make?', () => {});
    deliver.snapshot([asTheFlowWroteIt()]);

    deliver.snapshot([makeSession({ messages: [], updatedAt: '2026-09-17T00:00:00.000Z' })]);

    const shown = getChatSessionsSnapshot().find((s) => s.id === 'sess-1');
    expect(shown?.messages).toHaveLength(2);
  });

  it('releases the bypass when the send fails, since no write is coming', async () => {
    fs.streamChefChat.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });

    await sendMessage(
      makeSession({ updatedAt: CLIENT_NOW.toISOString() }),
      'what can I make?',
      () => {},
    );

    // A stale document arriving after a failed send must NOT jump the guard: the
    // store's copy is the one the composer's rollback restored.
    deliver.snapshot([makeSession({ title: 'clobbered', updatedAt: '2026-09-17T00:00:00.000Z' })]);
    expect(getChatSessionsSnapshot().find((s) => s.id === 'sess-1')?.title).not.toBe('clobbered');
  });
});

describe('chatService — the generated title cannot clobber the turn', () => {
  it('waits for the flow write, then composes the title onto it', async () => {
    await sendMessage(makeSession(), 'what can I make?', () => {});

    // Nothing written yet: the title is held until the flow's document arrives.
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.saveChatSession).not.toHaveBeenCalled();

    deliver.snapshot([asTheFlowWroteIt()]);
    await vi.advanceTimersByTimeAsync(0);

    const saved = fs.saveChatSession.mock.calls.at(-1)?.[0] as ChatSessionDoc;
    expect(saved.title).toBe('Pilaf night');
    // The SERVER's turn ids — the captured `finalSession`'s would put the
    // browser's copy of the turn back over the flow's under LWW.
    expect(saved.messages.map((m) => m.id)).toEqual(['srv-1', 'srv-2']);
  });

  it('drops the title rather than writing one over a turn that never landed', async () => {
    await sendMessage(makeSession(), 'what can I make?', () => {});
    await vi.advanceTimersByTimeAsync(0);

    // The flow's write failed, so no snapshot for it ever arrives. A lost title is
    // the cosmetic half #1430 names; a write built on the optimistic copy would be
    // the expensive half.
    expect(fs.saveChatSession).not.toHaveBeenCalled();
  });
});
