/**
 * The turn the user watched is the turn that gets stored — and a tool input
 * Genkit refuses does not take it away from them (issue #1299, PR #1303 review).
 *
 * Both claims are about the REAL path, which the `declaredOffers` unit tests
 * cannot reach: those hand the function a message array we built ourselves, so
 * neither Genkit's tool loop nor its input validation is in play. This suite
 * drives `chefChatFlow` with a stubbed `ai.generateStream`, where both live.
 *
 *  1. WHAT WAS STREAMED IS WHAT IS STORED. Genkit streams every tool-loop
 *     iteration's chunks through the one callback, while `response.text` is the
 *     LAST model message alone — so a chef that writes its reply and asks for
 *     `declareOffer` in one message, which the tool description invites, had the
 *     whole reply streamed and then "Hope that helps!" persisted in its place.
 *  2. A REFUSED TOOL INPUT NEVER COSTS THE TURN, AND IS NEVER SILENT. Genkit
 *     validates a model-authored tool input before the handler runs and THROWS;
 *     nothing in the tool loop catches it, so the callable 500s and the client
 *     rolls the user's own message out of the transcript — after they watched the
 *     reply arrive in full. The reply is kept instead, AND reported: the flow
 *     cannot tell which of the three tools was refused, and for the two library
 *     tools what it keeps is a lead-in with no lookup behind it (PR #1303
 *     review). The last two tests pin the containment's narrowness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenkitError } from 'genkit';

const mockGenerateStream = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (_config: unknown, handler: unknown) => handler,
    generateStream: mockGenerateStream,
  },
}));

vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));

// `withAiTimeout` stubbed to a pass-through; `withAiStreamTimeout` left real, so
// the drain loop under test is the production one.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

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

type Turn = { text: string; offered: string[] };

function runTurn(onChunk: (t: string) => void = () => {}): Promise<Turn> {
  return (
    chefChatFlow as unknown as (
      input: unknown,
      streamingCallback: (t: string) => void,
    ) => Promise<Turn>
  )({ messages: [], newMessage: 'anything to serve with this?', recipeId: null }, onChunk);
}

async function* chunks(...texts: string[]): AsyncGenerator<{ text: string }> {
  for (const text of texts) yield { text };
}

/** Streams `texts`, then fails the way the tool loop fails. */
function chunksThenThrow(texts: string[], err: unknown): AsyncGenerator<{ text: string }> {
  return (async function* () {
    for (const text of texts) yield { text };
    throw err;
  })();
}

/**
 * A rejected aggregate that nothing has to observe.
 *
 * Genkit fails the STREAM and the aggregate together, and the flow reaches the
 * stream first — so `response` is left unawaited in every failing case here,
 * exactly as it is in production. The attached no-op keeps Node from calling
 * that an unhandled rejection; it changes nothing about what the flow sees.
 */
function rejecting(err: unknown): Promise<never> {
  const rejected = Promise.reject(err);
  rejected.catch(() => {});
  return rejected;
}

