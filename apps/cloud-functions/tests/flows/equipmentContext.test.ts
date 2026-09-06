import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('firebase-functions', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

const {
  renderEquipmentManifest,
  readEquipmentContext,
  equipmentSectionForChef,
  equipmentSectionForLibrarian,
  equipmentSectionForKit,
} = await import('../../src/flows/equipmentContext.js');

type EquipmentEnvironmentDoc = import('@salt/domain/schemas').EquipmentEnvironmentDoc;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function accessory(name: string, owned: boolean) {
  return { id: `acc-${name}`, name, owned, included: false };
}

function item(
  name: string,
  opts: {
    accessories?: ReturnType<typeof accessory>[];
    rules?: string[];
    environment?: EquipmentEnvironmentDoc | null;
  } = {},
) {
  return {
    id: `eq-${name}`,
    schemaVersion: 1 as const,
    name,
    accessories: opts.accessories ?? [],
    rules: opts.rules ?? [],
    environment: opts.environment ?? null,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function manifest(items: ReturnType<typeof item>[]) {
  return { schemaVersion: 1 as const, updatedAt: '2026-07-01T00:00:00.000Z', items };
}

/** A Firestore stub whose equipmentManifest/current get() resolves to `snap`. */
function dbReturning(snap: unknown) {
  return { collection: () => ({ doc: () => ({ get: () => Promise.resolve(snap) }) }) } as never;
}

// ─── rendering ────────────────────────────────────────────────────────────────

describe('renderEquipmentManifest', () => {
  it('renders each item by name', () => {
    const out = renderEquipmentManifest([
      item('Sage the Smart Oven Pizzaiolo SPZ820'),
      item('Anova Precision Oven'),
    ]);
    expect(out).toContain('- Sage the Smart Oven Pizzaiolo SPZ820');
    expect(out).toContain('- Anova Precision Oven');
  });

  it('renders owned accessories as owned', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        accessories: [accessory('4 mm slicing disc', true), accessory('Steam basket', true)],
      }),
    ]);
    expect(out).toContain('accessories owned: 4 mm slicing disc, Steam basket');
    expect(out).not.toContain('NOT owned');
  });

  it('renders unowned accessories as explicitly unavailable rather than dropping them', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        accessories: [
          accessory('4 mm slicing disc', true),
          accessory('XL Steamer Attachment', false),
        ],
      }),
    ]);
    // The unowned one must survive into the prompt — the whole point is that the
    // chef can say "you don't have that" instead of suggesting it blindly.
    expect(out).toContain('XL Steamer Attachment');
    expect(out).toContain('accessories NOT owned');
    // …and it must not be confused with the owned list.
    expect(out).toContain('accessories owned: 4 mm slicing disc');
    expect(out).not.toContain('accessories owned: 4 mm slicing disc, XL Steamer Attachment');
  });

  it('surfaces the household rules override', () => {
    const out = renderEquipmentManifest([
      item('Kuhn Rikon Duromatic Inox 6L / 24cm', {
        rules: ['Never fill past two-thirds', 'Always release pressure under cold water'],
      }),
    ]);
    expect(out).toContain('household rules');
    expect(out).toContain('override your own product knowledge');
    expect(out).toContain('Never fill past two-thirds');
    expect(out).toContain('Always release pressure under cold water');
  });

  it('omits the accessory and rules lines entirely when there are none', () => {
    const out = renderEquipmentManifest([item('Cast iron skillet')]);
    expect(out).toBe('- Cast iron skillet');
  });

  it('degrades to an empty string for an empty manifest', () => {
    expect(renderEquipmentManifest([])).toBe('');
  });
});

// ─── reading ──────────────────────────────────────────────────────────────────

