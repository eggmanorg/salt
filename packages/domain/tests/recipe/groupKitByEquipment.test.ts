import { describe, it, expect } from 'vitest';
import { groupKitByEquipment } from '@salt/domain';
import type { EquipmentItem, KitEquipmentGroup } from '@salt/domain';
import type { RecipeKitEntryDoc } from '@salt/domain/schemas';

// Accessories under their appliance (issue #1140), from the LINK alone (#1465).
//
// The two word-based passes this file used to drive are gone — #1465's Phase 4,
// after the production re-run of 2026-09-19 relinked all 66 recipes and replaying
// the query over the live manifest showed not one of them grouping differently
// without those passes. What is left is pinned here, and the cases that pinned the
// word passes went with them.
//
// Four of these are the safety properties the design rests on, and each is written
// so it goes RED if the guard is removed rather than merely passing today:
//   • an unlinked entry is a flat row and can anchor nothing;
//   • a family member never nests and never anchors;
//   • every entry appears exactly once, so the tab's count stays `kit.length`;
//   • which entry HEADS a row never depends on stored order (#1182), so every case
//     that could turn on it is written in both orders.
//
// What is NOT pinned here, because it is not this query's job any more: whether a
// label that names one of your things by WORDS alone still finds it. It does —
// through `resolveKitEntryItem`, for the PICTURE — and `kitIcons.test.ts` is where
// that is pinned. See this query's header for the two production lines that rest
// on it.

function entry(label: string): RecipeKitEntryDoc {
  return { label, stepIds: [], equipment: null };
}

/** The same entry with the link the kit flow records since issue #1465. */
function linked(
  label: string,
  itemId: string,
  accessoryId: string | null = null,
): RecipeKitEntryDoc {
  return { label, stepIds: [], equipment: { itemId, accessoryId } };
}

