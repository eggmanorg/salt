import { describe, it, expect } from 'vitest';
import { packsForNeed } from '@salt/domain';
import type { PackNeed, PackWeight } from '@salt/domain';

// Issue #1712: Use from the freezer starts at the row's need over one pack's
// weight, rounded up, capped at what the bag holds — and at 1 whenever the two
// cannot be compared.

const G500: PackWeight = { amount: 500, unit: 'g' };
const G100: PackWeight = { amount: 100, unit: 'g' };
const ML500: PackWeight = { amount: 500, unit: 'ml' };
const L1: PackWeight = { amount: 1000, unit: 'ml' };

describe('packsForNeed', () => {
  it.each<[string, PackNeed, PackWeight, number]>([
    ['1.2 kg over 500 g rounds up to 3', { amount: 1.2, unit: 'kg' }, G500, 3],
    ['1000 g over 500 g is exactly 2', { amount: 1000, unit: 'g' }, G500, 2],
    ['0.3 kg over 100 g is 3', { amount: 0.3, unit: 'kg' }, G100, 3],
    // Float noise: 1.1 dl is 110.00000000000001 ml, and 16.1 kg is 161.00000000000003
    // packs of 100 g. Without the tolerance each would round up a pack too many.
    [
      '1.1 dl over 10 ml is 11, not 12',
      { amount: 1.1, unit: 'dl' },
      { amount: 10, unit: 'ml' },
      11,
    ],
    ['750 ml over a 1 l bag is 1', { amount: 750, unit: 'ml' }, L1, 1],
    ['2 l over 500 ml is 4', { amount: 2, unit: 'l' }, ML500, 4],
    ['30 cl over 100 ml packs is 3', { amount: 30, unit: 'cl' }, { amount: 100, unit: 'ml' }, 3],
    ['5 dl over 500 ml is 1', { amount: 5, unit: 'dl' }, ML500, 1],
    ['"KG" in capitals', { amount: 1, unit: 'KG' }, G500, 2],
    ['" Litres " spaced and spelled out', { amount: 1, unit: ' Litres ' }, ML500, 2],
    ['"grams" spelled out', { amount: 800, unit: 'grams' }, G500, 2],
    ['a need below one pack is 1', { amount: 50, unit: 'g' }, G500, 1],
  ])('%s', (_, need, weight, expected) => {
    expect(packsForNeed(need, weight, 20)).toBe(expected);
  });

  it('16.1 kg over 100 g is 161, not 162', () => {
    expect(packsForNeed({ amount: 16.1, unit: 'kg' }, G100, 500)).toBe(161);
  });

  it('never starts above what the bag holds', () => {
    expect(packsForNeed({ amount: 3, unit: 'kg' }, G500, 4)).toBe(4);
  });

  it.each<[string, PackNeed, PackWeight | null, number]>([
    ['g against an ml bag', { amount: 1000, unit: 'g' }, ML500, 10],
    ['ml against a g bag', { amount: 1000, unit: 'ml' }, G500, 10],
    ['a counted row', { amount: 3, unit: 'count' }, G500, 10],
    ['a container word', { amount: 2, unit: 'tins' }, G500, 10],
    ['an imperial unit', { amount: 2, unit: 'lb' }, G500, 10],
    ['no unit', { amount: 1000 }, G500, 10],
    ['no amount', { unit: 'g' }, G500, 10],
    ['a zero amount', { amount: 0, unit: 'g' }, G500, 10],
    ['a bag with no weight', { amount: 1000, unit: 'g' }, null, 10],
    ['a bag weighing 0', { amount: 1000, unit: 'g' }, { amount: 0, unit: 'g' }, 10],
    ['a bag weighing less than 0', { amount: 1000, unit: 'g' }, { amount: -500, unit: 'g' }, 10],
    ['a bag holding none', { amount: 1000, unit: 'g' }, G500, 0],
  ])('starts at 1 for %s', (_, need, weight, held) => {
    expect(packsForNeed(need, weight, held)).toBe(1);
  });
});
