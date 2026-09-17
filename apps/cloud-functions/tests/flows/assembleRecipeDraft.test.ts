import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecipeDoc } from '@salt/domain/schemas';

// The one assembler both authoring paths share (the librarian chat and the URL
// import). Everything that used to be duplicated between them — step-ordinal
// resolution, id minting, the non-fatal parse/canon failure modes — is asserted
// here once, against the module directly rather than through either flow.

const mockUUID = vi.fn();
const mockParseFlow = vi.fn();
const mockCanonFlow = vi.fn();

vi.mock('../../src/flows/parseRecipeIngredients.js', () => ({
  parseRecipeIngredientsFlow: mockParseFlow,
}));

vi.mock('../../src/flows/canonicaliseRecipeIngredients.js', () => ({
  canonicaliseRecipeIngredientsFlow: mockCanonFlow,
}));

const mockReport = vi.fn();
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportServerError: mockReport,
}));

const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
vi.mock('firebase-functions', () => ({
  logger: { info: mockLogInfo, warn: mockLogWarn, error: vi.fn() },
}));

vi.stubGlobal('crypto', { randomUUID: mockUUID });

const { assembleRecipeDraft } = await import('../../src/flows/assembleRecipeDraft.js');

beforeEach(() => {
  vi.clearAllMocks();
  let counter = 0;
  mockUUID.mockImplementation(() => `id-${++counter}`);
  // Default: the parser behaves — one item per line handed in, echoed verbatim.
  // Canon is only asked about lines that parsed (issue #949), so a test about
  // canon needs the parse to have worked, exactly as production does.
  mockParseFlow.mockImplementation(({ rawText }: { rawText: string }) =>
    Promise.resolve(parseResultFor(rawText.split('\n'))),
  );
  mockCanonFlow.mockResolvedValue([]);
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function rawOutput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Garlic Pasta',
    // What the model classified this as (issue #765). `as const` so the literal
    // survives into the argument type — the assembler's `raw` is bounded to the
    // authorable kinds, and a widened `string` is not assignable to it.
    kind: 'recipe' as 'recipe' | 'cocktail',
    description: null,
    servings: 2,
    tags: [],
    ingredientGroups: [
      {
        name: null,
        ingredients: [
          // Annotated, not inferred: the flow's input allows a NULL ordinal (an
          // ingredient no step names), and a test below writes one. Inferred from
          // these literals the field would be `number` and that assignment a
          // compile error (#1135).
          { rawText: '200g pasta', isOptional: false, firstUsedInStepOrdinal: 0 as number | null },
          {
            rawText: '2 cloves garlic, crushed',
            isOptional: true,
            firstUsedInStepOrdinal: 1 as number | null,
          },
        ],
      },
    ],
    steps: [
      { text: 'Boil the pasta.', timerMinutes: 10, timerLabel: 'Boil', note: null },
      { text: 'Crush the garlic.', timerMinutes: null, timerLabel: null, note: 'Use a press.' },
    ],
    notes: null,
    ...overrides,
  };
}

// Mirrors parseRecipeIngredientsFlow's output shape: groups of items each
// carrying a full `parsed` object keyed by rawText.
function parseResultFor(rawTexts: string[]) {
  return [
    {
      id: 'parse-group-1',
      name: null,
      items: rawTexts.map((rawText, i) => ({
        id: `parse-item-${i}`,
        rawText,
        parsed: {
          quantity: { type: 'single', value: 1 },
          unit: null,
          item: rawText.split(' ').at(-1)!,
          preparation: [],
          notes: null,
          displayText: null,
        },
        canonId: null,
        matchState: 'pending' as const,
        isOptional: false,
        firstUsedInStepId: null,
      })),
    },
  ];
}

const MANUAL = { type: 'manual' } as const;
// The URL import's provenance. The time reconciliation below is the same on both
// sources — that it no longer forks with the source is the point of #952 — so the
// two constants are there to say WHICH path each case stands for, not to select a
// behaviour.
const IMPORT = { type: 'url', url: 'https://example.com/focaccia' } as const;

// ─── ingredient → step ordinal resolution ────────────────────────────────────