function item(id: string, name: string, accessories: readonly string[] = []): EquipmentItem {
  return {
    id,
    schemaVersion: 1,
    name,
    kind: 'equipment',
    accessories: accessories.map((accName, i) => ({
      id: `${id}-acc-${i}`,
      name: accName,
      owned: true,
      included: true,
      note: '',
      borrowedPicture: null,
    })),
    rules: [],
    note: '',
    environment: null,
    borrowedPicture: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** The rendered shape: one entry per line, an accessory line marked by its indent. */
function lines(groups: readonly KitEquipmentGroup[]): string[] {
  return groups.flatMap((group) => [
    group.entry.label,
    ...group.accessories.map((a) => `  ↳ ${a.label}`),
  ]);
}

const RICE_COOKER = item('eq-cosori', 'Cosori 5L Rice Cooker', ['Rice Spoon', 'Measuring Cup']);
const ANOVA = item('eq-anova', 'Anova Precision Oven', ['Oven Sheet Pan', 'Wire Oven Rack']);
// The prefixed spelling issue #1182 was about: both "Magimix Cook Expert" and
// "Magimix Cocotte Slow Cook Pot" name this one item, and the link now says which
// part of it each line means rather than the words being read twice.
const MAGIMIX = item('eq-magimix', 'Magimix Cook Expert', ['Cocotte Slow Cook Pot', 'Blender Jug']);

// A FAMILY, as the live manifest carries it since #1373: members that share not
// one word with the family's own name, which is why no rule over the words can
// find them and why #1465 records the link instead.
const FRYING_PANS: EquipmentItem = {
  ...item('eq-pans', 'Frying Pans', ['All-Clad D3 10" frying pan', 'Tefal non-stick 28cm']),
  kind: 'family',
};

describe('groupKitByEquipment', () => {
  it('nests a linked accessory under its appliance, however the words are spelled', () => {
    // The point of the link: "steam basket" shares no word with "Cosori 5L Rice
    // Cooker" and is not the stored name of any of its accessories either, so
    // nothing read off the words could ever reach it. The link answers regardless.
    const kit = [
      linked('Cosori 5L Rice Cooker', 'eq-cosori'),
      linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ steam basket',
    ]);
  });

  it('does not depend on stored order for which linked entry heads', () => {
    const kit = [
      linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
      linked('Cosori 5L Rice Cooker', 'eq-cosori'),
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ steam basket',
    ]);
  });

  it('orders a group by stored position, not by the order the accessories linked', () => {
    const kit = [
      linked('blender jug', 'eq-magimix', 'eq-magimix-acc-1'),
      linked('Magimix Cook Expert', 'eq-magimix'),
      linked('the cocotte', 'eq-magimix', 'eq-magimix-acc-0'),
    ];
    expect(lines(groupKitByEquipment(kit, [MAGIMIX]))).toEqual([
      'Magimix Cook Expert',
      '  ↳ blender jug',
      '  ↳ the cocotte',
    ]);
  });

  it('gives a linked accessory its own row when the appliance is not in the kit', () => {
    // No appliance is ever INVENTED as a heading: promoting a whole rice cooker to
    // a row because the recipe wants its basket asks for kit nobody called for.
    const kit = [linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'), entry('colander')];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual(['steam basket', 'colander']);
  });

  it('never nests one linked accessory under another when no entry names the appliance', () => {
    // The stated boundary (CLAUDE.md rule 12): the same item CAN still head two
    // top-level rows, and deliberately does. Nesting the jug under the pot would
    // say the jug is part of the pot.
    const kit = [
      linked('the cocotte', 'eq-magimix', 'eq-magimix-acc-0'),
      linked('blender jug', 'eq-magimix', 'eq-magimix-acc-1'),
    ];
    expect(lines(groupKitByEquipment(kit, [MAGIMIX]))).toEqual(['the cocotte', 'blender jug']);
  });

  it('attaches to the FIRST mention when one appliance is linked twice', () => {
    // A machine is not an accessory of itself, so a second line naming it keeps its
    // own row — and the accessory goes to one head, never both, which is what the
    // one-line-per-entry property below rests on.
    const kit = [
      linked('Cosori 5L Rice Cooker', 'eq-cosori'),
      linked('the rice cooker', 'eq-cosori'),
      linked('rice spoon', 'eq-cosori', 'eq-cosori-acc-0'),
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ rice spoon',
      'the rice cooker',
    ]);
  });

  it('never makes a family member an attachment of another pan', () => {
    // The defect in one line. A kit holding "frying pan" and the All-Clad read
    // "frying pan — with the All-Clad D3 10\" frying pan", as if one pan were a
    // part of the other. A family is not an appliance with parts.
    const kit = [entry('frying pan'), linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0')];
    expect(lines(groupKitByEquipment(kit, [FRYING_PANS]))).toEqual(['frying pan', 'the All-Clad']);
  });

  it('keeps a family member its own row even when the family itself is named', () => {
    // The sharper case: the family DOES head a row, so an `equipment`-kind item
    // would nest here. `kind` is picking presentation and nothing else.
    const kit = [
      linked('Frying Pans', 'eq-pans'),
      linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0'),
      linked('the Tefal', 'eq-pans', 'eq-pans-acc-1'),
    ];
    expect(lines(groupKitByEquipment(kit, [FRYING_PANS]))).toEqual([
      'Frying Pans',
      'the All-Clad',
      'the Tefal',
    ]);
  });

  it('never lets a family member anchor another entry beneath it', () => {
    const kit = [linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0'), entry('Tefal non-stick 28cm')];
    expect(lines(groupKitByEquipment(kit, [FRYING_PANS]))).toEqual([
      'the All-Clad',
      'Tefal non-stick 28cm',
    ]);
  });

  // ── An unlinked entry is a flat row (issue #1465, Phase 4) ─────────────────
  //
  // These three are what goes red if either word pass is ever put back. Each uses
  // words the deleted passes DID group: the owning item's leading word plus an
  // accessory's name (pass one), and a bare label spelled exactly like an
  // accessory's stored name beside its appliance (pass two).

  it('leaves a bare accessory name flat beside the appliance it belongs to', () => {
    // Pass two's case, now ungrouped: "Rice Spoon" IS the stored name of one of
    // this cooker's accessories and the cooker heads a row, and it still does not
    // nest. Only a link nests anything.
    const kit = [entry('Cosori 5L Rice Cooker'), entry('Rice Spoon'), entry('sieve')];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      'Rice Spoon',
      'sieve',
    ]);
  });

  it('leaves a prefixed accessory label flat beside its appliance', () => {
    // Pass one's case, now ungrouped, in both orders — the #1182 pair.
    for (const kit of [
      [entry('Magimix Cook Expert'), entry('Magimix Cocotte Slow Cook Pot')],
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Magimix Cook Expert')],
    ]) {
      expect(lines(groupKitByEquipment(kit, [MAGIMIX]))).toEqual(kit.map((e) => e.label));
    }
  });

  it('never lets an unlinked row anchor a LINKED accessory either', () => {
    // The mixed case a half-re-run library produces: the appliance line was never
    // relinked, the accessory line was. The accessory keeps its own row rather than
    // filing itself under a head that resolves to nothing.
    const kit = [
      entry('Cosori 5L Rice Cooker'),
      linked('rice spoon', 'eq-cosori', 'eq-cosori-acc-0'),
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      'rice spoon',
    ]);
  });

  it('reads a link that no longer answers to anything as an unlinked flat row', () => {
    // Delete the item, or one of its entries, and every recipe pointing at it reads
    // as an unlinked label — which since Phase 4 means a flat row. That is the whole
    // degradation story: no cleanup job, and nothing written back to a recipe.
    const kit = [
      {
        label: 'Cosori 5L Rice Cooker',
        stepIds: [],
        equipment: { itemId: 'eq-gone', accessoryId: null },
      },
      { label: 'Rice Spoon', stepIds: [], equipment: { itemId: 'eq-cosori', accessoryId: 'nope' } },
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      'Rice Spoon',
    ]);
  });

  it('returns a flat list when the manifest is empty or has not loaded yet', () => {
    // A cold load paints before the manifest lands. Flat is the correct reading of
    // "nothing is known to be owned", not a degraded one — and a link resolves to
    // nothing against an empty manifest just as a word does.
    const kit = [
      linked('Cosori 5L Rice Cooker', 'eq-cosori'),
      linked('rice spoon', 'eq-cosori', 'eq-cosori-acc-0'),
    ];
    expect(lines(groupKitByEquipment(kit, []))).toEqual(['Cosori 5L Rice Cooker', 'rice spoon']);
  });

  it('returns nothing for an empty kit', () => {
    expect(groupKitByEquipment([], [RICE_COOKER])).toEqual([]);
  });

  it('renders every entry exactly once, whatever the grouping — so the tab count holds', () => {
    // The property the Equipment tab's count rests on. Asserted over every kit in
    // this file at once, because the way this breaks is a later change adding a
    // THIRD disposition — dropped, or nested under two heads — that one
    // hand-written case would not happen to cover.
    const kits: RecipeKitEntryDoc[][] = [
      [
        linked('Cosori 5L Rice Cooker', 'eq-cosori'),
        linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
      ],
      [
        linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
        linked('Cosori 5L Rice Cooker', 'eq-cosori'),
      ],
      [
        linked('blender jug', 'eq-magimix', 'eq-magimix-acc-1'),
        linked('Magimix Cook Expert', 'eq-magimix'),
        linked('the cocotte', 'eq-magimix', 'eq-magimix-acc-0'),
      ],
      [
        linked('Cosori 5L Rice Cooker', 'eq-cosori'),
        linked('the rice cooker', 'eq-cosori'),
        linked('rice spoon', 'eq-cosori', 'eq-cosori-acc-0'),
      ],
      [entry('frying pan'), linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0')],
      [linked('Frying Pans', 'eq-pans'), linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0')],
      // Unlinked entries, including every shape the deleted word passes used to
      // group: all flat, and still exactly one row each.
      [entry('Cosori 5L Rice Cooker'), entry('Rice Spoon'), entry('sieve')],
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Magimix Cook Expert')],
      [entry('Oven Sheet Pan'), entry('Wire Oven Rack')],
      // A link nothing answers to falls back to a flat row, so it is still exactly
      // one row.
      [linked('Rice Spoon', 'eq-gone'), entry('Cosori 5L Rice Cooker')],
    ];
    const manifest = [RICE_COOKER, ANOVA, MAGIMIX, FRYING_PANS];

    for (const kit of kits) {
      const rendered = lines(groupKitByEquipment(kit, manifest));
      expect(rendered).toHaveLength(kit.length);
      expect(rendered.map((line) => line.replace('  ↳ ', '')).sort()).toEqual(
        kit.map((e) => e.label).sort(),
      );
    }
  });
});
