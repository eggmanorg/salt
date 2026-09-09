/**
 * The chef's read-a-dish tool (issue #840, phase 2).
 *
 * Four claims, each pinned rather than asserted:
 *
 *  1. IT ADDS NO THIRD RENDERER. `readRecipe` returns exactly what
 *     `readRecipeContext` produces — which is `formatRecipeForPrompt` (#890) with
 *     the component dishes appended (#838). Pinned by reading a MEAL and finding
 *     its component's own ingredient and step text in the result: a hand-rolled
 *     renderer here would carry neither.
 *  2. AN EMPTY RENDER MEANS NOT FOUND, AND ONLY THAT. `readRecipeForChef` maps
 *     `readRecipeContext`'s '' to `found: false`, which is only sound because a
 *     recipe that parses can never render to ''. That is pinned directly — the
 *     emptiest recipe the schema admits still comes back `found: true` — so if
 *     the renderer ever gains an early `return ''` this suite goes red instead of
 *     the chef quietly announcing that a dish it can see does not exist.
 *  3. NOT FOUND DEGRADES, IT DOES NOT THROW. Missing, corrupt and Firestore-down
 *     all reach the model as `{ found: false }`, never as a failed turn.
 *  4. BOTH TOOL DESCRIPTIONS STILL CARRY THEIR "WHEN NOT TO CALL" CLAUSE, and
 *     there are still exactly two tools. That is the constraint the doc's
 *     rewritten principle #1 states, and prompt text is falsifiable only by
 *     content assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from 'firebase-functions';

// A spy rather than a sixth `vi.mock` — the unit-test spec's mock ceiling
// (UT-B1) is at five, and the warn calls are what prove the degrade paths ran.
const mockWarn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

const defineToolCalls: { name: string; description: string }[] = [];
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (config: { name: string; description: string }, handler: unknown) => {
      defineToolCalls.push(config);
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
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}) }));

const { readRecipeForChef, readRecipeTool, findRecipesTool } =
  await import('../../src/flows/chefChat.js');

beforeEach(() => {
  mockWarn.mockClear();
});

// ─── Firestore stub ───────────────────────────────────────────────────────────

function recipe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r-chicken',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Roast chicken',
    description: 'A whole bird, hot oven, long rest.',
    ingredients: [
      {
        id: 'g-1',
        name: null,
        items: [
          {
            id: 'i-1',
            rawText: '1 whole chicken, 1.6 kg',
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ],
    steps: [
      {
        id: 's-1',
        text: 'Roast at 200 °C for 90 minutes, then rest for 20.',
        timer: null,
        note: null,
      },
    ],
    metadata: { servings: 4, tags: ['sunday'] },
    source: null,
    notes: null,
    image: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

/** The emptiest document `RecipeSchema` will accept: no ingredients, no steps. */
function barestRecipe(): Record<string, unknown> {
  return {
    id: 'r-bare',
    schemaVersion: 1,
    title: '',
    description: null,
    ingredients: [],
    steps: [],
    metadata: { servings: null, tags: [] },
    source: null,
    notes: null,
    image: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function dbWith(docs: Record<string, unknown>): never {
  const db = {
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: () =>
          Promise.resolve(
            id in docs
              ? { exists: true, data: () => docs[id] }
              : { exists: false, data: () => undefined },
          ),
      }),
    }),
    getAll: (...refs: { id: string }[]) =>
      Promise.resolve(
        refs.map((ref) =>
          ref.id in docs
            ? { id: ref.id, exists: true, data: () => docs[ref.id] }
            : { id: ref.id, exists: false, data: () => undefined },
        ),
      ),
  };
  return db as never;
}

// ─── 1. The shared renderer ──────────────────────────────────────────────────

