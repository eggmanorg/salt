import { describe, it, expect } from 'vitest';
import { groupItemsByAisle } from '@salt/domain';
import type { ShoppingListItem, FormDemand } from '@salt/domain';
import type { CanonInfo, AisleInfo } from '../../src/shoppingList/queries/groupItemsByAisle.js';

const NOW = '2026-01-01T00:00:00.000Z';

function makeItem(id: string, overrides: Partial<ShoppingListItem> = {}): ShoppingListItem {
  return {
    id,
    rawText: 'test item',
    notes: '',
    sources: [{ kind: 'manual' }],
    canonId: null,
    matchState: 'pending',
    checked: false,
    needsCheck: false,
    schemaVersion: 1 as const,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCanonMap(entries: CanonInfo[]): ReadonlyMap<string, CanonInfo> {
  return new Map(entries.map((c) => [c.id, c]));
}

const AISLES: AisleInfo[] = [
  { id: 'aisle-1', name: 'Produce', order: 0 },
  { id: 'aisle-2', name: 'Dairy', order: 1 },
  { id: 'aisle-3', name: 'Bakery', order: 2 },
];

describe('groupItemsByAisle — Other bucket routing', () => {
  it('routes pending items to Other with isPending=true', () => {
    const items = [makeItem('i1', { matchState: 'pending' })];
    const result = groupItemsByAisle(items, makeCanonMap([]), AISLES);
    expect(result.other.contributors).toHaveLength(1);
    expect(result.other.contributors[0]!.isPending).toBe(true);
    expect(result.aisles).toHaveLength(0);
  });

  it('routes failed items to Other with isPending=false', () => {
    const items = [makeItem('i1', { matchState: 'failed' })];
    const result = groupItemsByAisle(items, makeCanonMap([]), AISLES);
    expect(result.other.contributors).toHaveLength(1);
    expect(result.other.contributors[0]!.isPending).toBe(false);
  });

  it('routes needs_approval items with a valid aisle to the aisle (treated as matched)', () => {
    const items = [makeItem('i1', { matchState: 'needs_approval', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Beans', aisleId: 'aisle-1' }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.other.contributors).toHaveLength(0);
    expect(result.aisles[0]!.rows).toHaveLength(1);
  });

  it('routes needs_approval items with null aisleId to Other', () => {
    const items = [makeItem('i1', { matchState: 'needs_approval', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Beans', aisleId: null }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.other.contributors).toHaveLength(1);
  });

  it('routes stale-canon items (canonId not in map) to Other', () => {
    const items = [makeItem('i1', { matchState: 'matched', canonId: 'deleted-canon' })];
    const result = groupItemsByAisle(items, makeCanonMap([]), AISLES);
    expect(result.other.contributors).toHaveLength(1);
    expect(result.other.contributors[0]!.isPending).toBe(false);
  });

  it('routes matched items with null aisleId to Other', () => {
    const items = [makeItem('i1', { matchState: 'matched', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Beans', aisleId: null }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.other.contributors).toHaveLength(1);
  });

  // Issue #1149. Canon and `canonData/aisles` reach the page from two separate
  // listeners, so a canon pointing at an aisle the page does not (yet) hold is
  // reachable — and before this the item was returned in NO bucket at all, so
  // the row rendered nowhere.
  it('routes matched items whose aisleId is absent from `aisles` to Other', () => {
    const items = [makeItem('i1', { matchState: 'matched', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Soy Sauce', aisleId: 'aisle-unknown' }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.other.contributors.map((c) => c.item.id)).toEqual(['i1']);
    expect(result.other.contributors[0]!.isPending).toBe(false);
    expect(result.aisles).toHaveLength(0);
  });

  it('routes every matched item to Other when `aisles` is empty (aisles not yet loaded)', () => {
    const items = [makeItem('i1', { matchState: 'matched', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Soy Sauce', aisleId: 'aisle-1' }]);
    const result = groupItemsByAisle(items, canonMap, []);
    expect(result.other.contributors.map((c) => c.item.id)).toEqual(['i1']);
    expect(result.aisles).toHaveLength(0);
  });

  // The accounting pin for the bug above. Bounded to this input, not a proof for
  // all inputs: it asserts that across one list mixing every routing case —
  // pending, stale canon, null aisle, unknown aisle, known aisle and checked —
  // each item lands in exactly one of the three returned buckets.
  it('accounts for every item exactly once across other/aisles/checked', () => {
    const items = [
      makeItem('pending'),
      makeItem('stale', { matchState: 'matched', canonId: 'gone' }),
      makeItem('null-aisle', { matchState: 'matched', canonId: 'c-null' }),
      makeItem('unknown-aisle', { matchState: 'matched', canonId: 'c-unknown' }),
      makeItem('known-aisle', { matchState: 'matched', canonId: 'c-known' }),
      makeItem('done', { matchState: 'matched', canonId: 'c-known', checked: true }),
    ];
    const canonMap = makeCanonMap([
      { id: 'c-null', name: 'Beans', aisleId: null },
      { id: 'c-unknown', name: 'Soy Sauce', aisleId: 'aisle-unknown' },
      { id: 'c-known', name: 'Milk', aisleId: 'aisle-2' },
    ]);
    const result = groupItemsByAisle(items, canonMap, AISLES);

    const placed = [
      ...result.other.contributors.map((c) => c.item.id),
      ...result.aisles.flatMap((g) => g.rows.flatMap((r) => r.contributors.map((i) => i.id))),
      ...result.checked.contributors.map((i) => i.id),
    ];
    expect([...placed].sort()).toEqual([...items.map((i) => i.id)].sort());
  });
});

describe('groupItemsByAisle — aisle ordering', () => {
  it('places matched items in the correct aisle in canon order', () => {
    const items = [
      makeItem('i1', { matchState: 'matched', canonId: 'c-dairy' }),
      makeItem('i2', { matchState: 'matched', canonId: 'c-produce' }),
    ];
    const canonMap = makeCanonMap([
      { id: 'c-dairy', name: 'Milk', aisleId: 'aisle-2' },
      { id: 'c-produce', name: 'Apples', aisleId: 'aisle-1' },
    ]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles).toHaveLength(2);
    expect(result.aisles[0]!.aisleId).toBe('aisle-1');
    expect(result.aisles[1]!.aisleId).toBe('aisle-2');
  });

  it('omits aisles with no matching items', () => {
    const items = [makeItem('i1', { matchState: 'matched', canonId: 'c1' })];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Milk', aisleId: 'aisle-2' }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles).toHaveLength(1);
    expect(result.aisles[0]!.aisleId).toBe('aisle-2');
  });
});

describe('groupItemsByAisle — items within an aisle', () => {
  it('keeps duplicate-canon manual items as separate single rows (no collapsing)', () => {
    const items = [
      makeItem('i1', { matchState: 'matched', canonId: 'c1', rawText: 'heinz beans 4 tins' }),
      makeItem('i2', { matchState: 'matched', canonId: 'c1', rawText: 'baked beans 2 tins' }),
    ];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Baked Beans', aisleId: 'aisle-1' }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows).toHaveLength(2);
    expect(result.aisles[0]!.rows.every((r) => !r.combined)).toBe(true);
    expect(result.aisles[0]!.rows.map((r) => r.key)).toEqual(['i1', 'i2']);
  });

  it('sorts rows within an aisle alphabetically by matched canon name', () => {
    const items = [
      makeItem('i1', { matchState: 'matched', canonId: 'c-beans' }),
      makeItem('i2', { matchState: 'matched', canonId: 'c-apples' }),
      makeItem('i3', { matchState: 'matched', canonId: 'c-carrots' }),
    ];
    const canonMap = makeCanonMap([
      { id: 'c-beans', name: 'Beans', aisleId: 'aisle-1' },
      { id: 'c-apples', name: 'Apples', aisleId: 'aisle-1' },
      { id: 'c-carrots', name: 'Carrots', aisleId: 'aisle-1' },
    ]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows.map((r) => r.key)).toEqual(['i2', 'i1', 'i3']);
  });

  it('clusters rows matched to the same canon together, breaking ties by createdAt', () => {
    const items = [
      makeItem('i1', {
        matchState: 'matched',
        canonId: 'c-onions',
        rawText: 'red onions',
        createdAt: '2026-01-01T12:00:00.000Z',
      }),
      makeItem('i2', {
        matchState: 'matched',
        canonId: 'c-apples',
        rawText: 'granny smith',
        createdAt: '2026-01-01T10:00:00.000Z',
      }),
      makeItem('i3', {
        matchState: 'matched',
        canonId: 'c-onions',
        rawText: 'brown onions',
        createdAt: '2026-01-01T11:00:00.000Z',
      }),
    ];
    const canonMap = makeCanonMap([
      { id: 'c-onions', name: 'Onions', aisleId: 'aisle-1' },
      { id: 'c-apples', name: 'Apples', aisleId: 'aisle-1' },
    ]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    // Apples first (A < O); the two (manual) Onions rows cluster, oldest (i3) before i1.
    expect(result.aisles[0]!.rows.map((r) => r.key)).toEqual(['i2', 'i3', 'i1']);
  });
});

describe('groupItemsByAisle — combining recipe rows (#184)', () => {
  const recipeSource = (recipeId: string) => ({
    kind: 'recipe' as const,
    recipeId,
    servings: 2,
    label: recipeId,
  });
  const canonMap = makeCanonMap([{ id: 'c-onion', name: 'Onions', aisleId: 'aisle-1' }]);

  it('combines recipe-sourced items resolving to the same canon into one row', () => {
    const items = [
      makeItem('r1', {
        matchState: 'matched',
        canonId: 'c-onion',
        sources: [recipeSource('soup')],
        amount: 2,
        unit: 'g',
      }),
      makeItem('r2', {
        matchState: 'matched',
        canonId: 'c-onion',
        sources: [recipeSource('stew')],
        amount: 3,
        unit: 'g',
      }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows).toHaveLength(1);
    const row = result.aisles[0]!.rows[0]!;
    expect(row.combined).toBe(true);
    expect(row.key).toBe('canon:c-onion');
    expect(row.contributors).toHaveLength(2);
    expect(row.subtotals).toEqual([{ unit: 'g', amount: 5 }]);
  });

  it('never combines manual items, even with the same canon', () => {
    const items = [
      makeItem('m1', { matchState: 'matched', canonId: 'c-onion' }),
      makeItem('m2', { matchState: 'matched', canonId: 'c-onion' }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows).toHaveLength(2);
    expect(result.aisles[0]!.rows.every((r) => !r.combined)).toBe(true);
  });

  it('keeps a manual item separate from a combined recipe row of the same canon', () => {
    const items = [
      makeItem('m1', { matchState: 'matched', canonId: 'c-onion' }),
      makeItem('r1', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('a')] }),
      makeItem('r2', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('b')] }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows).toHaveLength(2);
    const combined = result.aisles[0]!.rows.find((r) => r.combined);
    const single = result.aisles[0]!.rows.find((r) => !r.combined);
    expect(combined?.contributors.map((c) => c.id).sort()).toEqual(['r1', 'r2']);
    expect(single?.key).toBe('m1');
  });

  it('a lone recipe item is a single (not combined) row', () => {
    const items = [
      makeItem('r1', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('a')] }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows[0]!.combined).toBe(false);
    expect(result.aisles[0]!.rows[0]!.key).toBe('r1');
  });

  it('aggregates recipe-sourced metric (g) contributions of the same canon into one summed row', () => {
    // End-to-end win: now that recipe ingredients carry metric weights, two
    // recipe contributions of the same canon (150g + 300g carrots) collapse into
    // a single aisle row whose g subtotal sums to 450.
    const canonCarrots = makeCanonMap([{ id: 'c-carrot', name: 'Carrots', aisleId: 'aisle-1' }]);
    const items = [
      makeItem('r1', {
        matchState: 'matched',
        canonId: 'c-carrot',
        sources: [recipeSource('soup')],
        amount: 150,
        unit: 'g',
      }),
      makeItem('r2', {
        matchState: 'matched',
        canonId: 'c-carrot',
        sources: [recipeSource('stew')],
        amount: 300,
        unit: 'g',
      }),
    ];
    const result = groupItemsByAisle(items, canonCarrots, AISLES);
    expect(result.aisles[0]!.rows).toHaveLength(1);
    const row = result.aisles[0]!.rows[0]!;
    expect(row.combined).toBe(true);
    expect(row.contributors).toHaveLength(2);
    expect(row.subtotals).toEqual([{ unit: 'g', amount: 450 }]);
  });

  it('sums per unit and lists mixed units separately', () => {
    const items = [
      makeItem('r1', {
        matchState: 'matched',
        canonId: 'c-onion',
        sources: [recipeSource('a')],
        amount: 200,
        unit: 'g',
      }),
      makeItem('r2', {
        matchState: 'matched',
        canonId: 'c-onion',
        sources: [recipeSource('b')],
        amount: 2,
      }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows[0]!.subtotals).toEqual([
      { unit: 'g', amount: 200 },
      { unit: null, amount: 2 },
    ]);
  });

  it('flags the combined row for check if any contributor needs checking', () => {
    const items = [
      makeItem('r1', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('a')] }),
      makeItem('r2', {
        matchState: 'matched',
        canonId: 'c-onion',
        sources: [recipeSource('b')],
        needsCheck: true,
      }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.aisles[0]!.rows[0]!.needsCheck).toBe(true);
  });

  it('does not combine when combine:false (selection mode)', () => {
    const items = [
      makeItem('r1', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('a')] }),
      makeItem('r2', { matchState: 'matched', canonId: 'c-onion', sources: [recipeSource('b')] }),
    ];
    const result = groupItemsByAisle(items, canonMap, AISLES, { combine: false });
    expect(result.aisles[0]!.rows).toHaveLength(2);
    expect(result.aisles[0]!.rows.every((r) => !r.combined)).toBe(true);
  });
});

describe('groupItemsByAisle — product-form parent aggregation (#501, #518)', () => {
  const recipeSource = (recipeId: string) => ({
    kind: 'recipe' as const,
    recipeId,
    servings: 2,
    label: recipeId,
  });
  // A LEGACY form contributor: written before `formDemand` existed (#501), so it
  // carries only its collapsed, already-rounded per-recipe parent count and no
  // per-form breakdown. Its raw demand is unrecoverable, so such a row can only
  // take the old lossy MAX-across-recipes rule — the degrade path. Every test
  // using this helper is pinning that back-compat behaviour, NOT the current rule.
  const legacyForm = (
    id: string,
    recipeId: string,
    canonId: string,
    count: number,
    rawText: string,
  ) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount: count,
      unit: 'count',
      rawText,
    });
  // A CURRENT form contributor (#518): same shape, plus the per-form `formDemand`
  // breakdown recipeService now writes. `amount` stays the within-recipe collapsed
  // MAX (the row's own display value); `demand` carries each form's UNROUNDED
  // parent-count, which is what the cross-recipe aggregation actually sums.
  const form = (
    id: string,
    recipeId: string,
    canonId: string,
    count: number,
    rawText: string,
    demand: FormDemand[],
  ) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount: count,
      unit: 'count',
      rawText,
      formDemand: demand,
    });
  // A whole/direct contributor: parent demanded as itself, no g/ml unit.
  const whole = (id: string, recipeId: string, canonId: string, amount: number, rawText: string) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount,
      rawText,
    });
  const canonMap = makeCanonMap([
    { id: 'c-lime', name: 'Lime', aisleId: 'aisle-1' },
    { id: 'c-chicken', name: 'Whole Chicken', aisleId: 'aisle-1' },
    { id: 'c-egg', name: 'Free Range Egg', aisleId: 'aisle-1' },
  ]);

  const onlyRow = (items: ShoppingListItem[]) =>
    groupItemsByAisle(items, canonMap, AISLES).aisles[0]!.rows[0]!;

  it('Lime headline: Σwhole(2) + MAX(juice 1, zest 1) = 3', () => {
    // Two recipes, but DISTINCT forms (juice vs zest) → they max to 1, and the two
    // whole limes sum on top. One lime supplies both its juice and its zest.
    const row = onlyRow([
      whole('w', 'a', 'c-lime', 2, '2 limes'),
      form('j', 'a', 'c-lime', 1, '30ml lime juice', [{ formId: 'pf-juice', parentCount: 1 }]),
      form('z', 'b', 'c-lime', 1, 'zest of one lime', [{ formId: 'pf-zest', parentCount: 1 }]),
    ]);
    expect(row.combined).toBe(true);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 3 }]);
  });

  it('whole + part mix: Σwhole(2) + MAX(thighs 2) = 4 in one ×N bucket', () => {
    const row = onlyRow([
      whole('w', 'a', 'c-chicken', 2, '2 whole chickens'),
      form('t', 'b', 'c-chicken', 2, '4 chicken thighs', [{ formId: 'pf-thigh', parentCount: 2 }]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 4 }]);
  });

  it('a row with no form contributor keeps plain per-unit behaviour (no count merge)', () => {
    // Two whole unit-undefined amounts of the same canon that is NOT a product
    // form here (no 'count' contributor) sum into the null bucket, unchanged.
    const row = onlyRow([
      whole('w1', 'a', 'c-lime', 2, 'limes'),
      whole('w2', 'b', 'c-lime', 3, 'limes'),
    ]);
    expect(row.subtotals).toEqual([{ unit: null, amount: 5 }]);
  });

  it('form + g/ml contributor degrades to separate buckets (count first)', () => {
    const row = onlyRow([
      form('t', 'a', 'c-chicken', 2, '4 chicken thighs', [{ formId: 'pf-thigh', parentCount: 2 }]),
      makeItem('g', {
        matchState: 'matched',
        canonId: 'c-chicken',
        sources: [recipeSource('b')],
        amount: 300,
        unit: 'g',
      }),
    ]);
    expect(row.subtotals).toEqual([
      { unit: 'count', amount: 2 },
      { unit: 'g', amount: 300 },
    ]);
  });
});

// The three headline staging cases (#518), driven end-to-end through the display
// aggregation with the `formDemand` recipeService now writes. Each pins a distinct
// half of the rule, and each was WRONG before #518.
describe('groupItemsByAisle — #518 headline cases (same form sums, distinct forms max)', () => {
  const recipeSource = (recipeId: string) => ({
    kind: 'recipe' as const,
    recipeId,
    servings: 2,
    label: recipeId,
  });
  const form = (
    id: string,
    recipeId: string,
    canonId: string,
    count: number,
    rawText: string,
    demand: FormDemand[],
  ) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount: count,
      unit: 'count',
      rawText,
      formDemand: demand,
    });
  const whole = (id: string, recipeId: string, canonId: string, amount: number, rawText: string) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount,
      rawText,
    });
  const canonMap = makeCanonMap([
    { id: 'c-lime', name: 'Lime', aisleId: 'aisle-1' },
    { id: 'c-chicken', name: 'Whole Chicken', aisleId: 'aisle-1' },
    { id: 'c-egg', name: 'Free Range Egg', aisleId: 'aisle-1' },
  ]);
  const onlyRow = (items: ShoppingListItem[]) =>
    groupItemsByAisle(items, canonMap, AISLES).aisles[0]!.rows[0]!;

  it('Lime ×5 — zest 10 g + 15 g is the SAME form in two recipes, so it SUMS', () => {
    // Recipe A wants 10 g of zest (2 limes at 5 g/lime), recipe B wants 15 g
    // (3 limes). Same form → 25 g of zest → 5 limes. The old rule MAXed to 3 and
    // sent the shopper home short.
    const row = onlyRow([
      form('a', 'a', 'c-lime', 2, '10 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 2 }]),
      form('b', 'b', 'c-lime', 3, '15 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 3 }]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 5 }]);
  });

  it('Free Range Egg ×4 — yolks 2+2 SUM to 4, whites 3 MAX against them', () => {
    // Both rules in one row. Recipe A: 2 yolks. Recipe B: 3 whites + 2 yolks,
    // already collapsed at write to the MAX row (count 3) carrying BOTH forms'
    // demand. Yolks sum across recipes to 4; whites are 3; MAX(4, 3) = 4 eggs.
    // The old rule reported MAX(2, 3) = 3.
    const row = onlyRow([
      form('a', 'a', 'c-egg', 2, '2 egg yolks', [{ formId: 'pf-egg-yolk', parentCount: 2 }]),
      form('b', 'b', 'c-egg', 3, '3 egg whites, 2 egg yolks', [
        { formId: 'pf-egg-white', parentCount: 3 },
        { formId: 'pf-egg-yolk', parentCount: 2 },
      ]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 4 }]);
  });

  it('Whole Chicken ×5 — breasts 2 MAX against thighs 4+6 summed', () => {
    // Recipe C: 2 breasts (1 bird at 2 breasts/bird) + 4 thighs (2 birds at
    // 2 thighs/bird), collapsed at write to the MAX row (count 2) carrying both.
    // Recipe D: 6 thighs (3 birds). Thighs are the SAME form across C and D →
    // 2 + 3 = 5 birds; breasts stay 1; MAX(1, 5) = 5.
    const row = onlyRow([
      form('c', 'c', 'c-chicken', 2, '2 chicken breasts, 4 chicken thighs', [
        { formId: 'pf-breast', parentCount: 1 },
        { formId: 'pf-thigh', parentCount: 2 },
      ]),
      form('d', 'd', 'c-chicken', 3, '6 chicken thighs', [{ formId: 'pf-thigh', parentCount: 3 }]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 5 }]);
  });

  it('Whole Chicken ×6 — a whole bird on the same list SUMS on top of the ×5', () => {
    // Guards the "bought for its parts can't also be the roast" half: adding
    // recipe C's own `1 whole chicken` to the case above gives 1 + 5 = 6, in ONE
    // ×N bucket. This is why the staging runbook's recipe C cannot show ×5.
    const row = onlyRow([
      form('c', 'c', 'c-chicken', 2, '2 chicken breasts, 4 chicken thighs', [
        { formId: 'pf-breast', parentCount: 1 },
        { formId: 'pf-thigh', parentCount: 2 },
      ]),
      whole('w', 'c', 'c-chicken', 1, '1 whole chicken'),
      form('d', 'd', 'c-chicken', 3, '6 chicken thighs', [{ formId: 'pf-thigh', parentCount: 3 }]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 6 }]);
  });

  it('rounds ONCE on the summed demand: 6 g + 6 g of zest = 3 limes, not 2 + 2 = 4', () => {
    // The round-once rule through the full display path, at a 4 g/lime yield.
    // Each recipe's 6 g is 1.5 limes and shows ×2 on its own row (Math.round(1.5)),
    // but the demand sums raw to 3.0 and rounds once to 3. Summing the rows'
    // DISPLAYED amounts — which is what a naive reading of the list would do —
    // buys 4. This is exactly why `formDemand` stores the unrounded value.
    const row = onlyRow([
      form('a', 'a', 'c-lime', 2, '6 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 1.5 }]),
      form('b', 'b', 'c-lime', 2, '6 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 1.5 }]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 3 }]);
  });
});

// Back-compat lock. `formDemand` is additive and optional, so a list written
// before #518 has contributors that carry only a collapsed per-recipe count. Those
// rows CANNOT be re-derived (the per-form breakdown is gone) and must keep their
// old MAX number rather than change under the user. A list self-heals when its
// recipes are re-added; there is no migration.
describe('groupItemsByAisle — legacy degrade path (items written before #518)', () => {
  const recipeSource = (recipeId: string) => ({
    kind: 'recipe' as const,
    recipeId,
    servings: 2,
    label: recipeId,
  });
  const legacyForm = (
    id: string,
    recipeId: string,
    canonId: string,
    count: number,
    rawText: string,
  ) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount: count,
      unit: 'count',
      rawText,
    });
  const form = (
    id: string,
    recipeId: string,
    canonId: string,
    count: number,
    rawText: string,
    demand: FormDemand[],
  ) =>
    makeItem(id, {
      matchState: 'matched',
      canonId,
      sources: [recipeSource(recipeId)],
      amount: count,
      unit: 'count',
      rawText,
      formDemand: demand,
    });
  const canonMap = makeCanonMap([
    { id: 'c-lime', name: 'Lime', aisleId: 'aisle-1' },
    { id: 'c-chicken', name: 'Whole Chicken', aisleId: 'aisle-1' },
  ]);
  const onlyRow = (items: ShoppingListItem[]) =>
    groupItemsByAisle(items, canonMap, AISLES).aisles[0]!.rows[0]!;

  it('legacy zest 10 g + 15 g keeps the OLD ×3, not the new ×5', () => {
    // The exact #518 headline case, but written pre-#518. These two ARE the same
    // form and would now sum to 5 — but without `formDemand` that is unknowable,
    // so the row honestly keeps MAX(2, 3) = 3 rather than guess.
    const row = onlyRow([
      legacyForm('a', 'a', 'c-lime', 2, '10 g lime zest'),
      legacyForm('b', 'b', 'c-lime', 3, '15 g lime zest'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 3 }]);
  });

  it('legacy distinct forms still MAX: MAX(thighs 2, drumsticks 1) = 2', () => {
    // Thigh and drumstick are DISTINCT forms of one bird, so MAX is the right
    // answer under BOTH rules — this row's number is unchanged by #518. It is on
    // the legacy path only because it carries no `formDemand`; give it one and the
    // answer is still 2 (see the sibling test below).
    const row = onlyRow([
      legacyForm('t', 'a', 'c-chicken', 2, '4 chicken thighs'),
      legacyForm('d', 'b', 'c-chicken', 1, '2 chicken drumsticks'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 2 }]);
  });

  it('the same distinct-form case WITH formDemand agrees: still MAX = 2', () => {
    // Proves the point above: the degrade path and the current rule only diverge
    // when the SAME form repeats across recipes. Distinct forms max either way.
    const row = onlyRow([
      form('t', 'a', 'c-chicken', 2, '4 chicken thighs', [{ formId: 'pf-thigh', parentCount: 2 }]),
      form('d', 'b', 'c-chicken', 1, '2 chicken drumsticks', [
        { formId: 'pf-drumstick', parentCount: 1 },
      ]),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 2 }]);
  });

  it('legacy single-recipe multi-part (already MAX-collapsed at write) stays ×2, never ×3', () => {
    // buildRecipeAddPlan collapses juice/zest of one recipe to one row before the
    // list is written; the surviving contributor carries the MAX count (2). Pin
    // that the display aggregation of that lone count contributor is 2, not 3.
    const row = onlyRow([
      legacyForm('t', 'a', 'c-chicken', 2, '4 chicken thighs and 2 drumsticks'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 2 }]);
  });

  it('legacy pre-rounded parent count (3 thighs, yield 2/bird → 2) passes through as ×2', () => {
    const row = onlyRow([
      legacyForm('t', 'a', 'c-chicken', 2, '3 chicken thighs'),
      legacyForm('d', 'b', 'c-chicken', 1, '1 drumstick'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 2 }]);
  });

  it('an empty formDemand array is treated as legacy, not as zero demand', () => {
    // Defensive: `formDemand: []` must not silently drop the contributor's count
    // and under-buy. It falls back to the collapsed amount.
    const row = onlyRow([
      makeItem('t', {
        matchState: 'matched',
        canonId: 'c-chicken',
        sources: [recipeSource('a')],
        amount: 2,
        unit: 'count',
        formDemand: [],
      }),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 2 }]);
  });

  it('MIXED legacy + new on one row: the new form sums, then maxes with the legacy count', () => {
    // A half-migrated list — recipe A re-added since #518, recipe B not. The new
    // zest demand (2 + 1 = 3) maxes against B's opaque legacy 4 → 4. The legacy
    // row neither disappears nor caps the new sum.
    const row = onlyRow([
      form('a1', 'a', 'c-lime', 2, '10 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 2 }]),
      form('a2', 'c', 'c-lime', 1, '5 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 1 }]),
      legacyForm('b', 'b', 'c-lime', 4, '20 g lime zest'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 4 }]);
  });

  it('MIXED legacy + new: a summed new form beats a smaller legacy count', () => {
    // The self-heal direction: once the big recipes are re-added their summed
    // demand (2 + 3 = 5) wins over the stale legacy 3, and the list corrects.
    const row = onlyRow([
      form('a1', 'a', 'c-lime', 2, '10 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 2 }]),
      form('a2', 'c', 'c-lime', 3, '15 g lime zest', [{ formId: 'pf-lime-zest', parentCount: 3 }]),
      legacyForm('b', 'b', 'c-lime', 3, '15 g lime zest'),
    ]);
    expect(row.subtotals).toEqual([{ unit: 'count', amount: 5 }]);
  });
});

describe('groupItemsByAisle — checked bucket', () => {
  it('routes checked items to the checked bucket regardless of match state', () => {
    const items = [
      makeItem('i1', { matchState: 'matched', canonId: 'c1', checked: true }),
      makeItem('i2', { matchState: 'pending', checked: true }),
      makeItem('i3', { matchState: 'matched', canonId: 'c1', checked: false }),
    ];
    const canonMap = makeCanonMap([{ id: 'c1', name: 'Milk', aisleId: 'aisle-2' }]);
    const result = groupItemsByAisle(items, canonMap, AISLES);
    expect(result.checked.contributors).toHaveLength(2);
    expect(result.aisles[0]!.rows).toHaveLength(1);
    expect(result.other.contributors).toHaveLength(0);
  });

  it('sorts checked items most-recently-updated first', () => {
    const items = [
      makeItem('i1', { checked: true, updatedAt: '2026-01-01T10:00:00.000Z' }),
      makeItem('i2', { checked: true, updatedAt: '2026-01-01T12:00:00.000Z' }),
      makeItem('i3', { checked: true, updatedAt: '2026-01-01T11:00:00.000Z' }),
    ];
    const result = groupItemsByAisle(items, makeCanonMap([]), AISLES);
    const ids = result.checked.contributors.map((i) => i.id);
    expect(ids).toEqual(['i2', 'i3', 'i1']);
  });

  it('returns empty buckets for an empty input', () => {
    const result = groupItemsByAisle([], makeCanonMap([]), AISLES);
    expect(result.aisles).toHaveLength(0);
    expect(result.other.contributors).toHaveLength(0);
    expect(result.checked.contributors).toHaveLength(0);
  });
});

// ─── Counted rows: one count, one weight (issue #1643) ───────────────────────
describe('groupItemsByAisle — a counted item reads as one count and one weight', () => {
  const recipe = (id: string) => [
    { kind: 'recipe' as const, recipeId: id, servings: 2, label: id },
  ];
  const ONION: CanonInfo = {
    id: 'c-onion',
    name: 'Red Onion',
    aisleId: 'aisle-1',
    unit: 'count',
    gramsPerItem: 150,
  };
  const onions = (over: Partial<ShoppingListItem>[]) =>
    over.map((o, i) =>
      makeItem(`i${i}`, {
        canonId: 'c-onion',
        matchState: 'matched',
        sources: recipe(`r${i}`),
        ...o,
      }),
    );

  function rowFor(items: ShoppingListItem[], canon: CanonInfo) {
    return groupItemsByAisle(items, makeCanonMap([canon]), AISLES).aisles[0]!.rows[0]!;
  }

  it('adds counts, converts the weight-only line once, and writes one weight', () => {
    // "2 onions" (300 g est.), "3 large onions" (540 g est.), "200 g onion".
    const row = rowFor(
      onions([
        { amount: 2, weightGrams: 300 },
        { amount: 3, weightGrams: 540 },
        { amount: 200, unit: 'g' },
      ]),
      ONION,
    );
    // 2 + 3 + ceil(200 / 150) = 7, and the weight is each contribution's own.
    expect(row.subtotals).toEqual([{ unit: null, amount: 7, weightGrams: 1040 }]);
  });

  it('converts the weight-only lines as one total, not one by one', () => {
    // 3 × 50 g = 150 g is ONE onion; rounding each line up first would buy three.
    const row = rowFor(
      onions([
        { amount: 50, unit: 'g' },
        { amount: 50, unit: 'g' },
        { amount: 50, unit: 'g' },
      ]),
      ONION,
    );
    expect(row.subtotals).toEqual([{ unit: null, amount: 1, weightGrams: 150 }]);
  });

  it('weighs a count with no recorded weight at the weight of one', () => {
    const row = rowFor(onions([{ amount: 2 }, { amount: 1, weightGrams: 120 }]), ONION);
    expect(row.subtotals).toEqual([{ unit: null, amount: 3, weightGrams: 420 }]);
  });

  it('keeps a unit it cannot count from as its own subtotal', () => {
    const row = rowFor(
      onions([
        { amount: 1, weightGrams: 150 },
        { amount: 50, unit: 'ml' },
      ]),
      ONION,
    );
    expect(row.subtotals).toEqual([
      { unit: null, amount: 1, weightGrams: 150 },
      { unit: 'ml', amount: 50 },
    ]);
  });

  it('keeps today’s per-unit subtotals when the item has no weight of one', () => {
    const { gramsPerItem: _g, ...noWeight } = ONION;
    const row = rowFor(
      onions([
        { amount: 2, weightGrams: 300 },
        { amount: 200, unit: 'g' },
      ]),
      noWeight,
    );
    expect(row.subtotals).toEqual([
      { unit: null, amount: 2 },
      { unit: 'g', amount: 200 },
    ]);
  });

  it('keeps today’s per-unit subtotals for an item bought by weight', () => {
    const row = rowFor(onions([{ amount: 2 }, { amount: 200, unit: 'g' }]), {
      ...ONION,
      unit: 'g',
    });
    expect(row.subtotals.every((s) => s.weightGrams === undefined)).toBe(true);
    expect(row.subtotals).toHaveLength(2);
  });

  it('weighs a product-form parent row as its count of whole items, never the parts', () => {
    // The stock's carcass and the salad's two breasts: one bird.
    const CHICKEN: CanonInfo = {
      id: 'c-chicken',
      name: 'Chicken',
      aisleId: 'aisle-1',
      unit: 'count',
      gramsPerItem: 1500,
    };
    const items = [
      makeItem('carcass', {
        canonId: 'c-chicken',
        matchState: 'matched',
        sources: recipe('stock'),
        amount: 1,
        unit: 'count',
        formDemand: [{ formId: 'form-carcass', parentCount: 1 }],
      }),
      makeItem('breasts', {
        canonId: 'c-chicken',
        matchState: 'matched',
        sources: recipe('salad'),
        amount: 1,
        unit: 'count',
        formDemand: [{ formId: 'form-breast', parentCount: 1 }],
      }),
    ];
    expect(rowFor(items, CHICKEN).subtotals).toEqual([
      { unit: 'count', amount: 1, weightGrams: 1500 },
    ]);
  });

  it('never converts a form row’s grams through the parent’s weight', () => {
    const CHICKEN: CanonInfo = {
      id: 'c-chicken',
      name: 'Chicken',
      aisleId: 'aisle-1',
      unit: 'count',
      gramsPerItem: 1500,
    };
    const items = [
      makeItem('breasts', {
        canonId: 'c-chicken',
        matchState: 'matched',
        sources: recipe('salad'),
        amount: 1,
        unit: 'count',
        formDemand: [{ formId: 'form-breast', parentCount: 1 }],
      }),
      makeItem('thighs', {
        canonId: 'c-chicken',
        matchState: 'matched',
        sources: recipe('curry'),
        amount: 400,
        unit: 'g',
      }),
    ];
    expect(rowFor(items, CHICKEN).subtotals).toEqual([
      { unit: 'count', amount: 1, weightGrams: 1500 },
      { unit: 'g', amount: 400 },
    ]);
  });

  it('cannot write a weight per contributor — only one subtotal ever carries it', () => {
    const row = rowFor(
      onions([
        { amount: 4, weightGrams: 400 },
        { amount: 2, weightGrams: 500 },
      ]),
      ONION,
    );
    expect(row.subtotals.filter((s) => s.weightGrams !== undefined)).toHaveLength(1);
    expect(row.subtotals[0]).toEqual({ unit: null, amount: 6, weightGrams: 900 });
  });
});
