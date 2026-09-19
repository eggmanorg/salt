import { describe, expect, it } from 'vitest';
import {
  kitchenToolForKitLabel,
  namesManifestAccessory,
  resolveKitchenTool,
} from '../../src/index.js';
import type { EquipmentItem } from '../../src/index.js';
import type { KitchenToolDoc } from '../../src/schemas/index.js';

// A named part of a machine never borrows an ordinary object's drawing (issue
// #1460, folded into #1465).
//
// DRIVEN FROM A FIXTURE, NOT FROM LIVE DATA, as #1460 asks: production carries 24
// of the 64 seeded tools, so half the sharp cases are latent there and fire only
// once the vocabulary is filled in. The vocabulary below is the sharp reading —
// the rows of the real seed table that the real accessory names collide with —
// and the manifest below is the shape of `equipmentManifest/current` as read from
// staging on 2026-09-18, trimmed to the records the table needs.
//
// Every "not a …" row of #1460's case table was RED before the change and is
// green here; every "unchanged" row is green on both sides. That is the whole
// point of listing them in one table rather than as prose.

const tool = (id: string, label: string, matchers: string[] = []): KitchenToolDoc => ({
  id,
  schemaVersion: 1,
  label,
  matchers,
  thumbnail: null,
  createdAt: '',
  updatedAt: '',
});

/** The seeded rows the accessory names actually collide with. */
const VOCABULARY: readonly KitchenToolDoc[] = [
  tool('mixing-bowl', 'Mixing bowl', ['bowl', 'pudding basin']),
  tool('small-bowl', 'Small bowl', ['ramekin', 'prep bowl', 'little bowl']),
  tool('plate', 'Plate', ['dish', 'platter']),
  tool('sieve', 'Sieve', ['sifter', 'mesh strainer', 'chinois']),
  tool('stockpot', 'Stockpot', ['pot']),
  tool('saucepan', 'Saucepan', ['pan']),
  tool('frying-pan', 'Frying pan', ['skillet', 'non-stick pan', 'sauté pan']),
  tool('chefs-knife', "Chef's knife", ['knife']),
  tool('whisk', 'Whisk', ['egg whisk']),
  tool('spatula', 'Spatula', ['fish slice', 'turner']),
  tool('ladle', 'Ladle', ['soup ladle']),
  tool('kitchen-scales', 'Kitchen scales', ['scales']),
  tool('wire-rack', 'Wire rack', ['rack']),
  tool('baking-tray', 'Baking tray', ['tray', 'baking sheet', 'sheet pan']),
  tool('rice-paddle', 'Rice paddle', ['rice spoon', 'shamoji']),
  tool('food-processor', 'Food processor'),
  tool('wooden-spoon', 'Wooden spoon', ['spoon']),
];

const item = (
  id: string,
  name: string,
  accessories: readonly string[],
  kind: 'equipment' | 'family' = 'equipment',
): EquipmentItem => ({
  id,
  schemaVersion: 1,
  name,
  kind,
  accessories: accessories.map((accessoryName, i) => ({
    id: `${id}-a${i}`,
    name: accessoryName,
    owned: true,
    included: true,
    note: '',
    borrowedPicture: null,
  })),
  rules: [],
  note: '',
  environment: null,
  borrowedPicture: null,
  updatedAt: '',
});

const MANIFEST: readonly EquipmentItem[] = [
  item('magimix', 'Magimix Cook Expert', [
    'Thermo Bowl',
    'Food Processor Bowls',
    'Egg Whisk',
    'Kitchen Scales',
    'Cocotte Slow Cook Pot',
  ]),
  item('kenwood-chef', 'Kenwood Chef KVC3100S', ['Stainless Steel Bowl', 'Glass Mixing Bowl']),
  item('kenwood-go', 'Kenwood MultiPro Go', ['Knife Blade', 'Main Bowl']),
  item('ninja', 'Ninja Foodi CI100UK', ['Chopper Bowl']),
  item('bamix', 'Bamix SwissLine M200', ['Whisk Disc']),
  item('moulin', 'Louis Tellier Moulin', ['2.5mm Sieve Disc']),
  item('ham-press', 'Browin Ham Maker', ['Pressure plate with spring', 'Water jacket pot']),
  item('amzchef', 'AMZCHEF 4-in-1 grill', ['Grill plate']),
  item('pizzaiolo', 'Sage Pizzaiolo', ['Deep Pan Pizza Pan', 'Pizza Peel']),
  item('cosori', 'Cosori 5L Rice Cooker', [
    'Non-stick Inner Pot',
    'Steam Basket',
    'Rice Spoon',
    'Soup Ladle',
  ]),
  item('anova-oven', 'Anova Precision Oven', ['Oven Sheet Pan', 'Wire Oven Rack']),
  item('super-q', 'Sage The Super Q', ['Spatula']),
  item('pans', 'Frying Pans', ['Tefal non-stick 28cm'], 'family'),
];

const drawn = (label: string): string | null =>
  kitchenToolForKitLabel(label, VOCABULARY, MANIFEST)?.id ?? null;

