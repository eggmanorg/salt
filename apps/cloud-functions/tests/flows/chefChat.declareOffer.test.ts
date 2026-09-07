/**
 * The chef says what its reply offered (issue #1299).
 *
 * Four claims, each pinned rather than asserted:
 *
 *  1. THE DECLARATION IS READ OFF THE REQUEST, FROM THE WHOLE HISTORY. Genkit
 *     resolves a tool call and calls the model again, so by the time a turn is
 *     finished the LAST model message is prose and carries no tool request at
 *     all — `response.toolRequests` is empty and the declaration is two messages
 *     back. Reading only the final message is the obvious wrong implementation
 *     and it would be silently, permanently empty.
 *  2. IT HOLDS NO STATE BETWEEN INVOCATIONS. `declareOfferTool` is a module-scope
 *     singleton like the other two, so a module-level variable written by its
 *     handler would be shared across concurrent invocations on one warm instance
 *     and would leak one household's declaration into another's turn. Pinned by
 *     reading two different turns back-to-back and by the handler being a
 *     constant.
 *  3. A DECLARATION THAT DOES NOT PARSE IS DROPPED, NOT RAISED. The model writes
 *     the tool input, so it is a trust boundary; the failure this design accepts
 *     is a missing button, never a failed turn.
 *  4. THE TOOL WRITES NOTHING. Its handler is the whole implementation and it
 *     touches no Firestore, which is what keeps design principle #1's "the chef
 *     still writes nothing" true with a third tool in play.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MessageData } from 'genkit';

const defineToolCalls: { name: string; description: string }[] = [];
const toolHandlers = new Map<string, (input: unknown) => unknown>();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (
      config: { name: string; description: string },
      handler: (input: unknown) => unknown,
    ) => {
      defineToolCalls.push(config);
      toolHandlers.set(config.name, handler);
      return { __tool: config.name, handler };
    },
    generateStream: vi.fn(),
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));
// The stub throws if anything reads it, which is claim 4: this tool must not.
const getFirestore = vi.fn(() => {
  throw new Error('declareOffer must not touch Firestore');
});
vi.mock('firebase-admin/firestore', () => ({ getFirestore }));

const { declaredOffers, declareOfferTool } = await import('../../src/flows/chefChat.js');

/** A finished turn: the user asked, the chef declared, the tool answered, prose. */
function turnDeclaring(offers: unknown): MessageData[] {
  return [
    { role: 'user', content: [{ text: 'make it less sweet' }] },
    {
      role: 'model',
      content: [{ toolRequest: { name: 'declareOffer', ref: 'r1', input: { offers } } }],
    },
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'declareOffer', ref: 'r1', output: { recorded: true } } }],
    },
    { role: 'model', content: [{ text: 'Halve the honey.' }] },
  ];
}

describe('declaredOffers — reading the finished turn', () => {
  it('finds the declaration two messages back, not in the last one', () => {
    // The last model message is prose. An implementation that read only
    // `response.toolRequests` — the final message's requests — returns [] here
    // and the buttons never appear for anyone.
    expect(declaredOffers(turnDeclaring(['dish-change']))).toEqual(['dish-change']);
  });

  it('carries both kinds when the reply did both', () => {
    expect(declaredOffers(turnDeclaring(['dish-change', 'new-dish']))).toEqual([
      'dish-change',
      'new-dish',
    ]);
  });

  it('collapses a kind the chef declared twice', () => {
    // Two buttons of the same name is not what "declared it twice" means.
    expect(declaredOffers(turnDeclaring(['new-dish', 'new-dish']))).toEqual(['new-dish']);
  });

  it('ignores the other two tools', () => {
    const messages: MessageData[] = [
      {
        role: 'model',
        content: [{ toolRequest: { name: 'findRecipes', ref: 'r0', input: { query: 'lamb' } } }],
      },
      { role: 'model', content: [{ text: 'Here you go.' }] },
    ];

    expect(declaredOffers(messages)).toEqual([]);
  });
});

describe('declaredOffers — fail closed', () => {
  it('answers empty for a turn where the chef declared nothing', () => {
    const messages: MessageData[] = [
      { role: 'user', content: [{ text: 'why is my crumb so tight?' }] },
      { role: 'model', content: [{ text: 'Under-proved, most likely.' }] },
    ];

    expect(declaredOffers(messages)).toEqual([]);
  });

  it('drops a kind the schema does not know, rather than failing the turn', () => {
    expect(declaredOffers(turnDeclaring(['delete-everything']))).toEqual([]);
  });

  it('drops a malformed input, rather than failing the turn', () => {
    expect(declaredOffers(turnDeclaring('dish-change'))).toEqual([]);
    expect(declaredOffers(turnDeclaring(undefined))).toEqual([]);
  });
});

describe('declaredOffers — no state between invocations', () => {
  it('answers each turn from that turn alone', () => {
    // The module-scope trap: `declareOfferTool` is a singleton, so a handler that
    // stashed its input in a module variable would answer the SECOND call here
    // with the first call's declaration. Reading the request cannot.
    expect(declaredOffers(turnDeclaring(['dish-change']))).toEqual(['dish-change']);
    expect(declaredOffers(turnDeclaring(['new-dish']))).toEqual(['new-dish']);
    expect(declaredOffers(turnDeclaring([]))).toEqual([]);
  });
});

describe('the declareOffer tool itself', () => {
  it('is registered, and writes nothing at all', async () => {
    expect(declareOfferTool).toMatchObject({ __tool: 'declareOffer' });

    const handler = toolHandlers.get('declareOffer')!;
    await expect(handler({ offers: ['dish-change'] })).resolves.toEqual({ recorded: true });

    // Claim 4: the Firestore stub throws if it is reached, and it was not.
    expect(getFirestore).not.toHaveBeenCalled();
  });

  it('tells the model when NOT to call it', () => {
    // Without this clause it fires on every turn and gates nothing, which is the
    // noise #1299 exists to remove.
    const description = defineToolCalls.find((c) => c.name === 'declareOffer')?.description ?? '';
    expect(description).toContain('DO NOT CALL IT');
    expect(description).toMatch(/simply answered a question/i);
    expect(description).toMatch(/if you are unsure, do not call it/i);
  });
});
