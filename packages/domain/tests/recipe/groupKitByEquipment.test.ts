import { describe, it, expect } from 'vitest';
import { groupKitByEquipment } from '@salt/domain';
import type { EquipmentItem, KitEquipmentGroup } from '@salt/domain';
import type { RecipeKitEntryDoc } from '@salt/domain/schemas';

// Accessories under their appliance (issue #1140).
//
// Every kit list below is real staging output (2026-08-31) or a collision the
// manifest genuinely makes possible — the point of the query is that it behaves on
// the library that exists, not on a shape invented to make it look good.
//
// Four of these cases are the safety properties the design rests on, and each is
// written so it goes RED if the guard is removed rather than merely passing today:
//   • an accessory whose appliance is absent is never nested (and never invents it);
//   • two appliances owning the same accessory name nest nothing;
//   • every entry appears exactly once, so the tab's count stays `kit.length`;
//   • which entry HEADS a row never depends on stored order (#1182), so every case
//     that could turn on it is written in both orders.

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

// The four appliances the staging cases below name, with the accessory names the
// manifest actually stores for them.
const RICE_COOKER = item('eq-cosori', 'Cosori 5L Rice Cooker', ['Rice Spoon', 'Measuring Cup']);
const HAND_BLENDER = item('eq-ninja', 'Ninja Foodi 3-in-1 Hand Blender, Mixer & Chopper CI100UK', [
  'Hand Blender Attachment',
  'Chopper Bowl',
]);
const ANOVA = item('eq-anova', 'Anova Precision Oven', ['Oven Sheet Pan', 'Wire Oven Rack']);
const SAGE_Q = item('eq-sage-q', 'Sage The Super Q', ['Spatula', 'Tamper']);

// A FAMILY, as the live manifest carries it since #1373: members that share not
// one word with the family's own name, which is why no rule over the words can
// find them and why #1465 records the link instead.
const FRYING_PANS: EquipmentItem = {
  ...item('eq-pans', 'Frying Pans', ['All-Clad D3 10" frying pan', 'Tefal non-stick 28cm']),
  kind: 'family',
};
// The prefixed spelling issue #1182 is about. `resolveEquipmentItem`'s header names
// this exact pair as a label the kit flow is licensed to write, and both spellings
// resolve to this one item — which is why pass one had to stop making both heads.
const MAGIMIX = item('eq-magimix', 'Magimix Cook Expert', ['Cocotte Slow Cook Pot', 'Blender Jug']);