/** Exactly what `parseSchema` throws when a model writes a tool input wrong. */
function schemaRejection(): GenkitError {
  return new GenkitError({
    status: 'INVALID_ARGUMENT',
    message: 'Schema validation failed. Parse Errors:\n\n- offers: must be array',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chefChat — the stored reply is the streamed reply', () => {
  it('keeps the prose from a turn that also asked for a tool', async () => {
    // Genkit's loop: the model wrote its reply AND asked for `declareOffer` in
    // one message, the tool answered, and the second pass added a sign-off.
    // `response.text` is only that sign-off.
    const declaringHistory = [
      { role: 'user', content: [{ text: 'anything to serve with this?' }] },
      {
        role: 'model',
        content: [
          { text: 'Roast some carrots in honey and thyme.' },
          { toolRequest: { name: 'declareOffer', ref: 'r1', input: { offers: ['new-dish'] } } },
        ],
      },
      {
        role: 'tool',
        content: [
          { toolResponse: { name: 'declareOffer', ref: 'r1', output: { recorded: true } } },
        ],
      },
      { role: 'model', content: [{ text: ' Hope that helps!' }] },
    ];
    mockGenerateStream.mockReturnValue({
      stream: chunks('Roast some carrots in honey and thyme.', ' Hope that helps!'),
      response: Promise.resolve({ messages: declaringHistory, text: ' Hope that helps!' }),
    });

    const relayed: string[] = [];

    await expect(runTurn((t) => relayed.push(t))).resolves.toEqual({
      // Everything the reader saw, in the order they saw it — not the last
      // model message, which is all `response.text` would have given them.
      text: 'Roast some carrots in honey and thyme. Hope that helps!',
      offered: ['new-dish'],
    });
    expect(relayed.join('')).toBe('Roast some carrots in honey and thyme. Hope that helps!');
  });

  it('falls back to the aggregate when a turn streamed nothing at all', async () => {
    // Not a shape we have seen, and an empty reply is worse than a duplicated
    // one — so the fallback exists and is pinned rather than assumed.
    mockGenerateStream.mockReturnValue({
      stream: chunks(),
      response: Promise.resolve({ messages: [], text: 'Under-proved, most likely.' }),
    });

    await expect(runTurn()).resolves.toEqual({
      text: 'Under-proved, most likely.',
      offered: [],
    });
  });
});

describe('chefChat — a refused tool input never costs the turn, and is never silent', () => {
  it('returns the reply the chef had already written', async () => {
    // The concrete case: the chef called `declareOffer` with a bare string
    // instead of a list. Genkit rejects it before the handler runs and throws
    // out of the tool loop, so `response` never resolves and the declaration is
    // unreadable. The reply is finished — a model's message ends when it asks
    // for a tool — and the user has watched all of it arrive.
    mockGenerateStream.mockReturnValue({
      stream: chunksThenThrow(['Roast some carrots in honey and thyme.'], schemaRejection()),
      response: rejecting(schemaRejection()),
    });

    await expect(runTurn()).resolves.toEqual({
      text: 'Roast some carrots in honey and thyme.',
      // Fail closed: nothing legible was declared, so no buttons.
      offered: [],
    });
    // Kept AND reported (PR #1303 review). The reader loses nothing, but a turn
    // that succeeded on a refused tool input is not a healthy turn and used to
    // leave no trace at all.
    expect(mockReportFlowError).toHaveBeenCalledOnce();
  });

  it('reports a refused LIBRARY lookup, whose cost is the answer and not a button', async () => {
    // The case the silence hid. This branch cannot see which tool was refused,
    // so the reply it keeps may be a lead-in with no lookup behind it — the user
    // is told the chef is about to search and then it never does. Storing that
    // as a success with nothing reported is what this pins against; the reply is
    // still kept, because the alternative is rolling the user's own message out
    // of the transcript.
    mockGenerateStream.mockReturnValue({
      stream: chunksThenThrow(['Let me have a look at what you have…'], schemaRejection()),
      response: rejecting(schemaRejection()),
    });

    await expect(runTurn()).resolves.toEqual({
      text: 'Let me have a look at what you have…',
      offered: [],
    });
    expect(mockReportFlowError).toHaveBeenCalledOnce();
  });

  it('still fails a turn that broke before the chef said anything', async () => {
    // Same error, no prose. There is no reply to save, and answering with an
    // empty one would show the reader a blank turn and store it.
    mockGenerateStream.mockReturnValue({
      stream: chunksThenThrow([], schemaRejection()),
      response: rejecting(schemaRejection()),
    });

    await expect(runTurn()).rejects.toThrow(GenkitError);
    expect(mockReportFlowError).toHaveBeenCalledOnce();
  });

  it('still fails a turn that broke for any other reason', async () => {
    // The containment must not become a general "keep whatever streamed"
    // swallow: a model, transport or timeout failure mid-answer leaves a
    // TRUNCATED reply, and storing that as the turn is the bug it would create.
    mockGenerateStream.mockReturnValue({
      stream: chunksThenThrow(['Braise the shin until '], new Error('model stream broke')),
      response: rejecting(new Error('model stream broke')),
    });

    await expect(runTurn()).rejects.toThrow('model stream broke');
    expect(mockReportFlowError).toHaveBeenCalledOnce();
  });
});
