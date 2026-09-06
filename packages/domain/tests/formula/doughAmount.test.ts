import { describe, it, expect } from 'vitest';
import { doughAmountGrams, targetYield, basisYield, solveFormula } from '../../src/index.js';
import type { Formula } from '../../src/schemas/index.js';

// What a declared dough amount comes to (issue #1274). `doughAmountGrams` is the
// one expression every screen and every solve reads through — see
// `formula/doughAmount.ts` — so the only thing worth pinning here is that it
// really is `count × unitDoughGrams`, and that `solveFormula` resolves a target
// yield through the identical figure.

describe('doughAmountGrams', () => {
  it('is count times unitDoughGrams', () => {
    expect(doughAmountGrams({ count: 2, unitDoughGrams: 900 })).toBe(1800);
    expect(doughAmountGrams({ count: 1, unitDoughGrams: 1400 })).toBe(1400);
  });

  it('is what solveFormula resolves a target yield’s usable grams to', () => {
    const formula: Formula = {
      recipeId: 'recipe-1',
      components: [
        { ingredientId: 'flour', percent: 100, inBasis: true },
        { ingredientId: 'water', percent: 70, inBasis: false },
      ],
      referenceYield: { kind: 'target', shape: { count: 2, unitDoughGrams: 900 } },
      schemaVersion: 1,
    };

    const solved = solveFormula(formula, targetYield({ count: 2, unitDoughGrams: 900 }));
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.solution.usableExactGrams).toBe(
      doughAmountGrams({ count: 2, unitDoughGrams: 900 }),
    );
  });
});

describe('targetYield / basisYield', () => {
  it('targetYield wraps a dough amount as a target-kind reference yield', () => {
    expect(targetYield({ count: 8, unitDoughGrams: 120 })).toEqual({
      kind: 'target',
      shape: { count: 8, unitDoughGrams: 120 },
    });
  });

  it('basisYield wraps a gram figure as a basis-kind reference yield', () => {
    expect(basisYield(2400)).toEqual({ kind: 'basis', grams: 2400 });
  });
});
