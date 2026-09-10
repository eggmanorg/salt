/**
 * The chef's side of a meal (issue #838).
 *
 * A meal is a recipe pointing at other recipes, and until this existed the chef
 * read one as an empty recipe with a title: asked "what's this missing?" it
 * answered from nothing. It gets the WHOLE dishes — ingredients and methods —
 * because the two things it is asked for, spotting the gap and writing the
 * coordination, are readings of exactly those. That is the opposite of what the
 * librarian gets, and the asymmetry is pinned in componentContext.test.ts.
 *
 * Also pinned here: the section rides with the recipe it belongs to, so a
 * variation chat based on a meal sees the dinner too; and a plain recipe's prompt
 * is untouched, with no Firestore read spent on a feature it does not use.
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

// `recipes` docs are served by id; `equipmentManifest` and `canonData` resolve
// absent so their sections are omitted and the prompt is the dish plus the meal.
// `getAll` serves BOTH the favourites lookup (which never runs — there are no
// counts) and the component batch read, so it answers from the same recipe map.
const recipeDocs = new Map<string, unknown>();
const mockGetAll = vi.fn((...refs: { id: string }[]) =>
  Promise.resolve(
    refs.map((ref) =>
      recipeDocs.has(ref.id)
        ? { id: ref.id, exists: true, data: () => recipeDocs.get(ref.id) }
        : { id: ref.id, exists: false, data: () => undefined },
    ),
  ),
);
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
    getAll: (...refs: { id: string }[]) => mockGetAll(...refs),
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

const CHICKEN_INGREDIENT = '1 whole chicken, 1.6 kg';
const CHICKEN_STEP = 'Roast for 90 minutes at 200 °C, then rest for 20.';
const POTATO_INGREDIENT = '1.5 kg Maris Piper potatoes';

function recipeDoc(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    schemaVersion: 1 as const,
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 4,
      tags: [],
    },
    componentRecipeIds: [],
    source: { type: 'manual' as const },
    notes: null,
    image: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function group(prefix: string, rawTexts: string[]) {
  return [
    {
      id: `${prefix}-g1`,
      name: null,
      items: rawTexts.map((rawText, i) => ({
        id: `${prefix}-i${i}`,
        rawText,
        parsed: null,
        canonId: null,
        matchState: 'pending' as const,
        isOptional: false,
        firstUsedInStepId: null,
      })),
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  recipeDocs.clear();
  recipeDocs.set(
    'roast',
    recipeDoc('roast', 'Sunday roast', { componentRecipeIds: ['chicken', 'potatoes'] }),
  );
  recipeDocs.set(
    'chicken',
    recipeDoc('chicken', 'Roast chicken', {
      description: 'A whole bird, hot oven then rested.',
      ingredients: group('chicken', [CHICKEN_INGREDIENT]),
      steps: [{ id: 'cs1', text: CHICKEN_STEP, timer: null, note: null }],
      metadata: {
        servings: 4,
        phases: [{ label: 'Roast & rest', handsOnMinutes: 15, handsOffMinutes: 110 }],
        tags: [],
      },
    }),
  );
  recipeDocs.set(
    'potatoes',
    recipeDoc('potatoes', 'Roast potatoes', {
      ingredients: group('potatoes', [POTATO_INGREDIENT]),
      metadata: {
        servings: 4,
        phases: [{ label: 'Parboil & roast', handsOnMinutes: 10, handsOffMinutes: 60 }],
        tags: [],
      },
    }),
  );
  recipeDocs.set('plain', recipeDoc('plain', 'Cheese on toast'));

  mockGenerateStream.mockReturnValue({
    stream: (async function* () {})(),
    response: Promise.resolve({ text: 'There is nothing green on that table.' }),
  });
});

function systemPromptFrom(): string {
  return (mockGenerateStream.mock.calls[0]![0] as { system: string }).system;
}

async function send(input: Record<string, unknown>): Promise<void> {
  await (chefChatFlow as Function)(
    { messages: [], newMessage: "what's this missing?", ...input },
    () => {},
  );
}

describe('chefChat — meal components', () => {
  it('gives the chef the whole dishes, ingredients and method included', async () => {
    await send({ recipeId: 'roast' });

    const system = systemPromptFrom();
    expect(system).toContain('Dish 1: Roast chicken');
    expect(system).toContain('Dish 2: Roast potatoes');
    expect(system).toContain(CHICKEN_INGREDIENT);
    expect(system).toContain(CHICKEN_STEP);
    expect(system).toContain(POTATO_INGREDIENT);
    // The dish's timing, as the phase strip and nothing else (issue #1233).
    expect(system).toContain('110 min hands-off');
  });

  it("carries each dish's tags, step timers and notes through to the prompt (#934)", async () => {
    // Deliberate widening, not a new feature: the chef's meal section used to
    // build its own thinner rendering of a dish and drop these three. That is the
    // hole #890 closed for the recipe body, re-opened for the dishes hanging off
    // it — and it costs the same thing. Ask the chef to write a meal out again and
    // it cannot preserve a timer it was never shown.
    recipeDocs.set(
      'chicken',
      recipeDoc('chicken', 'Roast chicken', {
        description: 'A whole bird, hot oven then rested.',
        ingredients: group('chicken', [CHICKEN_INGREDIENT]),
        steps: [
          {
            id: 'cs1',
            text: CHICKEN_STEP,
            timer: { durationMinutes: 90, description: 'Roast the bird' },
            note: 'Rest it or the juices run out.',
          },
        ],
        metadata: {
          servings: 4,
          tags: ['sunday', 'roast'],
        },
        notes: 'The bird comes out at 4:30 whatever else happens.',
      }),
    );

    await send({ recipeId: 'roast' });

    const system = systemPromptFrom();
    expect(system).toContain('Tags: sunday, roast');
    expect(system).toContain('[timer: 90 min — Roast the bird]');
    expect(system).toContain('(note: Rest it or the juices run out.)');
    expect(system).toContain('Notes: The bird comes out at 4:30 whatever else happens.');
  });

  it('asks for the gap and the coordination, not a list of what is attached', async () => {
    await send({ recipeId: 'roast' });

    const system = systemPromptFrom();
    expect(system).toContain('WHAT IS MISSING');
    expect(system).toContain('THE COORDINATION');
    expect(system).toContain('nothing green');
    // And the invariant: the meal's own lines are never a copy of a dish's.
    expect(system).toContain('NEVER a copy');
  });

  it('keeps the dishes adjacent to the recipe they hang off', async () => {
    await send({ recipeId: 'roast' });

    const system = systemPromptFrom();
    // The meal section sits inside the "Current recipe" section, after the meal
    // itself — not adrift at the top of the prompt.
    expect(system.indexOf('## Current recipe')).toBeLessThan(
      system.indexOf('### The dishes this meal is made of'),
    );
    expect(system.indexOf('Title: Sunday roast')).toBeLessThan(
      system.indexOf('### The dishes this meal is made of'),
    );
  });

  it('shows the dishes in a variation chat based on a meal', async () => {
    await send({ recipeId: null, basedOnRecipeId: 'roast' });

    const system = systemPromptFrom();
    expect(system).toContain('Starting point for a NEW dish');
    expect(system).toContain('Dish 1: Roast chicken');
    expect(system).toContain(CHICKEN_INGREDIENT);
  });

  it('resolves exactly one level — a component that is itself a meal is not followed', async () => {
    recipeDocs.set(
      'chicken',
      recipeDoc('chicken', 'Roast chicken', { componentRecipeIds: ['potatoes'] }),
    );

    await send({ recipeId: 'roast' });

    expect(systemPromptFrom()).toContain('Dish 1: Roast chicken');
    // One batched read for the meal, and nothing for the second level.
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain recipe untouched and reads nothing', async () => {
    await send({ recipeId: 'plain' });

    const system = systemPromptFrom();
    expect(system).toContain('Title: Cheese on toast');
    expect(system).not.toContain('The dishes this meal is made of');
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it('still answers the turn when the component read throws', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('firestore down'));

    await send({ recipeId: 'roast' });

    // Rule 10: the meal degrades to today's prompt rather than failing the turn.
    expect(systemPromptFrom()).not.toContain('The dishes this meal is made of');
    expect(systemPromptFrom()).toContain('Title: Sunday roast');
    expect(mockGenerateStream).toHaveBeenCalledTimes(1);
  });
});
