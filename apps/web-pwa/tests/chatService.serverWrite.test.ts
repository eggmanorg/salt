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
    pendingSaveIntent: null,
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

describe('chatService — an unrelated write mid-turn cannot wipe the optimistic turn', () => {
  it('keeps the optimistic user turn when the session is re-delivered with no new turn on it', async () => {
    // `subscribeChatSessions` re-delivers the owner's WHOLE session set on every
    // change to ANY of the user's sessions (review of this PR). The commonest
    // case is the title callable's own `persistSession` echo landing while a
    // later turn is still in flight — same session id, but the PRE-TURN message
    // count, since the flow has not written yet.
    //
    // A DEDICATED session id, not 'sess-1': `awaitingServerWrite` is module state
    // that outlives a single test (nothing in this file resets it in `afterEach`),
    // and another test's still-pending wait for 'sess-1' would otherwise resolve
    // here as a side effect of the very displacement fix this suite also covers.
    const id = 'sess-mid-turn-echo';
    let resolveStream!: (v: { kind: 'ok'; value: string }) => void;
    fs.streamChefChat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStream = resolve;
      }),
    );

    const sendPromise = sendMessage(makeSession({ id }), 'what can I make?', () => {});

    // The echo: same session, no new messages, just a changed field (as a title
    // write would produce).
    deliver.snapshot([
      makeSession({ id, title: 'New chat', updatedAt: '2026-09-19T10:00:00.500Z' }),
    ]);

    const midTurn = getChatSessionsSnapshot().find((s) => s.id === id);
    expect(midTurn?.messages).toHaveLength(1);
    expect(midTurn?.messages[0]?.text).toBe('what can I make?');

    resolveStream({ kind: 'ok', value: 'A pilaf, at a guess.' });
    await sendPromise;

    const afterReply = getChatSessionsSnapshot().find((s) => s.id === id);
    expect(afterReply?.messages).toHaveLength(2);
  });
});

describe('chatService — the store never un-supersedes a landed flow write', () => {
  it('keeps the flow document when its snapshot lands before the callable resolves', async () => {
    // The flow `await`s its Firestore write before returning, so the listener can
    // deliver that document before `streamChefChat` resolves here — not a rare
    // interleaving, just a race between two round trips (review of this PR).
    const id = 'sess-race-with-flow';
    let resolveStream!: (v: { kind: 'ok'; value: string }) => void;
    fs.streamChefChat.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStream = resolve;
      }),
    );

    const sendPromise = sendMessage(makeSession({ id }), 'what can I make?', () => {});

    deliver.snapshot([asTheFlowWroteIt({ id })]);

    resolveStream({ kind: 'ok', value: 'A pilaf, at a guess.' });
    await sendPromise;

    // Un-superseded would put the browser's turn ids back; the server's must win.
    const shown = getChatSessionsSnapshot().find((s) => s.id === id);
    expect(shown?.messages.map((m) => m.id)).toEqual(['srv-1', 'srv-2']);
  });
});

describe('chatService — a displaced wait resolves rather than leaking', () => {
  it('does not hang the first turn behind a second send on the same session', async () => {
    const id = 'sess-displaced-wait';
    await sendMessage(makeSession({ id }), 'first', () => {});
    await vi.advanceTimersByTimeAsync(0);

    // Turn 1's flow write has not landed yet, so its title generation is parked
    // on `serverWrite.landed`. A second `sendMessage` on the SAME session id
    // (a quick follow-up sent before the first turn's title callable resolved)
    // used to silently displace the map entry without resolving it — leaving
    // turn 1's `landed` unsettled forever, and its generated title dropped
    // although the flow's write had not failed.
    await sendMessage(makeSession({ id }), 'second', () => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(fs.saveChatSession).toHaveBeenCalled();
  });
});
