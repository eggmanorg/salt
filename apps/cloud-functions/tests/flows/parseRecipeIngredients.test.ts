import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { READER_UNIT_PRINCIPLE } from '@salt/domain/prompts';

const mockGenerate = vi.fn();
const mockUUID = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

// Stub withAiTimeout to call op() directly — timeout/retry logic is tested in its own suite.
// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

vi.stubGlobal('crypto', { randomUUID: mockUUID });

const { parseRecipeIngredientsFlow } = await import('../../src/flows/parseRecipeIngredients.js');

beforeEach(() => {
  vi.clearAllMocks();
  let counter = 0;
  mockUUID.mockImplementation(() => `id-${++counter}`);
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

type AiIngredient = {
  rawText: string;
  quantity: unknown;
  unit: 'g' | 'ml' | null;
  item: string;
  preparation: string[];
  notes: string | null;
  isOptional: boolean;
  displayText: string | null;
};

function aiOutput(groups: Array<{ name: string | null; items: AiIngredient[] }>) {
  return { groups };
}

function simpleIngredient(overrides: Partial<AiIngredient> & { rawText: string }): AiIngredient {
  return {
    quantity: null,
    unit: null,
    item: overrides.rawText,
    preparation: [],
    notes: null,
    isOptional: false,
    displayText: null,
    ...overrides,
  };
}

// ─── Range quantity ───────────────────────────────────────────────────────────

describe('parseRecipeIngredients — range quantity', () => {
  it('maps a range quantity (in metric ml) to the ingredient parsed field', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '2-3 tbsp olive oil',
              quantity: { type: 'range', min: 30, max: 45 },
              unit: 'ml',
              item: 'olive oil',
              displayText: '2-3 tbsp',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '2-3 tbsp olive oil',
    });

    expect(result[0].items[0].rawText).toBe('2-3 tbsp olive oil');
    expect(result[0].items[0].parsed.quantity).toEqual({ type: 'range', min: 30, max: 45 });
    expect(result[0].items[0].parsed.unit).toBe('ml');
    expect(result[0].items[0].parsed.displayText).toBe('2-3 tbsp');
    expect(result[0].items[0].parsed.item).toBe('olive oil');
  });
});

// ─── Non-metric source quantities ────────────────────────────────────────────

describe('parseRecipeIngredients — non-metric source quantities', () => {
  it('stores the metric equivalent and NO displayText for cup measures', async () => {
    // A cup is a measure a UK kitchen cannot take, so it converts and then
    // disappears — the prompt asks for `displayText: null` rather than a "(1½
    // cups)" bracket the cook has no way to act on. Only tsp/tbsp and counts earn
    // the bracket. The flow itself just threads whatever the model returns; this
    // pins the SHAPE the prompt asks for.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '1 ½ cups plain flour, sifted',
              quantity: { type: 'single', value: 180 },
              unit: 'g',
              item: 'plain flour',
              preparation: ['sifted'],
              displayText: null,
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '1 ½ cups plain flour, sifted',
    });

    const ingredient = result[0].items[0];
    expect(ingredient.rawText).toBe('1 ½ cups plain flour, sifted');
    expect(ingredient.parsed.quantity).toEqual({ type: 'single', value: 180 });
    expect(ingredient.parsed.unit).toBe('g');
    expect(ingredient.parsed.displayText).toBeNull();
    expect(ingredient.parsed.preparation).toEqual(['sifted']);
  });

  it('stores metric ml and original displayText for tsp measures', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '½ tsp salt',
              quantity: { type: 'single', value: 2.5 },
              unit: 'ml',
              item: 'salt',
              displayText: '½ tsp',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({ rawText: '½ tsp salt' });

    expect(result[0].items[0].parsed.quantity).toEqual({ type: 'single', value: 2.5 });
    expect(result[0].items[0].parsed.unit).toBe('ml');
    expect(result[0].items[0].parsed.displayText).toBe('½ tsp');
  });
});

// ─── Grouped recipe ───────────────────────────────────────────────────────────

