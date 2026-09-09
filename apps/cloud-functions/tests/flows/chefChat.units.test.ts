/**
 * What units the chef writes for a person to read (issue #934).
 *
 * The chef used to carry four unit sentences of its own, and the last of them
 * said the opposite of what the recipe pipeline produces: it asked for
 * `"½ tsp salt (3 g)"` while a saved recipe renders `"2g whole black peppercorns
 * (1 tsp)"`. Two prompts, one policy, two answers — and nothing could see it,
 * because two paraphrases of a rule share no substring.
 *
 * Both now interpolate `READER_UNIT_PRINCIPLE` from `@salt/domain/prompts`. What
 * is pinned here is the composed system prompt: the statement reaches it, and the
 * old bracketing is gone rather than merely joined by the new one.
 *
 * ── The honest boundary ─────────────────────────────────────────────────────
 * This proves what the chef is ASKED for, not what a model does with it. No test
 * in this repo can prove the latter — a cloud session has no AI keys, which is
 * why prompt policy here is pinned by text assertions. The round trip that a test
 * cannot reach (chef → librarian → parser → what the cook sees) is a manual
 * staging check, and the issue makes it a condition of the phase.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { READER_UNIT_PRINCIPLE } from '@salt/domain/prompts';

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

vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

// Every context read resolves absent, so the prompt under test is the base and
// nothing else — which is exactly the part this file is about.
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: () => Promise.resolve({ exists: false, data: () => undefined }),
      }),
      get: () => Promise.resolve({ docs: [] }),
    }),
    getAll: () => Promise.resolve([]),
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateStream.mockReturnValue({
    stream: (async function* () {})(),
    response: Promise.resolve({ text: 'Salt it early.' }),
  });
});

async function systemPrompt(): Promise<string> {
  await (chefChatFlow as Function)(
    { messages: [], newMessage: 'how much salt?', recipeId: null },
    () => {},
  );
  return (mockGenerateStream.mock.calls[0]![0] as { system: string }).system;
}

describe('chefChat — the unit policy', () => {
  it('states the shared reader-facing policy, verbatim', async () => {
    // Imported, never restated (docs/unit-test-spec.md UT-E1): reword the constant
    // and this assertion moves with it. A prompt that stops interpolating is still
    // a valid prompt and a valid type — this is the only thing that notices.
    expect(await systemPrompt()).toContain(READER_UNIT_PRINCIPLE);
  });

  it('no longer asks for the spoon measure first', async () => {
    // The behaviour change #934 names. The old wording is gone, not merely joined
    // by the new one — a prompt carrying both would be worse than either.
    const system = await systemPrompt();
    expect(system).not.toContain('½ tsp salt (3 g)');
    expect(system).not.toContain('1 tbsp oil (15 ml)');
    expect(system).not.toContain('the metric equivalent in brackets');
    // ...and the replacement genuinely puts the metric value first.
    expect(system).toContain('3 g salt (½ tsp)');
  });

  it('keeps the two rules that were never part of the unit policy', async () => {
    // Temperature and ingredient names are separate policies with separate homes
    // (°C inline here, UK_INGREDIENT_PRINCIPLE in ingredientConversions.ts).
    // Trimming four sentences to one is how a rule gets dropped by accident.
    const system = await systemPrompt();
    expect(system).toContain('Temperatures in °C only');
    expect(system).toContain('prefer British ingredient names');
  });
});
