import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWarn = vi.fn();
vi.mock('firebase-functions', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

const {
  renderEquipmentManifest,
  renderEquipmentDetail,
  readEquipmentContext,
  equipmentSectionForChef,
  equipmentSectionForLibrarian,
  equipmentSectionForKit,
  renderEquipmentManifestForKit,
} = await import('../../src/flows/equipmentContext.js');

type EquipmentEnvironmentDoc = import('@salt/domain/schemas').EquipmentEnvironmentDoc;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function accessory(name: string, owned: boolean, note = '') {
  return { id: `acc-${name}`, name, owned, included: false, note };
}

function item(
  name: string,
  opts: {
    accessories?: ReturnType<typeof accessory>[];
    rules?: string[];
    environment?: EquipmentEnvironmentDoc | null;
    // Issue #1373. Default `'equipment'` and `''` so every test written before
    // families existed still describes what it meant to describe.
    kind?: 'equipment' | 'family';
    note?: string;
  } = {},
) {
  return {
    id: `eq-${name}`,
    schemaVersion: 1 as const,
    name,
    kind: opts.kind ?? ('equipment' as const),
    accessories: opts.accessories ?? [],
    rules: opts.rules ?? [],
    note: opts.note ?? '',
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

  it('renders owned accessories as one row of names', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        accessories: [accessory('4 mm slicing disc', true), accessory('Steam basket', true)],
      }),
    ]);
    expect(out).toContain('accessories: 4 mm slicing disc, Steam basket');
  });

  // Issue #1373, decision 8. This REVERSES #954's prompt behaviour and not its
  // data: the 28 not-owned entries in the live manifest stay stored, stay on
  // screen, and come back from `renderEquipmentDetail` marked — they simply stop
  // riding along on every call to five AI flows.
  it('renders neither the unowned entries nor any warning about them', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        accessories: [
          accessory('4 mm slicing disc', true),
          accessory('XL Steamer Attachment', false),
        ],
      }),
    ]);
    expect(out).not.toContain('XL Steamer Attachment');
    expect(out).not.toContain('NOT owned');
    expect(out).not.toContain('unavailable');
    expect(out).toContain('accessories: 4 mm slicing disc');
  });

  it('labels a family\'s row "contains" and an appliance\'s "accessories"', () => {
    const entries = [accessory('28cm cast iron', true), accessory('20cm non-stick', true)];
    const family = renderEquipmentManifest([
      item('Frying pans', { accessories: entries, kind: 'family' }),
    ]);
    expect(family).toContain('  contains: 28cm cast iron, 20cm non-stick');
    expect(family).not.toContain('accessories:');

    const appliance = renderEquipmentManifest([item('Frying pans', { accessories: entries })]);
    expect(appliance).toContain('  accessories: 28cm cast iron, 20cm non-stick');
    expect(appliance).not.toContain('contains:');
  });

  // The row is a CONCATENATION, never a parse (#1281's rule, restated by #1373).
  // Nothing derives "from 20cm to 32cm", nothing groups by material, nothing
  // reads a number out of a name — so a name with a size in it survives verbatim.
  it('joins entry names verbatim and derives nothing from them', () => {
    const out = renderEquipmentManifest([
      item('Frying pans', {
        kind: 'family',
        accessories: [
          accessory('20cm non-stick', true),
          accessory('28cm carbon steel', true),
          accessory('32cm stainless', true),
        ],
      }),
    ]);
    expect(out).toContain('  contains: 20cm non-stick, 28cm carbon steel, 32cm stainless');
    expect(out).not.toMatch(/20\s*(cm)?\s*(to|–|-)\s*32/);
    expect(out).not.toContain('3 ');
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
    expect(out).toContain('accessories: Pizza stone');
    expect(out).toContain('Preheat for a full 20 minutes');
    // The unowned one is read from the document and deliberately not rendered
    // (issue #1373, decision 8) — the stored tick is untouched, and the chef sees
    // it again the moment it looks this item up.
    expect(out).not.toContain('Crisper plate');
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
    expect(section).toContain('OVERRIDE your general product knowledge');
    // Issue #1373, decision 8: the roll-call of what they do NOT own is gone, and
    // what replaces it is the simpler instruction. If the old paragraph ever
    // comes back, it comes back with its 28 entries in every prompt.
    expect(section).toContain('WHAT IS LISTED IS WHAT THEY HAVE');
    expect(section).not.toContain('NOT owned are unavailable');
    expect(section).not.toContain('XL Steamer Attachment');
    // A family's row needs explaining where it is rendered.
    expect(section).toContain('FAMILY of similar things');
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

// ─── The uniform-notes claim, pinned (issue #1373) ───────────────────────────
//
// THE CLAIM: "no note is ever rendered ambiently — not on an entry in the list,
// not on the record itself. Every note reaches the chef only through the tool."
// It is the load-bearing half of the whole issue: the reason one record can hold
// twelve pans without the prompt growing twelvefold is that what is written about
// each of them is not sent. A note leaking into this renderer would restore
// exactly the cost the feature exists to remove, silently and in every flow.
//
// This expectation must survive every future change to this renderer.

describe('renderEquipmentManifest — no note is ever ambient', () => {
  it('puts no note text into the prompt, from an item or from an entry', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        accessories: [
          accessory('Thermo Bowl', true, 'ENTRY_NOTE_SENTINEL'),
          accessory('XL Steamer Attachment', false, 'UNOWNED_NOTE_SENTINEL'),
        ],
        rules: ['has the upgraded firmware'],
        note: 'ITEM_NOTE_SENTINEL',
      }),
      item('Frying pans', {
        kind: 'family',
        accessories: [accessory('28cm cast iron', true, 'FAMILY_NOTE_SENTINEL')],
        note: 'FAMILY_ITEM_NOTE_SENTINEL',
      }),
    ]);
    expect(out).not.toContain('ENTRY_NOTE_SENTINEL');
    expect(out).not.toContain('UNOWNED_NOTE_SENTINEL');
    expect(out).not.toContain('ITEM_NOTE_SENTINEL');
    expect(out).not.toContain('FAMILY_NOTE_SENTINEL');
    expect(out).not.toContain('FAMILY_ITEM_NOTE_SENTINEL');
  });

  it('renders a record carrying notes identically to the same record without them', () => {
    const bare = item('Magimix Cook Expert', {
      accessories: [accessory('Thermo Bowl', true)],
      rules: ['has the upgraded firmware'],
    });
    const noted = item('Magimix Cook Expert', {
      accessories: [accessory('Thermo Bowl', true, 'everything about the Thermo Bowl')],
      rules: ['has the upgraded firmware'],
      note: 'on a high shelf and takes ages to wash',
    });
    expect(renderEquipmentManifest([noted])).toBe(renderEquipmentManifest([bare]));
  });

  it('still renders rules in full and verbatim — a rule is not a note', () => {
    const out = renderEquipmentManifest([
      item('Magimix Cook Expert', {
        rules: ['the bowl seal is perished, do not process liquids'],
        note: 'ITEM_NOTE_SENTINEL',
      }),
    ]);
    expect(out).toContain('the bowl seal is perished, do not process liquids');
    expect(out).not.toContain('ITEM_NOTE_SENTINEL');
  });
});