describe('assembleRecipeDraft — step ordinal resolution', () => {
  it('resolves each ingredient ordinal to the id of the step at that index', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    const [pasta, garlic] = doc.ingredients[0]!.items;
    expect(pasta!.firstUsedInStepId).toBe(doc.steps[0]!.id);
    expect(garlic!.firstUsedInStepId).toBe(doc.steps[1]!.id);
  });

  it('leaves firstUsedInStepId null for a null ordinal', async () => {
    const raw = rawOutput();
    raw.ingredientGroups[0]!.ingredients[0]!.firstUsedInStepOrdinal = null;

    const doc = await assembleRecipeDraft(raw, { source: MANUAL });

    expect(doc.ingredients[0]!.items[0]!.firstUsedInStepId).toBeNull();
  });

  it('leaves firstUsedInStepId null for an out-of-range or negative ordinal', async () => {
    const raw = rawOutput();
    // Only two steps exist, so 7 is past the end and -1 is before the start.
    raw.ingredientGroups[0]!.ingredients[0]!.firstUsedInStepOrdinal = 7;
    raw.ingredientGroups[0]!.ingredients[1]!.firstUsedInStepOrdinal = -1;

    const doc = await assembleRecipeDraft(raw, { source: MANUAL });

    expect(doc.ingredients[0]!.items[0]!.firstUsedInStepId).toBeNull();
    expect(doc.ingredients[0]!.items[1]!.firstUsedInStepId).toBeNull();
  });
});

// ─── group / id minting ───────────────────────────────────────────────────────

describe('assembleRecipeDraft — id minting', () => {
  it('mints a distinct id for every step, group, ingredient, and the recipe itself', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    const ids = [
      doc.id,
      ...doc.steps.map((s) => s.id),
      ...doc.ingredients.map((g) => g.id),
      ...doc.ingredients.flatMap((g) => g.items.map((i) => i.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // 2 steps + 1 group + 2 ingredients + 1 recipe.
    expect(mockUUID).toHaveBeenCalledTimes(6);
  });

  it('preserves group names and per-group membership', async () => {
    const raw = rawOutput({
      ingredientGroups: [
        {
          name: 'For the sauce',
          ingredients: [{ rawText: '400g tomatoes', isOptional: false, firstUsedInStepOrdinal: 0 }],
        },
        {
          name: null,
          ingredients: [{ rawText: '200g pasta', isOptional: false, firstUsedInStepOrdinal: 1 }],
        },
      ],
    });

    const doc = await assembleRecipeDraft(raw, { source: MANUAL });

    expect(doc.ingredients).toHaveLength(2);
    expect(doc.ingredients[0]!.name).toBe('For the sauce');
    expect(doc.ingredients[0]!.items.map((i) => i.rawText)).toEqual(['400g tomatoes']);
    expect(doc.ingredients[1]!.name).toBeNull();
    expect(doc.ingredients[1]!.items.map((i) => i.rawText)).toEqual(['200g pasta']);
  });

  it('carries step text, timer, label and note onto the assembled steps', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    expect(doc.steps[0]!.text).toBe('Boil the pasta.');
    expect(doc.steps[0]!.timer).toEqual({ durationMinutes: 10, description: 'Boil' });
    // No timerMinutes ⇒ no timer object at all.
    expect(doc.steps[1]!.timer).toBeNull();
    expect(doc.steps[1]!.note).toBe('Use a press.');
  });
});

// ─── non-fatal sub-flow failures ─────────────────────────────────────────────

describe('assembleRecipeDraft — non-fatal sub-flow failures', () => {
  it('never writes matched alongside parsed: null when the parse flow throws (issue #949)', async () => {
    // The coarse route into the defect: the whole parse fails, canon runs anyway
    // on the full raw line, and every row lands `matched` holding no amount —
    // healthy-looking, unscalable, and invisible in the list. Canon is no longer
    // asked about a line it would have to match as "2 cloves garlic, crushed".
    mockParseFlow.mockRejectedValue(new Error('parse failed'));
    mockCanonFlow.mockResolvedValue([
      { kind: 'ok', value: { decision: 'matched', item: { id: 'canon-pasta' } } },
      { kind: 'ok', value: { decision: 'matched', item: { id: 'canon-garlic' } } },
    ]);

    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items.every((i) => i.parsed === null)).toBe(true);
    expect(items.some((i) => i.matchState === 'matched' && i.parsed === null)).toBe(false);
    // `pending`, not `failed`: matchState still means canon matching and nothing
    // else, and canon was never asked.
    expect(items.every((i) => i.matchState === 'pending')).toBe(true);
    expect(items.every((i) => i.canonId === null)).toBe(true);
  });

  it('does not send an unparsed line to canon, and reports the miss', async () => {
    mockParseFlow.mockRejectedValue(new Error('parse failed'));

    await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    expect(mockCanonFlow).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledTimes(1);
    const reported = mockReport.mock.calls[0]![0] as Error;
    expect(reported.message).toContain('2 of 2');
  });

  it('keeps raw ingredient text out of the report (free-form user content)', async () => {
    mockParseFlow.mockRejectedValue(new Error('parse failed'));

    await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    const reported = mockReport.mock.calls[0]![0] as Error;
    expect(reported.message).not.toContain('200g pasta');
    expect(reported.message).not.toContain('garlic');
  });

  it('emits no report when every line parsed', async () => {
    await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    expect(mockReport).not.toHaveBeenCalled();
  });

  it('lands every ingredient as pending when the canon flow throws', async () => {
    mockParseFlow.mockResolvedValue(parseResultFor(['200g pasta', '2 cloves garlic, crushed']));
    mockCanonFlow.mockRejectedValue(new Error('canon failed'));

    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items.every((i) => i.matchState === 'pending')).toBe(true);
    expect(items.every((i) => i.canonId === null)).toBe(true);
    // The parse result still threaded through — the two failures are independent.
    expect(items[0]!.parsed).not.toBeNull();
  });

  it('marks an ingredient failed when canon returns a non-ok result for it', async () => {
    mockCanonFlow.mockResolvedValue([
      { kind: 'err', error: { kind: 'AiError' } },
      { kind: 'ok', value: { decision: 'created', item: { id: 'canon-garlic' } } },
    ]);

    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items[0]!.matchState).toBe('failed');
    expect(items[0]!.canonId).toBeNull();
    expect(items[1]!.matchState).toBe('matched');
    expect(items[1]!.canonId).toBe('canon-garlic');
  });

  it('calls neither sub-flow when there are no ingredients at all', async () => {
    const doc = await assembleRecipeDraft(rawOutput({ ingredientGroups: [] }), {
      source: MANUAL,
    });

    expect(mockParseFlow).not.toHaveBeenCalled();
    expect(mockCanonFlow).not.toHaveBeenCalled();
    expect(doc.ingredients).toEqual([]);
  });
});

