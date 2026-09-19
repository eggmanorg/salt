/**
 * The turn survives the reader going away (issue #1430) — the whole point of
 * moving the write here.
 *
 * `writeChefChatTurn` runs AFTER the drain loop. That ordering is the fix, and it
 * is also its one structural risk: anything that can throw out of the loop takes
 * the write with it, in exactly the case the write exists for. A phone that
 * locked mid-reply is a closed SSE socket, so the emit is the thing to worry
 * about.
 *
 * `firebase-functions@7.3.2` does not throw there — `wrapOnCallHandler` aborts a
 * controller on `res.on('close')` and `sendChunk` then returns
 * `Promise.resolve(false)`, which `onCallGenkit` ignores. That is read from the
 * pinned dependency's source, and it is a property of a transport this repo does
 * not own. So the flow wraps the emit and this file pins the wrapper: BREAK IT
 * AND THE FIRST TEST BELOW GOES RED, whatever any future `firebase-functions`
 * does.
 *
 * The second half is the regression this issue is actually about: with no client
 * write anywhere in the picture, a completed turn is in Firestore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

const mockGenerateStream = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (_config: unknown, handler: unknown) => handler,
    generateStream: mockGenerateStream,
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));

const { mockSet, session, setStored, FakeTimestamp } = vi.hoisted(() => {
  class FakeTimestamp {
    constructor(private readonly ms: number) {}
    static fromDate(date: Date): FakeTimestamp {
      return new FakeTimestamp(date.getTime());
    }
    toDate(): Date {
      return new Date(this.ms);
    }
  }
  const session: { exists: boolean; data?: unknown } = { exists: true };
  return {
    mockSet: vi.fn(async (_doc: unknown) => undefined),
    session,
    setStored: (data: unknown) => {
      session.data = data;
    },
    FakeTimestamp,
  };
});

vi.mock('firebase-admin/firestore', () => {
  const empty = { docs: [], empty: true, size: 0, forEach: () => {} };
  const query = {
    get: async () => empty,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
  };
  return {
    Timestamp: FakeTimestamp,
    getFirestore: () => ({
      collection: (name: string) => ({
        ...query,
        doc: (id: string) => ({
          id,
          get: async () =>
            name === 'chatSessions'
              ? { exists: session.exists, id, data: () => session.data }
              : { exists: false, id, data: () => undefined },
          set: mockSet,
        }),
      }),
      getAll: async () => [],
    }),
  };
});

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

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
  return { ...doc, expiresAt: FakeTimestamp.fromDate(new Date(doc.expiresAt)) };
}

async function* chunks(...texts: string[]): AsyncGenerator<{ text: string }> {
  for (const text of texts) yield { text };
}

/** A streaming callback carrying the verified caller, as `onCallGenkit` supplies it. */
function callback(onChunk: (t: string) => void, uid: string | null = 'uid-1') {
  const cb = (t: string) => onChunk(t);
  if (uid !== null) Object.assign(cb, { context: { auth: { uid } } });
  return cb;
}

function runTurn(cb: (t: string) => void, input: Record<string, unknown> = {}): Promise<string> {
  return (
    chefChatFlow as unknown as (
      input: unknown,
      streamingCallback: (t: string) => void,
    ) => Promise<string>
  )(
    { messages: [], newMessage: 'what can I make?', recipeId: null, sessionId: 'sess-1', ...input },
    cb,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  session.exists = true;
  setStored(storedSession());
  mockGenerateStream.mockReturnValue({
    stream: chunks('A pilaf,', ' at a guess.'),
    response: Promise.resolve({ messages: [], text: ' at a guess.' }),
  });
});

describe('chefChat — the turn outlives the reader', () => {
  it('writes the turn even when every emit throws', async () => {
    // A dead SSE socket, in the only shape that could hurt: the emit raising.
    // The drain must finish and the write must still happen.
    const emit = vi.fn(() => {
      throw new Error('socket closed');
    });

    await expect(runTurn(callback(emit))).resolves.toBe('A pilaf, at a guess.');

    expect(emit).toHaveBeenCalledTimes(2);
    const messages = (mockSet.mock.calls.at(-1)?.[0] as { messages: { text: string }[] }).messages;
    expect(messages.map((m) => m.text)).toEqual(['what can I make?', 'A pilaf, at a guess.']);
  });

  it('writes a completed turn with no client write anywhere in the picture', async () => {
    // The regression, stated as this issue states it: nothing on the browser side
    // runs here at all, and both the user's sentence and the reply are in
    // Firestore when the flow returns.
    await expect(runTurn(callback(() => {}))).resolves.toBe('A pilaf, at a guess.');

    expect(mockSet).toHaveBeenCalledTimes(1);
    const doc = mockSet.mock.calls.at(0)?.[0] as { messages: { role: string; text: string }[] };
    expect(doc.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'what can I make?' }),
      expect.objectContaining({ role: 'assistant', text: 'A pilaf, at a guess.' }),
    ]);
  });

  it('stores what was STREAMED, not the last model message', async () => {
    // `streamedText` is the accumulation across every tool-loop iteration;
    // `response.text` is the tail alone (`chefChat.turnText.test.ts`). The write
    // must store exactly the string the flow returns.
    const reply = await runTurn(callback(() => {}));
    const doc = mockSet.mock.calls.at(0)?.[0] as { messages: { text: string }[] };
    expect(doc.messages.at(-1)?.text).toBe(reply);
    expect(doc.messages.at(-1)?.text).not.toBe(' at a guess.');
  });
});

describe('chefChat — a turn that cannot be written still answers', () => {
  it('writes nothing and returns the reply when no sessionId was sent', async () => {
    // A browser left on an older bundle after a deploy. It persists the turn
    // itself, so the flow writing nothing is correct rather than merely tolerated.
    await expect(
      runTurn(
        callback(() => {}),
        { sessionId: undefined },
      ),
    ).resolves.toBe('A pilaf, at a guess.');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('returns the reply when the write fails', async () => {
    mockSet.mockRejectedValueOnce(new Error('firestore unavailable'));

    await expect(runTurn(callback(() => {}))).resolves.toBe('A pilaf, at a guess.');
  });

  it('returns the reply when the session belongs to someone else', async () => {
    setStored(storedSession({ ownerUid: 'someone-else' }));

    await expect(runTurn(callback(() => {}))).resolves.toBe('A pilaf, at a guess.');
    expect(mockSet).not.toHaveBeenCalled();
  });
});
