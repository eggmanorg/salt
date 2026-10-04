import { describe, it, expect } from 'vitest';
import {
  setCanonItemShoppingBehavior,
  setCanonItemThreshold,
  setCanonItemUnit,
  setCanonItemGramsPerItem,
} from '../../src/canon/commands/setCanonItemShoppingFields.js';
import type { CanonItem } from '../../src/canon/entities/CanonItem.js';

function item(overrides: Partial<CanonItem> = {}): CanonItem {
  return {
    id: 'c1',
    schemaVersion: 5,
    name: 'Olive Oil',
    synonyms: ['EVOO'],
    aisleId: 'oils',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

describe('setCanonItemShoppingBehavior', () => {
  it('updates the behavior field', () => {
    const result = setCanonItemShoppingBehavior(item(), 'stocked');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.shoppingBehavior).toBe('stocked');
  });

  it('replaces an existing behavior', () => {
    const result = setCanonItemShoppingBehavior(item({ shoppingBehavior: 'stocked' }), 'check');
    if (result.kind === 'ok') expect(result.value.shoppingBehavior).toBe('check');
  });

  it('preserves all other fields', () => {
    const original = item({ synonyms: ['EVOO'], largeQuantityThreshold: 5, unit: 'ml' });
    const result = setCanonItemShoppingBehavior(original, 'stocked');
    if (result.kind === 'ok') {
      expect(result.value.id).toBe(original.id);
      expect(result.value.name).toBe(original.name);
      expect(result.value.synonyms).toEqual(original.synonyms);
      expect(result.value.aisleId).toBe(original.aisleId);
      expect(result.value.largeQuantityThreshold).toBe(5);
      expect(result.value.unit).toBe('ml');
    }
  });
});

// The threshold and the unit are separate decisions (issue #1651). These used to
// be one command that dropped `unit` whenever it was handed `undefined`, so
// clearing a counted item's threshold silently turned it back into a weighed one.
describe('setCanonItemThreshold', () => {
  it('sets a threshold, leaving the unit as it was', () => {
    const result = setCanonItemThreshold(item({ unit: 'ml' }), 5);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(5);
      expect(result.value.unit).toBe('ml');
    }
  });

  it('updates an existing threshold', () => {
    const result = setCanonItemThreshold(item({ largeQuantityThreshold: 5, unit: 'ml' }), 10);
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(10);
      expect(result.value.unit).toBe('ml');
    }
  });

  it('clearing the threshold of a counted item keeps it counted, and its weight of one', () => {
    const original = item({ largeQuantityThreshold: 3, unit: 'count', gramsPerItem: 150 });
    const result = setCanonItemThreshold(original, undefined);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect('largeQuantityThreshold' in result.value).toBe(false);
      expect(result.value.unit).toBe('count');
      expect(result.value.gramsPerItem).toBe(150);
    }
  });

  it('never adds a unit to an item that has none', () => {
    const result = setCanonItemThreshold(item(), 500);
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(500);
      expect('unit' in result.value).toBe(false);
    }
  });

  it('preserves all other fields', () => {
    const original = item({ synonyms: ['EVOO'], shoppingBehavior: 'stocked' });
    const result = setCanonItemThreshold(original, 5);
    if (result.kind === 'ok') {
      expect(result.value.id).toBe(original.id);
      expect(result.value.name).toBe(original.name);
      expect(result.value.synonyms).toEqual(original.synonyms);
      expect(result.value.aisleId).toBe(original.aisleId);
      expect(result.value.shoppingBehavior).toBe('stocked');
    }
  });
});

describe('setCanonItemUnit (issue #1651)', () => {
  it('sets the unit on an item with no threshold', () => {
    const result = setCanonItemUnit(item(), 'count');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.unit).toBe('count');
      expect('largeQuantityThreshold' in result.value).toBe(false);
    }
  });

  it('changes the unit and leaves the threshold alone', () => {
    const result = setCanonItemUnit(item({ largeQuantityThreshold: 5, unit: 'ml' }), 'g');
    if (result.kind === 'ok') {
      expect(result.value.unit).toBe('g');
      expect(result.value.largeQuantityThreshold).toBe(5);
    }
  });

  it('clears the unit (key absence) and keeps a weight of one it no longer reads', () => {
    const original = item({ unit: 'count', gramsPerItem: 150 });
    const result = setCanonItemUnit(original, undefined);
    if (result.kind === 'ok') {
      expect('unit' in result.value).toBe(false);
      expect(result.value.gramsPerItem).toBe(150);
    }
  });
});

describe('setCanonItemGramsPerItem (issue #1643)', () => {
  const ITEM = {
    id: 'c1',
    schemaVersion: 5 as const,
    name: 'Red Onion',
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed' as const,
    unit: 'count' as const,
    updatedAt: '',
  };

  it('sets, replaces and clears the weight of one', () => {
    const set = setCanonItemGramsPerItem(ITEM, 150);
    expect(set.kind === 'ok' && set.value.gramsPerItem).toBe(150);
    const cleared = setCanonItemGramsPerItem({ ...ITEM, gramsPerItem: 150 }, undefined);
    expect(cleared.kind === 'ok' && 'gramsPerItem' in cleared.value).toBe(false);
  });

  it('refuses a weight that is not a positive number', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setCanonItemGramsPerItem(ITEM, bad).kind).toBe('err');
    }
  });
});
