import { describe, it, expect, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import type { CanonItem, Ingredient, ProductForm } from '@salt/domain';

// The shared count-or-weight lookup (issue #1643). The decision is the domain's;
// this pins the plumbing — the canon lookup by id, and that the store follows
// canon and product forms as they change, which is what makes a unit change take
// effect in every recipe without a re-match.

const { canonStore, formStore } = vi.hoisted(() => ({
  canonStore: { value: null as unknown },
  formStore: { value: null as unknown },
}));
vi.mock('../src/lib/canonService.js', async () => {
  const { writable: w } = await import('svelte/store');
  const s = w<CanonItem[]>([]);
  canonStore.value = s;
  return { canonItems: s };
});
vi.mock('../src/lib/productFormService.js', async () => {
  const { writable: w } = await import('svelte/store');
  const s = w<ProductForm[]>([]);
  formStore.value = s;
  return { productForms: s };
});

import { amountLookupFor, ingredientAmounts } from '../src/lib/ingredientAmounts.js';

const ONION: CanonItem = {
  id: 'canon-onion',
  schemaVersion: 5,
  name: 'Red Onion',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  embedding: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '',
};

function onion(canonId: string | null): Ingredient {
  return {
    id: 'i1',
    rawText: '1 red onion',
    parsed: {
      quantity: { type: 'single', value: 150 },
      unit: 'g',
      statedCount: { type: 'single', value: 1 },
      item: 'red onion',
      preparation: [],
      notes: null,
      displayText: null,
    },
    canonId,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

describe('amountLookupFor', () => {
  const lookup = amountLookupFor([ONION], []);

  it('reads a matched line through its canon item', () => {
    expect(lookup.amountFor(onion(ONION.id))?.unit).toBe('count');
  });

  it('reads a never-matched line, and one whose canon item is gone, as stored', () => {
    expect(lookup.amountFor(onion(null))?.unit).toBe('g');
    expect(lookup.amountFor(onion('canon-deleted'))?.unit).toBe('g');
  });

  it('gives nothing for an unparsed line', () => {
    expect(lookup.amountFor({ ...onion(ONION.id), parsed: null })).toBeNull();
  });
});

describe('ingredientAmounts', () => {
  it('follows the canon store: changing an item’s unit changes how the line reads', () => {
    const canon = canonStore.value as ReturnType<typeof writable<CanonItem[]>>;
    canon.set([ONION]);
    expect(get(ingredientAmounts).amountFor(onion(ONION.id))?.unit).toBe('count');
    canon.set([{ ...ONION, unit: 'g' }]);
    expect(get(ingredientAmounts).amountFor(onion(ONION.id))?.unit).toBe('g');
    expect(formStore.value).not.toBeNull();
  });
});