describe('readRecipe — it reuses readRecipeContext and adds no third renderer', () => {
  it('returns the whole dish — ingredients, method, servings and tags', async () => {
    const result = await readRecipeForChef(dbWith({ 'r-chicken': recipe() }), { id: 'r-chicken' });

    expect(result.found).toBe(true);
    const text = result.recipe ?? '';
    expect(text).toContain('Title: Roast chicken');
    expect(text).toContain('1 whole chicken, 1.6 kg');
    expect(text).toContain('Roast at 200 °C for 90 minutes');
    expect(text).toContain('servings: 4');
    expect(text).toContain('sunday');
  });

  it('carries the timings, which the shallow search line only summarises', async () => {
    const result = await readRecipeForChef(
      dbWith({
        'r-chicken': recipe({
          metadata: {
            servings: 4,
            tags: [],
            phases: [{ label: 'Roast', handsOnMinutes: 10, handsOffMinutes: 90 }],
          },
        }),
      }),
      { id: 'r-chicken' },
    );

    expect(result.recipe).toContain('Roast: 10 min hands-on, 90 min hands-off');
  });

  it('carries a meal’s component dishes with it, inherited from #838', async () => {
    // The pin for "no third renderer": a hand-rolled reader here would return the
    // meal's own (empty) ingredients and steps and know nothing about the dishes
    // hanging off it. Reusing readRecipeContext means readRecipe is meal-aware
    // for free, exactly as the issue intended.
    const meal = recipe({
      id: 'r-sunday',
      title: 'Sunday roast',
      ingredients: [],
      steps: [],
      componentRecipeIds: ['r-chicken'],
    });
    const result = await readRecipeForChef(dbWith({ 'r-sunday': meal, 'r-chicken': recipe() }), {
      id: 'r-sunday',
    });

    expect(result.recipe).toContain('Dish 1: Roast chicken');
    expect(result.recipe).toContain('1 whole chicken, 1.6 kg');
    expect(result.recipe).toContain('Roast at 200 °C for 90 minutes');
  });
});

// ─── 2. Empty means not-found, and only that ─────────────────────────────────

describe('readRecipe — an empty render can only mean "no such dish"', () => {
  it('reports the emptiest recipe the schema admits as FOUND', () => {
    // The whole soundness of mapping '' → found:false rests on this. A recipe
    // with no title, no description, no ingredients and no steps still renders a
    // `Title:` line, so a document that parses can never look like a missing one.
    // Break that — an early `return ''` in the renderer — and this goes red
    // instead of the chef telling the household a dish they can see is gone.
    return expect(
      readRecipeForChef(dbWith({ 'r-bare': barestRecipe() }), { id: 'r-bare' }),
    ).resolves.toMatchObject({ found: true });
  });
});

// ─── 3. Not found degrades ───────────────────────────────────────────────────

describe('readRecipe — degrading', () => {
  it('reports a dish that is not there as not found, without throwing', async () => {
    await expect(readRecipeForChef(dbWith({}), { id: 'r-gone' })).resolves.toEqual({
      found: false,
      recipe: null,
    });
  });

  it('reports a corrupt document as not found, and warns', async () => {
    await expect(
      readRecipeForChef(dbWith({ 'r-bad': { nonsense: true } }), { id: 'r-bad' }),
    ).resolves.toEqual({ found: false, recipe: null });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('reports a Firestore failure as not found, and warns', async () => {
    const db = {
      collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('boom')) }) }),
    } as never;

    await expect(readRecipeForChef(db, { id: 'r-any' })).resolves.toEqual({
      found: false,
      recipe: null,
    });
    expect(mockWarn).toHaveBeenCalled();
  });
});

// ─── 4. Two tools, both saying when not to call ──────────────────────────────

describe('the chef’s tool surface', () => {
  it('is exactly two tools, and no more', () => {
    // The constraint the rewritten design principle #1 states. A third tool is a
    // new issue with its own justification, and this is what notices one arriving
    // without it.
    expect(defineToolCalls.map((c) => c.name)).toEqual(['findRecipes', 'readRecipe']);
    expect(findRecipesTool).toMatchObject({ __tool: 'findRecipes' });
    expect(readRecipeTool).toMatchObject({ __tool: 'readRecipe' });
  });

  it('both descriptions tell the model when NOT to call', () => {
    for (const tool of defineToolCalls) {
      expect(tool.description, `${tool.name} lost its "when not to call" clause`).toContain(
        'DO NOT CALL IT',
      );
    }
  });

  it('readRecipe says when the shallow line from findRecipes is already enough', () => {
    const description = defineToolCalls.find((c) => c.name === 'readRecipe')?.description ?? '';
    expect(description).toMatch(/already answers the question/i);
    expect(description).toMatch(/reading instead of cooking/i);
  });

  it('never tells the model that found:false means the dish was deleted', () => {
    // Three different causes reach `found: false` — gone, corrupt, and a read
    // that threw (all three are pinned above). A description that says "the dish
    // is gone" turns one transient Firestore failure into the chef announcing
    // that a recipe the household is looking at on screen no longer exists.
    const description = defineToolCalls.find((c) => c.name === 'readRecipe')?.description ?? '';
    expect(description).toMatch(/could not read/i);
    expect(description).toMatch(/never state\b.*deleted/i);
    expect(description).not.toMatch(/the dish is gone/i);
  });

  it('findRecipes points at readRecipe for the detail it does not carry', () => {
    const description = defineToolCalls.find((c) => c.name === 'findRecipes')?.description ?? '';
    expect(description).toMatch(/read the dish with readRecipe/i);
  });
});
