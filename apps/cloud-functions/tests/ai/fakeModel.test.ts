import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerateRequest } from 'genkit/model';

/**
 * The e2e fake model's own behaviour — the cross-process stub contract.
 *
 * This seam only ever runs inside the emulator harness, so nothing else in the
 * unit suite exercises it, and what it has to get right is narrow: a STRING stub
 * is emitted verbatim, so a streamed reply is not JSON-quoted, and anything else
 * is emitted as JSON, because the flows whose output is an object parse it back.
 *
 * The tests came from #1299's declaring turn, which #1310 removed; the stub
 * encoding they pin predates it and outlives it.
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

  it('gives an object with a text field no special treatment', async () => {
    // `text` is an ordinary key. The one encoding rule is string-or-JSON, and an
    // object carrying a `text` is still an object.
    const fake = await chefChatFake({ text: 'not a declaration' });

    const result = await fake(NO_HISTORY);

    expect(result.message.content).toEqual([{ text: '{"text":"not a declaration"}' }]);
  });
});
