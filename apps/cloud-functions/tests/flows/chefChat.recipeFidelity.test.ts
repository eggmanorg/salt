/**
 * What the chef is shown of the dish it is talking about (issue #890).
 *
 * The chef used to read a THINNER rendering than the librarian: title,
 * description, ingredient lines and step text, and nothing else. That was
 * survivable while it only talked ABOUT a recipe, and stopped being survivable
 * when Refresh started asking it to write one OUT — a chef shown no servings, no
 * times, no step timers and no notes hands back a recipe with those things
 * missing, and the household loses them on apply.
 *
 * So both flows now render a stored recipe through the one function in
 * `recipeText.ts`. What is pinned here is the fidelity itself, field by field: a
 * future prompt trim that quietly drops a field from that renderer costs the
 * household data, and does it silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));

const recipeDocs = new Map<string, unknown>();
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        get: () =>
          Promise.resolve(
            name === 'recipes' && recipeDocs.has(id)
              ? { exists: true, data: () => recipeDocs.get(id) }
              : { exists: false, data: () => undefined },
          ),
      }),
    }),
    getAll: (...refs: { id: string }[]) =>
      Promise.resolve(refs.map((ref) => ({ id: ref.id, exists: false, data: () => undefined }))),
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

const RECIPE = {
  id: 'r1',
  schemaVersion: 1 as const,
  kind: 'recipe' as const,
  title: 'Braised beef shin',
  description: 'Low and slow, until it gives up.',
  ingredients: [
    {
      id: 'g1',
      name: 'For the braise',
      items: [
        {
          id: 'i1',
          rawText: '1.2 kg beef shin, on the bone',
          parsed: null,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: false,
          firstUsedInStepId: null,
        },
        {
          id: 'i2',
          rawText: 'a handful of parsley, to finish',
          parsed: null,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: true,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  steps: [
    {
      id: 's1',
      text: 'Brown the shin hard on every side.',
      timer: null,
      note: 'Dry the meat first or it will steam instead of browning.',
    },
    {
      id: 's2',
      text: 'Braise in the low oven until it pulls apart.',
      timer: { durationMinutes: 180, description: 'Braise the shin' },
      note: null,
    },
  ],
  metadata: {
    servings: 6,
    phases: [
      { label: 'Prep', handsOnMinutes: 30, handsOffMinutes: 0 },
      { label: 'Braise', handsOnMinutes: 0, handsOffMinutes: 180 },
    ],
    tags: ['slow', 'winter'],
  },
  componentRecipeIds: [],
  source: { type: 'manual' as const },
  notes: 'Better on the second day. Always.',
  image: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  recipeDocs.clear();
  recipeDocs.set('r1', RECIPE);
  mockGenerateStream.mockReturnValue({
    stream: (async function* () {})(),
    response: Promise.resolve({ text: 'ok' }),
  });
});

async function systemPromptFor(recipeId: string): Promise<string> {
  await (chefChatFlow as unknown as (i: unknown) => Promise<string>)({
    messages: [],
    newMessage: 'write this out again',
    recipeId,
  });
  return (mockGenerateStream.mock.calls[0]![0] as { system: string }).system;
}

describe('chefChat — the chef reads the whole recipe, not a summary of it', () => {
  it('shows the servings, and the timing as the phase strip', async () => {
    const system = await systemPromptFor('r1');
    expect(system).toContain('servings: 6');
    // Since issue #1233 the strip IS the timing, and the three stored numbers are
    // no longer rendered — the chef must not be shown a figure no screen displays.
    expect(system).toContain('Prep: 30 min hands-on, 0 min hands-off');
    expect(system).toContain('Braise: 0 min hands-on, 180 min hands-off');
    expect(system).not.toContain('prep: 30 min');
    expect(system).not.toContain('total: 210 min');
  });

  it('shows a step timer with its label, so a re-author can hand it back', async () => {
    const system = await systemPromptFor('r1');
    expect(system).toContain('[timer: 180 min — Braise the shin]');
  });

  it("shows the household's own notes — the recipe's and the step's", async () => {
    const system = await systemPromptFor('r1');
    expect(system).toContain('(note: Dry the meat first or it will steam instead of browning.)');
    expect(system).toContain('Notes: Better on the second day. Always.');
  });

  it('shows the tags, the groups and which ingredients are optional', async () => {
    const system = await systemPromptFor('r1');
    expect(system).toContain('Tags: slow, winter');
    expect(system).toContain('For the braise:');
    expect(system).toContain('- a handful of parsley, to finish (optional)');
  });

  it('shows the method with no step ids in it (issue #1178)', async () => {
    // `formatRecipeForPrompt` grew a `stepIds` option so the LIBRARIAN's edit mode
    // can ask the model which step each rewrite came from. It is opt-in, and this
    // is what "the chef's prompt is unchanged" means mechanically: the chef is
    // holding a conversation, not producing a citation, and a UUID threaded through
    // the method is both noise and something it can read out loud.
    const system = await systemPromptFor('r1');
    expect(system).toContain('1. Brown the shin hard on every side.');
    expect(system).not.toContain('[s1]');
    expect(system).not.toContain('[s2]');
  });

  it('still says nothing at all about a recipe it cannot read', async () => {
    // Rule 10 at the prompt level: a missing dish degrades to an ordinary chat.
    const system = await systemPromptFor('gone');
    expect(system).not.toContain('Current recipe');
  });
});
