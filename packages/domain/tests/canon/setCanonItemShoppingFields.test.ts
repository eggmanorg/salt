import { describe, it, expect } from 'vitest';
import {
  setCanonItemShoppingBehavior,
  setCanonItemThreshold,
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

describe('setCanonItemThreshold', () => {
  it('sets both threshold and unit when both provided', () => {
    const result = setCanonItemThreshold(item(), 5, 'ml');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(5);
      expect(result.value.unit).toBe('ml');
    }
  });

  it('updates an existing threshold and unit', () => {
    const result = setCanonItemThreshold(item({ largeQuantityThreshold: 5, unit: 'ml' }), 10, 'g');
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(10);
      expect(result.value.unit).toBe('g');
    }
  });

  it('removes both fields when both args are undefined (key absence, not undefined value)', () => {
    const original = item({ largeQuantityThreshold: 5, unit: 'ml' });
    const result = setCanonItemThreshold(original, undefined, undefined);
    if (result.kind === 'ok') {
      expect('largeQuantityThreshold' in result.value).toBe(false);
      expect('unit' in result.value).toBe(false);
    }
  });

  it('removes only unit when threshold is provided and unit is undefined', () => {
    const original = item({ largeQuantityThreshold: 5, unit: 'ml' });
    const result = setCanonItemThreshold(original, 10, undefined);
    if (result.kind === 'ok') {
      expect(result.value.largeQuantityThreshold).toBe(10);
      expect('unit' in result.value).toBe(false);
    }
  });

  it('removes only threshold when unit is provided and threshold is undefined', () => {
    const original = item({ largeQuantityThreshold: 5, unit: 'ml' });
    const result = setCanonItemThreshold(original, undefined, 'g');
    if (result.kind === 'ok') {
      expect('largeQuantityThreshold' in result.value).toBe(false);
      expect(result.value.unit).toBe('g');
    }
  });

  it('leaves an item without threshold or unit unchanged when both args are undefined', () => {
    const original = item();
    const result = setCanonItemThreshold(original, undefined, undefined);
    if (result.kind === 'ok') {
      expect('largeQuantityThreshold' in result.value).toBe(false);
      expect('unit' in result.value).toBe(false);
    }
  });

  it('preserves all other fields', () => {
    const original = item({ synonyms: ['EVOO'], shoppingBehavior: 'stocked' });
    const result = setCanonItemThreshold(original, 5, 'ml');
    if (result.kind === 'ok') {
      expect(result.value.id).toBe(original.id);
      expect(result.value.name).toBe(original.name);
      expect(result.value.synonyms).toEqual(original.synonyms);
      expect(result.value.aisleId).toBe(original.aisleId);
      expect(result.value.shoppingBehavior).toBe('stocked');
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
