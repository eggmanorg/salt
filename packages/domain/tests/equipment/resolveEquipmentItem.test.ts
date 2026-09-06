import { describe, it, expect } from 'vitest';
import { resolveEquipmentItem } from '../../src/index.js';
import type { EquipmentItem, Accessory } from '../../src/index.js';

// The display-time join from a kit label to the appliance this household owns
// (issue #954). Two properties carry the whole feature and both are asserted
// against the REAL staging manifest shape, because that is where the trap is: the
// household owns two mandolines and five things that answer to "food processor",
// so a generic word must never select one of them, and a branded name must never
// be beaten by the generic tool vocabulary that also matches its tail.
//
// ACCESSORIES ARE STORED UNDER THEIR ITEM, never as a standalone item — that is
// how `equipmentManifest/current` actually holds them (confirmed against
// staging), and it is why "Magimix Cocotte Slow Cook Pot" and "FoodSaver Fresh
// Container" below are accessories, not entries of their own. An earlier version
// of this fixture promoted them to top-level items — a shape the manifest never
// takes — which is how the flagship ordering test below passed while the real
// resolver returned null in production for both labels the issue named.

function accessory(name: string, owned = true): Accessory {
  return { id: `acc-${name}`, name, owned, included: owned };
}

function item(name: string, accessories: Accessory[] = []): EquipmentItem {
  return {
    id: `eq-${name}`,
    schemaVersion: 1,
    name,
    accessories,
    rules: [],
    environment: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

// The staging manifest's relevant slice, names and accessory nesting as they are
// actually stored.
const MANIFEST: EquipmentItem[] = [
  item('Magimix Cook Expert', [accessory('Cocotte Slow Cook Pot')]),
  item('Kenwood MultiPro Go FDP22.130GY'),
  item('Kenwood Chef KVC3100S Mary Berry Special Edition'),
  item("OXO Good Grips Chef's Mandoline Slicer 2.0"),
  item('Benriner BN-95W Wide Mandoline Slicer'),
  item('FoodSaver FFS005X Vacuum Sealer', [accessory('Fresh Container')]),
  item('Anova Precision Oven v2.0'),
  item('Anova Precision Cooker 3.0'),
];

describe('resolveEquipmentItem', () => {
  it('finds the item from its own name, verbatim', () => {
    // What the kit flow now writes: the manifest's spelling, capitalisation and
    // all. This is the common case and it must be exact, not fuzzy.
    expect(resolveEquipmentItem("OXO Good Grips Chef's Mandoline Slicer 2.0", MANIFEST)?.name).toBe(
      "OXO Good Grips Chef's Mandoline Slicer 2.0",
    );
    expect(resolveEquipmentItem('Magimix Cook Expert', MANIFEST)?.name).toBe('Magimix Cook Expert');
  });

  it('finds it from a shortened name that keeps the maker', () => {
    // A cook — or the model — writing the name from memory drops the middle.
    expect(resolveEquipmentItem('OXO Mandoline', MANIFEST)?.name).toBe(
      "OXO Good Grips Chef's Mandoline Slicer 2.0",
    );
    expect(resolveEquipmentItem('Kenwood MultiPro Go', MANIFEST)?.name).toBe(
      'Kenwood MultiPro Go FDP22.130GY',
    );
  });

  it('folds case, punctuation and plurals, as the tool resolver does', () => {
    expect(resolveEquipmentItem('  magimix cook expert  ', MANIFEST)?.name).toBe(
      'Magimix Cook Expert',
    );
    expect(resolveEquipmentItem('oxo good grips chefs mandolines', MANIFEST)?.name).toBe(
      "OXO Good Grips Chef's Mandoline Slicer 2.0",
    );
  });

  it('never matches a generic word against a branded name', () => {
    // THE ordering trap, and the reason equipment is resolved before tools rather
    // than after. "Magimix Cocotte Slow Cook Pot" contains the token "pot"; a
    // containment rule in either direction would hand the bare word "pot" a
    // specific appliance's picture.
    expect(resolveEquipmentItem('pot', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('slow cooker', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('large frying pan', MANIFEST)).toBeNull();
    // "container" is a real owned accessory's tail word (FoodSaver's "Fresh
    // Container"), which is exactly why it must still fail bare: the accessory
    // match requires the OWNING item's leading word too.
    expect(resolveEquipmentItem('container', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('food processor', MANIFEST)).toBeNull();
  });

  it('returns null for a generic class the household owns several of', () => {
    // Two mandolines, and neither stores the word — so the generic label names
    // nothing, which is exactly the answer. It falls through to `kitchenTools`,
    // where a mandoline pictogram lives.
    expect(resolveEquipmentItem('mandoline', MANIFEST)).toBeNull();
  });

  it('returns null rather than guessing when the maker owns two things', () => {
    // "Kenwood" and "Anova" each satisfy both halves against two items in the
    // real manifest (two Kenwoods, an Anova oven and an Anova cooker). A picture
    // chosen at random is worse than no picture — the #882 graceful-miss
    // contract.
    expect(resolveEquipmentItem('Kenwood', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('Anova', MANIFEST)).toBeNull();
  });

  it('rejects a label carrying a word the item does not have', () => {
    // Same maker, wrong machine.
    expect(resolveEquipmentItem('Kenwood MultiPro Chef', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('Magimix Cook Expert blender', MANIFEST)).toBeNull();
  });

  it('prefers an exact name over a longer one that contains it', () => {
    const items = [item('Magimix Cook Expert XL'), item('Magimix Cook Expert')];
    expect(resolveEquipmentItem('Magimix Cook Expert', items)?.name).toBe('Magimix Cook Expert');
  });

  it('returns null for an empty manifest, a blank label, or a label of digits', () => {
    expect(resolveEquipmentItem('Magimix Cook Expert', [])).toBeNull();
    expect(resolveEquipmentItem('   ', MANIFEST)).toBeNull();
    // `normaliseName` strips numeric tokens entirely, so this normalises to ''.
    expect(resolveEquipmentItem('500', MANIFEST)).toBeNull();
  });

  it('returns null rather than guessing when two items tie on an exact match (#1058)', () => {
    // `normaliseName` strips model numbers, so "OXO Good Grips 2.0" and "...
    // 3.0" both fold to "oxo good grip" — the same trap the staging manifest
    // hits for real ("OXO Good Grips Chef's Mandoline Slicer 2.0" is one
    // digit away from a hypothetical "... 3.0"). `.find` used to hand the
    // label to whichever tied item came first in the array; it must say
    // nothing instead.
    const items = [item('OXO Good Grips 2.0'), item('OXO Good Grips 3.0')];
    expect(resolveEquipmentItem('OXO Good Grips 2.0', items)).toBeNull();
  });

  it('resolves an owned accessory to the item that owns it', () => {
    // The two labels issue #954 names, and the two the fixture used to fabricate
    // as standalone items: both are accessories in the real manifest, named with
    // their owning item's leading word standing in for the maker. Neither has an
    // icon of its own — `equipmentIcons` is keyed by item id — so the owning
    // item is the correct identity to resolve to.
    expect(resolveEquipmentItem('Magimix Cocotte Slow Cook Pot', MANIFEST)?.name).toBe(
      'Magimix Cook Expert',
    );
    expect(resolveEquipmentItem('FoodSaver Fresh Container', MANIFEST)?.name).toBe(
      'FoodSaver FFS005X Vacuum Sealer',
    );
  });

  it('rejects an accessory name with no owning item word', () => {
    // The bare accessory name, with none of the owning item's words, is
    // indistinguishable from a generic label — it must not resolve.
    expect(resolveEquipmentItem('Cocotte Slow Cook Pot', MANIFEST)).toBeNull();
    expect(resolveEquipmentItem('Fresh Container', MANIFEST)).toBeNull();
  });

  it('rejects a label pairing the wrong item with a real accessory name', () => {
    // "Cocotte Slow Cook Pot" belongs to the Magimix, not the Kenwood — pairing
    // it with the wrong maker's word must not borrow the Kenwood's picture.
    expect(resolveEquipmentItem('Kenwood Cocotte Slow Cook Pot', MANIFEST)).toBeNull();
  });
});
