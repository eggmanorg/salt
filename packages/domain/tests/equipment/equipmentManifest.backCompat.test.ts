import { describe, it, expect } from 'vitest';
import { EquipmentManifestSchema } from '../../src/schemas/equipmentManifest.js';

// ─── The back-compat claim, made mechanical (issue #1373, CLAUDE.md rule 12) ──
//
// THE CLAIM: "every change is additive with a default, so a document written
// before this change parses unchanged — as an `equipment` record with empty
// notes". The manifest holds real production data in ONE document, so a field
// that failed to default would not degrade one row, it would take the whole
// equipment list down for every user at once.
//
// THE FIXTURE IS A VERBATIM PRE-CHANGE SHAPE, deliberately written as a literal
// rather than built from the current types: a fixture derived from today's
// schema would acquire tomorrow's fields and stop testing anything. This is what
// `equipmentManifest/current` looked like in production on 2026-09-14 — an item
// with accessories carrying `owned`/`included` and no `note`, no `kind` on the
// item, no `note` on the item, and (for the older items) no `environment` key at
// all.
//
// THE BOUNDARY, stated honestly: this pins PARSING, not rendering. That a note
// never reaches an AI prompt is a separate claim pinned on the renderer.
const PRE_CHANGE_DOCUMENT = {
  schemaVersion: 1,
  updatedAt: '2026-09-14T10:00:00.000Z',
  items: [
    {
      id: 'eq-magimix',
      schemaVersion: 1,
      name: 'Magimix Cook Expert',
      accessories: [
        { id: 'acc-1', name: 'Thermo Bowl', owned: true, included: true },
        { id: 'acc-2', name: 'XL Steamer Attachment', owned: false, included: false },
      ],
      rules: ['has the upgraded firmware with the Dough Hook XL program'],
      updatedAt: '2026-09-14T10:00:00.000Z',
    },
    {
      id: 'eq-proofer',
      schemaVersion: 1,
      name: 'Dough proofer',
      accessories: [],
      rules: [],
      environment: {
        control: 'dedicated',
        minCelsius: 20,
        maxCelsius: 50,
      },
      updatedAt: '2026-09-14T10:00:00.000Z',
    },
  ],
};

describe('EquipmentManifestSchema back-compat (issue #1373)', () => {
  it('parses a document written before kind and notes existed', () => {
    const parsed = EquipmentManifestSchema.safeParse(PRE_CHANGE_DOCUMENT);
    expect(parsed.success).toBe(true);
  });

  it('reads an item with no kind key as a piece of equipment', () => {
    const parsed = EquipmentManifestSchema.safeParse(PRE_CHANGE_DOCUMENT);
    if (!parsed.success) throw new Error('fixture must parse');
    expect(parsed.data.items.map((i) => i.kind)).toEqual(['equipment', 'equipment']);
  });

  it('reads a missing note — on the item and on every accessory — as nothing said', () => {
    const parsed = EquipmentManifestSchema.safeParse(PRE_CHANGE_DOCUMENT);
    if (!parsed.success) throw new Error('fixture must parse');
    expect(parsed.data.items.map((i) => i.note)).toEqual(['', '']);
    expect(parsed.data.items[0]!.accessories.map((a) => a.note)).toEqual(['', '']);
  });

  it('leaves every owned and included tick exactly as it was stored', () => {
    const parsed = EquipmentManifestSchema.safeParse(PRE_CHANGE_DOCUMENT);
    if (!parsed.success) throw new Error('fixture must parse');
    expect(parsed.data.items[0]!.accessories).toEqual([
      { id: 'acc-1', name: 'Thermo Bowl', owned: true, included: true, note: '' },
      { id: 'acc-2', name: 'XL Steamer Attachment', owned: false, included: false, note: '' },
    ]);
  });

  it('leaves the #1281 place fields untouched', () => {
    const parsed = EquipmentManifestSchema.safeParse(PRE_CHANGE_DOCUMENT);
    if (!parsed.success) throw new Error('fixture must parse');
    expect(parsed.data.items[0]!.environment).toBeNull();
    expect(parsed.data.items[1]!.environment).toEqual({
      control: 'dedicated',
      minCelsius: 20,
      maxCelsius: 50,
      humidity: null,
      standing: null,
    });
  });

  it('refuses a kind it does not know rather than inventing one', () => {
    const parsed = EquipmentManifestSchema.safeParse({
      ...PRE_CHANGE_DOCUMENT,
      items: [{ ...PRE_CHANGE_DOCUMENT.items[0], kind: 'gadget' }],
    });
    expect(parsed.success).toBe(false);
  });
});
