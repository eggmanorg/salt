/**
 * The meal-components prompt fragment (issue #838).
 *
 * Two things are pinned here and they are not the same weight. The rendering and
 * the degradation paths are ordinary care. The ASYMMETRY is the feature: the chef
 * sees whole dishes because gap-spotting is a reading of ingredients and methods,
 * and the librarian sees names, descriptions and times ONLY because it returns a
 * complete RecipeDoc that is spread over the stored recipe — and the planner
 * attaches the meal AND its dishes, so an ingredient line it copies from a dish
 * is shopped twice for one dinner. The "no ingredient reaches the librarian" test
 * is the guard on that, and it must never be relaxed to a prompt instruction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('firebase-functions', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

const { readComponentContext, componentSectionForChef, componentSectionForLibrarian } =
  await import('../../src/flows/componentContext.js');
const { formatRecipeForPrompt } = await import('../../src/flows/recipeText.js');

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function recipe(
  id: string,
  title: string,
  opts: {
    description?: string | null;
    ingredients?: string[];
    steps?: string[];
    /** Elapsed minutes of the dish's phase strip — the timing anything reads (#1233). */
    elapsedMinutes?: number;
    componentRecipeIds?: string[];
    // The three fields the chef's own thin rendering used to drop (#934, A5-007).
    // Optional so every existing fixture is byte-for-byte what it was.
    tags?: string[];
    stepTimer?: { durationMinutes: number; description: string };
    stepNote?: string;
    notes?: string;
  } = {},
) {
  return {
    id,
    schemaVersion: 1 as const,
    cureCategory: null,
    title,
    description: opts.description ?? null,
    ingredients:
      opts.ingredients && opts.ingredients.length > 0
        ? [
            {
              id: `${id}-g1`,
              name: null,
              items: opts.ingredients.map((rawText, i) => ({
                id: `${id}-i${i}`,
                rawText,
                parsed: null,
                canonId: null,
                matchState: 'pending' as const,
                isOptional: false,
                firstUsedInStepId: null,
              })),
            },
          ]
        : [],
    steps: (opts.steps ?? []).map((text, i) => ({
      id: `${id}-s${i}`,
      text,
      timer: i === 0 ? (opts.stepTimer ?? null) : null,
      note: i === 0 ? (opts.stepNote ?? null) : null,
    })),
    metadata: {
      servings: 4,
      phases:
        opts.elapsedMinutes === undefined
          ? []
          : [{ label: 'Cook', handsOnMinutes: 0, handsOffMinutes: opts.elapsedMinutes }],
      tags: opts.tags ?? [],
    },
    kind: 'recipe' as const,
    componentRecipeIds: opts.componentRecipeIds ?? [],
    producesCanonId: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    source: { type: 'manual' as const },
    notes: opts.notes ?? null,
    image: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const CHICKEN = recipe('chicken', 'Roast chicken', {
  description: 'A whole bird, hot oven then rested.',
  ingredients: ['1 whole chicken, 1.6 kg', '30 g butter, softened'],
  steps: ['Heat the oven to 200 °C.', 'Roast for 90 minutes, then rest for 20.'],
  elapsedMinutes: 125,
});

const POTATOES = recipe('potatoes', 'Roast potatoes', {
  // Deliberately says nothing about what goes in it: the description IS shown to
  // the librarian, so a fixture that names an ingredient in it would make the
  // "no ingredient reaches the librarian" assertion below untestable.
  description: 'Parboiled and roughed up before roasting.',
  ingredients: ['1.5 kg Maris Piper potatoes', '4 tbsp goose fat'],
  steps: ['Parboil for 8 minutes and rough up the edges.', 'Roast for 50 minutes at 200 °C.'],
  elapsedMinutes: 70,
});

/**
 * A Firestore stub over `docs`. `getAll` is deliberately given a SHUFFLED reply
 * (reversed) so a test that passes on order is proving the module re-indexes,
 * not that the stub happened to answer in request order.
 */
function dbWith(docs: Map<string, unknown>, opts: { shuffle?: boolean; throws?: boolean } = {}) {
  const getAll = vi.fn((...refs: { id: string }[]) => {
    if (opts.throws) return Promise.reject(new Error('firestore down'));
    const snaps = refs.map((ref) =>
      docs.has(ref.id)
        ? { id: ref.id, exists: true, data: () => docs.get(ref.id) }
        : { id: ref.id, exists: false, data: () => undefined },
    );
    return Promise.resolve(opts.shuffle ? snaps.reverse() : snaps);
  });
  const db = {
    collection: () => ({ doc: (id: string) => ({ id }) }),
    getAll,
  };
  return { db: db as never, getAll };
}

function docsOf(...rs: ReturnType<typeof recipe>[]) {
  return new Map<string, unknown>(rs.map((r) => [r.id, r]));
}

// ─── reading ──────────────────────────────────────────────────────────────────

describe('readComponentContext', () => {
  it('reads every component in one batched getAll', async () => {
    const { db, getAll } = dbWith(docsOf(CHICKEN, POTATOES));

    const out = await readComponentContext(
      db,
      { componentRecipeIds: ['chicken', 'potatoes'] },
      'chefChat',
    );

    expect(out.map((r) => r.title)).toEqual(['Roast chicken', 'Roast potatoes']);
    // One round trip for the whole meal — never one per dish.
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('preserves the stored order — the user drag order is the running order', async () => {
    // Stored potatoes-first, and the stub answers in the opposite order.
    const { db } = dbWith(docsOf(CHICKEN, POTATOES), { shuffle: true });

    const out = await readComponentContext(
      db,
      { componentRecipeIds: ['potatoes', 'chicken'] },
      'chefChat',
    );

    expect(out.map((r) => r.id)).toEqual(['potatoes', 'chicken']);
  });

  it('reads nothing at all when there are no components', async () => {
    const { db, getAll } = dbWith(docsOf(CHICKEN));

    expect(await readComponentContext(db, { componentRecipeIds: [] }, 'chefChat')).toEqual([]);
    // A plain recipe must not pay a Firestore read for a feature it does not use.
    expect(getAll).not.toHaveBeenCalled();
  });

  it('skips a dangling id silently, keeping the dishes that do resolve', async () => {
    const { db } = dbWith(docsOf(CHICKEN));

    const out = await readComponentContext(
      db,
      { componentRecipeIds: ['chicken', 'deleted-gravy'] },
      'chefChat',
    );

    // One dish fewer in the prompt, never a failed turn.
    expect(out.map((r) => r.id)).toEqual(['chicken']);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('skips an invalid doc rather than losing every dish', async () => {
    const docs = docsOf(CHICKEN);
    docs.set('corrupt', { title: 'Not a recipe' });
    const { db } = dbWith(docs);

    const out = await readComponentContext(
      db,
      { componentRecipeIds: ['corrupt', 'chicken'] },
      'chefChat',
    );

    expect(out.map((r) => r.id)).toEqual(['chicken']);
  });

  it('resolves exactly one level — a component that is itself a meal is not followed', async () => {
    const nested = recipe('sub-meal', 'Gravy and trimmings', {
      componentRecipeIds: ['chicken', 'potatoes'],
    });
    const { db, getAll } = dbWith(docsOf(nested, CHICKEN, POTATOES));

    const out = await readComponentContext(db, { componentRecipeIds: ['sub-meal'] }, 'chefChat');

    expect(out.map((r) => r.id)).toEqual(['sub-meal']);
    // The second level is never fetched: this is what keeps a reference cycle
    // inert and the read O(1) in the depth of the graph.
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('logs and degrades to no components when the read throws — never propagates', async () => {
    const { db } = dbWith(docsOf(CHICKEN), { throws: true });

    expect(
      await readComponentContext(db, { componentRecipeIds: ['chicken'] }, 'authorRecipe'),
    ).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('authorRecipe'),
      expect.anything(),
    );
  });
});

// ─── framings ─────────────────────────────────────────────────────────────────

describe('componentSectionForChef', () => {
  it('gives the chef the whole dish — ingredients and method included', () => {
    const section = componentSectionForChef([CHICKEN, POTATOES]);

    expect(section).toContain('Roast chicken');
    expect(section).toContain('1 whole chicken, 1.6 kg');
    expect(section).toContain('Roast for 90 minutes, then rest for 20.');
    expect(section).toContain('1.5 kg Maris Piper potatoes');
    // The chef sees the whole recipe rendering, timing included — as the phase
    // strip since issue #1233, which is the only timing a screen shows.
    expect(section).toContain('Roast for 90 minutes');
    expect(section).toContain('125 min hands-off');
  });

  it('asks for the two things the cards cannot tell the user themselves', () => {
    const section = componentSectionForChef([CHICKEN, POTATOES]);

    // Gap-spotting…
    expect(section).toContain('WHAT IS MISSING');
    expect(section).toContain('nothing green');
    // …and the coordination that belongs to no single dish.
    expect(section).toContain('THE COORDINATION');
    expect(section).toContain('chicken in at 4:00, potatoes at 4:45');
    // The founding invariant, stated to the chef in its own terms.
    expect(section).toContain('NEVER a copy');
  });

  it('numbers the dishes in stored order', () => {
    const section = componentSectionForChef([POTATOES, CHICKEN]);
    expect(section).toContain('Dish 1: Roast potatoes');
    expect(section).toContain('Dish 2: Roast chicken');
  });

  it('renders each dish through formatRecipeForPrompt — tags, step timers and notes included', () => {
    // Issue #934, finding A5-007. This section used to build its own thinner
    // rendering: no tags, no step timers, no recipe notes. That is the identical
    // hole #890 closed one layer up (`recipeText.ts`'s header is its post-mortem),
    // re-opened one layer down — and it costs the same thing, because a chef shown
    // no timer on a component dish hands back a meal whose dishes have lost their
    // timings, silently.
    //
    // Asserted against the shared renderer's output rather than against
    // hand-written strings: if `formatRecipeForPrompt` grows a field, the chef's
    // dishes get it with no edit here, which is the whole point of converging.
    const RICH = recipe('rich', 'Braised shin', {
      description: 'Low and slow.',
      ingredients: ['1.2 kg beef shin'],
      steps: ['Brown the shin hard.', 'Braise until it pulls apart.'],
      tags: ['slow', 'winter'],
      stepTimer: { durationMinutes: 180, description: 'Braise the shin' },
      stepNote: 'Dry the meat first or it will steam.',
      notes: 'Better on the second day.',
    });

    const section = componentSectionForChef([RICH]);

    expect(section).toContain(formatRecipeForPrompt(RICH as never));
    // ...and named individually, because `toContain` of the whole rendering would
    // still pass if the renderer itself quietly lost one of them.
    expect(section).toContain('Tags: slow, winter');
    expect(section).toContain('[timer: 180 min — Braise the shin]');
    expect(section).toContain('(note: Dry the meat first or it will steam.)');
    expect(section).toContain('Notes: Better on the second day.');
  });

  it('still binds the ordinal to the dish name in one line', () => {
    // Only the librarian framing tells the model to "PRESERVE the dish names
    // exactly as they appear here" as an explicit instruction; the chef framing
    // does not. Here it is the repeated heading itself that binds the ordinal to
    // the dish name, and the coordination answer refers to dishes by number. The
    // shared rendering opens with `Title:`; the heading is what joins the two.
    const section = componentSectionForChef([POTATOES, CHICKEN]);
    expect(section).toContain('Dish 1: Roast potatoes\nTitle: Roast potatoes');
    expect(section).toContain('Dish 2: Roast chicken\nTitle: Roast chicken');
  });

  it('says nothing at all when the recipe is not a meal', () => {
    expect(componentSectionForChef([])).toBe('');
  });
});

describe('componentSectionForLibrarian', () => {
  it('gives the librarian recognition-and-preservation framing, never licence to fold a dish in', () => {
    const section = componentSectionForLibrarian([CHICKEN, POTATOES]);

    expect(section).toContain('NAMES AND TIMES ONLY');
    expect(section).toContain('NEVER copy');
    expect(section).toContain('bought TWICE');
    expect(section).toContain('PRESERVE the dish names');
  });

  it('shows names, descriptions and how long each dish takes', () => {
    const section = componentSectionForLibrarian([CHICKEN]);

    expect(section).toContain('Dish 1: Roast chicken');
    expect(section).toContain('A whole bird, hot oven then rested.');
    // The whole process, start to serve — the same figure the cook plan's start
    // clock is worked back from (issue #1233), not the old stored cook time.
    expect(section).toContain('takes: 125 min start to serve');
  });

  it('NEVER shows a component ingredient or step — the guard is structural, not a prompt clause', () => {
    const section = componentSectionForLibrarian([CHICKEN, POTATOES]);

    // If any of these ever appear, the librarian can merge them onto the meal and
    // the dinner gets shopped twice. This is the test that must not be relaxed.
    expect(section).not.toContain('1 whole chicken, 1.6 kg');
    expect(section).not.toContain('30 g butter, softened');
    expect(section).not.toContain('1.5 kg Maris Piper potatoes');
    expect(section).not.toContain('goose fat');
    expect(section).not.toContain('Heat the oven to 200 °C.');
    expect(section).not.toContain('Parboil for 8 minutes');
    expect(section).not.toContain('Ingredients:');
    expect(section).not.toContain('Method:');
  });

  it('shows no stored prep, cook or total — nothing reads them (#1233)', () => {
    const section = componentSectionForLibrarian([CHICKEN]);
    expect(section).not.toContain('prep:');
    expect(section).not.toContain('cook:');
    expect(section).not.toContain('total:');
  });

  it('says nothing about timing for a dish with no phase strip', () => {
    // A fabricated figure would be worse than none: the meal's method is a timing
    // plan, and a made-up number is a plan built on a guess.
    const section = componentSectionForLibrarian([recipe('salad', 'Green salad')]);
    expect(section).toContain('Dish 1: Green salad');
    expect(section).not.toContain('takes:');
  });

  it('says nothing at all when the recipe is not a meal', () => {
    expect(componentSectionForLibrarian([])).toBe('');
  });
});