// ─── The fetched half: renderEquipmentDetail (issue #1373) ───────────────────

describe('renderEquipmentDetail', () => {
  it("gives back an appliance's accessory notes and its own note", () => {
    const out = renderEquipmentDetail(
      item('Magimix Cook Expert', {
        accessories: [accessory('Thermo Bowl', true, 'the seal is perished')],
        rules: ['has the upgraded firmware'],
        note: 'on a high shelf and takes ages to wash',
      }),
    );
    expect(out).toContain('Magimix Cook Expert');
    expect(out).toContain('on a high shelf and takes ages to wash');
    expect(out).toContain('the seal is perished');
    expect(out).toContain('has the upgraded firmware');
  });

  it("gives back a family's entry notes, and says it is a family", () => {
    const out = renderEquipmentDetail(
      item('Frying pans', {
        kind: 'family',
        accessories: [
          accessory('28cm cast iron', true, 'the only one that goes in the oven'),
          accessory('20cm non-stick', true, 'never sear in this'),
        ],
        note: 'the cast iron lives in the bottom drawer',
      }),
    );
    expect(out).toContain('family of kit');
    expect(out).toContain('contains:');
    expect(out).toContain('the only one that goes in the oven');
    expect(out).toContain('never sear in this');
    expect(out).toContain('the cast iron lives in the bottom drawer');
  });

  // DECISION 8's other half, and the reason dropping the ambient roll-call is not
  // a loss: "the warning is not lost, it moves". If this goes red, the chef can
  // no longer tell the household what it does not own at the one moment the
  // answer turns on it.
  it('marks an unowned accessory as unowned rather than hiding it', () => {
    const out = renderEquipmentDetail(
      item('Magimix Cook Expert', {
        accessories: [accessory('Thermo Bowl', true), accessory('XL Steamer Attachment', false)],
      }),
    );
    expect(out).toContain('XL Steamer Attachment');
    expect(out).toContain('NOT OWNED');
    expect(out).not.toMatch(/Thermo Bowl.*NOT OWNED/);
  });

  it('carries the place figures through, unchanged from #1281', () => {
    const out = renderEquipmentDetail(
      item('Curing chamber', {
        environment: {
          control: 'shared',
          minCelsius: 10,
          maxCelsius: 18,
          humidity: { precision: 'controlled', minPercent: 70, maxPercent: 80 },
          standing: { celsius: 13, relativeHumidityPercent: 75 },
        },
      }),
    );
    expect(out).toContain('holds a temperature: 10–18 °C');
    expect(out).toContain('13 °C');
    expect(out).toContain('shared');
  });

  it('says only what there is to say about a bare record', () => {
    expect(renderEquipmentDetail(item('Cast iron skillet'))).toBe(
      'Cast iron skillet — a piece of kit',
    );
  });
});

