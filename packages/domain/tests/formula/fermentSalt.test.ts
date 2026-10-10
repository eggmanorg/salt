import { describe, it, expect } from 'vitest';
import {
  FERMENT_SALT_RANGES,
  deriveFormula,
  fermentSaltNote,
  hasFermentSaltRange,
  solveFormula,
  statedStrength,
} from '../../src/index.js';
import type { FormulaComponent, RecipeKindDoc } from '../../src/schemas/index.js';
import { RecipeKindSchema } from '../../src/schemas/index.js';

// A ferment's salt outside its usual range gets a note (issue #1657, phase 3). The
// figures are the issue's: a kraut salted at 1% of the cabbage, and a pickle at 6% of
// the water.

const component = (patch: Partial<FormulaComponent> & { ingredientId: string }) =>
  ({
    percent: 0,
    inBasis: false,
    stageId: null,
    statedOf: null,
    ...patch,
  }) satisfies FormulaComponent;

/** A dry-salted kraut: the cabbage is the basis, the salt `percent` of it. */
const kraut = (percent: number, saltProduct: FormulaComponent['saltProduct'] | null = 'plain') => [
  component({ ingredientId: 'ing-cabbage', percent: 100, inBasis: true }),
  component({
    ingredientId: 'ing-salt',
    percent,
    ...(saltProduct === null ? {} : { saltProduct }),
  }),
];

/** A brined pickle, cucumbers and water half each, salt `ofWater` percent of the water. */
const pickle = (ofWater: number) => [
  component({ ingredientId: 'ing-cucumber', percent: 50, inBasis: true }),
  component({ ingredientId: 'ing-water', percent: 50, inBasis: true }),
  component({
    ingredientId: 'ing-salt',
    percent: ofWater / 2,
    saltProduct: 'plain',
    statedOf: 'ing-water',
  }),
];

const noteOn = (components: FormulaComponent[], kind: RecipeKindDoc = 'ferment') =>
  fermentSaltNote({ kind, components });

describe('FERMENT_SALT_RANGES', () => {
  it('holds the two starting ranges the issue names', () => {
    expect(FERMENT_SALT_RANGES.ofBasis).toEqual({ minPercent: 1.5, maxPercent: 3 });
    expect(FERMENT_SALT_RANGES.ofMember).toEqual({ minPercent: 2, maxPercent: 5 });
  });
});

describe('hasFermentSaltRange', () => {
  it('answers for every kind, and only a ferment has a range', () => {
    // Read off the schema, so a new kind is asked here on the day it is added.
    const withRange = RecipeKindSchema.options.filter(hasFermentSaltRange);
    expect(withRange).toEqual(['ferment']);
  });
});

describe('fermentSaltNote — against the whole basis', () => {
  it('notes a kraut salted at 1% of the cabbage as below 1.5–3%', () => {
    expect(noteOn(kraut(1))).toEqual({
      kind: 'below',
      ingredientId: 'ing-salt',
      statedOf: null,
      percent: 1,
      range: FERMENT_SALT_RANGES.ofBasis,
    });
  });

  it('notes a kraut at 4% as above', () => {
    expect(noteOn(kraut(4))).toMatchObject({ kind: 'above', percent: 4, statedOf: null });
  });

  it('is silent at both edges and between them', () => {
    expect(noteOn(kraut(1.5))).toEqual({ kind: 'ok' });
    expect(noteOn(kraut(2))).toEqual({ kind: 'ok' });
    expect(noteOn(kraut(3))).toEqual({ kind: 'ok' });
  });

  it('compares the figure as the screen prints it, to one decimal', () => {
    // 3.04 prints as "3%" — a note calling that above 3 would contradict the figure.
    expect(noteOn(kraut(3.04))).toEqual({ kind: 'ok' });
    expect(noteOn(kraut(1.46))).toEqual({ kind: 'ok' });
    // One printed tenth outside is outside.
    expect(noteOn(kraut(3.1))).toMatchObject({ kind: 'above' });
    expect(noteOn(kraut(1.4))).toMatchObject({ kind: 'below' });
    // 1.45 prints as "1.4%" (`toFixed` at a binary half-point), so it is below — a
    // `Math.round` comparison would read it as 1.5 and fall silent beside "1.4%".
    expect((1.45).toFixed(1)).toBe('1.4');
    expect(noteOn(kraut(1.45))).toMatchObject({ kind: 'below' });
  });

  it('measures a brined jar stated against everything in it on the basis range', () => {
    // 1 kg cabbage + 0.8 kg water at 2% of the basis: inside, so silent.
    const jar = [
      component({ ingredientId: 'ing-cabbage', percent: 55.5556, inBasis: true }),
      component({ ingredientId: 'ing-water', percent: 44.4444, inBasis: true }),
      component({ ingredientId: 'ing-salt', percent: 2, saltProduct: 'plain' }),
    ];
    expect(noteOn(jar)).toEqual({ kind: 'ok' });
    // The same jar at 1% of the basis is 2.25% of the water — inside 2–5%, yet it is
    // stated against the basis, so the basis range speaks.
    const thin = jar.map((c) => (c.ingredientId === 'ing-salt' ? { ...c, percent: 1 } : c));
    expect(noteOn(thin)).toMatchObject({ kind: 'below', statedOf: null, percent: 1 });
  });
});

