/**
 * The chef's library-search tool (issue #840, phase 1).
 *
 * Three properties this feature CLAIMS, each pinned here because a sentence
 * nothing can falsify is worth nothing:
 *
 *  1. A SEARCH NEVER READS `ingredients` OR `steps` OFF THE WIRE. The stub
 *     Firestore below REFUSES an unprojected read — `get()` throws unless
 *     `select()` was called first — so replacing the projection with a full
 *     collection read turns this suite red rather than merely slower and more
 *     expensive. The projected field list is asserted exactly, both for what it
 *     contains and for what it must not.
 *  2. THE TOOL DESCRIPTION SAYS WHEN NOT TO CALL. That clause is the whole
 *     mitigation for the failure mode design principle #1 was protecting — a
 *     chef with a tool reaches for it — and it is prompt text, so nothing but a
 *     content assertion can hold it in place.
 *  3. THE CHEF STILL HAS NO STRUCTURED OUTPUT SCHEMA. Half of principle #1
 *     survives, and "survives" means `generateStream` is called with tools and
 *     with no `output` option at all.
 *
 * The handler's own behaviour — the skip-invalid read, the degradation, the
 * shallow line it renders — is pinned alongside them. Ranking is not: that is
 * pure and lives in `@salt/domain`, tested in `searchRecipes.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from 'firebase-functions';

// A SPY on the real logger rather than a sixth `vi.mock`, which would put this
// file over the unit-test spec's mock ceiling (UT-B1). The warn calls are what
// prove the skip-invalid and degrade-on-failure paths were taken.
const mockWarn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

const mockGenerateStream = vi.fn();
const defineToolCalls: { config: { name: string; description: string } }[] = [];

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    // Capture the config so the description — which is prompt text — can be
    // asserted, and return a recognisable token as the tool value.
    defineTool: (config: { name: string; description: string }, handler: unknown) => {
      defineToolCalls.push({ config });
      return { __tool: config.name, handler };
    },
    generateStream: mockGenerateStream,
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));

const mockGetFirestore = vi.fn();
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => mockGetFirestore() }));

const { findRecipesInLibrary, findRecipesTool, readRecipeTool, chefChatFlow } =
  await import('../../src/flows/chefChat.js');

beforeEach(() => {
  mockWarn.mockClear();
  mockGenerateStream.mockReset();
});

// ─── Firestore stub that refuses an unprojected read ─────────────────────────

interface StoredRecipe {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

let lastSelect: string[] | null = null;

/**
 * A `recipes` collection that can ONLY be read through `select()`.
 *
 * The refusal is the assertion: a handler that dropped the projection would call
 * `get()` on the collection itself and get an exception, not a slower success.
 */
function dbWith(docs: StoredRecipe[]): never {
  lastSelect = null;
  const snapshot = { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
  const db = {
    collection: (name: string) => {
      if (name !== 'recipes') throw new Error(`unexpected collection ${name}`);
      return {
        select: (...fields: string[]) => {
          lastSelect = fields;
          return { get: () => Promise.resolve(snapshot) };
        },
        get: () => {
          throw new Error(
            'findRecipes read the recipes collection WITHOUT select(): a search must never ' +
              'pull ingredients or steps off the wire',
          );
        },
      };
    },
  };
  return db as never;
}

function recipeDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Slow-roast lamb shoulder',
    description: 'Six hours in a low oven.',
    kind: 'recipe',
    metadata: { servings: 4, tags: ['sunday'], phases: [] },
    ...over,
  };
}

// ─── 1. The projected read ────────────────────────────────────────────────────

describe('findRecipes — what crosses the wire', () => {
  it('reads through select(), and never fetches ingredients or steps', async () => {
    await findRecipesInLibrary(dbWith([{ id: 'r-1', data: recipeDoc() }]), {});

    expect(lastSelect).not.toBeNull();
    expect(lastSelect).toEqual(['title', 'description', 'kind', 'metadata']);
    expect(lastSelect).not.toContain('ingredients');
    expect(lastSelect).not.toContain('steps');
  });

  it('takes the id from the document, not from a projected field', async () => {
    // `id` is not in the projection, so a handler reading `data().id` would
    // return undefined and every link the chef writes would be broken.
    const result = await findRecipesInLibrary(
      dbWith([{ id: 'r-real', data: recipeDoc({ id: 'r-stale' }) }]),
      {},
    );
    expect(result.matches[0]?.id).toBe('r-real');
  });
});

