/**
 * The turn the user watched is the turn that gets stored (PR #1303 review, kept
 * by issue #1310).
 *
 * `chefChatFlow` returns `streamedText || finalResponse.text` rather than
 * `response.text`, and the claim is about the REAL path: Genkit streams every
 * tool-loop iteration's chunks through the one callback, while `response.text`
 * is the LAST model message alone. A chef that writes a sentence and then
 * reaches for `findRecipes` or `readRecipe` has the whole reply streamed and
 * only the tail of it persisted. So this suite drives the flow with a stubbed
 * `ai.generateStream`, where the loop is in play.
 *
 * #1310 removed `declareOffer`, which is what these cases originally used as
 * their tool; the guarantee is not specific to it and neither is the flow's
 * remaining pair of tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function runTurn(onChunk: (t: string) => void = () => {}): Promise<string> {
  return (
    chefChatFlow as unknown as (
      input: unknown,
      streamingCallback: (t: string) => void,
    ) => Promise<string>
  )({ messages: [], newMessage: 'anything to serve with this?', recipeId: null }, onChunk);
}

async function* chunks(...texts: string[]): AsyncGenerator<{ text: string }> {
  for (const text of texts) yield { text };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chefChat — the stored reply is the streamed reply', () => {
  it('keeps the prose from a turn that also asked for a tool', async () => {
    // Genkit's loop: the model wrote its reply AND asked for `findRecipes` in
    // one message, the tool answered, and the second pass added a sign-off.
    // `response.text` is only that sign-off.
    const toolUsingHistory = [
      { role: 'user', content: [{ text: 'anything to serve with this?' }] },
      {
        role: 'model',
        content: [
          { text: 'Roast some carrots in honey and thyme.' },
          { toolRequest: { name: 'findRecipes', ref: 'r1', input: { query: 'carrots' } } },
        ],
      },
      {
        role: 'tool',
        content: [{ toolResponse: { name: 'findRecipes', ref: 'r1', output: { recipes: [] } } }],
      },
      { role: 'model', content: [{ text: ' Hope that helps!' }] },
    ];
    mockGenerateStream.mockReturnValue({
      stream: chunks('Roast some carrots in honey and thyme.', ' Hope that helps!'),
      response: Promise.resolve({ messages: toolUsingHistory, text: ' Hope that helps!' }),
    });

    const relayed: string[] = [];

    // Everything the reader saw, in the order they saw it — not the last model
    // message, which is all `response.text` would have given them.
    await expect(runTurn((t) => relayed.push(t))).resolves.toBe(
      'Roast some carrots in honey and thyme. Hope that helps!',
    );
    expect(relayed.join('')).toBe('Roast some carrots in honey and thyme. Hope that helps!');
  });

  it('falls back to the aggregate when a turn streamed nothing at all', async () => {
    // Not a shape we have seen, and an empty reply is worse than a duplicated
    // one — so the fallback exists and is pinned rather than assumed.
    mockGenerateStream.mockReturnValue({
      stream: chunks(),
      response: Promise.resolve({ messages: [], text: 'Under-proved, most likely.' }),
    });

    await expect(runTurn()).resolves.toBe('Under-proved, most likely.');
  });
});