describe('kitchenToolForKitLabel — #1460’s case table', () => {
  it.each([
    // A machine part never takes a generic object's drawing.
    ['Thermo Bowl'],
    ['Chopper Bowl'],
    ['Main Bowl'],
    ['Stainless Steel Bowl'],
    ['Food Processor Bowls'],
    ['Grill plate'],
    ['2.5mm Sieve Disc'],
    ['Pressure plate with spring'],
    ['Whisk Disc'],
    ['Cocotte Slow Cook Pot'],
    ['Non-stick Inner Pot'],
    ['Water jacket pot'],
    ['Knife Blade'],
    ['Deep Pan Pizza Pan'],
  ])('refuses a generic drawing for %s', (label) => {
    // RED before the change: every one of these resolved to a tool.
    expect(resolveKitchenTool(label, VOCABULARY)).not.toBeNull();
    expect(drawn(label)).toBeNull();
  });

  it.each([
    ['Egg Whisk', 'whisk'],
    ['Kitchen Scales', 'kitchen-scales'],
    ['Glass Mixing Bowl', 'mixing-bowl'],
    ['Spatula', 'spatula'],
    ['Rice Spoon', 'rice-paddle'],
    ['Oven Sheet Pan', 'baking-tray'],
    // #1460's row is "Soup Ladle, Rice Spoon, Oven Sheet Pan" — all three
    // "unchanged either way". Left off this list once, which let a false PR claim
    // ("every row except Egg Whisk") through review undetected.
    ['Soup Ladle', 'ladle'],
  ])('leaves %s drawing the %s it draws today', (label, id) => {
    expect(drawn(label)).toBe(id);
  });

  it.each([
    ['large mixing bowl', 'mixing-bowl'],
    ['small saucepan', 'saucepan'],
    ['sharp knife', 'chefs-knife'],
    ['large frying pan', 'frying-pan'],
    ['wooden spoon', 'wooden-spoon'],
  ])('never touches an ordinary label: %s still draws the %s', (label, id) => {
    // The gate is the manifest. A label that is not one of your accessory names
    // is handed straight to `resolveKitchenTool`, unchanged and unexamined.
    expect(drawn(label)).toBe(id);
    expect(resolveKitchenTool(label, VOCABULARY)?.id).toBe(id);
  });

  it('leaves a label nothing knows undrawn, exactly as before', () => {
    expect(drawn('tagine')).toBeNull();
    expect(drawn('steam basket')).toBeNull();
    expect(drawn('Universal Blade')).toBeNull();
  });

  it('draws Wire Oven Rack when the vocabulary names it, and not off "rack" alone', () => {
    // Called out in #1460 and worth keeping visible: production holds a curated
    // `kitchenTools` document called exactly "Wire Oven Rack", minted because the
    // accessory had nowhere else to go. Against the SEED vocabulary the label wins
    // only the bare matcher "rack" and is refused; add the curated row and it
    // draws again. Both readings are asserted so neither can change silently.
    expect(drawn('Wire Oven Rack')).toBeNull();
    const curated = [...VOCABULARY, tool('wire-oven-rack', 'Wire Oven Rack')];
    expect(kitchenToolForKitLabel('Wire Oven Rack', curated, MANIFEST)?.id).toBe('wire-oven-rack');
  });

  it('is exactly `resolveKitchenTool` when no manifest has loaded', () => {
    // The cold-load reading: with no items, no label can be an accessory name.
    for (const label of ['Thermo Bowl', 'Grill plate', 'large mixing bowl']) {
      expect(kitchenToolForKitLabel(label, VOCABULARY, [])?.id ?? null).toBe(
        resolveKitchenTool(label, VOCABULARY)?.id ?? null,
      );
    }
  });

  it('treats a name that normalises away entirely as naming nothing', () => {
    // A quantity that wandered into a container field — "500g", "2". It names no
    // accessory and never could, which is the same guard `unresolvedKitLabels`
    // states for the same reason.
    expect(namesManifestAccessory('500g', MANIFEST)).toBe(false);
    expect(namesManifestAccessory('Thermo Bowl', MANIFEST)).toBe(true);
  });

  it('degrades to “names nothing” for an item carrying no accessories array', () => {
    // Not hypothetical: the recipe page's own test fixtures build manifest items
    // as `{ id, name }`, and a throw here would take the whole Equipment tab down
    // rather than cost one picture. `resolveEquipmentItem` guards the same way.
    const partial = [{ id: 'x', name: 'Some machine' }] as unknown as EquipmentItem[];
    expect(namesManifestAccessory('Thermo Bowl', partial)).toBe(false);
    expect(kitchenToolForKitLabel('Thermo Bowl', VOCABULARY, partial)?.id).toBe('mixing-bowl');
  });

  it('matches an accessory name exactly, never by containment', () => {
    // "Sheet Pan" is not "Oven Sheet Pan" — `namesManifestAccessory` is exact on
    // the normalised name, never a prefix or substring match, so this is an
    // ordinary label and keeps the ordinary answer.
    expect(drawn('Sheet Pan')).toBe('baking-tray');
    // …and normalisation still folds case, punctuation and plurals, so a
    // carelessly typed accessory name is still recognised as one.
    expect(drawn('thermo bowls')).toBeNull();
  });
});
