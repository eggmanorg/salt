import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerate = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

// Stub withAiTimeout to call op() directly — timeout/retry logic is tested elsewhere.
// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

// resolveModel reads Firestore in production; pin it in the unit test.
vi.mock('../../src/ai/resolveModel.js', () => ({
  resolveModel: vi.fn().mockResolvedValue('gemini-flash-latest'),
}));

// equipmentContext.ts pulls in firebase-functions for its warn logs. The flow only
// uses its pure string half, so stub the logger rather than the module.
vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { identifyRecipeKitFlow, sanitiseRecipeKit } =
  await import('../../src/flows/identifyRecipeKit.js');
const { IdentifyRecipeKitInputSchema } = await import('@salt/domain/schemas');

beforeEach(() => {
  vi.clearAllMocks();
});

const input = {
  title: 'Champ',
  description: 'Buttery mashed potato with spring onions.',
  ingredients: ['1kg floury potatoes', '100g butter'],
  steps: [
    { id: 's1', text: 'Boil the potatoes until tender.' },
    { id: 's2', text: 'Drain, then mash with the butter.' },
  ],
  equipment: [],
};

// Two manifest records, shaped as production's are: an appliance with parts, and
// a FAMILY whose members carry no word of the family's own name — the case the
// word resolvers can never reach and the link exists for (issue #1465).
const MAGIMIX = {
  id: 'item-magimix',
  schemaVersion: 1 as const,
  name: 'Magimix Cook Expert',
  kind: 'equipment' as const,
  accessories: [
    { id: 'acc-steam', name: 'Steam Basket', owned: true, included: true, note: '' },
    { id: 'acc-xl', name: 'XL Steamer Attachment', owned: false, included: false, note: '' },
  ],
  rules: [],
  note: '',
  environment: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const FRYING_PANS = {
  id: 'item-pans',
  schemaVersion: 1 as const,
  name: 'Frying Pans',
  kind: 'family' as const,
  accessories: [
    { id: 'acc-tefal', name: 'Tefal non-stick 28cm', owned: true, included: false, note: '' },
  ],
  rules: [],
  note: '',
  environment: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('sanitiseRecipeKit', () => {
  it('drops a step id that is not a step on this recipe', () => {
    const kit = sanitiseRecipeKit(
      [{ label: 'potato masher', stepIds: ['s2', 's99'], ref: null }],
      ['s1', 's2'],
    );
    expect(kit).toEqual([{ label: 'potato masher', stepIds: ['s2'], equipment: null }]);
  });

  it('keeps an entry whose step ids were all hallucinated', () => {
    // A piece of kit with no step attached is still real kit — a mixing bowl the
    // method never mentions — so an emptied `stepIds` must not drop the entry.
    const kit = sanitiseRecipeKit(
      [{ label: 'large mixing bowl', stepIds: ['nope'], ref: null }],
      ['s1'],
    );
    expect(kit).toEqual([{ label: 'large mixing bowl', stepIds: [], equipment: null }]);
  });

  it('drops an entry with a blank or whitespace-only label', () => {
    const kit = sanitiseRecipeKit(
      [
        { label: '', stepIds: ['s1'], ref: null },
        { label: '   ', stepIds: ['s1'], ref: null },
        { label: 'colander', stepIds: ['s1'], ref: null },
      ],
      ['s1'],
    );
    expect(kit).toEqual([{ label: 'colander', stepIds: ['s1'], equipment: null }]);
  });

  it('collapses duplicate labels, keeping the first spelling and merging the steps', () => {
    const kit = sanitiseRecipeKit(
      [
        { label: 'Large saucepan', stepIds: ['s1'], ref: null },
        { label: '  large   saucepan ', stepIds: ['s2'], ref: null },
      ],
      ['s1', 's2'],
    );
    expect(kit).toEqual([{ label: 'Large saucepan', stepIds: ['s1', 's2'], equipment: null }]);
  });

  it('de-duplicates repeated step ids within one entry', () => {
    const kit = sanitiseRecipeKit(
      [{ label: 'wooden spoon', stepIds: ['s1', 's1'], ref: null }],
      ['s1'],
    );
    expect(kit).toEqual([{ label: 'wooden spoon', stepIds: ['s1'], equipment: null }]);
  });

  it('preserves the order the model listed the kit in', () => {
    const kit = sanitiseRecipeKit(
      [
        { label: 'large saucepan', stepIds: ['s1'], ref: null },
        { label: 'colander', stepIds: ['s2'], ref: null },
        { label: 'potato masher', stepIds: ['s2'], ref: null },
      ],
      ['s1', 's2'],
    );
    expect(kit.map((k) => k.label)).toEqual(['large saucepan', 'colander', 'potato masher']);
  });

  // ── The link (issue #1465) ─────────────────────────────────────────────────

  it('turns a handle from this call into the link it stands for', () => {
    const handles = new Map([
      ['k1', { itemId: 'item-magimix', accessoryId: null }],
      ['k1.1', { itemId: 'item-magimix', accessoryId: 'acc-steam' }],
    ]);
    const kit = sanitiseRecipeKit(
      [
        { label: 'Magimix Cook Expert', stepIds: [], ref: 'k1' },
        { label: 'steam basket', stepIds: [], ref: 'k1.1' },
        { label: 'colander', stepIds: [], ref: null },
      ],
      [],
      handles,
    );
    expect(kit).toEqual([
      {
        label: 'Magimix Cook Expert',
        stepIds: [],
        equipment: { itemId: 'item-magimix', accessoryId: null },
      },
      {
        label: 'steam basket',
        stepIds: [],
        equipment: { itemId: 'item-magimix', accessoryId: 'acc-steam' },
      },
      { label: 'colander', stepIds: [], equipment: null },
    ]);
  });

  it('tolerates the brackets the prompt shows the handle in', () => {
    // `KIT_HANDLE_FRAMING` shows the model `[k3.2] Steam Basket` and asks it to
    // "copy its handle EXACTLY" — `ref: "[k3.2]"` is a plausible reading of that,
    // and the map is keyed on the bare handle. Without stripping, this link would
    // drop silently.
    const handles = new Map([['k1.1', { itemId: 'item-magimix', accessoryId: 'acc-steam' }]]);
    const kit = sanitiseRecipeKit(
      [{ label: 'steam basket', stepIds: [], ref: '[k1.1]' }],
      [],
      handles,
    );
    expect(kit).toEqual([
      {
        label: 'steam basket',
        stepIds: [],
        equipment: { itemId: 'item-magimix', accessoryId: 'acc-steam' },
      },
    ]);
  });

  it('drops a handle this call never offered, and keeps the entry', () => {
    // The trust boundary doing its job: a returned link is untrusted exactly as a
    // returned step id is, and an invented one costs the line its link, never its
    // existence.
    const kit = sanitiseRecipeKit(
      [{ label: 'tagine', stepIds: [], ref: 'k99' }],
      [],
      new Map([['k1', { itemId: 'item-magimix', accessoryId: null }]]),
    );
    expect(kit).toEqual([{ label: 'tagine', stepIds: [], equipment: null }]);
  });

  it('drops every handle when no manifest was offered at all', () => {
    const kit = sanitiseRecipeKit([{ label: 'pan', stepIds: [], ref: 'k1' }], []);
    expect(kit[0]?.equipment).toBeNull();
  });

  it('keeps the first surviving link when two mentions collapse', () => {
    const handles = new Map([['k2', { itemId: 'item-pans', accessoryId: 'acc-tefal' }]]);
    const kit = sanitiseRecipeKit(
      [
        { label: 'Tefal 28cm', stepIds: ['s1'], ref: null },
        { label: 'tefal 28cm', stepIds: ['s2'], ref: 'k2' },
      ],
      ['s1', 's2'],
      handles,
    );
    // The first spelling and the first SURVIVING link — the second mention is the
    // only one that said which of your things it is, so it is not thrown away.
    expect(kit).toEqual([
      {
        label: 'Tefal 28cm',
        stepIds: ['s1', 's2'],
        equipment: { itemId: 'item-pans', accessoryId: 'acc-tefal' },
      },
    ]);
  });

  it('trims the label it keeps', () => {
    expect(sanitiseRecipeKit([{ label: '  box grater ', stepIds: [], ref: null }], [])).toEqual([
      { label: 'box grater', stepIds: [], equipment: null },
    ]);
  });
});

describe('identifyRecipeKit flow', () => {
  it('sanitises the model output against the recipe it was asked about', async () => {
    mockGenerate.mockResolvedValue({
      output: {
        kit: [
          { label: 'large saucepan', stepIds: ['s1', 'not-a-step'] },
          { label: '', stepIds: ['s1'] },
          { label: 'Large saucepan', stepIds: ['s2'] },
        ],
      },
    });

    const result = await (identifyRecipeKitFlow as Function)(input);

    expect(result).toEqual({
      kit: [{ label: 'large saucepan', stepIds: ['s1', 's2'], equipment: null }],
    });
  });

  it('sends the step ids to the model alongside the step text', async () => {
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)(input);

    const prompt = mockGenerate.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('[s1] Boil the potatoes until tender.');
    expect(prompt).toContain('[s2] Drain, then mash with the butter.');
  });

  it('throws when the model returns an unparseable shape', async () => {
    mockGenerate.mockResolvedValue({ output: { kit: [{ label: 'pan' }] } });

    await expect((identifyRecipeKitFlow as Function)(input)).rejects.toThrow(
      /identifyRecipeKit returned invalid output/,
    );
  });

  it('does not constrain the model to a vocabulary — an unknown tool passes through', async () => {
    // The load-bearing decision of issue #882: labels are free text, so a tool the
    // drawn vocabulary has never heard of survives to the document and renders as
    // words with no picture. An enum here would have turned it into something else.
    mockGenerate.mockResolvedValue({
      output: { kit: [{ label: 'tagine', stepIds: ['s1'] }] },
    });

    const result = await (identifyRecipeKitFlow as Function)(input);

    expect(result.kit).toEqual([{ label: 'tagine', stepIds: ['s1'], equipment: null }]);
  });
});

describe('IdentifyRecipeKitInputSchema — equipment (issues #954, #1465)', () => {
  const base = {
    title: 'Champ',
    description: null,
    ingredients: [],
    steps: [],
  };

  it('parses without `equipment`, defaulting it to the empty list', () => {
    // The fail-open contract: `readEquipmentItems` returns `[]` for a missing,
    // corrupt or unreadable manifest, and `[]` must mean "answer exactly as
    // before", never "skip inference".
    const parsed = IdentifyRecipeKitInputSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.equipment).toEqual([]);
  });

  it('parses with `equipment`, keeping the manifest items structured', () => {
    const parsed = IdentifyRecipeKitInputSchema.safeParse({ ...base, equipment: [MAGIMIX] });
    expect(parsed.success && parsed.data.equipment[0]?.name).toBe('Magimix Cook Expert');
    expect(parsed.success && parsed.data.equipment[0]?.accessories[0]?.id).toBe('acc-steam');
  });
});