describe('fermentSaltNote — against one member', () => {
  it('notes a pickle at 6% of the water as above 2–5%', () => {
    expect(noteOn(pickle(6))).toEqual({
      kind: 'above',
      ingredientId: 'ing-salt',
      statedOf: 'ing-water',
      percent: 6,
      range: FERMENT_SALT_RANGES.ofMember,
    });
  });

  it('uses the member range, not the basis range — 3% of the water is 1.5% of the basis', () => {
    expect(noteOn(pickle(3))).toEqual({ kind: 'ok' });
    // 4% of the water is 2% of the basis; 1.8% of the water is 0.9% of the basis.
    expect(noteOn(pickle(4))).toEqual({ kind: 'ok' });
    expect(noteOn(pickle(1.8))).toMatchObject({ kind: 'below', statedOf: 'ing-water' });
  });

  it('is silent at both edges, including a strength read back a ten-thousandth high', () => {
    expect(noteOn(pickle(2))).toEqual({ kind: 'ok' });
    expect(noteOn(pickle(5))).toEqual({ kind: 'ok' });
    // 35 g of salt on 700 g of water (and 907 g of cucumbers), through the real
    // derive: the two stored four-decimal percentages read back as 5.0001% of the
    // water, which the screen prints as "5%".
    const derived = deriveFormula({
      recipeId: 'r',
      components: [
        { ingredientId: 'ing-cucumber', grams: 907, inBasis: true },
        { ingredientId: 'ing-water', grams: 700, inBasis: true },
        {
          ingredientId: 'ing-salt',
          grams: 35,
          inBasis: false,
          saltProduct: 'plain',
          statedOf: 'ing-water',
        },
      ],
    });
    if (!derived.ok) throw new Error('fixture');
    const salt = derived.formula.components.find((c) => c.ingredientId === 'ing-salt');
    if (salt === undefined) throw new Error('fixture');
    // Not vacuous: the strength really does read above the edge.
    expect(statedStrength(salt, derived.formula.components)?.percent).toBeGreaterThan(5);
    expect(noteOn(derived.formula.components)).toEqual({ kind: 'ok' });
  });

  it('reads a statedOf naming nothing measurable as a percentage of the basis', () => {
    const orphan = pickle(6).map((c) =>
      c.ingredientId === 'ing-salt' ? { ...c, statedOf: 'ing-gone' } : c,
    );
    // 3% of the basis: inside 1.5–3%, so the stale name does not borrow 2–5%.
    expect(noteOn(orphan)).toEqual({ kind: 'ok' });
  });
});

describe('fermentSaltNote — silences', () => {
  it('says nothing about the same figures on any kind but a ferment', () => {
    for (const kind of RecipeKindSchema.options) {
      if (kind === 'ferment') continue;
      expect(noteOn(kraut(1), kind)).toEqual({ kind: 'ok' });
      expect(noteOn(pickle(6), kind)).toEqual({ kind: 'ok' });
    }
  });

  it('says nothing when no line is named Plain salt', () => {
    expect(noteOn(kraut(1, null))).toEqual({ kind: 'ok' });
  });

  it('never reads a curing salt as the salt', () => {
    expect(noteOn(kraut(0.25, 'cure1'))).toEqual({ kind: 'ok' });
  });

  it('speaks about the first plain salt only, never a sum of two', () => {
    const two = [
      ...kraut(1),
      component({ ingredientId: 'ing-salt-2', percent: 1, saltProduct: 'plain' }),
    ];
    expect(noteOn(two)).toMatchObject({ kind: 'below', ingredientId: 'ing-salt', percent: 1 });
  });

  it('is a note, never a refusal — a noted formula still solves', () => {
    // The range is not a bound: nothing is stamped, so the one rail stays silent.
    const derived = deriveFormula({
      recipeId: 'r',
      components: [
        { ingredientId: 'ing-cabbage', grams: 1000, inBasis: true },
        { ingredientId: 'ing-salt', grams: 10, inBasis: false, saltProduct: 'plain' },
      ],
    });
    if (!derived.ok) throw new Error('fixture');
    expect(noteOn(derived.formula.components)).toMatchObject({ kind: 'below' });
    const salt = derived.formula.components.find((c) => c.ingredientId === 'ing-salt');
    expect(salt?.minPercent).toBeUndefined();
    expect(salt?.maxPercent).toBeUndefined();
    expect(solveFormula(derived.formula).ok).toBe(true);
  });
});
