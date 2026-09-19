/**
 * The flow writes the turn it just streamed (issue #1430) — the write itself.
 *
 * `writeChefChatTurn` takes its `db` as a parameter for the same reason
 * `writeKitchenNoteForChef` does: it is the only thing that makes the write
 * testable without a live Firestore. The flow binds the real handle.
 *
 * Four claims, each of which is a real defect if it is wrong:
 *
 *  1. THE TRANSCRIPT IT APPENDS TO IS THE DOCUMENT'S, never the history on the
 *     wire. `chatService` strips every `/remember …` line before sending, so the
 *     wire history is not a faithful copy of the conversation and a write built
 *     from it would silently delete those lines from storage.
 *  2. THE OWNERSHIP CHECK `firestore.rules` STOPS PERFORMING IS RE-CREATED HERE.
 *     An Admin SDK write bypasses the rules wholesale, so without this a
 *     client-supplied `sessionId` is a write primitive into another user's chat.
 *  3. `expiresAt` IS BUMPED, AS A `Timestamp`. A full `.set()` that omitted it
 *     would switch that document's TTL off in silence (#1008), and carrying the
 *     old value forward lets a chat expire mid-conversation.
 *  4. IT NEVER THROWS. A Firestore hiccup must not throw away a completed,
 *     already-paid-for turn (Rule 10, and `persistAuthoredRecipe`'s reasoning).
 *
 * The real `firebase-admin` `Timestamp` is used deliberately — claim 3 is about
 * the wire TYPE, and a fake would assert only that the fake was called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { ChatSessionDoc } from '@salt/domain/schemas';

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (_config: unknown, handler: unknown) => handler,
    generateStream: vi.fn(),
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));
const mockReportFlowError = vi.fn(async () => undefined);
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: mockReportFlowError,
}));

const { writeChefChatTurn } = await import('../../src/flows/chefChat.js');

const mockWarn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
const mockError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

const ASKED_AT = new Date('2026-09-18T10:00:00.000Z');
const REPLIED_AT = new Date('2026-09-18T10:00:47.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function storedSession(overrides: Partial<ChatSessionDoc> = {}): Record<string, unknown> {
  const doc: ChatSessionDoc = {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: '2026-09-17T08:00:00.000Z',
    updatedAt: '2026-09-17T08:00:00.000Z',
    reopenedAt: null,
    pendingSaveIntent: null,
    expiresAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
  // As it is on the wire since #1008, which is also what the read path has to
  // cope with: a `Timestamp`, not the ISO string the domain schema names.
  return { ...doc, expiresAt: Timestamp.fromDate(new Date(doc.expiresAt)) };
}

function fakeDb(snapshot: { exists: boolean; data?: unknown }, setImpl?: () => Promise<void>) {
  const set = vi.fn(setImpl ?? (async () => undefined));
  const ref = {
    get: async () => ({ exists: snapshot.exists, id: 'sess-1', data: () => snapshot.data }),
    set,
  };
  const doc = vi.fn(() => ref);
  const collection = vi.fn(() => ({ doc }));
  return { db: { collection } as unknown as ReturnType<typeof getFirestore>, set, collection, doc };
}

function turn(overrides: Partial<Parameters<typeof writeChefChatTurn>[1]> = {}) {
  return {
    sessionId: 'sess-1',
    caller: { uid: 'uid-1' },
    userText: 'what can I make with what I have?',
    replyText: 'A pilaf, at a guess.',
    askedAt: ASKED_AT,
    repliedAt: REPLIED_AT,
    ...overrides,
  };
}

function written(set: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return set.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeChefChatTurn — the turn reaches Firestore', () => {
  it('appends both turns to the document it read', async () => {
    const { db, set, collection } = fakeDb({ exists: true, data: storedSession() });

    await writeChefChatTurn(db, turn());

    expect(collection).toHaveBeenCalledWith('chatSessions');
    const doc = written(set);
    expect(doc['messages']).toEqual([
      {
        id: expect.any(String),
        role: 'user',
        text: 'what can I make with what I have?',
        createdAt: ASKED_AT.toISOString(),
      },
      {
        id: expect.any(String),
        role: 'assistant',
        text: 'A pilaf, at a guess.',
        createdAt: REPLIED_AT.toISOString(),
      },
    ]);
    expect(doc['updatedAt']).toBe(REPLIED_AT.toISOString());
  });

  it('appends to the STORED transcript, not to the history that was on the wire', async () => {
    // The whole reason this is a read-then-`.set()` and not a rebuild from
    // `input.messages`: the wire history has every `/remember …` line stripped
    // out of it, and a write built from it would delete them from storage.
    const { db, set } = fakeDb({
      exists: true,
      data: storedSession({
        messages: [
          {
            id: 'm1',
            role: 'user',
            text: '/remember we hate coriander',
            createdAt: '2026-09-17T08:01:00.000Z',
          },
        ],
      }),
    });

    await writeChefChatTurn(db, turn());

    const messages = written(set)['messages'] as { text: string }[];
    expect(messages.map((m) => m.text)).toEqual([
      '/remember we hate coriander',
      'what can I make with what I have?',
      'A pilaf, at a guess.',
    ]);
  });

  it('bumps expiresAt to a fortnight from the reply, as a Timestamp', async () => {
    const { db, set } = fakeDb({ exists: true, data: storedSession() });

    await writeChefChatTurn(db, turn());

    const stored = written(set)['expiresAt'];
    expect(stored).toBeInstanceOf(Timestamp);
    expect((stored as Timestamp).toDate().getTime()).toBe(REPLIED_AT.getTime() + 14 * DAY_MS);
  });

  it('gives a recipe-attached chat the eighteen-month window, from the same one place', async () => {
    const { db, set } = fakeDb({
      exists: true,
      data: storedSession({ recipeId: 'recipe-1' }),
    });

    await writeChefChatTurn(db, turn());

    const stored = written(set)['expiresAt'] as Timestamp;
    expect(stored.toDate().getTime()).toBe(REPLIED_AT.getTime() + 540 * DAY_MS);
  });
});

describe('writeChefChatTurn — what firestore.rules no longer sees', () => {
  it('writes nothing when the document belongs to another user', async () => {
    // The rules' `resource.data.ownerUid == request.auth.uid` (#408) is bypassed
    // by an Admin SDK write, so without this check a client-supplied sessionId
    // would be a write primitive into someone else's conversation.
    const { db, set } = fakeDb({ exists: true, data: storedSession({ ownerUid: 'someone-else' }) });

    await writeChefChatTurn(db, turn({ caller: { uid: 'uid-1' } }));

    expect(set).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('writes nothing when the turn carried no verified caller', async () => {
    // Cannot happen behind `isSignedIn()`, and therefore not a case to be
    // generous about: no uid, no write.
    const { db, set } = fakeDb({ exists: true, data: storedSession() });

    await writeChefChatTurn(db, turn({ caller: null }));

    expect(set).not.toHaveBeenCalled();
  });

  it('writes nothing when the session does not exist', async () => {
    const { db, set } = fakeDb({ exists: false });

    await writeChefChatTurn(db, turn());

    expect(set).not.toHaveBeenCalled();
  });

  it('writes nothing over a session it could not read', async () => {
    // Same reasoning as `writeKitchenNoteForChef` leaving an unreadable note
    // alone: writing over a document we could not parse destroys whatever it
    // actually held.
    const { db, set } = fakeDb({ exists: true, data: { id: 'sess-1', title: 42 } });

    await writeChefChatTurn(db, turn());

    expect(set).not.toHaveBeenCalled();
  });
});

describe('writeChefChatTurn — it never throws', () => {
  it('swallows and logs a failed write', async () => {
    const { db } = fakeDb({ exists: true, data: storedSession() }, async () => {
      throw new Error('firestore unavailable');
    });

    await expect(writeChefChatTurn(db, turn())).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalled();
  });

  it('swallows and logs a failed read', async () => {
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw new Error('firestore unavailable');
          },
        }),
      }),
    } as unknown as ReturnType<typeof getFirestore>;

    await expect(writeChefChatTurn(db, turn())).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalled();
  });
});

describe('writeChefChatTurn — a failed write is reported, not just logged', () => {
  it('reports a failed write through reportFlowError, additively to the log line', async () => {
    // Before this fix the catch here logged to Cloud Logging alone — the same
    // failure category the pre-#1430 `persistSession` path reached PostHog with,
    // via `reportIfFailed` (review of this PR). Uncategorised: this is a raw
    // Firestore exception, not a classified Result envelope.
    const { db } = fakeDb({ exists: true, data: storedSession() }, async () => {
      throw new Error('firestore unavailable');
    });

    await writeChefChatTurn(db, turn());

    expect(mockError).toHaveBeenCalled();
    expect(mockReportFlowError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not report when there is nothing to write (not-found, ownership, unreadable)', async () => {
    const { db } = fakeDb({ exists: false });

    await writeChefChatTurn(db, turn());

    // These are ordinary, expected outcomes — not failures — and the existing
    // `logger.warn` sites for them are unaffected by this fix.
    expect(mockReportFlowError).not.toHaveBeenCalled();
  });
});