// ─── parse-result join (issue #949) ──────────────────────────────────────────

// `rawText` on a parse result is echoed by the MODEL. Joining on it lost a whole
// line to a single re-typed character, and canon — joined by index — matched
// anyway, so the row went to Firestore `matched` with no amount at all.

/** A parse result whose echoes deliberately DON'T match what went in. */
function mangledEchoResult() {
  return [
    {
      id: 'parse-group-1',
      name: null,
      items: [
        // Whitespace normalised away.
        { rawText: '200 g pasta', parsed: parsedFor('pasta', 200) },
        // Trailing preparation dropped.
        { rawText: '2 cloves garlic', parsed: parsedFor('garlic clove', 2) },
      ].map((item, i) => ({
        id: `parse-item-${i}`,
        ...item,
        canonId: null,
        matchState: 'pending' as const,
        isOptional: false,
        firstUsedInStepId: null,
      })),
    },
  ];
}

function parsedFor(item: string, value: number) {
  return {
    quantity: { type: 'single', value },
    unit: 'g',
    item,
    preparation: [],
    notes: null,
    displayText: null,
  };
}

describe('assembleRecipeDraft — parse-result join', () => {
  it('threads parsed data onto every line when the model mangles its rawText echo', async () => {
    mockParseFlow.mockResolvedValue(mangledEchoResult());

    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items[0]!.parsed).toEqual(parsedFor('pasta', 200));
    expect(items[1]!.parsed).toEqual(parsedFor('garlic clove', 2));
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('gives canon the parsed item name even when the echo was mangled', async () => {
    mockParseFlow.mockResolvedValue(mangledEchoResult());

    await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    const sent = mockCanonFlow.mock.calls[0]![0].items as { rawName: string; rawText: string }[];
    expect(sent.map((i) => i.rawName)).toEqual(['pasta', 'garlic clove']);
    // …keyed back to the line the recipe actually holds, not the model's echo.
    expect(sent.map((i) => i.rawText)).toEqual(['200g pasta', '2 cloves garlic, crushed']);
  });

  it('falls back to the rawText echo when the parser split or merged a line', async () => {
    // Three items for two input lines: position means nothing here, so the echo
    // is all there is. A blind positional zip would hang the wrong quantity on
    // the wrong ingredient, which is worse than a null.
    mockParseFlow.mockResolvedValue([
      {
        id: 'parse-group-1',
        name: null,
        items: [
          { rawText: '200g pasta', parsed: parsedFor('pasta', 200) },
          { rawText: '2 cloves garlic, crushed', parsed: parsedFor('garlic clove', 2) },
          { rawText: 'a pinch of salt', parsed: parsedFor('salt', 1) },
        ].map((item, i) => ({
          id: `parse-item-${i}`,
          ...item,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: false,
          firstUsedInStepId: null,
        })),
      },
    ]);

    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items[0]!.parsed).toEqual(parsedFor('pasta', 200));
    expect(items[1]!.parsed).toEqual(parsedFor('garlic clove', 2));
  });

  it('leaves a line the fallback cannot reach unparsed, unmatched and reported', async () => {
    // Count mismatch forces the echo join, and one echo is unrecognisable.
    mockParseFlow.mockResolvedValue([
      {
        id: 'parse-group-1',
        name: null,
        items: [
          { rawText: '200g pasta', parsed: parsedFor('pasta', 200) },
          { rawText: '2 cloves garlic, crushed', parsed: parsedFor('garlic clove', 2) },
          { rawText: 'garlic, crushed (2 cloves)', parsed: parsedFor('garlic clove', 2) },
        ].map((item, i) => ({
          id: `parse-item-${i}`,
          ...item,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: false,
          firstUsedInStepId: null,
        })),
      },
    ]);
    // Only the pasta line is offered to canon, so only one result comes back.
    mockCanonFlow.mockImplementation(({ items }: { items: unknown[] }) =>
      Promise.resolve(items.map(() => ({ kind: 'ok', value: { item: { id: 'canon-x' } } }))),
    );

    const raw = rawOutput();
    raw.ingredientGroups[0]!.ingredients[1]!.rawText = '2 garlic cloves, finely crushed';

    const doc = await assembleRecipeDraft(raw, { source: MANUAL });
    const items = doc.ingredients[0]!.items;

    expect(items[0]!.parsed).not.toBeNull();
    expect(items[0]!.matchState).toBe('matched');
    // The unreachable line: no amount, and honestly unresolved rather than
    // claiming a canon match it was never offered for.
    expect(items[1]!.parsed).toBeNull();
    expect(items[1]!.matchState).toBe('pending');
    expect(items[1]!.canonId).toBeNull();

    const sent = mockCanonFlow.mock.calls[0]![0].items as { rawText: string }[];
    expect(sent.map((i) => i.rawText)).toEqual(['200g pasta']);

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect((mockReport.mock.calls[0]![0] as Error).message).toContain('1 of 2');
  });
});