describe('readEquipmentContext', () => {
  it('reads, validates, and renders the manifest', async () => {
    const db = dbReturning({
      exists: true,
      data: () =>
        manifest([
          item('Sage the Smart Oven Pizzaiolo SPZ820', {
            accessories: [accessory('Pizza stone', true), accessory('Crisper plate', false)],
            rules: ['Preheat for a full 20 minutes'],
          }),
        ]),
    });

    const out = await readEquipmentContext(db, 'chefChat');
    expect(out).toContain('- Sage the Smart Oven Pizzaiolo SPZ820');
    expect(out).toContain('accessories owned: Pizza stone');
    expect(out).toContain('accessories NOT owned');
    expect(out).toContain('Crisper plate');
    expect(out).toContain('Preheat for a full 20 minutes');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('degrades to an empty string when the manifest doc does not exist', async () => {
    expect(await readEquipmentContext(dbReturning({ exists: false }), 'chefChat')).toBe('');
  });

  it('degrades to an empty string when the manifest has no items', async () => {
    const db = dbReturning({ exists: true, data: () => manifest([]) });
    expect(await readEquipmentContext(db, 'chefChat')).toBe('');
  });

  it('logs and degrades when the manifest fails validation', async () => {
    const db = dbReturning({ exists: true, data: () => ({ schemaVersion: 99 }) });
    expect(await readEquipmentContext(db, 'authorRecipe')).toBe('');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('authorRecipe'));
  });

  it('logs and degrades when the read throws — never propagates the failure', async () => {
    const db = {
      collection: () => ({
        doc: () => ({ get: () => Promise.reject(new Error('firestore down')) }),
      }),
    } as never;
    expect(await readEquipmentContext(db, 'chefChat')).toBe('');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed to read equipmentManifest'),
      expect.anything(),
    );
  });
});

// ─── framings ─────────────────────────────────────────────────────────────────

describe('equipment prompt framings', () => {
  const context = '- Sage the Smart Oven Pizzaiolo SPZ820';

  it('gives the chef sweep-then-detail, proportionality, and the no-shoehorn escape hatch', () => {
    const section = equipmentSectionForChef(context);
    expect(section).toContain(context);
    expect(section).toContain('PROPORTIONALITY IS A RULE');
    expect(section).toContain('MOST VIABLE');
    expect(section).toContain('washing-up');
    expect(section).toContain('NOT owned are unavailable');
    expect(section).toContain('OVERRIDE your general product knowledge');
    // Still free to answer without any appliance at all.
    expect(section).toContain('need no special kit');
    // The old opt-out must not come back.
    expect(section).not.toContain('never feel obliged');
  });

  it('gives the librarian preservation-only framing, never licence to pick equipment', () => {
    const section = equipmentSectionForLibrarian(context);
    expect(section).toContain(context);
    expect(section).toContain('RECOGNITION ONLY');
    expect(section).toContain('PRESERVE');
    expect(section).toContain('NEVER generalise a named appliance');
    expect(section).toContain('NEVER introduce, substitute, or upgrade equipment');
    expect(section).toContain('NOT a menu');
  });

  it('gives the kit flow licence to NAME which one, and no licence to introduce one', () => {
    // The third framing (issue #954). It sits between the other two on purpose: the
    // chef may choose equipment, the librarian may only preserve it, and the kit
    // flow may resolve a class the method already reached for into the item the
    // household actually owns.
    const section = equipmentSectionForKit(context);
    expect(section).toContain(context);
    expect(section).toContain('NEVER generalise a named appliance back to a generic one');
    expect(section).toContain("Copy the item's WORDS from this list verbatim");
    // The words are fixed; the CAPITALS are not, and only ever downwards. A product
    // inventory is title-cased and a kit entry is a line of prose, so an accessory
    // named in ordinary words reads lower case beside "sharp knife" while a maker
    // and model keep theirs. Same rule the ingredients tab already reads by.
    expect(section).toContain('only downwards');
    expect(section).toContain('"hand blender attachment"');
    expect(section).toContain('NOT owned are unavailable');
    // The limit — naming which appliance must not become adding one.
    expect(section).toContain('NOT a licence to introduce one');
    // And the generic path survives: a frying pan is still a frying pan.
    expect(section).toContain('If nothing here does the job');
  });

  it('omits every section entirely when there is no equipment context', () => {
    expect(equipmentSectionForChef('')).toBe('');
    expect(equipmentSectionForLibrarian('')).toBe('');
    expect(equipmentSectionForKit('')).toBe('');
  });
});