// ─── The shallow line ─────────────────────────────────────────────────────────

describe('findRecipes — the shallow line', () => {
  it('carries the id, title, kind, tags, servings and timings', async () => {
    const result = await findRecipesInLibrary(
      dbWith([
        {
          id: 'r-1',
          data: recipeDoc({
            metadata: {
              servings: 6,
              tags: ['sunday', 'roast'],
              phases: [
                { label: 'Prep', handsOnMinutes: 20, handsOffMinutes: 0 },
                { label: 'Roast', handsOnMinutes: 5, handsOffMinutes: 335 },
              ],
            },
          }),
        },
      ]),
      {},
    );

    expect(result.matches).toEqual([
      {
        id: 'r-1',
        title: 'Slow-roast lamb shoulder',
        kind: 'recipe',
        tags: ['sunday', 'roast'],
        description: 'Six hours in a low oven.',
        servings: 6,
        elapsedMinutes: 360,
        handsOnMinutes: 25,
      },
    ]);
  });

  it('reports no timing rather than zero minutes for a recipe that has never been timed', async () => {
    const result = await findRecipesInLibrary(
      dbWith([{ id: 'r-1', data: recipeDoc({ metadata: { servings: null, tags: [] } }) }]),
      {},
    );
    expect(result.matches[0]).toMatchObject({ elapsedMinutes: null, handsOnMinutes: null });
  });

  it('trims a long description and marks that it was cut', async () => {
    const long = `${'word '.repeat(200)}end`;
    const result = await findRecipesInLibrary(
      dbWith([{ id: 'r-1', data: recipeDoc({ description: long }) }]),
      {},
    );
    const trimmed = result.matches[0]?.description ?? '';
    expect(trimmed.length).toBeLessThan(long.length);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(trimmed).not.toContain('end');
  });

  it('leaves a short description exactly as written', async () => {
    const result = await findRecipesInLibrary(
      dbWith([{ id: 'r-1', data: recipeDoc({ description: 'Short.' }) }]),
      {},
    );
    expect(result.matches[0]?.description).toBe('Short.');
  });

  it('defaults a document written before `kind` existed to a recipe', async () => {
    const { kind: _dropped, ...noKind } = recipeDoc();
    const result = await findRecipesInLibrary(dbWith([{ id: 'r-1', data: noKind }]), {});
    expect(result.matches[0]?.kind).toBe('recipe');
  });
});

// ─── Filters, browse and the library size ────────────────────────────────────

describe('findRecipes — the search', () => {
  const library = [
    { id: 'r-lamb', data: recipeDoc() },
    {
      id: 'r-dhal',
      data: recipeDoc({
        title: 'Red lentil dhal',
        description: 'On the table in twenty minutes.',
        metadata: { servings: 2, tags: ['vegetarian', 'quick'] },
      }),
    },
    {
      id: 'r-negroni',
      data: recipeDoc({
        title: 'Negroni',
        description: null,
        kind: 'cocktail',
        metadata: { servings: 1, tags: [] },
      }),
    },
  ];

  it('browses the whole library for an empty query', async () => {
    const result = await findRecipesInLibrary(dbWith(library), {});
    expect(result.matches).toHaveLength(3);
    expect(result.totalInLibrary).toBe(3);
  });

  it('narrows on a query, and still reports the whole library size', async () => {
    // The size is what tells the chef "we have almost nothing saved" apart from
    // "we have nothing like that" — the two need different answers.
    const result = await findRecipesInLibrary(dbWith(library), { query: 'lamb' });
    expect(result.matches.map((m) => m.id)).toEqual(['r-lamb']);
    expect(result.totalInLibrary).toBe(3);
  });

  it('passes the kind and tag filters through to the ranking function', async () => {
    await expect(
      findRecipesInLibrary(dbWith(library), { kind: 'cocktail' }),
    ).resolves.toMatchObject({ matches: [{ id: 'r-negroni' }] });
    await expect(
      findRecipesInLibrary(dbWith(library), { tags: ['quick', 'vegetarian'] }),
    ).resolves.toMatchObject({ matches: [{ id: 'r-dhal' }] });
  });

  it('returns no matches for a query nothing answers', async () => {
    const result = await findRecipesInLibrary(dbWith(library), { query: 'gochujang' });
    expect(result.matches).toEqual([]);
    expect(result.totalInLibrary).toBe(3);
  });
});