// ─── canon keying is by rawText ──────────────────────────────────────────────

describe('assembleRecipeDraft — canon keying', () => {
  it('canonicalises a repeated ingredient line once and applies the result to both', async () => {
    const raw = rawOutput({
      ingredientGroups: [
        {
          name: 'For the sauce',
          ingredients: [
            { rawText: '2 cloves garlic', isOptional: false, firstUsedInStepOrdinal: 0 },
          ],
        },
        {
          name: 'To serve',
          ingredients: [
            { rawText: '2 cloves garlic', isOptional: false, firstUsedInStepOrdinal: 1 },
          ],
        },
      ],
    });
    mockCanonFlow.mockResolvedValue([
      { kind: 'ok', value: { decision: 'matched', item: { id: 'canon-garlic' } } },
    ]);

    const doc = await assembleRecipeDraft(raw, { source: MANUAL });

    // One canon item sent, not two — deduped on rawText.
    const sent = mockCanonFlow.mock.calls[0]![0].items as unknown[];
    expect(sent).toHaveLength(1);
    // …and both occurrences still carry the match.
    expect(doc.ingredients[0]!.items[0]!.canonId).toBe('canon-garlic');
    expect(doc.ingredients[1]!.items[0]!.canonId).toBe('canon-garlic');
    // Distinct ingredient ids, though — they are two separate lines on the doc.
    expect(doc.ingredients[0]!.items[0]!.id).not.toBe(doc.ingredients[1]!.items[0]!.id);
  });
});

// ─── edit mode ───────────────────────────────────────────────────────────────

// The stored recipe an edit-mode amend is spread over. Module-scoped so the
// phase-strip suite at the foot of this file can reuse it (issue #1122).
function baseRecipe(): RecipeDoc {
  return {
    cureCategory: null,
    id: 'r1',
    schemaVersion: 1,
    kind: 'cocktail',
    kit: [],
    title: 'Old Fashioned',
    description: null,
    ingredients: [
      {
        id: 'g1',
        name: null,
        items: [
          {
            id: 'i1',
            rawText: '200g pasta',
            parsed: {
              quantity: { type: 'single', value: 200 },
              unit: 'g',
              item: 'pasta',
              preparation: [],
              notes: null,
              displayText: null,
            },
            canonId: 'canon-pasta',
            matchState: 'matched',
            isOptional: false,
            firstUsedInStepId: 'old-step',
          },
        ],
      },
    ],
    steps: [{ id: 'old-step', text: 'Boil the pasta.', timer: null, note: null }],
    metadata: {
      servings: 4,
      // A strip a cook corrected by hand (issue #1122). The two tests at the
      // bottom of this file are what make the "survives an amend" claim in
      // `assembleRecipeDraft`'s metadata block checkable rather than asserted.
      phases: [{ label: 'Stir', handsOnMinutes: 3, handsOffMinutes: 0 }],
      timingSummary: 'Three minutes, all of them you.',
      tags: [],
    },
    source: { type: 'manual' },
    notes: null,
    producesCanonId: 'canon-sauce',
    componentRecipeIds: ['comp-a', 'comp-b'],
    image: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Kate',
  };
}