describe('parseRecipeIngredients — grouped recipe', () => {
  it('returns two groups when the AI detects a section header', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '200g pasta',
              quantity: { type: 'single', value: 200 },
              unit: 'g',
              item: 'pasta',
            }),
          ],
        },
        {
          name: 'For the sauce',
          items: [
            simpleIngredient({
              rawText: '2 cloves garlic, crushed',
              quantity: { type: 'single', value: 2 },
              unit: null,
              item: 'garlic',
              preparation: ['crushed'],
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '200g pasta\nFor the sauce:\n2 cloves garlic, crushed',
    });

    expect(result).toHaveLength(2);
    expect(result[0].name).toBeNull();
    expect(result[1].name).toBe('For the sauce');
    expect(result[1].items[0].rawText).toBe('2 cloves garlic, crushed');
  });

  it('assigns distinct IDs to groups and their items', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        { name: null, items: [simpleIngredient({ rawText: '1 egg' })] },
        { name: 'Sauce', items: [simpleIngredient({ rawText: '2 tbsp oil' })] },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '1 egg\nSauce:\n2 tbsp oil',
    });

    const groupIds = result.map((g: { id: string }) => g.id);
    const itemIds = result.flatMap((g: { items: Array<{ id: string }> }) =>
      g.items.map((i) => i.id),
    );
    const allIds = [...groupIds, ...itemIds];
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

// ─── Optional garnish ─────────────────────────────────────────────────────────

describe('parseRecipeIngredients — optional garnish', () => {
  it('sets isOptional true when the AI flags an optional ingredient', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: 'fresh parsley to serve (optional)',
              item: 'fresh parsley',
              notes: 'to serve',
              isOptional: true,
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: 'fresh parsley to serve (optional)',
    });

    expect(result[0].items[0].isOptional).toBe(true);
    expect(result[0].items[0].rawText).toBe('fresh parsley to serve (optional)');
  });
});

// ─── displayText threading ────────────────────────────────────────────────────