describe('groupKitByEquipment', () => {
  it('folds a bare accessory name under the appliance beside it', () => {
    // Staging: `['sieve', 'Cosori 5L Rice Cooker', 'Rice Spoon']`. "Rice Spoon"
    // carries no maker, so `resolveEquipmentItem` refuses it outright — which is
    // correct and stays correct; the second pass is what reads it here.
    const groups = groupKitByEquipment(
      [entry('sieve'), entry('Cosori 5L Rice Cooker'), entry('Rice Spoon')],
      [RICE_COOKER, ANOVA],
    );

    expect(lines(groups)).toEqual(['sieve', 'Cosori 5L Rice Cooker', '  ↳ Rice Spoon']);
  });

  it('folds an accessory under a long product name the label only partly repeats', () => {
    // Staging: the Ninja's kit label is the full catalogue name, model number and
    // all. Pass one resolves it; pass two then has a head to attach to.
    const groups = groupKitByEquipment(
      [
        entry('tall glass jar'),
        entry('Ninja Foodi 3-in-1 Hand Blender, Mixer & Chopper CI100UK'),
        entry('Hand Blender Attachment'),
      ],
      [HAND_BLENDER, RICE_COOKER],
    );

    expect(lines(groups)).toEqual([
      'tall glass jar',
      'Ninja Foodi 3-in-1 Hand Blender, Mixer & Chopper CI100UK',
      '  ↳ Hand Blender Attachment',
    ]);
  });

  it('never nests an accessory whose appliance the recipe did not ask for', () => {
    // Staging's Baked Camembert: sheet pan and oven rack with no Anova anywhere.
    // The list's job is to say what to get OUT — promoting a whole steam oven to a
    // heading because the recipe wants a baking tray is a worse answer than a flat
    // list. Both stay top-level, and NO oven appears.
    const groups = groupKitByEquipment(
      [
        entry('small frying pan'),
        entry('wooden spoon'),
        entry('sharp knife'),
        entry('Oven Sheet Pan'),
        entry('Wire Oven Rack'),
        entry('spoon'),
      ],
      [ANOVA, RICE_COOKER],
    );

    expect(lines(groups)).toEqual([
      'small frying pan',
      'wooden spoon',
      'sharp knife',
      'Oven Sheet Pan',
      'Wire Oven Rack',
      'spoon',
    ]);
    expect(lines(groups).some((line) => line.includes('Anova'))).toBe(false);
  });

  it('nests nothing when two appliances present in this kit own the same accessory name', () => {
    // The manifest really does put a "Measuring Cup" on the rice cooker; give a
    // second appliance in the same kit one too and the word says nothing. Guessing
    // one of them is worse than an unindented line.
    const rival = item('eq-rival', 'Kenwood Chef', ['Measuring Cup']);
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('Kenwood Chef'), entry('Measuring Cup')],
      [RICE_COOKER, rival],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', 'Kenwood Chef', 'Measuring Cup']);
  });

  it('still nests when the rival owner is NOT in this kit — the tie has to be live', () => {
    // The same collision, with only one of the two appliances actually called for.
    // Condition 3 is what makes the ambiguity local: an item nobody asked for
    // cannot make a word ambiguous.
    const rival = item('eq-rival', 'Kenwood Chef', ['Measuring Cup']);
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('Measuring Cup')],
      [RICE_COOKER, rival],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', '  ↳ Measuring Cup']);
  });

  it('leaves a generic word alone when its owning appliance is absent', () => {
    // "Spatula" is an accessory of the Sage The Super Q in the real manifest. A
    // recipe saying "spatula" beside a rice cooker must not file itself under the
    // blender — this is the case condition 3 exists for, and it is why conditions
    // 1-2 are safe to have at all.
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('spatula')],
      [RICE_COOKER, SAGE_Q],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', 'spatula']);
  });

  it('matches the accessory name EXACTLY, never by containment or prefix', () => {
    // "Sheet Pan" is a substring of the Anova's "Oven Sheet Pan" and must not find
    // it; containment is precisely the loosening `resolveEquipmentItem` refuses,
    // and the narrow second pass does not reintroduce it by the back door.
    const groups = groupKitByEquipment(
      [entry('Anova Precision Oven'), entry('sheet pan'), entry('Oven Sheet Pan Liner')],
      [ANOVA],
    );

    expect(lines(groups)).toEqual(['Anova Precision Oven', 'sheet pan', 'Oven Sheet Pan Liner']);
  });

  it('folds case, punctuation and plurals through the shared normaliser', () => {
    // `normaliseName` is the one normaliser both sides use, so "rice spoons" and
    // "RICE SPOON!" are the same word as far as this is concerned — nothing here
    // hand-rolls case or plural handling.
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('RICE SPOONS!')],
      [RICE_COOKER],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', '  ↳ RICE SPOONS!']);
  });

  it('nests an accessory named BEFORE its appliance', () => {
    // Stored order decides where the HEADS go; it does not decide what belongs to
    // what. The flow has no rule about listing an appliance before its bits.
    const groups = groupKitByEquipment(
      [entry('Rice Spoon'), entry('Cosori 5L Rice Cooker')],
      [RICE_COOKER],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', '  ↳ Rice Spoon']);
  });

  // Issue #1182. `resolveEquipmentItem` resolves BOTH of these to the Magimix — the
  // prefixed accessory spelling is one of the two its header names — so pass one saw
  // two genuine resolutions and made two heads out of them, drawing the same machine
  // twice with the same picture. These five cases are what pins the fix.
  it.each([
    ['appliance first', ['Magimix Cook Expert', 'Magimix Cocotte Slow Cook Pot']],
    ['accessory first', ['Magimix Cocotte Slow Cook Pot', 'Magimix Cook Expert']],
  ])(
    'nests a PREFIXED accessory under its appliance, whichever order they are stored in (%s)',
    (_name, labels) => {
      // The order-independence is the point, not a bonus. The reverted attempt during
      // #1179's review nested whatever resolved second under whatever resolved first,
      // so "accessory first" rendered the MACHINE indented and muted under its own
      // pot — a false relationship, which is worse than the missing one it replaced.
      const groups = groupKitByEquipment(labels.map(entry), [MAGIMIX, RICE_COOKER]);

      expect(lines(groups)).toEqual(['Magimix Cook Expert', '  ↳ Magimix Cocotte Slow Cook Pot']);
    },
  );

  it('keeps a prefixed accessory top-level when its appliance is not in the kit', () => {
    // The same guard pass two has, on pass one's side: the appliance heads the row
    // or there is no row to head. Promoting a whole Magimix to a heading because the
    // recipe wants its pot invents kit the cook was never asked for.
    const groups = groupKitByEquipment(
      [entry('Magimix Cocotte Slow Cook Pot'), entry('sharp knife')],
      [MAGIMIX, RICE_COOKER],
    );

    expect(lines(groups)).toEqual(['Magimix Cocotte Slow Cook Pot', 'sharp knife']);
  });

  it('keeps two prefixed accessories flat when neither names the appliance', () => {
    // The stated boundary of the fix (CLAUDE.md rule 12): the same item CAN still
    // appear on two top-level rows here, and deliberately does. Nesting the jug
    // under the pot would say the jug is part of the pot, and the appliance that
    // actually owns both is not in the kit to head them.
    const groups = groupKitByEquipment(
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Magimix Blender Jug')],
      [MAGIMIX],
    );

    expect(lines(groups)).toEqual(['Magimix Cocotte Slow Cook Pot', 'Magimix Blender Jug']);
  });

  it('orders a mixed group by stored position, not by which pass nested it', () => {
    // A bare accessory (pass two) and a prefixed one (pass one) under one head. The
    // rows read in the order the flow wrote them, not in pass order.
    const groups = groupKitByEquipment(
      [entry('Magimix Blender Jug'), entry('Magimix Cook Expert'), entry('Cocotte Slow Cook Pot')],
      [MAGIMIX],
    );

    expect(lines(groups)).toEqual([
      'Magimix Cook Expert',
      '  ↳ Magimix Blender Jug',
      '  ↳ Cocotte Slow Cook Pot',
    ]);
  });

  // Reproduced against PR #1186's review: a bare accessory (pass two) reached an
  // accessory-form top-level row through `headOfItem`, even though that row itself
  // never named the appliance — nesting a jug under a pot, or a pot under itself.
  // `headOfItem` only registers a row that `namesItemItself`, so pass two now
  // finds no owner and every row here stays flat, matching the boundary above.
  it('never nests a bare accessory under an accessory-form row when no entry names the appliance', () => {
    const groups = groupKitByEquipment(
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Blender Jug')],
      [MAGIMIX],
    );

    expect(lines(groups)).toEqual(['Magimix Cocotte Slow Cook Pot', 'Blender Jug']);
  });

  it('never nests a prefixed accessory under itself when no entry names the appliance', () => {
    const groups = groupKitByEquipment(
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Cocotte Slow Cook Pot')],
      [MAGIMIX],
    );

    expect(lines(groups)).toEqual(['Magimix Cocotte Slow Cook Pot', 'Cocotte Slow Cook Pot']);
  });

  it('returns a flat list when the manifest is empty or has not loaded yet', () => {
    // A cold load paints before the manifest lands. Flat is the correct reading of
    // "nothing is known to be owned", not a degraded one.
    const groups = groupKitByEquipment([entry('Cosori 5L Rice Cooker'), entry('Rice Spoon')], []);

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', 'Rice Spoon']);
  });

  it('returns nothing for an empty kit', () => {
    expect(groupKitByEquipment([], [RICE_COOKER])).toEqual([]);
  });

  it('attaches to the FIRST mention when one appliance is named twice', () => {
    // Not something the flow produces, but nothing forbids it either, and the
    // alternative — the same accessory drawn under both mentions — would break the
    // one-line-per-entry property the tab count rests on.
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('Cosori Rice Cooker'), entry('Rice Spoon')],
      [RICE_COOKER],
    );

    expect(lines(groups)).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ Rice Spoon',
      'Cosori Rice Cooker',
    ]);
  });

  it('leaves a label that normalises to nothing as its own row', () => {
    // `normaliseName` strips bare and digit-prefixed numbers, so a kit entry of
    // "500g" folds to the empty string. It is still a line the flow wrote and still
    // gets rendered; it simply cannot name an accessory.
    const groups = groupKitByEquipment(
      [entry('Cosori 5L Rice Cooker'), entry('500g'), entry('Rice Spoon')],
      [RICE_COOKER],
    );

    expect(lines(groups)).toEqual(['Cosori 5L Rice Cooker', '  ↳ Rice Spoon', '500g']);
  });

  it('treats an item carrying no accessories array as owning none', () => {
    // `EquipmentItemSchema.accessories` has a `.default([])`, so a Firestore read
    // always has the array — but the shape reaches this query from test fixtures and
    // hand-built objects too, and `resolveEquipmentItem` carries the identical guard
    // for the identical reason. The cast is what a JS caller can genuinely hand over.
    const bare = {
      id: 'eq-bare',
      schemaVersion: 1,
      name: 'Sage Pizzaiolo',
      rules: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as EquipmentItem;
    const groups = groupKitByEquipment([entry('Sage Pizzaiolo'), entry('Rice Spoon')], [bare]);

    expect(lines(groups)).toEqual(['Sage Pizzaiolo', 'Rice Spoon']);
  });

  it('renders every entry exactly once, whatever the grouping — so the tab count holds', () => {
    // The property the Equipment tab's `count={kit.length}` rests on. Asserted over
    // every kit in this file at once, because the way this breaks is a later change
    // adding a THIRD disposition — dropped, or nested under two heads — that one
    // hand-written case would not happen to cover.
    const kits: RecipeKitEntryDoc[][] = [
      [entry('sieve'), entry('Cosori 5L Rice Cooker'), entry('Rice Spoon')],
      [entry('Cosori 5L Rice Cooker'), entry('Kenwood Chef'), entry('Measuring Cup')],
      [entry('Oven Sheet Pan'), entry('Wire Oven Rack')],
      [entry('Rice Spoon'), entry('Cosori 5L Rice Cooker'), entry('Measuring Cup')],
      [entry('Anova Precision Oven'), entry('Oven Sheet Pan'), entry('Wire Oven Rack')],
      // #1182, in both orders — the pass-one nesting is a THIRD disposition, and
      // this property is what says it did not lose or duplicate an entry.
      [entry('Magimix Cook Expert'), entry('Magimix Cocotte Slow Cook Pot')],
      [entry('Magimix Cocotte Slow Cook Pot'), entry('Magimix Cook Expert')],
      [entry('Magimix Blender Jug'), entry('Magimix Cook Expert'), entry('Cocotte Slow Cook Pot')],
      // …and the LINK path (issue #1465), which is a fourth and fifth disposition:
      // a linked accessory that nests, and a family member that never does. Both
      // orders again, for the same #1182 reason.
      [
        linked('Cosori 5L Rice Cooker', 'eq-cosori'),
        linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
      ],
      [
        linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'),
        linked('Cosori 5L Rice Cooker', 'eq-cosori'),
      ],
      [entry('frying pan'), linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0')],
      [linked('Frying Pans', 'eq-pans'), linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0')],
      // A link nothing answers to falls back to the words, so it is still exactly
      // one row.
      [linked('Rice Spoon', 'eq-gone'), entry('Cosori 5L Rice Cooker')],
    ];
    const manifest = [
      RICE_COOKER,
      HAND_BLENDER,
      ANOVA,
      SAGE_Q,
      MAGIMIX,
      item('eq-rival', 'Kenwood Chef', ['Measuring Cup']),
      FRYING_PANS,
    ];

    for (const kit of kits) {
      const rendered = lines(groupKitByEquipment(kit, manifest));
      expect(rendered).toHaveLength(kit.length);
      expect(rendered.map((line) => line.replace('  ↳ ', '')).sort()).toEqual(
        kit.map((e) => e.label).sort(),
      );
    }
  });

  // ── The link path (issue #1465) ────────────────────────────────────────────

  it('nests a linked accessory under its appliance, however the words are spelled', () => {
    // The point of the link: "steam basket" shares no word with "Cosori 5L Rice
    // Cooker", so neither word pass can reach it — pass one needs the maker's
    // word, pass two needs the accessory's exact stored name ("Steam Basket" is
    // not on this fixture's rice cooker at all). The link answers regardless.
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

  it('gives a linked accessory its own row when the appliance is not in the kit', () => {
    const kit = [linked('steam basket', 'eq-cosori', 'eq-cosori-acc-0'), entry('colander')];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual(['steam basket', 'colander']);
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

  it('falls back to the words when a link no longer answers to anything', () => {
    // Delete the item and every recipe pointing at it reads exactly as an
    // unlinked label does — which here means pass two still nests it, because the
    // words happen to be the accessory's stored name and the cooker heads a row.
    const kit = [
      {
        label: 'Cosori 5L Rice Cooker',
        stepIds: [],
        equipment: { itemId: 'eq-gone', accessoryId: null },
      },
      { label: 'Rice Spoon', stepIds: [], equipment: { itemId: 'eq-gone', accessoryId: 'nope' } },
    ];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ Rice Spoon',
    ]);
  });

  it('leaves a kit with no links grouped exactly as it was', () => {
    // The back-compat promise: a recipe not yet re-run looks the same.
    const kit = [entry('Cosori 5L Rice Cooker'), entry('Rice Spoon'), entry('sieve')];
    expect(lines(groupKitByEquipment(kit, [RICE_COOKER]))).toEqual([
      'Cosori 5L Rice Cooker',
      '  ↳ Rice Spoon',
      'sieve',
    ]);
  });

  it('never lets a family member anchor another entry beneath it', () => {
    // Condition 3 of pass two, restated for the link path: an accessory-form label
    // must not file itself under a row that is itself a member of a family.
    const kit = [linked('the All-Clad', 'eq-pans', 'eq-pans-acc-0'), entry('Tefal non-stick 28cm')];
    expect(lines(groupKitByEquipment(kit, [FRYING_PANS]))).toEqual([
      'the All-Clad',
      'Tefal non-stick 28cm',
    ]);
  });
});