describe('assembleRecipeDraft — edit mode', () => {
  it('reuses id, parsed data and canon match for a byte-identical rawText, and skips both sub-flows for it', async () => {
    mockCanonFlow.mockResolvedValue([
      { kind: 'ok', value: { decision: 'created', item: { id: 'canon-garlic' } } },
    ]);

    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    // Only the genuinely new line reached the expensive flows.
    expect(mockParseFlow).toHaveBeenCalledWith({ rawText: '2 cloves garlic, crushed' });
    const sent = mockCanonFlow.mock.calls[0]![0].items as { rawText: string }[];
    expect(sent.map((i) => i.rawText)).toEqual(['2 cloves garlic, crushed']);

    const pasta = doc.ingredients[0]!.items[0]!;
    expect(pasta.id).toBe('i1');
    expect(pasta.canonId).toBe('canon-pasta');
    expect(pasta.matchState).toBe('matched');
    expect(pasta.parsed!.item).toBe('pasta');
  });

  it("keeps the base ingredient's parsed data even when the parser is having a bad day", async () => {
    // The carry-over branch is what stops an unrelated re-author discarding good
    // data, so it has to hold when the parse path is failing outright — the very
    // situation the join fix changes the behaviour of.
    mockParseFlow.mockRejectedValue(new Error('parse failed'));

    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    const pasta = doc.ingredients[0]!.items[0]!;
    expect(pasta.parsed).toEqual(baseRecipe().ingredients[0]!.items[0]!.parsed);
    expect(pasta.matchState).toBe('matched');
    expect(pasta.canonId).toBe('canon-pasta');
  });

  it('re-resolves the step ordinal on a carried-over ingredient rather than keeping the old step id', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    const pasta = doc.ingredients[0]!.items[0]!;
    expect(pasta.firstUsedInStepId).toBe(doc.steps[0]!.id);
    expect(pasta.firstUsedInStepId).not.toBe('old-step');
  });

  it('takes isOptional from the fresh output, not the base ingredient', async () => {
    const raw = rawOutput();
    raw.ingredientGroups[0]!.ingredients[0]!.isOptional = true;

    const doc = await assembleRecipeDraft(raw, {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(doc.ingredients[0]!.items[0]!.isOptional).toBe(true);
  });

  it('carries the base recipe kind and producesCanonId through the amend', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(doc.kind).toBe('cocktail');
    expect(doc.producesCanonId).toBe('canon-sauce');
  });

  it("carries the base recipe's components through the amend (issue #752)", async () => {
    // Load-bearing, not cosmetic. `mergeAmendedRecipe` spreads this draft over the
    // stored recipe, so a draft that dropped `componentRecipeIds` would silently
    // erase a meal's dishes on every chat amend and every ⋮ → Refresh. The
    // librarian neither reads nor writes them, so the base value is the answer.
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(doc.componentRecipeIds).toEqual(['comp-a', 'comp-b']);
  });

  it("carries the base recipe's attribution through the amend (issue #845)", async () => {
    // Load-bearing for the same reason as the components above: the draft is
    // spread over the stored recipe, so dropping these would erase whoever added
    // the dish on every chat amend and every ⋮ → Refresh. `lastEditedBy` is
    // carried rather than cleared — the amender is stamped client-side when the
    // proposal is applied, and until then the last human edit is still the base's.
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(doc.createdBy).toBe('Daniel');
    expect(doc.lastEditedBy).toBe('Kate');
  });

  it('defaults to a fresh recipe with no makes-link, no components and no attribution when there is no base', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    // 'recipe' here because that is what `rawOutput()` classifies, NOT because
    // the assembler hardcodes it — see the kind-precedence suite below.
    expect(doc.kind).toBe('recipe');
    expect(doc.producesCanonId).toBeNull();
    expect(doc.componentRecipeIds).toEqual([]);
    // The flow knows no user; the client stamps whoever saved it.
    expect(doc.createdBy).toBe('');
    expect(doc.lastEditedBy).toBe('');
  });
});

// ─── document-level fields ───────────────────────────────────────────────────