describe('parseRecipeIngredients — displayText threading', () => {
  it('threads metric quantity/unit and displayText through to the parsed field', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '½ cup butter, melted',
              quantity: { type: 'single', value: 113 },
              unit: 'g',
              item: 'butter',
              preparation: ['melted'],
              displayText: null,
            }),
            simpleIngredient({
              rawText: '1 tbsp olive oil',
              quantity: { type: 'single', value: 15 },
              unit: 'ml',
              item: 'olive oil',
              displayText: '1 tbsp',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '½ cup butter, melted\n1 tbsp olive oil',
    });

    // The cup converts and loses its bracket; the tbsp converts and KEEPS one.
    // That asymmetry is the whole display policy: the bracket is only worth
    // showing when the cook owns the thing that measures it.
    expect(result[0].items[0].parsed.quantity).toEqual({ type: 'single', value: 113 });
    expect(result[0].items[0].parsed.unit).toBe('g');
    expect(result[0].items[0].parsed.displayText).toBeNull();
    expect(result[0].items[1].parsed.quantity).toEqual({ type: 'single', value: 15 });
    expect(result[0].items[1].parsed.unit).toBe('ml');
    expect(result[0].items[1].parsed.displayText).toBe('1 tbsp');
  });

  it('nulls a spoon-measure displayText the model returned above the cap (#1196)', async () => {
    // The prompt bullet only ASKS the model to leave displayText null above the
    // cap; this is the deterministic backstop for when it doesn't. A model that
    // ignores the bullet and returns "6 tbsp" anyway must not reach storage.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '6 tbsp olive oil',
              quantity: { type: 'single', value: 90 },
              unit: 'ml',
              item: 'olive oil',
              displayText: '6 tbsp',
            }),
            simpleIngredient({
              rawText: '3 tbsp olive oil',
              quantity: { type: 'single', value: 45 },
              unit: 'ml',
              item: 'olive oil',
              displayText: '3 tbsp',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '6 tbsp olive oil\n3 tbsp olive oil',
    });

    // Over the cap: clamped to null even though the model returned a bracket.
    expect(result[0].items[0].parsed.quantity).toEqual({ type: 'single', value: 90 });
    expect(result[0].items[0].parsed.displayText).toBeNull();
    // At the cap ("3 tbsp or less"): untouched.
    expect(result[0].items[1].parsed.displayText).toBe('3 tbsp');
  });

  it('threads metric weight, "g" unit, and a count displayText for count/item-based ingredients', async () => {
    // Count items are now converted to estimated metric weight by the model; the original
    // count form rides along in displayText. The flow threads whatever the model returns.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '2 cloves garlic',
              quantity: { type: 'single', value: 6 },
              unit: 'g',
              item: 'garlic',
              displayText: '2 cloves',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({ rawText: '2 cloves garlic' });

    expect(result[0].items[0].parsed.quantity).toEqual({ type: 'single', value: 6 });
    expect(result[0].items[0].parsed.unit).toBe('g');
    expect(result[0].items[0].parsed.displayText).toBe('2 cloves');
  });

  it('keeps the count with unit null for bought-whole discrete proteins (egg parts, poultry joints, whole fish)', async () => {
    // Egg parts, poultry joints, and whole fish are bought and used as whole discrete pieces:
    // the shopper's COUNT is kept as quantity, unit is null, and the gram estimate rides in
    // displayText. The flow threads whatever the model returns for these.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '3 egg whites',
              quantity: { type: 'single', value: 3 },
              unit: null,
              item: 'egg whites',
              displayText: 'about 105g',
            }),
            simpleIngredient({
              rawText: '6 chicken thighs',
              quantity: { type: 'single', value: 6 },
              unit: null,
              item: 'chicken thighs',
              displayText: 'about 720g',
            }),
            simpleIngredient({
              rawText: '2 whole sea bass',
              quantity: { type: 'single', value: 2 },
              unit: null,
              item: 'sea bass',
              displayText: 'about 400g',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '3 egg whites\n6 chicken thighs\n2 whole sea bass',
    });

    const [eggWhites, thighs, fish] = result[0].items;

    expect(eggWhites.parsed.quantity).toEqual({ type: 'single', value: 3 });
    expect(eggWhites.parsed.unit).toBeNull();
    expect(eggWhites.parsed.displayText).toBe('about 105g');

    expect(thighs.parsed.quantity).toEqual({ type: 'single', value: 6 });
    expect(thighs.parsed.unit).toBeNull();
    expect(thighs.parsed.displayText).toBe('about 720g');

    expect(fish.parsed.quantity).toEqual({ type: 'single', value: 2 });
    expect(fish.parsed.unit).toBeNull();
    expect(fish.parsed.displayText).toBe('about 400g');
  });

  it('still flattens ordinary count/pack ingredients (onions, rashers) to metric grams', async () => {
    // The keep-as-count exception is narrow: everything outside bought-whole discrete proteins
    // continues to flatten to grams with the count in displayText.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '2 onions',
              quantity: { type: 'single', value: 300 },
              unit: 'g',
              item: 'onions',
              displayText: 'about 2 medium',
            }),
            simpleIngredient({
              rawText: '4 rashers bacon',
              quantity: { type: 'single', value: 100 },
              unit: 'g',
              item: 'bacon',
              displayText: 'about 4 rashers',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: '2 onions\n4 rashers bacon',
    });

    const [onions, bacon] = result[0].items;

    expect(onions.parsed.quantity).toEqual({ type: 'single', value: 300 });
    expect(onions.parsed.unit).toBe('g');

    expect(bacon.parsed.quantity).toEqual({ type: 'single', value: 100 });
    expect(bacon.parsed.unit).toBe('g');
  });

  it('threads a citrus-component parse through unchanged (component in item, count in displayText)', async () => {
    // Issue #854. The whole defect was upstream of this flow: the model used to
    // return item "limes" with preparation ["juice of"], so product-form
    // resolution — which is fed `parsed.item` and nothing else — never saw the
    // word "juice" and fell back to scaling 130ml. The prompt now names the
    // component; this pins that the flow threads that shape through untouched,
    // and that a whole-fruit line keeps the fruit in item with the action in
    // preparation.
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: 'Juice of 2 limes',
              quantity: { type: 'single', value: 60 },
              unit: 'ml',
              item: 'lime juice',
              displayText: '2 limes',
            }),
            simpleIngredient({
              rawText: 'Zest of 1 lemon',
              quantity: { type: 'single', value: 5 },
              unit: 'g',
              item: 'lemon zest',
              displayText: '1 lemon',
            }),
            simpleIngredient({
              rawText: '2 limes, halved',
              quantity: { type: 'single', value: 130 },
              unit: 'g',
              item: 'limes',
              preparation: ['halved'],
              displayText: 'about 2 limes',
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({
      rawText: 'Juice of 2 limes\nZest of 1 lemon\n2 limes, halved',
    });

    const [juice, zest, wholeFruit] = result[0].items;

    expect(juice.parsed.item).toBe('lime juice');
    expect(juice.parsed.preparation).toEqual([]);
    expect(juice.parsed.quantity).toEqual({ type: 'single', value: 60 });
    expect(juice.parsed.unit).toBe('ml');
    expect(juice.parsed.displayText).toBe('2 limes');

    expect(zest.parsed.item).toBe('lemon zest');
    expect(zest.parsed.quantity).toEqual({ type: 'single', value: 5 });
    expect(zest.parsed.unit).toBe('g');
    expect(zest.parsed.displayText).toBe('1 lemon');

    // The fruit itself is the ingredient here, so nothing about it changes.
    expect(wholeFruit.parsed.item).toBe('limes');
    expect(wholeFruit.parsed.preparation).toEqual(['halved']);
    expect(wholeFruit.parsed.quantity).toEqual({ type: 'single', value: 130 });
    expect(wholeFruit.parsed.unit).toBe('g');
  });

  it('keeps quantity and unit null for genuinely unquantifiable items', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: 'salt to taste',
              quantity: null,
              unit: null,
              item: 'salt',
              displayText: null,
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({ rawText: 'salt to taste' });

    expect(result[0].items[0].parsed.quantity).toBeNull();
    expect(result[0].items[0].parsed.unit).toBeNull();
    expect(result[0].items[0].parsed.displayText).toBeNull();
  });
});

