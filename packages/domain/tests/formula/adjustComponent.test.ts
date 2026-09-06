import { describe, it, expect } from 'vitest';
import {
  LEAVENING_PERCENT_BOUNDS,
  solveFormula,
  withComponentPercentScaled,
} from '../../src/index.js';
import type { Formula } from '../../src/schemas/index.js';

// "Longer and colder, so I'd take the yeast down to about two-thirds" — the
// proposal's opinion, arriving as a factor and leaving as a percentage through the
// one rounding authority.

const LOAF: Formula = {
  recipeId: 'recipe-1',
  components: [
    { ingredientId: 'flour', percent: 100, inBasis: true },
    { ingredientId: 'water', percent: 70, inBasis: false },
    { ingredientId: 'salt', percent: 2, inBasis: false },
    { ingredientId: 'yeast', percent: 1.2, inBasis: false },
  ],
  referenceYield: { kind: 'basis', grams: 500 },
  schemaVersion: 1,
};

function percentOf(formula: Formula, ingredientId: string): number | undefined {
  return formula.components.find((c) => c.ingredientId === ingredientId)?.percent;
}

describe('withComponentPercentScaled', () => {
  it('multiplies the named component and leaves every other alone', () => {
    const next = withComponentPercentScaled(LOAF, { ingredientId: 'yeast', factor: 0.66 });
    expect(percentOf(next, 'yeast')).toBe(0.792);
    expect(percentOf(next, 'flour')).toBe(100);
    expect(percentOf(next, 'water')).toBe(70);
    expect(percentOf(next, 'salt')).toBe(2);
  });

  it("rounds through the module's one rounding authority", () => {
    // 1.2 × 0.66 is 0.7919999999999999 in binary floating point. A screen must not
    // show that and a solve must not re-derive it differently.
    const next = withComponentPercentScaled(LOAF, { ingredientId: 'yeast', factor: 0.66 });
    expect(String(percentOf(next, 'yeast'))).toBe('0.792');
  });

  it('leaves the original formula untouched', () => {
    withComponentPercentScaled(LOAF, { ingredientId: 'yeast', factor: 0.5 });
    expect(percentOf(LOAF, 'yeast')).toBe(1.2);
  });

  it('returns the formula unchanged for an ingredient it does not hold', () => {
    // An opinion that cannot be applied is simply not applied. The flow already
    // drops an adjustment naming an unknown ingredient; this is total either way.
    expect(withComponentPercentScaled(LOAF, { ingredientId: 'ghost', factor: 0.5 })).toEqual(LOAF);
  });

  it('returns the formula unchanged for a factor that is not a usable number', () => {
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(withComponentPercentScaled(LOAF, { ingredientId: 'yeast', factor })).toEqual(LOAF);
    }
  });

  it('knows nothing about yeast — the bounds are passed in', () => {
    // The function is generic on purpose: the same seam serves a cure's nitrite.
    // Nothing in it names an ingredient, and no bound is stamped unless asked for.
    const next = withComponentPercentScaled(
      LOAF,
      { ingredientId: 'salt', factor: 1.5 },
      {
        maxPercent: 4,
      },
    );
    const salt = next.components.find((c) => c.ingredientId === 'salt');
    expect(salt).toEqual({ ingredientId: 'salt', percent: 3, inBasis: false, maxPercent: 4 });
    expect(next.components.find((c) => c.ingredientId === 'yeast')).toEqual(
      LOAF.components.find((c) => c.ingredientId === 'yeast'),
    );
  });
});

describe('withComponentPercentScaled — the bounds rail', () => {
  // THE RAIL IS THE ONE THAT ALREADY EXISTS (#782). This function declares the
  // bounds; `solveFormula` refuses. There is no second bounds check anywhere.

  it('refuses an absurd proposal through the solve, not through a check of its own', () => {
    const mad = withComponentPercentScaled(
      LOAF,
      { ingredientId: 'yeast', factor: 40 },
      LEAVENING_PERCENT_BOUNDS,
    );
    // The percentage is applied — the function is not a validator.
    expect(percentOf(mad, 'yeast')).toBe(48);
    const solved = solveFormula(mad);
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.reason).toEqual({
      kind: 'boundViolation',
      violations: [
        { ingredientId: 'yeast', percent: 48, bound: 'max', minPercent: 0.2, maxPercent: 2.5 },
      ],
    });
  });

  it('is never a decider inside the sane range', () => {
    // 1.2% down to 0.792% is a long cold ferment and 1.2% up to 1.8% is a hurried
    // one. Both are ordinary, both solve, and the domain has no opinion in the
    // argument between them.
    for (const factor of [0.66, 1.5]) {
      const next = withComponentPercentScaled(
        LOAF,
        { ingredientId: 'yeast', factor },
        LEAVENING_PERCENT_BOUNDS,
      );
      expect(solveFormula(next).ok).toBe(true);
    }
  });

  it('refuses a factor that takes the leavening below the floor', () => {
    const barely = withComponentPercentScaled(
      LOAF,
      { ingredientId: 'yeast', factor: 0.05 },
      LEAVENING_PERCENT_BOUNDS,
    );
    expect(solveFormula(barely).ok).toBe(false);
  });
});