describe('identifyRecipeKit flow — the manifest (issue #954)', () => {
  it('puts the household kit on the system prompt, with the naming rules', async () => {
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)({ ...input, equipment: [MAGIMIX, FRYING_PANS] });

    const system = mockGenerate.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('Magimix Cook Expert');
    expect(system).toContain('Frying Pans');
    // The licence that comes with the manifest, and its limit.
    expect(system).toContain('NEVER generalise a named appliance back to a generic one');
    expect(system).toContain('NOT a licence to introduce one');
  });

  it('leaves the system prompt untouched when there is no manifest', async () => {
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)({ ...input, equipment: [] });

    const system = mockGenerate.mock.calls[0]?.[0]?.system as string;
    expect(system).not.toContain('## Your kitchen');
  });

  it('asks for ordinary English capitals, so the tab reads like the ingredients beside it', async () => {
    // The equipment tab prints the stored label verbatim, exactly as the ingredients
    // tab prints `parsed.item` verbatim — so a column mixing "sharp knife" with
    // "Hand Blender Attachment" is a defect in what was WRITTEN, not in what is
    // rendered. Everyday kit lower case, a proper name keeps its capitals: the same
    // rule that lets one ingredient line hold "Dijon mustard" and "fine sea salt".
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)(input);

    const system = mockGenerate.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('CAPITALS');
    expect(system).toContain('"hand blender attachment", not "Hand Blender Attachment"');
    // And the old flat instruction is gone: "Lowercase" full stop is what would
    // strip the capitals off "Magimix Cook Expert".
    expect(system).not.toContain('Lowercase, singular');
  });

  it('gives every item and owned entry a handle, and asks for it back (issue #1465)', async () => {
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)({ ...input, equipment: [MAGIMIX, FRYING_PANS] });

    const system = mockGenerate.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('[k1] Magimix Cook Expert');
    expect(system).toContain('[k1.1] Steam Basket');
    expect(system).toContain('[k2] Frying Pans');
    expect(system).toContain('[k2.1] Tefal non-stick 28cm');
    // A family's entries are still labelled "contains", not "accessories" — `kind`
    // picking words, as it always has.
    expect(system).toContain('contains:');
    expect(system).toContain('copy its handle EXACTLY');
    // An entry marked NOT owned is not in the kitchen, so it gets no handle and is
    // not shown — matching what every other flow is told.
    expect(system).not.toContain('XL Steamer Attachment');
  });

  it('maps a returned handle onto the entry it wrote', async () => {
    mockGenerate.mockResolvedValue({
      output: { kit: [{ label: 'steam basket', stepIds: ['s1'], ref: 'k1.1' }] },
    });

    const result = await (identifyRecipeKitFlow as Function)({
      ...input,
      equipment: [MAGIMIX, FRYING_PANS],
    });

    expect(result.kit).toEqual([
      {
        label: 'steam basket',
        stepIds: ['s1'],
        equipment: { itemId: 'item-magimix', accessoryId: 'acc-steam' },
      },
    ]);
  });

  it('no longer forbids brand names', async () => {
    // The #954 defect in one line: the prompt used to end the naming rules with
    // "no brand names", which is what discarded "Magimix Cook Expert" from a step
    // that said it.
    mockGenerate.mockResolvedValue({ output: { kit: [] } });

    await (identifyRecipeKitFlow as Function)(input);

    expect(mockGenerate.mock.calls[0]?.[0]?.system as string).not.toContain('no brand names');
  });
});
