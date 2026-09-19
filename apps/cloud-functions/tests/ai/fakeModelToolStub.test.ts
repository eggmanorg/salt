/**
 * The e2e fake model, and the tool-call stub it gained in #1480.
 *
 * #1310 set `supports.tools: false` on the fake when it removed the last
 * tool-driven spec, and nothing tool-shaped could be driven from an e2e spec
 * while that stood. #1480 reopened the seam. Three claims:
 *
 *  1. THE STUB SHAPES THAT CAME BEFORE IT ARE UNTOUCHED. A string stub is emitted
 *     verbatim (chefChat, generateChatTitle — for a streaming string flow the
 *     chunks ARE the displayed reply, so JSON quotes would land in the bubble),
 *     and an object stub is `JSON.stringify`d for Genkit's output formatter to
 *     parse back (authorRecipe, parseRecipeIngredients).
 *  2. A `{ tool, then }` STUB ASKS FOR THE TOOL FIRST AND SPEAKS SECOND.
 *  3. IT ASKS EXACTLY ONCE, decided from the REQUEST — a second model turn
 *     arrives with the tool's own response already in its history — because the
 *     runner holds no state between turns. Without this the loop re-requests the
 *     same tool until Genkit's `maxTurns` gives up, and a spec stubbed once gets
 *     called five times.
 *
 * The runner is driven directly rather than through Genkit: `ai.defineModel` is
 * substituted for the pair `(config, runner)` so the runner can be called with a
 * request of this suite's own making. What that does NOT cover is Genkit's half —
 * that it accepts this message shape, and that `supports.tools` is consulted —
 * which `chat.spec.ts`'s save case covers end to end under the real emulator.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { mockStubDoc } = vi.hoisted(() => ({ mockStubDoc: vi.fn() }));

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineModel: (config: { name: string }, runner: unknown) => ({ config, runner }),
  },
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: (name: string) => ({ doc: () => mockStubDoc(name) }) }),
}));

// Read at module load — the fake models are registered eagerly, as Genkit's
// "actions defined at load time" rule requires — so it has to be set before the
// import below rather than in a `beforeEach`.
process.env['FUNCTIONS_AI_FAKE'] = '1';
const { asToolCallStub, historyHasToolResponse, flowModel, E2E_AI_STUB_COLLECTION } =
  await import('../../src/ai/fakeModel.js');
afterAll(() => {
  delete process.env['FUNCTIONS_AI_FAKE'];
});

interface FakeModelMessage {
  readonly message: { readonly content: { text?: string; toolRequest?: unknown }[] };
}

/** The registered fake for `chefChat`, as a callable runner. */
async function runner(): Promise<(request: unknown) => Promise<FakeModelMessage>> {
  const model = (await flowModel('chefChat')) as unknown as {
    runner: (request: unknown) => Promise<FakeModelMessage>;
  };
  return model.runner;
}

/** A request whose history is exactly these messages. */
function request(messages: unknown[]): unknown {
  return { messages };
}

const FIRST_PASS = request([{ role: 'user', content: [{ text: 'create a recipe from this' }] }]);
const SECOND_PASS = request([
  { role: 'user', content: [{ text: 'create a recipe from this' }] },
  { role: 'model', content: [{ toolRequest: { name: 'saveRecipe', input: {} } }] },
  {
    role: 'tool',
    content: [{ toolResponse: { name: 'saveRecipe', output: { requested: true } } }],
  },
]);