// ─── Places: equipment that holds a temperature (issue #1281) ─────────────────

describe('renderEquipmentManifest — environment', () => {
  it('says nothing at all for equipment that is not a place', () => {
    // The claim the whole feature rests on: describing six chambers changes
    // nothing about the other thirty items in the manifest.
    const rendered = renderEquipmentManifest([item('Sharp knife')]);
    expect(rendered).toBe('- Sharp knife');
  });

  it('renders a dedicated place as one a job may dial in', () => {
    const rendered = renderEquipmentManifest([
      item('Dough proofer', {
        environment: {
          control: 'dedicated',
          minCelsius: 20,
          maxCelsius: 50,
          humidity: null,
          standing: null,
        },
      }),
    ]);
    expect(rendered).toContain('holds a temperature: 20–50 °C');
    expect(rendered).toContain('humidity: no control');
    expect(rendered).toContain('dedicated — it holds one job at a time');
    expect(rendered).not.toContain('shared');
  });

  it('renders a shared place with the setting it is standing at', () => {
    const rendered = renderEquipmentManifest([
      item('Curing chamber', {
        environment: {
          control: 'shared',
          minCelsius: 8,
          maxCelsius: 18,
          humidity: { precision: 'approximate', minPercent: 60, maxPercent: 85 },
          standing: { celsius: 12, relativeHumidityPercent: 75 },
        },
      }),
    ]);
    expect(rendered).toContain('holds a temperature: 8–18 °C');
    expect(rendered).toContain('humidity: roughly held, 60–85% RH');
    expect(rendered).toContain('set to 12 °C and 75% RH');
    expect(rendered).toContain('a single job does not change it');
  });

  it('marks a precisely-held humidity as controlled', () => {
    const rendered = renderEquipmentManifest([
      item('Anova Precision Oven', {
        environment: {
          control: 'dedicated',
          minCelsius: 25,
          maxCelsius: 250,
          humidity: { precision: 'controlled', minPercent: 0, maxPercent: 100 },
          standing: null,
        },
      }),
    ]);
    expect(rendered).toContain('humidity: controlled, 0–100% RH');
  });

  it('ignores a standing setpoint on a DEDICATED place', () => {
    // The boundary of the shared/dedicated claim, stated in the schema's field
    // docs: the write path normalises this away, but a document written any
    // other way still parses, so the renderer must not read it.
    const rendered = renderEquipmentManifest([
      item('Fermentation chamber', {
        environment: {
          control: 'dedicated',
          minCelsius: 15,
          maxCelsius: 35,
          humidity: null,
          standing: { celsius: 28, relativeHumidityPercent: null },
        },
      }),
    ]);
    expect(rendered).not.toContain('28');
    expect(rendered).toContain('dedicated — it holds one job at a time');
  });

  it('renders a shared place held at a temperature but no humidity reading', () => {
    const rendered = renderEquipmentManifest([
      item('Wine fridge', {
        environment: {
          control: 'shared',
          minCelsius: 5,
          maxCelsius: 18,
          humidity: null,
          standing: { celsius: 14, relativeHumidityPercent: null },
        },
      }),
    ]);
    expect(rendered).toContain('set to 14 °C and a single job does not change it');
    expect(rendered).not.toContain('% RH,');
  });

  it('says plainly when a shared place has no recorded setting', () => {
    const rendered = renderEquipmentManifest([
      item('Curing chamber', {
        environment: {
          control: 'shared',
          minCelsius: 8,
          maxCelsius: 18,
          humidity: null,
          standing: null,
        },
      }),
    ]);
    expect(rendered).toContain('a setting nobody has recorded');
  });

  it('tells the chef what to do with a place, and that the counter is an answer', () => {
    const section = equipmentSectionForChef('- Curing chamber');
    expect(section).toContain('HOLDS A TEMPERATURE');
    expect(section).toContain('the listed figures are the truth about them');
    expect(section).toContain('kitchen counter is a perfectly good answer');
  });
});
