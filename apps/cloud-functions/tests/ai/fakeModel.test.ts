import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerateRequest } from 'genkit/model';

/**
 * The e2e fake model's own behaviour — the cross-process stub contract, and the
 * declaring turn #1299 added to it.
 *
 * This seam only ever runs inside the emulator harness, so nothing else in the
 * unit suite exercises it; and the declaring turn is the one piece of #1299 that
 * a local run cannot see at all, because the specs that depend on it are the
 * heavy e2e suite. What it has to get right is narrow and mechanical:
 *
 *  - a declaring stub asks for the TOOL first and the prose second, so the reply
 *    is streamed once rather than twice;
 *  - the second turn is recognised by the tool RESPONSE Genkit appends, so the
 *    tool loop terminates instead of running to `maxTurns` and throwing;
 *  - a stub that is not a declaring one behaves exactly as it did before.
 */

const mockDefineModel = vi.fn((_config: unknown, handler: unknown) => handler);
vi.mock('../../src/genkit.js', () => ({ ai: { defineModel: mockDefineModel } }));
vi.mock('@genkit-ai/google-genai', () => ({ googleAI: { model: (name: string) => name } }));
vi.mock('../../src/ai/resolveModel.js', () => ({
  resolveModel: async (flowId: string) => `resolved-${flowId}`,
}));

const stubDoc = vi.fn<() => { exists: boolean; data: () => { response: unknown } }>(() => ({
  exists: true,
  data: () => ({ response: 'plain prose' }),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ get: async () => stubDoc() }) }) }),
}));

const ORIGINAL_FLAG = process.env['FUNCTIONS_AI_FAKE'];

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['FUNCTIONS_AI_FAKE'];
  else process.env['FUNCTIONS_AI_FAKE'] = ORIGINAL_FLAG;
  vi.clearAllMocks();
});

/** The registered fake for `chefChat`, with the flag on and `response` stubbed. */
async function chefChatFake(
  response: unknown,
): Promise<(request: GenerateRequest) => Promise<{ message: { content: unknown[] } }>> {
  process.env['FUNCTIONS_AI_FAKE'] = '1';
  stubDoc.mockReturnValue({ exists: true, data: () => ({ response }) });
  vi.resetModules();
  const { flowModel } = await import('../../src/ai/fakeModel.js');
  return (await flowModel('chefChat' as never)) as never;
}

const NO_HISTORY: GenerateRequest = { messages: [] };
const AFTER_THE_TOOL_RAN: GenerateRequest = {
  messages: [
    {
      role: 'tool',
      content: [{ toolResponse: { name: 'declareOffer', ref: 'r', output: { recorded: true } } }],
    },
  ],
};

describe('the e2e fake model — an ordinary stub', () => {
  it('emits a string stub verbatim, so a streamed reply is not JSON-quoted', async () => {
    const fake = await chefChatFake('Sear the halloumi.');

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([{ text: 'Sear the halloumi.' }]);
  });

  it('emits a structured stub as JSON, for the flows whose output is an object', async () => {
    const fake = await chefChatFake({ title: 'A loaf' });

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([{ text: '{"title":"A loaf"}' }]);
  });

  it('is not fooled by an object that merely has a text field', async () => {
    // The declaring shape is `{ text, offers }` and BOTH halves are required —
    // `offers` has to parse as `declareOffer`'s own input. A structured stub that
    // happens to carry a `text` must take the unchanged path.
    const fake = await chefChatFake({ text: 'not a declaration' });

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([{ text: '{"text":"not a declaration"}' }]);
  });

  it('is not fooled by an offer kind the tool would reject', async () => {
    const fake = await chefChatFake({ text: 'hello', offers: ['delete-everything'] });

    const result = await fake(NO_HISTORY);

    expect(result.message.content[0]).toHaveProperty('text');
    expect(result.message.content[0]).not.toHaveProperty('toolRequest');
  });
});

describe('the e2e fake model — a declaring stub (#1299)', () => {
  it('asks for the tool FIRST, with no text at all', async () => {
    // No text on this turn, deliberately: the flow's drain loop would stream it,
    // and the second turn streams it again — the reply would appear twice.
    const fake = await chefChatFake({ text: 'Halve the honey.', offers: ['dish-change'] });

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([
      {
        toolRequest: {
          name: 'declareOffer',
          ref: 'e2e-declare-offer',
          input: { offers: ['dish-change'] },
        },
      },
    ]);
  });

  it('emits the prose on the turn AFTER the tool answered, and asks for nothing more', async () => {
    // The loop terminates here. A fake that answered identically both times would
    // run to Genkit's `maxTurns` and throw instead of finishing the turn.
    const fake = await chefChatFake({ text: 'Halve the honey.', offers: ['dish-change'] });

    const result = await fake(AFTER_THE_TOOL_RAN);

    expect(result.message.content).toEqual([{ text: 'Halve the honey.' }]);
  });

  it('carries both kinds through when a stub declares both', async () => {
    const fake = await chefChatFake({
      text: 'Less honey, and a salad alongside.',
      offers: ['dish-change', 'new-dish'],
    });

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([
      {
        toolRequest: {
          name: 'declareOffer',
          ref: 'e2e-declare-offer',
          input: { offers: ['dish-change', 'new-dish'] },
        },
      },
    ]);
  });
});
