/**
 * A chef that goes quiet mid-answer fails the turn instead of hanging it
 * (issue #915, finding A5-001).
 *
 * chefChat is the one streaming flow. Its drain loop used to run bare, with
 * `withAiTimeout` applied afterwards to the aggregated response — which the
 * flow's own comment described as "already draining above". A model that stops
 * delivering never reaches that wrapper, so the turn sat there until the 120s
 * function quota killed the instance: no error to the client, no reported
 * failure, one wasted invocation.
 *
 * These tests exercise the real `withAiStreamTimeout` (this file deliberately
 * does NOT stub `../../src/adapters/withAiTimeout.js`, unlike its sibling
 * chefChat suites) so what is pinned is the flow's actual behaviour, not a
 * stand-in's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('firebase-functions', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockGenerateStream = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    // chefChat defines its findRecipes tool at module load (issue #840); the
    // identity stub keeps importing the module free for tests that are not about it.
    defineTool: (_config: unknown, handler: unknown) => handler,
    generateStream: mockGenerateStream,
  },
}));

vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));

const mockReportFlowError = vi.fn(async () => undefined);
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: mockReportFlowError,
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: (id: string) => ({ id, get: async () => ({ exists: false, data: () => undefined }) }),
    }),
    getAll: async () => [],
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');
const { AiTimeoutError, AI_STREAM_IDLE_TIMEOUT_MS } =
  await import('../../src/adapters/withAiTimeout.js');

type Chunk = { text: string };

function runTurn(onChunk: (t: string) => void): Promise<string> {
  return (
    chefChatFlow as unknown as (
      input: unknown,
      streamingCallback: (t: string) => void,
    ) => Promise<string>
  )({ messages: [], newMessage: 'what shall we have?' }, onChunk);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chefChat — the stream itself is under the deadline', () => {
  it('fails the turn when the model stops delivering mid-answer', async () => {
    vi.useFakeTimers();
    async function* stalls(): AsyncGenerator<Chunk> {
      yield { text: 'Braise the ' };
      yield { text: 'shin until ' };
      // …and then nothing, ever. Before #915 this held the whole invocation.
      await new Promise(() => {});
    }
    mockGenerateStream.mockReturnValue({
      stream: stalls(),
      // Never resolves either — the aggregate cannot settle while the stream is
      // stuck, which is exactly why guarding it was no guard at all.
      response: new Promise(() => {}),
    });

    const relayed: string[] = [];
    const turn = runTurn((t) => relayed.push(t));
    const assertion = expect(turn).rejects.toThrow(AiTimeoutError);
    await vi.advanceTimersByTimeAsync(AI_STREAM_IDLE_TIMEOUT_MS + 1);
    await assertion;

    // Everything the chef managed to say still reached the client.
    expect(relayed).toEqual(['Braise the ', 'shin until ']);
    // And the failure is reported, not swallowed — the flow's catch is reached.
    expect(mockReportFlowError).toHaveBeenCalledOnce();
  });

  it('leaves a slow but productive answer alone', async () => {
    vi.useFakeTimers();
    // Gaps well inside the idle budget, for far longer in total than the budget:
    // proof the deadline is silence, not total duration.
    const texts = ['One. ', 'Two. ', 'Three. ', 'Four. ', 'Five.'];
    const gap = AI_STREAM_IDLE_TIMEOUT_MS - 5_000;
    async function* slow(): AsyncGenerator<Chunk> {
      for (const text of texts) {
        await new Promise((resolve) => setTimeout(resolve, gap));
        yield { text };
      }
    }
    mockGenerateStream.mockReturnValue({
      stream: slow(),
      response: Promise.resolve({ text: texts.join('') }),
    });

    const relayed: string[] = [];
    const turn = runTurn((t) => relayed.push(t));
    await vi.advanceTimersByTimeAsync(gap * texts.length + 1);
    await expect(turn).resolves.toBe(texts.join(''));
    expect(relayed).toEqual(texts);
    expect(mockReportFlowError).not.toHaveBeenCalled();
  });

  it('relays an ordinary answer unchanged', async () => {
    mockGenerateStream.mockReturnValue({
      stream: (async function* () {
        yield { text: 'Hello ' };
        yield { text: '' }; // empty chunks are dropped, as before
        yield { text: 'there.' };
      })(),
      response: Promise.resolve({ text: 'Hello there.' }),
    });

    const relayed: string[] = [];
    await expect(runTurn((t) => relayed.push(t))).resolves.toBe('Hello there.');
    expect(relayed).toEqual(['Hello ', 'there.']);
  });
});