// ─── Degrading ────────────────────────────────────────────────────────────────

describe('findRecipes — degrading', () => {
  it('skips a recipe that fails validation without losing the rest', async () => {
    const result = await findRecipesInLibrary(
      dbWith([
        { id: 'r-bad', data: { nonsense: true } },
        { id: 'r-good', data: recipeDoc() },
      ]),
      {},
    );
    expect(result.matches.map((m) => m.id)).toEqual(['r-good']);
    expect(result.totalInLibrary).toBe(1);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('returns nothing, and warns, rather than throwing when Firestore fails', async () => {
    const db = {
      collection: () => ({ select: () => ({ get: () => Promise.reject(new Error('boom')) }) }),
    } as never;

    await expect(findRecipesInLibrary(db, {})).resolves.toEqual({
      matches: [],
      totalInLibrary: 0,
    });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('handles an empty library', async () => {
    await expect(findRecipesInLibrary(dbWith([]), { query: 'lamb' })).resolves.toEqual({
      matches: [],
      totalInLibrary: 0,
    });
  });
});

// ─── 2. The tool description is prompt work ──────────────────────────────────

describe('findRecipes — the tool the model is shown', () => {
  const tool = defineToolCalls.find((c) => c.config.name === 'findRecipes');

  it('is registered, alongside the one other tool the chef has', () => {
    // Exact, and it stays exact: two is the whole surface (issue #840), and a
    // third arriving without its own issue should turn this red. The same list
    // is asserted from the readRecipe side in `chefChat.readRecipe.test.ts`.
    expect(defineToolCalls.map((c) => c.config.name)).toEqual(['findRecipes', 'readRecipe']);
    expect(findRecipesTool).toMatchObject({ __tool: 'findRecipes' });
  });

  it('tells the model when NOT to call it', () => {
    // The load-bearing half. Without it the chef searches on questions it could
    // simply answer, which is the failure design principle #1 was protecting
    // against and the reason there are two tools rather than ten.
    const description = tool?.config.description ?? '';
    expect(description).toContain('DO NOT CALL IT');
    expect(description).toMatch(/technique/i);
    expect(description).toMatch(/substitution/i);
    expect(description).toMatch(/just answer/i);
  });

  it('tells the model that an empty query browses, and to turn a vibe into keywords', () => {
    const description = tool?.config.description ?? '';
    expect(description).toMatch(/leave query out/i);
    expect(description).toMatch(/keywords/i);
  });

  it('says the results carry no ingredients and no method, and where to get them', () => {
    const description = tool?.config.description ?? '';
    expect(description).toMatch(/does NOT include ingredients or a method/i);
    expect(description).toMatch(/read the dish with readRecipe/i);
  });
});

// ─── 3. Tools yes, structured output never ───────────────────────────────────

describe('chefChat — the tool in the flow', () => {
  async function runTurn(): Promise<Record<string, unknown>> {
    mockGetFirestore.mockReturnValue(dbWith([]));
    mockGenerateStream.mockReturnValue({
      stream: (async function* () {
        yield { text: 'hello' };
      })(),
      response: Promise.resolve({ text: 'hello' }),
    });

    await (
      chefChatFlow as unknown as (input: unknown, cb: (text: string) => void) => Promise<string>
    )({ messages: [], newMessage: 'what shall we have?', recipeId: null }, () => {});

    return mockGenerateStream.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it('passes both of the chef’s tools to the model', async () => {
    const options = await runTurn();
    expect(options['tools']).toEqual([findRecipesTool, readRecipeTool]);
  });

  it('gives the chef NO structured output schema — half of principle #1 survives', async () => {
    const options = await runTurn();
    expect(options['output']).toBeUndefined();
    expect(Object.keys(options)).not.toContain('output');
  });

  it('tells the chef to link every saved dish it names, and never to read the library back as a list', async () => {
    const options = await runTurn();
    const system = String(options['system']);
    expect(system).toContain('(#/recipes/');
    expect(system).toContain('NEVER READ THE LIBRARY BACK AS A LIST');
    // And that reading a dish is a separate, deliberate act (phase 2).
    expect(system).toMatch(/Search to FIND a dish; read one when/);
    // The FAVOURITES_FRAMING lesson, restated for the library: "something
    // different" must not be answered with what they already own.
    expect(system).toMatch(/something DIFFERENT/);
    expect(system).toMatch(/steer AWAY/);
  });
});
