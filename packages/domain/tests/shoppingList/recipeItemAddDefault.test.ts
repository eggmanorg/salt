import { describe, it, expect } from 'vitest';
import { recipeItemAddDefault } from '@salt/domain';
import type { RecipeItemAddCanon } from '../../src/shoppingList/queries/recipeItemAddDefault.js';

const canon = (over: Partial<RecipeItemAddCanon>): RecipeItemAddCanon => ({
  shoppingBehavior: 'stocked',
  ...over,
});
const ADD = { add: true, check: false };
const SKIP = { add: false, check: false };

describe('recipeItemAddDefault', () => {
  it('unmatched (no canon) → add, no check', () => {
    expect(recipeItemAddDefault(null, { amount: 200, unit: 'g' })).toEqual(ADD);
  });

  it('needed → add, no check (regardless of amount/threshold)', () => {
    const c = canon({ shoppingBehavior: 'needed', largeQuantityThreshold: 500, unit: 'g' });
    expect(recipeItemAddDefault(c, { amount: 200, unit: 'g' })).toEqual(ADD);
  });

  it('check → add + check', () => {
    expect(recipeItemAddDefault(canon({ shoppingBehavior: 'check' }), null)).toEqual({
      add: true,
      check: true,
    });
  });

  describe('stocked, same unit', () => {
    const c = canon({ largeQuantityThreshold: 500, unit: 'g' });

    it('under the threshold → skip', () => {
      expect(recipeItemAddDefault(c, { amount: 200, unit: 'g' })).toEqual(SKIP);
    });

    it('over the threshold → add (treated as needed)', () => {
      expect(recipeItemAddDefault(c, { amount: 750, unit: 'g' })).toEqual(ADD);
    });

    it('exactly at the threshold → skip (strictly greater-than)', () => {
      expect(recipeItemAddDefault(c, { amount: 500, unit: 'g' })).toEqual(SKIP);
    });

    it('a count against a count threshold compares the counts', () => {
      const counted = canon({ largeQuantityThreshold: 3, unit: 'count' });
      expect(recipeItemAddDefault(counted, { amount: 4, unit: 'count' })).toEqual(ADD);
      expect(recipeItemAddDefault(counted, { amount: 2, unit: 'count' })).toEqual(SKIP);
    });
  });

  it('stocked with no threshold → skip', () => {
    expect(recipeItemAddDefault(canon({ unit: 'g' }), { amount: 9999, unit: 'g' })).toEqual(SKIP);
  });

  it('stocked with no amount → skip', () => {
    const c = canon({ largeQuantityThreshold: 500, unit: 'g' });
    expect(recipeItemAddDefault(c, null)).toEqual(SKIP);
  });

  // Issue #1651: the comparison used to ignore both units, so 300 g of an item
  // with a `3 count` threshold read as "300 > 3" and was added.
  describe('stocked, grams against a count threshold', () => {
    it('converts through the weight of one: 300 g ÷ 150 g = 2 onions, under 3 → skip', () => {
      const c = canon({ largeQuantityThreshold: 3, unit: 'count', gramsPerItem: 150 });
      expect(recipeItemAddDefault(c, { amount: 300, unit: 'g' })).toEqual(SKIP);
    });

    it('600 g ÷ 150 g = 4 onions, over 3 → add', () => {
      const c = canon({ largeQuantityThreshold: 3, unit: 'count', gramsPerItem: 150 });
      expect(recipeItemAddDefault(c, { amount: 600, unit: 'g' })).toEqual(ADD);
    });

    it('with no weight of one the threshold does not apply → skip', () => {
      const c = canon({ largeQuantityThreshold: 3, unit: 'count' });
      expect(recipeItemAddDefault(c, { amount: 300, unit: 'g' })).toEqual(SKIP);
    });
  });

  it('any other unit mismatch → the threshold does not apply', () => {
    const grams = canon({ largeQuantityThreshold: 500, unit: 'g', gramsPerItem: 150 });
    expect(recipeItemAddDefault(grams, { amount: 9, unit: 'count' })).toEqual(SKIP);
    expect(recipeItemAddDefault(grams, { amount: 900, unit: 'ml' })).toEqual(SKIP);
    const counted = canon({ largeQuantityThreshold: 3, unit: 'count', gramsPerItem: 150 });
    expect(recipeItemAddDefault(counted, { amount: 900, unit: 'ml' })).toEqual(SKIP);
  });

  it('a threshold stored with no unit is compared as a bare number, as before', () => {
    const c = canon({ largeQuantityThreshold: 500 });
    expect(recipeItemAddDefault(c, { amount: 750, unit: 'g' })).toEqual(ADD);
    expect(recipeItemAddDefault(c, { amount: 200, unit: 'ml' })).toEqual(SKIP);
  });
});