// ─── Handles, for the kit flow only (issue #1465) ─────────────────────────────

describe('renderEquipmentManifestForKit', () => {
  const MAGIMIX = item('Magimix Cook Expert', {
    accessories: [accessory('Steam Basket', true), accessory('XL Steamer Attachment', false)],
    rules: ['the bowl seal is perished'],
  });
  const PANS = item('Frying Pans', {
    kind: 'family',
    accessories: [accessory('Tefal non-stick 28cm', true)],
  });

  it('numbers items and their owned entries, and maps every handle it printed', () => {
    const { rendered, byHandle } = renderEquipmentManifestForKit([MAGIMIX, PANS]);

    expect(rendered).toContain('- [k1] Magimix Cook Expert');
    expect(rendered).toContain('- [k1.1] Steam Basket');
    expect(rendered).toContain('- [k2] Frying Pans');
    expect(rendered).toContain('- [k2.1] Tefal non-stick 28cm');
    expect(byHandle.get('k1')).toEqual({ itemId: MAGIMIX.id, accessoryId: null });
    expect(byHandle.get('k1.1')).toEqual({
      itemId: MAGIMIX.id,
      accessoryId: MAGIMIX.accessories[0]?.id,
    });
  });

  it('prints exactly the handles it maps, and maps exactly the handles it prints', () => {
    // The property the whole scheme rests on (CLAUDE.md rule 12): a handle printed
    // but not mapped writes no link, and a handle mapped but not printed can never
    // come back. One loop produces both, and this is what goes red if that stops
    // being true.
    const { rendered, byHandle } = renderEquipmentManifestForKit([MAGIMIX, PANS]);
    const printed = [...rendered.matchAll(/\[(k[0-9.]+)\]/g)].map((m) => m[1]);
    expect(printed.sort()).toEqual([...byHandle.keys()].sort());
  });

  it('gives an unowned entry no handle at all', () => {
    const { rendered, byHandle } = renderEquipmentManifestForKit([MAGIMIX]);
    expect(rendered).not.toContain('XL Steamer Attachment');
    expect([...byHandle.values()].map((v) => v.accessoryId)).toEqual([
      null,
      MAGIMIX.accessories[0]?.id,
    ]);
  });

  it('gives an item with nothing owned under it a handle and no entry row', () => {
    // The salad spinner, on the live manifest: a record with no accessories at
    // all. It still gets a handle, because the cook can still be told to get it
    // out — what it has no need of is an entry list.
    const { rendered, byHandle } = renderEquipmentManifestForKit([item('Salad Spinner')]);
    expect(rendered).toBe('- [k1] Salad Spinner');
    expect([...byHandle.keys()]).toEqual(['k1']);
  });

  it('is empty for an empty manifest, so the section is omitted entirely', () => {
    const { rendered, byHandle } = renderEquipmentManifestForKit([]);
    expect(rendered).toBe('');
    expect(byHandle.size).toBe(0);
    expect(equipmentSectionForKit(rendered)).toBe('');
  });

  it('leaves `renderEquipmentManifest` byte-identical for the other four flows', () => {
    // The stated constraint of #1465: the kit flow gets its own rendering, and the
    // chef, the librarian, the stage extractor and the scheduler keep theirs to the
    // byte. A handle leaking into the shared renderer would change four prompts for
    // a feature none of them is part of.
    const shared = renderEquipmentManifest([MAGIMIX, PANS]);
    expect(shared).not.toMatch(/\[k\d/);
    expect(shared).toBe(
      [
        '- Magimix Cook Expert',
        '  accessories: Steam Basket',
        '  household rules (override your own product knowledge): the bowl seal is perished',
        '- Frying Pans',
        '  contains: Tefal non-stick 28cm',
      ].join('\n'),
    );
  });
});