describe('assembleRecipeDraft — document fields', () => {
  it('stamps the source it was given', async () => {
    const manual = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    expect(manual.source).toEqual({ type: 'manual' });

    const imported = await assembleRecipeDraft(rawOutput(), {
      source: { type: 'url', url: 'https://example.com/pasta' },
    });
    expect(imported.source).toEqual({ type: 'url', url: 'https://example.com/pasta' });
  });

  it('omits needs_approval entirely unless asked for it (absent means reviewed)', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });

    expect('needs_approval' in doc).toBe(false);
  });

  it('sets needs_approval: true when asked', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      needsApproval: true,
    });

    expect(doc.needs_approval).toBe(true);
  });

  it('normalises tags', async () => {
    const doc = await assembleRecipeDraft(rawOutput({ tags: ['Comfort Food, quick', 'QUICK'] }), {
      source: MANUAL,
    });

    expect(doc.metadata.tags).toEqual(['comfort-food', 'quick']);
  });
});

// ─── phases (issue #1122) ────────────────────────────────────────────────────

describe('assembleRecipeDraft — the phase strip', () => {
  it("carries the authoring path's strip straight onto the draft", async () => {
    const doc = await assembleRecipeDraft(
      rawOutput({
        phases: [
          { label: 'Prep', handsOnMinutes: 10, handsOffMinutes: 0 },
          { label: 'Cook', handsOnMinutes: 5, handsOffMinutes: 20 },
        ],
        timingSummary: 'About 15 minutes of you, over 35.',
      }),
      { source: MANUAL },
    );
    expect(doc.metadata.phases).toEqual([
      { label: 'Prep', handsOnMinutes: 10, handsOffMinutes: 0 },
      { label: 'Cook', handsOnMinutes: 5, handsOffMinutes: 20 },
    ]);
    expect(doc.metadata.timingSummary).toBe('About 15 minutes of you, over 35.');
  });

  it('stores an empty strip when the model returned none and there is no base', async () => {
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL });
    expect(doc.metadata.phases).toEqual([]);
    expect(doc.metadata.timingSummary).toBeNull();
  });

  // The load-bearing one: a hand-edited strip must survive an amend whose raw
  // output carries no phases, exercised directly against that input, or the
  // cook's correction is silently thrown away by unrelated work. `rawOutput()`
  // with no phases is not yet what a real librarian turn produces — it is
  // always asked for 3-6 phases (`PHASE_RULES`) and never shown the stored
  // strip to answer against (`formatRecipeForPrompt`) — so this pins the
  // fallback mechanism itself, not (yet) a guarantee that holds on a live chat
  // amend.
  it('preserves a hand-edited strip through an amend that returned no phases', async () => {
    const base = baseRecipe();
    const doc = await assembleRecipeDraft(rawOutput(), { source: MANUAL, baseRecipe: base });
    expect(doc.metadata.phases).toEqual(base.metadata.phases);
    expect(doc.metadata.timingSummary).toBe(base.metadata.timingSummary);
  });

  // And the other half of that claim, so it is not read as "phases are frozen":
  // a strip the model DID return is the amend doing its job, and it wins.
  it('lets an amend that DID return phases replace the stored strip', async () => {
    const doc = await assembleRecipeDraft(
      rawOutput({
        phases: [{ label: 'Shake', handsOnMinutes: 2, handsOffMinutes: 0 }],
        timingSummary: 'Two minutes.',
      }),
      { source: MANUAL, baseRecipe: baseRecipe() },
    );
    expect(doc.metadata.phases).toEqual([
      { label: 'Shake', handsOnMinutes: 2, handsOffMinutes: 0 },
    ]);
    expect(doc.metadata.timingSummary).toBe('Two minutes.');
  });

  // Blocking finding 2 (issue #1122 review, PR #1201): `phases` and
  // `timingSummary` used to fall back to the base INDEPENDENTLY, so a fresh
  // strip could be stored under the base's stale sentence. The fix takes both
  // fields from the SAME source — `raw` when it answered, `base` when it did
  // not — so this pairing can no longer happen in either direction.
  it('does not pair a fresh strip with the stale stored summary', async () => {
    const doc = await assembleRecipeDraft(
      rawOutput({
        phases: [{ label: 'Shake', handsOnMinutes: 2, handsOffMinutes: 0 }],
        // timingSummary omitted — the model returned a strip but no sentence.
      }),
      { source: MANUAL, baseRecipe: baseRecipe() },
    );
    expect(doc.metadata.phases).toEqual([
      { label: 'Shake', handsOnMinutes: 2, handsOffMinutes: 0 },
    ]);
    // NOT baseRecipe().metadata.timingSummary ('Three minutes, all of them
    // you.') — that sentence describes the OLD strip, not this one.
    expect(doc.metadata.timingSummary).toBeNull();
  });

  it('does not pair a fresh summary with the stale stored strip', async () => {
    const base = baseRecipe();
    const doc = await assembleRecipeDraft(
      rawOutput({
        // phases omitted — the model returned a sentence but no strip.
        timingSummary: 'A completely different timing than the strip below.',
      }),
      { source: MANUAL, baseRecipe: base },
    );
    // The strip and summary move TOGETHER: no fresh phases means BOTH fields
    // come from the base, not just the one the model happened to omit.
    expect(doc.metadata.phases).toEqual(base.metadata.phases);
    expect(doc.metadata.timingSummary).toBe(base.metadata.timingSummary);
  });
});