// ─── Domain invariants ────────────────────────────────────────────────────────

describe('parseRecipeIngredients — domain invariants on every item', () => {
  it('sets matchState pending, canonId null, firstUsedInStepId null', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({
              rawText: '1 egg',
              item: 'egg',
              quantity: { type: 'single', value: 1 },
            }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({ rawText: '1 egg' });

    const item = result[0].items[0];
    expect(item.matchState).toBe('pending');
    expect(item.canonId).toBeNull();
    expect(item.firstUsedInStepId).toBeNull();
  });

  it('assigns unique IDs to each group and ingredient', async () => {
    mockGenerate.mockResolvedValue({
      output: aiOutput([
        {
          name: null,
          items: [
            simpleIngredient({ rawText: '1 egg' }),
            simpleIngredient({ rawText: '200ml milk' }),
          ],
        },
      ]),
    });

    const result = await (parseRecipeIngredientsFlow as Function)({ rawText: '1 egg\n200ml milk' });

    // group id + 2 item ids = 3 distinct values from the counter
    expect(result[0].id).toBe('id-1');
    expect(result[0].items[0].id).toBe('id-2');
    expect(result[0].items[1].id).toBe('id-3');
  });
});

// ─── Prompt construction ──────────────────────────────────────────────────────

describe('parseRecipeIngredients — prompt construction', () => {
  it('passes the rawText verbatim as the prompt', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '1 cup flour\n2 eggs' });

    const opts = mockGenerate.mock.calls[0]![0];
    expect(opts.prompt).toBe('1 cup flour\n2 eggs');
  });

  it('passes temperature 0 and an output schema to generate', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '1 cup flour' });

    const opts = mockGenerate.mock.calls[0]![0];
    expect(opts.config).toEqual({ temperature: 0 });
    expect(opts.output?.schema).toBeDefined();
  });

  it('includes rawText preservation instructions in the system prompt', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '1 cup flour' });

    const { system } = mockGenerate.mock.calls[0]![0];
    expect(system).toContain('rawText');
    expect(system).toContain('verbatim');
  });

  it('states the shared reader-facing unit policy, and the 3 tbsp bound on it (#934)', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '½ tsp salt' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // Imported, never restated: the chef's prose and this bracket are one policy
    // now, and reading them from one constant is what stops them disagreeing again.
    expect(system).toContain(READER_UNIT_PRINCIPLE);
    // The cap is the issue's one bound — asked for here as a prompt instruction,
    // not enforced as a post-parse clamp (see unitPolicy.ts's header): a spoon
    // measure earns a bracket only up to 3 tbsp, above which nobody counts it out
    // at the bench.
    expect(system).toContain('but ONLY up');
    expect(system).toContain('to 3 tbsp');
    expect(system).toContain('"6 tbsp olive oil" → null');
    // And the clause that stops the chef's metric-first line losing its spoon: an
    // already-metric line WITH a bracket keeps it, rather than falling to null.
    expect(system).toContain('that BRACKET IS the displayText');
    expect(system).toContain('already in g, kg, ml, or l AND carries no bracketed spoon measure');
  });

  it('mandates converting ordinary count/pack ingredients to metric in the system prompt', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '2 cloves garlic' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // Ordinary count/pack ingredients (cloves, rashers, tins, etc.) still flatten to metric.
    expect(system).toContain('Convert count/item-based and pack-based ingredients to metric');
    // The clove estimate survives, but only as displayText — see the garlic test below.
    expect(system).toContain('1 clove garlic ≈ 3g');
    // unquantifiable items stay quantity+unit null.
    expect(system).toContain('genuinely unquantifiable');
  });

  it('puts the part of a thing you use into item, not into preparation (issue #854)', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: 'Juice of 2 limes' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // `parsed.item` is the ONLY thing product-form resolution is handed
    // (canonicaliseRecipeIngredients rawName / recipeService formCountFor), so a
    // component demoted to a preparation phrase is unrecoverable downstream.
    expect(system).toContain('NAMING — the PART of a thing you use belongs to its NAME');
    expect(system).toContain('item "lime juice"');
    expect(system).toContain('item "lemon zest"');
    expect(system).toContain('item "orange juice"');
    expect(system).toContain('Never leave "juice of" or "zest of" in preparation');
    // The non-coverage clause: ordinary prep of a whole thing is untouched.
    expect(system).toContain('"2 limes, halved" → item "limes", preparation ["halved"]');
    // The count rides in displayText plainly, with no "about" hedge.
    expect(system).toContain('CITRUS COMPONENT lines');
    expect(system).toContain('with NO "about" prefix');
  });

  it('carries citrus-component yields separately from whole-fruit weights (issue #854)', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: 'Juice of 2 limes' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // Physically accurate component yields — deliberately NOT authored to match
    // whatever the live productForms rows happen to say today (issue #854
    // Decisions). arbitrateProductForm's own prompt already teaches 30ml/lime.
    expect(system).toContain('juice of 1 lime ≈ 30ml');
    expect(system).toContain('juice of 1 lemon ≈ 45ml');
    expect(system).toContain('juice of 1 orange ≈ 70ml');
    expect(system).toContain('zest of 1 lime / lemon / orange ≈ 5g');
    // ml for juice, g for zest — the yield unit must agree with the product
    // form's formUnit in BOTH directions or formParentCount returns null.
    expect(system).toContain('unit to "ml" for juice and "g" for zest');
    // The whole-fruit weights survive for lines where the fruit IS the ingredient.
    expect(system).toContain('1 lemon ≈ 100g, 1 lime ≈ 65g');
    expect(system).toContain('"2 limes, halved" is 130g of limes');
  });

  it('keeps a garlic clove as a counted component of the bulb', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '2 cloves garlic, crushed' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // BOTH halves are load-bearing and neither works alone. The NAME, because
    // product-form resolution is handed `item` and nothing else, and containment
    // is one-directional — a form phrased "garlic clove" can never be found
    // inside an item of "garlic". The UNIT, because `formParentCount` returns
    // null on a unit mismatch, so a count-yield form fed grams is rejected even
    // once the name is right.
    expect(system).toContain('a garlic clove is a COUNTED COMPONENT of the bulb');
    expect(system).toContain('"1 clove garlic" → quantity 1, item "garlic clove"');
    expect(system).toContain('"2 cloves of garlic, crushed" → quantity 2, item "garlic clove"');
    expect(system).toContain('never reduce item to "garlic"');
    expect(system).toContain('quantity 2, unit null, item "garlic clove"');
    // The bulb-per-clove division belongs to the product form, not the parse.
    expect(system).toContain("the product form's job, not this one's");
    // A whole bulb is still a bulb.
    expect(system).toContain('"1 bulb garlic, roasted" → item "garlic"');
    // ...and cloves are no longer named among the things that flatten to grams.
    expect(system).not.toContain('garlic cloves, onions, rashers');
  });

  it('keeps the clove COUNT on the "N cloves of garlic" wording', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({
      rawText: '3 large cloves of garlic, peeled and very finely sliced',
    });

    const { system } = mockGenerate.mock.calls[0]![0];
    // The regression this guards: "3 large cloves of garlic" parsed to quantity
    // NULL while "6 cloves garlic" parsed to 6, because #857 taught the clove
    // case by hanging it off the juice/zest NAMING rule — and there the number
    // after "of" counts the PARENT ("juice of 2 limes" → 60ml), not the thing
    // being named. The model read "3 ... of garlic" as a parent count it had no
    // yield for and emitted nothing. A null quantity then fails `formCountFor`'s
    // first guard, so the line never becomes a product-form row: no count, no
    // formDemand, no originalText — a shopping row reading "Garlic Clove" with
    // nothing to buy. So the prompt must say, in BOTH places that discuss
    // cloves, that the number is the clove count in every wording.
    expect(system).toContain('The number a clove line states is ALWAYS the count of CLOVES');
    expect(system).toContain('it counts the CLOVES, so it survives verbatim as quantity');
    // The exact failing wording, in the unit rule and in the NAMING rule.
    expect(system).toContain(
      '"3 large cloves of garlic" → quantity 3, unit null, item "garlic clove"',
    );
    expect(system).toContain(
      '"3 large cloves of garlic, sliced" → quantity 3, item "garlic clove"',
    );
    // A size word must not be read as a reason to give up on the count.
    expect(system).toContain('a size word ("large", "small", "fat") changes nothing');
    // An unnumbered clove line still states one.
    expect(system).toContain('"a clove of garlic" → quantity 1, unit null, item "garlic clove"');
  });

  it('carves out bought-whole discrete proteins as count with unit null in the system prompt', async () => {
    mockGenerate.mockResolvedValue({ output: aiOutput([{ name: null, items: [] }]) });

    await (parseRecipeIngredientsFlow as Function)({ rawText: '3 egg whites' });

    const { system } = mockGenerate.mock.calls[0]![0];
    // The narrow keep-as-count exception must be present in the prompt.
    expect(system).toContain('bought-whole discrete proteins');
    expect(system).toContain('set unit to');
    // Poultry joints and egg parts are named as in-scope for the exception.
    expect(system).toContain('thighs');
    expect(system).toContain('whites');
  });
});

