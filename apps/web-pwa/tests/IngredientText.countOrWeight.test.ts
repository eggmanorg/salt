import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { CanonItem, Ingredient, ParsedIngredient, ProductForm } from '@salt/domain';

import IngredientText from '../src/routes/recipes/IngredientText.svelte';
import { amountLookupFor } from '../src/lib/ingredientAmounts.js';

// Count or weight on the page (issue #1643). A line holds both amounts it states;
// the canon item and product form decide which one it reads in, and the other
// stands beside it in brackets. These pin what the cook sees, from the data alone.

const CHICKEN: CanonItem = {
  id: 'canon-chicken',
  schemaVersion: 5,
  name: 'Chicken',
  synonyms: [],
  aisleId: null,
  thumbnail: null,
  embedding: null,
  needs_approval: false,
  shoppingBehavior: 'needed',
  unit: 'count',
  updatedAt: '',
};
const RED_ONION: CanonItem = { ...CHICKEN, id: 'canon-onion', name: 'Red Onion' };
const LENTILS: CanonItem = { ...CHICKEN, id: 'canon-lentils', name: 'Red Lentils', unit: 'g' };

const CARCASS: ProductForm = {
  id: 'form-carcass',
  schemaVersion: 1,
  matchers: ['roast chicken carcass', 'chicken carcass'],
  parentCanonId: CHICKEN.id,
  thumbnail: null,
  label: 'Chicken carcass',
  yield: { formUnit: 'count', amountPerParent: 1 },
  updatedAt: '',
};

const LOOKUP = amountLookupFor([CHICKEN, RED_ONION, LENTILS], [CARCASS]);

function line(
  rawText: string,
  canonId: string | null,
  over: Partial<ParsedIngredient>,
): Ingredient {
  return {
    id: 'ing-1',
    rawText,
    parsed: {
      quantity: null,
      unit: null,
      item: '',
      preparation: [],
      notes: null,
      displayText: null,
      ...over,
    },
    canonId,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const CARCASS_LINE = line('1 roast chicken carcass', CHICKEN.id, {
  quantity: { type: 'single', value: 500 },
  unit: 'g',
  statedCount: { type: 'single', value: 1 },
  item: 'roast chicken carcass',
  displayText: 'about 1',
});

const ONION_LINE = line('1 red onion, finely sliced', RED_ONION.id, {
  quantity: { type: 'single', value: 150 },
  unit: 'g',
  statedCount: { type: 'single', value: 1 },
  item: 'red onion',
  preparation: ['finely sliced'],
  displayText: 'about 1 medium',
});

const LENTIL_LINE = line('1 ½ cups red lentils', LENTILS.id, {
  quantity: { type: 'single', value: 300 },
  unit: 'g',
  item: 'red lentils',
  displayText: '1 ½ cups',
});

function textOf(
  ingredient: Ingredient,
  opts: { part?: 'all' | 'quantity' | 'name' | 'display'; scale?: number; lookup?: boolean } = {},
): string {
  const { container } = render(IngredientText, {
    props: {
      ingredient,
      ...(opts.part ? { part: opts.part } : {}),
      ...(opts.scale ? { scale: opts.scale } : {}),
      ...(opts.lookup === false ? {} : { amounts: LOOKUP }),
    },
  });
  return container.textContent ?? '';
}

afterEach(cleanup);

describe('IngredientText — a counted line reads count-first (issue #1643)', () => {
  it('reads the carcass as one carcass, its weight in brackets', () => {
    expect(textOf(CARCASS_LINE)).toBe('1 roast chicken carcass(about 500g)');
    expect(textOf(CARCASS_LINE, { part: 'quantity' })).toBe('1');
    expect(textOf(CARCASS_LINE, { part: 'display' })).toBe('(about 500g)');
  });

  it('reads a counted canon item with no form the same way', () => {
    expect(textOf(ONION_LINE)).toBe('1 red onion, finely sliced(about 150g)');
  });

  it('scales the count AND the bracket — never an unscaled weight beside a scaled count', () => {
    expect(textOf(CARCASS_LINE, { scale: 2 })).toBe('2 roast chicken carcasses(about 1000g)');
    expect(textOf(ONION_LINE, { scale: 3 })).toBe('3 red onions, finely sliced(about 450g)');
  });

  it('leaves a metric line exactly as it was', () => {
    expect(textOf(LENTIL_LINE)).toBe('300g red lentils(1 ½ cups)');
    // …and still drops the frozen source measure on a scaled read.
    expect(textOf(LENTIL_LINE, { scale: 2 })).toBe('600g red lentils');
  });

  it('reads the stored metric amount when there is no lookup to consult', () => {
    // A surface that passes no lookup has no canon item to ask — the line reads
    // as stored, which for a line written today is its metric estimate.
    expect(textOf(ONION_LINE, { lookup: false })).toBe(
      '150g red onion, finely sliced(about 1 medium)',
    );
  });

  it('follows the data, not the name: the same line under a by-weight canon reads in grams', () => {
    const byWeight = amountLookupFor([{ ...RED_ONION, unit: 'g' }], []);
    const { container } = render(IngredientText, {
      props: { ingredient: ONION_LINE, amounts: byWeight },
    });
    expect(container.textContent).toBe('150g red onion, finely sliced(about 1 medium)');
  });
});