function stub(response: unknown): void {
  mockStubDoc.mockReturnValue({
    get: async () => ({ exists: true, data: () => ({ response }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the fake model — the stub shapes that came before #1480', () => {
  it('emits a string stub verbatim, not JSON-quoted', async () => {
    stub('Deterministic stubbed chef reply.');
    const result = await (await runner())(FIRST_PASS);

    expect(result.message.content).toEqual([{ text: 'Deterministic stubbed chef reply.' }]);
  });

  it('emits an object stub as JSON, for the output formatter to parse back', async () => {
    stub({ title: 'Stubbed Negroni', kind: 'cocktail' });
    const result = await (await runner())(FIRST_PASS);

    expect(result.message.content[0]?.text).toBe('{"title":"Stubbed Negroni","kind":"cocktail"}');
  });

  it('reads its answer from the shared stub collection', async () => {
    stub('anything');
    await (
      await runner()
    )(FIRST_PASS);

    expect(mockStubDoc).toHaveBeenCalledWith(E2E_AI_STUB_COLLECTION);
  });

  it('fails loudly when a spec drove a flow without stubbing it', async () => {
    mockStubDoc.mockReturnValue({ get: async () => ({ exists: false, data: () => undefined }) });

    await expect((await runner())(FIRST_PASS)).rejects.toThrow(/no stub registered/);
  });
});

describe('the fake model — a tool-call stub', () => {
  it('requests the tool on the first pass', async () => {
    stub({ tool: 'saveRecipe', then: 'Saving that now.' });
    const result = await (await runner())(FIRST_PASS);

    expect(result.message.content).toEqual([{ toolRequest: { name: 'saveRecipe', input: {} } }]);
  });

  it('passes an input through when the stub names one', async () => {
    stub({ tool: 'someTool', input: { id: 'p-1' }, then: 'Done.' });
    const result = await (await runner())(FIRST_PASS);

    expect(result.message.content).toEqual([
      { toolRequest: { name: 'someTool', input: { id: 'p-1' } } },
    ]);
  });

  it('speaks on the second pass, once the tool has answered', async () => {
    // The one-round-trip property. Ask again here and Genkit runs the loop to
    // `maxTurns` and throws.
    stub({ tool: 'saveRecipe', then: 'Saving that now.' });
    const result = await (await runner())(SECOND_PASS);

    expect(result.message.content).toEqual([{ text: 'Saving that now.' }]);
  });
});

describe('asToolCallStub', () => {
  it('leaves every stub shape that came before it alone', () => {
    expect(asToolCallStub('Deterministic stubbed chef reply.')).toBeNull();
    expect(asToolCallStub({ title: 'Stubbed Negroni', kind: 'cocktail' })).toBeNull();
    expect(asToolCallStub(null)).toBeNull();
    expect(asToolCallStub(undefined)).toBeNull();
    expect(asToolCallStub(42)).toBeNull();
  });

  it('needs BOTH halves, because half of one is a stub that would hang', () => {
    // `{ tool }` with no `then` would request the tool and then have nothing to
    // say on the second pass; `{ then }` with no tool names nothing to call.
    expect(asToolCallStub({ tool: 'saveRecipe' })).toBeNull();
    expect(asToolCallStub({ then: 'Saving that now.' })).toBeNull();
    expect(asToolCallStub({ tool: 7, then: 'Saving that now.' })).toBeNull();
  });
});

describe('historyHasToolResponse', () => {
  it('is not satisfied by the model’s own REQUEST', () => {
    // The distinction the one-round-trip property rests on: the request is in the
    // history from the second pass onwards too, so testing for it would stop the
    // fake ever speaking.
    expect(
      historyHasToolResponse(
        request([{ role: 'model', content: [{ toolRequest: { name: 'saveRecipe' } }] }]),
      ),
    ).toBe(false);
  });

  it('says no rather than throwing on a request it does not recognise', () => {
    expect(historyHasToolResponse(undefined)).toBe(false);
    expect(historyHasToolResponse(null)).toBe(false);
    expect(historyHasToolResponse({})).toBe(false);
    expect(historyHasToolResponse({ messages: 'nonsense' })).toBe(false);
    expect(historyHasToolResponse(request([{ role: 'user' }]))).toBe(false);
    expect(historyHasToolResponse(request([null]))).toBe(false);
  });
});