// ─── The pin for "this flow persists nothing" (issue #1435, epic #1417) ───────
//
// The flow's header states that it deliberately writes nothing, and two files
// call it directly and depend on that: `assembleRecipeDraft` (reached by every
// URL import, photo import and chat-authored recipe) and the read-only-by-default
// `scripts/rematch-ingredients.ts`. Under CLAUDE.md rule 12 that sentence is
// pinned, not merely asserted.
//
// It has to be a SOURCE SCAN rather than a mock: the flow imports no Firestore
// module today, so there is nothing to mock and nothing a behavioural assertion
// could observe — add `getFirestore()` to the flow and every test above still
// passes. Same technique, same directory, as `unitPolicy.test.ts`'s PARSER_SRC.
//
// BOUNDARY: this pins what the flow's own file imports and calls. It does not
// reach a write smuggled in through a helper module the flow calls, so keep the
// write out rather than routing it through one.
describe('parseRecipeIngredients — persists nothing, by construction', () => {
  const FLOW_SRC = 'apps/cloud-functions/src/flows/parseRecipeIngredients.ts';
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const source = readFileSync(join(repoRoot, FLOW_SRC), 'utf8');

  // Comments argue about Firestore at length; code must not mention it at all.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  it('imports nothing that can reach Firestore', () => {
    expect(code).not.toMatch(/from\s+['"]firebase-admin/);
    expect(code).not.toMatch(/from\s+['"]firebase-functions\/.*firestore/);
    expect(code).not.toMatch(/from\s+['"]@google-cloud\/firestore['"]/);
  });

  it('calls no Firestore handle', () => {
    expect(code).not.toMatch(/\bgetFirestore\b/);
    expect(code).not.toMatch(/\bfirestore\s*\(/);
    expect(code).not.toMatch(/\bFieldValue\b/);
  });

  // Guards the guard: `readFileSync` above already throws if the flow file goes
  // missing or unreadable, so that isn't the failure this catches. What it does
  // catch is the comment-stripping regexes eating real code along with the
  // comments — a stray `/*` with no matching `*/`, or a code line that happens
  // to start with `//`-lookalike syntax, would leave `code` gutted enough that
  // the two cases above pass without having scanned anything meaningful.
  it('scanned the flow it claims to scan', () => {
    expect(code).toContain('parseRecipeIngredientsFlow');
  });
});
