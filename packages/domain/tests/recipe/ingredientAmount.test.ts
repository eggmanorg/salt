import { describe, it, expect } from 'vitest';
import {
  chooseIngredientAmount,
  ingredientMatchIssue,
  preferredIngredientUnit,
} from '../../src/index.js';
import type {
  CanonItem,
  Ingredient,
  IngredientAmount,
  ParsedIngredient,
  ProductForm,
} from '../../src/index.js';

// Count or weight is decided by DATA — the line's product form, else its canon
// item's unit — never by the item's name (issue #1643). Every case below states
// the data, and the answer follows from it alone.

const CANON_BASE: CanonItem = {
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
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const RED_ONION = CANON_BASE;
const FLOUR: CanonItem = { ...CANON_BASE, id: 'canon-flour', name: 'Plain Flour', unit: 'g' };
const UNSET: CanonItem = (() => {
  const { unit: _unit, ...rest } = { ...CANON_BASE, id: 'canon-fennel', name: 'Fennel' };
  return rest;
})();
const LIME: CanonItem = { ...CANON_BASE, id: 'canon-lime', name: 'Lime' };
const GARLIC: CanonItem = { ...CANON_BASE, id: 'canon-garlic', name: 'Garlic Bulbs' };
// Sold by weight, yet carries a counted form — rule 1 must win over rule 2.
const PORK: CanonItem = { ...CANON_BASE, id: 'canon-pork', name: 'Pork Belly', unit: 'g' };

const FORM_BASE: ProductForm = {
  id: 'form-lime-juice',
  schemaVersion: 1,
  matchers: [],
  thumbnail: null,
  parentCanonId: 'canon-lime',
  label: 'Lime juice',
  yield: { formUnit: 'ml', amountPerParent: 30 },
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const LIME_JUICE = FORM_BASE;
const GARLIC_CLOVE: ProductForm = {
  ...FORM_BASE,
  id: 'form-garlic-clove',
  parentCanonId: 'canon-garlic',
  label: 'Garlic clove',
  yield: { formUnit: 'count', amountPerParent: 12 },
};
const PORK_RIB: ProductForm = {
  ...FORM_BASE,
  id: 'form-pork-rib',
  parentCanonId: 'canon-pork',
  label: 'Pork rib',
  yield: { formUnit: 'count', amountPerParent: 10 },
};

const CANON = [RED_ONION, FLOUR, UNSET, LIME, GARLIC, PORK];
const FORMS = [LIME_JUICE, GARLIC_CLOVE, PORK_RIB];

function parsed(over: Partial<ParsedIngredient>): ParsedIngredient {
  return {
    quantity: null,
    unit: null,
    item: 'red onion',
    preparation: [],
    notes: null,
    displayText: null,
    ...over,
  };
}

const one = { type: 'single', value: 1 } as const;
const grams = (value: number) => ({ type: 'single', value }) as const;

function choose(p: ParsedIngredient, canon: CanonItem | null): IngredientAmount | null {
  return chooseIngredientAmount(p, canon, FORMS, CANON);
}

describe('chooseIngredientAmount — the form decides first', () => {
  it('reads a counted-form line with a stated count as that count, its weight beside it', () => {
    const p = parsed({
      item: 'garlic clove',
      quantity: grams(6),
      unit: 'g',
      statedCount: grams(2),
    });
    expect(choose(p, GARLIC)).toEqual({
      quantity: grams(2),
      unit: 'count',
      measure: { quantity: grams(6), unit: 'g' },
      form: GARLIC_CLOVE,
    });
  });

  it('reads a counted-form line holding only grams as grams — no count is invented', () => {
    // The #1643 carcass shape. No count to give, and the form line is never
    // converted through its parent's weight; `missing_count` reports it instead.
    const p = parsed({ item: 'garlic clove', quantity: grams(9), unit: 'g' });
    expect(choose(p, GARLIC)).toEqual({
      quantity: grams(9),
      unit: 'g',
      measure: null,
      form: GARLIC_CLOVE,
    });
  });

  it('keeps a metric-yield form metric, even beside a stated count', () => {
    // "juice of 2 limes" — the parser is told to leave the count null here, but
    // a stray one must not turn millilitres of juice into a count of juice.
    const p = parsed({
      item: 'lime juice',
      quantity: grams(60),
      unit: 'ml',
      statedCount: grams(2),
    });
    const chosen = choose(p, LIME);
    expect(chosen).toMatchObject({ quantity: grams(60), unit: 'ml', measure: null });
    expect(chosen?.form).toBe(LIME_JUICE);
  });

  it('counts a counted form even when its canon is sold by weight — rule 1 before rule 2', () => {
    const p = parsed({ item: 'pork rib', quantity: grams(800), unit: 'g', statedCount: grams(4) });
    expect(choose(p, PORK)).toMatchObject({ quantity: grams(4), unit: 'count' });
  });

  it('ignores a form whose parent is some other canon item', () => {
    // "garlic clove" text matched to canon Red Onion: the clove form is not this
    // line's, so the canon decides (count) — and the form is not reported.
    const p = parsed({
      item: 'garlic clove',
      quantity: grams(6),
      unit: 'g',
      statedCount: grams(2),
    });
    expect(choose(p, RED_ONION)).toMatchObject({ unit: 'count', form: null });
    expect(choose(p, FLOUR)).toMatchObject({ unit: 'g', form: null });
  });
});

describe('chooseIngredientAmount — otherwise the canon item decides', () => {
  it('reads a counted canon with a stated count as a count plus its weight', () => {
    const p = parsed({ quantity: grams(150), unit: 'g', statedCount: one });
    expect(choose(p, RED_ONION)).toEqual({
      quantity: one,
      unit: 'count',
      measure: { quantity: grams(150), unit: 'g' },
      form: null,
    });
  });

  it('reads a counted canon authored by weight as that weight', () => {
    const p = parsed({ item: 'fennel bulb', quantity: grams(150), unit: 'g' });
    expect(choose(p, RED_ONION)).toEqual({
      quantity: grams(150),
      unit: 'g',
      measure: null,
      form: null,
    });
  });

  it('reads a canon sold by weight as metric, stated count or not', () => {
    const p = parsed({ item: 'plain flour', quantity: grams(120), unit: 'g', statedCount: one });
    expect(choose(p, FLOUR)).toMatchObject({ quantity: grams(120), unit: 'g', measure: null });
  });

  it('reads a canon with no unit set as metric — exactly as before #1643', () => {
    const p = parsed({ item: 'fennel', quantity: grams(150), unit: 'g', statedCount: one });
    expect(choose(p, UNSET)).toMatchObject({ unit: 'g' });
  });

  it('reads a never-matched line as metric — there is nothing to consult', () => {
    const p = parsed({ quantity: grams(150), unit: 'g', statedCount: one });
    expect(choose(p, null)).toMatchObject({ unit: 'g', form: null });
  });

  it('keeps a range a range and a fraction a fraction', () => {
    const range = { type: 'range', min: 2, max: 3 } as const;
    const half = { type: 'mixed', whole: 0, numerator: 1, denominator: 2 } as const;
    expect(
      choose(parsed({ quantity: grams(300), unit: 'g', statedCount: range }), RED_ONION)?.quantity,
    ).toEqual(range);
    expect(
      choose(parsed({ quantity: grams(75), unit: 'g', statedCount: half }), RED_ONION)?.quantity,
    ).toEqual(half);
  });
});

describe('chooseIngredientAmount — legacy shapes read as they always did', () => {
  it('reads a pre-#1643 null-unit line as a count with no weight, whatever the canon prefers', () => {
    const legacy = parsed({ item: 'egg', quantity: grams(2), unit: null });
    const expected = { quantity: grams(2), unit: 'count', measure: null, form: null };
    expect(choose(legacy, RED_ONION)).toEqual(expected);
    expect(choose(legacy, FLOUR)).toEqual(expected);
    expect(choose(legacy, null)).toEqual(expected);
  });

  it('reads a legacy garlic-clove count through its counted form', () => {
    const legacy = parsed({ item: 'garlic clove', quantity: grams(3), unit: null });
    expect(choose(legacy, GARLIC)).toEqual({
      quantity: grams(3),
      unit: 'count',
      measure: null,
      form: GARLIC_CLOVE,
    });
  });

  it('reads a metric line written before statedCount existed as a weight', () => {
    // No `statedCount` key at all — the shape of every production line today.
    const legacy = parsed({ quantity: grams(150), unit: 'g' });
    expect('statedCount' in legacy).toBe(false);
    expect(choose(legacy, RED_ONION)).toMatchObject({ quantity: grams(150), unit: 'g' });
  });

  it('gives nothing for a line with no amount at all', () => {
    expect(choose(parsed({ item: 'flour', displayText: null }), FLOUR)).toBeNull();
  });
});

describe('chooseIngredientAmount — the measure stands only beside a count', () => {
  // The header claims `measure` is only ever set when `unit` is 'count'. Pinned
  // across every shape this file builds rather than asserted once.
  it('never carries a measure on a metric answer', () => {
    const shapes: [ParsedIngredient, CanonItem | null][] = [
      [parsed({ quantity: grams(150), unit: 'g', statedCount: one }), RED_ONION],
      [parsed({ quantity: grams(150), unit: 'g', statedCount: one }), FLOUR],
      [parsed({ quantity: grams(150), unit: 'g' }), RED_ONION],
      [parsed({ item: 'lime juice', quantity: grams(60), unit: 'ml' }), LIME],
      [parsed({ item: 'garlic clove', quantity: grams(9), unit: 'g' }), GARLIC],
      [parsed({ quantity: grams(2), unit: null }), FLOUR],
      [parsed({ quantity: grams(150), unit: 'g', statedCount: one }), null],
    ];
    for (const [p, canon] of shapes) {
      const chosen = choose(p, canon);
      if (chosen !== null && chosen.unit !== 'count') expect(chosen.measure).toBeNull();
    }
  });
});

describe('preferredIngredientUnit', () => {
  it('names the form it decided by, or none', () => {
    expect(preferredIngredientUnit(parsed({ item: 'garlic clove' }), GARLIC, FORMS, CANON)).toEqual(
      {
        unit: 'count',
        form: GARLIC_CLOVE,
      },
    );
    expect(preferredIngredientUnit(parsed({ item: 'lime juice' }), LIME, FORMS, CANON)).toEqual({
      unit: 'metric',
      form: LIME_JUICE,
    });
    expect(preferredIngredientUnit(parsed({}), RED_ONION, FORMS, CANON)).toEqual({
      unit: 'count',
      form: null,
    });
    expect(preferredIngredientUnit(parsed({}), null, FORMS, CANON)).toEqual({
      unit: 'metric',
      form: null,
    });
  });
});

// ─── The #1643 regression, built from the production documents ───────────────
//
// Read from prod (s2-prod-e46bd) on 2026-10-02 and reduced to the fields these
// queries read. "Control Freak and Pressure Cooker Chicken Stock" holds
// "1 roast chicken carcass" parsed to 1500 g; its canon is Chicken (by the
// count); its form is Chicken carcass (counted, one per bird). Before #1643 the
// line resolved its form, could not feed it grams, shopped as "1500 g" — and
// `ingredientMatchIssue` said nothing.
describe('the roast chicken carcass (issue #1643)', () => {
  const CHICKEN: CanonItem = {
    ...CANON_BASE,
    id: '0288c51e-chicken',
    name: 'Chicken',
    unit: 'count',
  };
  const CARCASS: ProductForm = {
    ...FORM_BASE,
    id: '811ab961-carcass',
    label: 'Chicken carcass',
    matchers: ['roast chicken carcass', 'chicken carcass'],
    parentCanonId: CHICKEN.id,
    yield: { formUnit: 'count', amountPerParent: 1 },
  };
  const BREAST: ProductForm = {
    ...FORM_BASE,
    id: '4256c30b-breast',
    label: 'chicken breast',
    matchers: [],
    parentCanonId: CHICKEN.id,
    yield: { formUnit: 'count', amountPerParent: 2 },
  };
  const forms = [CARCASS, BREAST];
  const canonById = new Map([[CHICKEN.id, CHICKEN]]);

  const stored: Ingredient = {
    id: '5ca41f94',
    rawText: '1 roast chicken carcass',
    parsed: {
      quantity: { type: 'single', value: 1500 },
      unit: 'g',
      item: 'roast chicken carcass',
      preparation: [],
      notes: null,
      displayText: '1 roast chicken carcass',
    },
    canonId: CHICKEN.id,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
  };
  const reRead: Ingredient = {
    ...stored,
    parsed: { ...stored.parsed!, quantity: grams(500), statedCount: one, displayText: null },
  };

  it('flags the stored line: a counted form, and only grams to feed it', () => {
    expect(ingredientMatchIssue(stored, canonById, forms)).toBe('missing_count');
  });

  it('reads the re-read line as one carcass, weighed beside it, and stops flagging it', () => {
    expect(chooseIngredientAmount(reRead.parsed!, CHICKEN, forms, [CHICKEN])).toEqual({
      quantity: one,
      unit: 'count',
      measure: { quantity: grams(500), unit: 'g' },
      form: CARCASS,
    });
    expect(ingredientMatchIssue(reRead, canonById, forms)).toBeNull();
  });
});