// ─── step citations (issue #1178) ─────────────────────────────────────────────

// One test per rule the comment at the id-assignment site states, because that
// comment is the only place three of them are written down (CLAUDE.md rule 12).
// Every one of these ends by asserting the ids are UNIQUE: a duplicate step id
// inside one recipe is the failure that would actually corrupt a document —
// `firstUsedInStepId` resolves an ingredient chip onto whichever step the lookup
// reaches first, and cook mode pages by id.
describe('assembleRecipeDraft — the step id a citation asks for', () => {
  function citations() {
    const call = mockLogInfo.mock.calls.find(
      (c) => c[0] === 'assembleRecipeDraft: librarian step citations',
    );
    return call?.[1] as
      { steps: number; baseSteps: number; cited: number; reused: number } | undefined;
  }

  function withCitations(...ids: (string | null)[]) {
    const steps = rawOutput().steps.map((step, i) => ({ ...step, sourceStepId: ids[i] ?? null }));
    return rawOutput({ steps });
  }

  function ids(doc: RecipeDoc) {
    return doc.steps.map((step) => step.id);
  }

  it('reuses the cited id, so the diff can pair the reword as one edit', async () => {
    const doc = await assembleRecipeDraft(withCitations('old-step', null), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    // `id-1`, not `id-2`: the mock counter only advances for a step that actually
    // minted, and the first step reused its cited id instead.
    expect(ids(doc)).toEqual(['old-step', 'id-1']);
    expect(new Set(ids(doc)).size).toBe(2);
  });

  it('mints a fresh id for a citation the base recipe has never heard of, and keeps the step', async () => {
    const doc = await assembleRecipeDraft(withCitations('hallucinated', null), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0]!.text).toBe('Boil the pasta.');
    expect(ids(doc)).toEqual(['id-1', 'id-2']);
  });

  it('honours one id once — the second claim on it gets a fresh id', async () => {
    // The rule that is a correctness requirement rather than tidiness. First wins,
    // in output order.
    const doc = await assembleRecipeDraft(withCitations('old-step', 'old-step'), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(ids(doc)).toEqual(['old-step', 'id-1']);
    expect(new Set(ids(doc)).size).toBe(2);
  });

  it('ignores a citation in create mode, where there is nothing to cite', async () => {
    const doc = await assembleRecipeDraft(withCitations('old-step', null), { source: MANUAL });

    expect(ids(doc)).toEqual(['id-1', 'id-2']);
  });

  it('ignores a citation in variation mode, which assembles with no base recipe', async () => {
    // Variation mode GROUNDS the prompt on the original but calls this with
    // `baseRecipe: null` on purpose (issue #763), so the new dish does not inherit
    // the original's identity. `authorRecipe` also withholds the ids from that
    // prompt, so this is the second of two independent reasons a variation cannot
    // reuse an id — either alone would do, and neither is relied on.
    const doc = await assembleRecipeDraft(withCitations('old-step', 'old-step'), {
      source: MANUAL,
      baseRecipe: null,
    });

    expect(ids(doc)).toEqual(['id-1', 'id-2']);
    expect(new Set(ids(doc)).size).toBe(2);
  });

  it('still assembles when the librarian cites nothing at all', async () => {
    // The back-compat floor: an older response, a FUNCTIONS_AI_FAKE fixture, or a
    // model that ignored the instruction. `rawOutput()` carries no citations.
    const doc = await assembleRecipeDraft(rawOutput(), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(ids(doc)).toEqual(['id-1', 'id-2']);
  });

  it('hangs an ingredient on the step it names even when that step kept its old id', async () => {
    // `firstUsedInStepId` resolves by ORDINAL into the assembled list, so a reused
    // id must not change which step an ingredient lands on. `rawOutput()` puts the
    // pasta on ordinal 0 and the garlic on ordinal 1.
    const doc = await assembleRecipeDraft(withCitations('old-step', null), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    const items = doc.ingredients[0]!.items;
    expect(items[0]!.firstUsedInStepId).toBe('old-step');
    expect(items[1]!.firstUsedInStepId).toBe('id-1');
  });

  it('logs how well the librarian cited, in counts and never a word of the recipe', async () => {
    await assembleRecipeDraft(withCitations('old-step', 'hallucinated'), {
      source: MANUAL,
      baseRecipe: baseRecipe(),
    });

    expect(citations()).toEqual({ steps: 2, baseSteps: 1, cited: 2, reused: 1 });
    const serialised = JSON.stringify(citations());
    expect(serialised).not.toContain('pasta');
    expect(serialised).not.toContain('garlic');
    expect(serialised).not.toContain('old-step');
  });

  it('says nothing at all when there is no recipe being amended', async () => {
    await assembleRecipeDraft(withCitations('old-step'), { source: MANUAL });

    expect(citations()).toBeUndefined();
  });
});

// ─── what kind of entry this is (issue #765) ─────────────────────────────────
//
// One line in the assembler decides which section of the library every
// AI-created entry lands in, and it is the choke point all three creation paths
// funnel through (URL import, photo import, chat "Save as recipe"). Before #765
// it read `baseRecipe?.kind ?? 'recipe'`, which is why none of the three could
// produce anything but a dinner.
//
// The precedence is what these tests exist to pin, in order:
//   1. an edit-mode base wins UNCONDITIONALLY — `kind` is immutable, so an amend
//      must never re-type the entry it is editing, whatever the model said;
//   2. a variation's `kindHint` — the base's kind is a known fact, not a guess;
//   3. the model's own classification.
describe('assembleRecipeDraft — what kind of entry it is', () => {
  it('honours the model on the create path', async () => {
    const doc = await assembleRecipeDraft(rawOutput({ kind: 'cocktail' }), { source: MANUAL });

    expect(doc.kind).toBe('cocktail');
  });

  // EVERY kind, including the two the librarian may not author: a special or a
  // placeholder amended by chat must come back a special or a placeholder. This
  // is the assertion that would go red if the operands were ever reordered, or if
  // the base branch gained a condition.
  it.each(['recipe', 'special', 'cocktail', 'placeholder'] as const)(
    'lets an edit-mode %s override the model, unconditionally',
    async (kind) => {
      const doc = await assembleRecipeDraft(
        // The model saying the opposite of the base, on purpose.
        rawOutput({ kind: kind === 'cocktail' ? 'recipe' : 'cocktail' }),
        { source: MANUAL, baseRecipe: { ...baseRecipe(), kind } },
      );

      expect(doc.kind).toBe(kind);
    },
  );

  it('lets an edit-mode base beat a kindHint as well as the model', async () => {
    // Both non-base operands set, and both losing. Nothing in production passes
    // this combination today — `authorRecipe` computes the hint only when there
    // is no `recipeId` — but the precedence must not depend on that.
    const doc = await assembleRecipeDraft(rawOutput({ kind: 'recipe' }), {
      source: MANUAL,
      baseRecipe: { ...baseRecipe(), kind: 'placeholder' },
      kindHint: 'cocktail',
    });

    expect(doc.kind).toBe('placeholder');
  });

  it('takes a variation kindHint over the model, with no base recipe', async () => {
    // Variation mode (issue #763): the base is deliberately NOT passed, so the
    // draft gets its own identity — but a variation on a cocktail is a cocktail,
    // which is a fact rather than something to infer from a chat about gin.
    const doc = await assembleRecipeDraft(rawOutput({ kind: 'recipe' }), {
      source: MANUAL,
      kindHint: 'cocktail',
    });

    expect(doc.kind).toBe('cocktail');
    // …and nothing else of an identity came with it: still a fresh dish.
    expect(doc.producesCanonId).toBeNull();
    expect(doc.componentRecipeIds).toEqual([]);
  });

  it('falls back to the model when there is neither a base nor a hint', async () => {
    const doc = await assembleRecipeDraft(rawOutput({ kind: 'cocktail' }), {
      source: MANUAL,
      baseRecipe: null,
      kindHint: null,
    });

    expect(doc.kind).toBe('cocktail');
  });

  it('lands on recipe when the model omitted the field entirely', async () => {
    // The floor is the SCHEMA's job, not the assembler's, so this asserts the two
    // halves meet: a raw payload with no `kind` is parsed first (exactly as the
    // flows do) and the assembler then reads what the schema put there. A model
    // that forgets the field must never fail an import, and must never mint a
    // cocktail by accident.
    const { LibrarianOutputSchema } = await import('@salt/domain/schemas');
    const { kind: _dropped, ...withoutKind } = rawOutput();
    const parsed = LibrarianOutputSchema.parse(withoutKind);

    const doc = await assembleRecipeDraft(parsed, { source: MANUAL });

    expect(doc.kind).toBe('recipe');
  });
});
