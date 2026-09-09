/**
 * The chef's side of "Make a variation" (issue #763).
 *
 * A variation chat is grounded on a recipe it is NOT amending, and the whole
 * feature turns on the chef knowing the difference. Under the existing "Current
 * recipe — the user is asking about this recipe" heading the chef answers as
 * though the user were editing that dish; the original is about to be left
 * exactly as it is, and a new dish is about to be written from the conversation.
 * So the two headings are pinned apart here, along with the degradation path: a
 * base recipe deleted mid-conversation must leave an ordinary chat, not a failed
 * turn (Rule 10).
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

// The flow reads three collections through one getFirestore(): `recipes` (the
// attached recipe and/or the variation's base), `equipmentManifest` and
// `canonData`. Only the recipe docs matter here; the other two resolve absent so
// their sections are omitted and the prompt is just the base + the framing.
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
    getAll: () => Promise.resolve([]),
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

function pilaf() {
  return {
    id: 'pilaf',
    schemaVersion: 1 as const,
    title: 'Chorizo & Red Pepper Pilaf',
    description: 'A one-pan rice dish.',
    ingredients: [
      {
        id: 'g1',
        name: null,
        items: [
          {
            id: 'i1',
            rawText: '200g chorizo, sliced',
            parsed: null,
            canonId: null,
            matchState: 'pending' as const,
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ],
    steps: [{ id: 's1', text: 'Fry the chorizo until the oil runs.', timer: null, note: null }],
    metadata: {
      servings: 4,
      tags: ['rice'],
    },
    source: { type: 'manual' as const },
    notes: null,
    image: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recipeDocs.clear();
  recipeDocs.set('pilaf', pilaf());
  mockGenerateStream.mockReturnValue({
    // An empty stream: the reply arrives on `response` below. The flow drains the
    // stream first, so it has to be async-iterable even when nothing streams.
    stream: (async function* () {})(),
    response: Promise.resolve({ text: 'Prawns need oil the chorizo was providing.' }),
  });
});

function systemPromptFrom(): string {
  return (mockGenerateStream.mock.calls[0]![0] as { system: string }).system;
}

async function send(input: Record<string, unknown>): Promise<void> {
  await (chefChatFlow as Function)(
    { messages: [], newMessage: 'prawns instead of chorizo', ...input },
    () => {},
  );
}

describe('chefChat — variation framing', () => {
  it('injects the base recipe under the new-dish heading, not the current-recipe one', async () => {
    await send({ recipeId: null, basedOnRecipeId: 'pilaf' });

    const system = systemPromptFrom();
    expect(system).toContain('Starting point for a NEW dish');
    expect(system).toContain('will not be changed');
    // The dish itself is there for the chef to reason from — its ingredients and
    // its method, which is what "demonstrably knows the original" means.
    expect(system).toContain('Chorizo & Red Pepper Pilaf');
    expect(system).toContain('200g chorizo, sliced');
    expect(system).toContain('Fry the chorizo until the oil runs.');
    // …and the amend framing is absent.
    expect(system).not.toContain('The user is asking about this recipe');
  });

  it('keeps the amend framing for an ordinary recipe-attached chat', async () => {
    await send({ recipeId: 'pilaf' });

    const system = systemPromptFrom();
    expect(system).toContain('The user is asking about this recipe');
    expect(system).not.toContain('Starting point for a NEW dish');
  });

  it('says nothing at all for a general chat', async () => {
    await send({ recipeId: null });

    const system = systemPromptFrom();
    expect(system).not.toContain('Starting point for a NEW dish');
    expect(system).not.toContain('The user is asking about this recipe');
  });

  it('degrades to an ordinary chat when the base recipe was deleted mid-conversation', async () => {
    recipeDocs.clear();

    await send({ recipeId: null, basedOnRecipeId: 'pilaf' });

    // No framing without a recipe to frame — and, crucially, the turn still went
    // to the model rather than throwing.
    expect(systemPromptFrom()).not.toContain('Starting point for a NEW dish');
    expect(mockGenerateStream).toHaveBeenCalledTimes(1);
  });
});
