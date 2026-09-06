import { describe, it, expect } from 'vitest';
import { deriveFormula, solveFormula, targetYield } from '../../src/index.js';
import type { Formula } from '../../src/schemas/index.js';
import { basisYield } from '../../src/formula/index.js';

// The solve read from the other end, and the ways it refuses.

const MEAT = 'ing-pork-collar';
const CURE_SALT = 'ing-sea-salt';
const SUGAR = 'ing-demerara';

// A coppa, the degenerate basis: one member at 100%. You do not choose the yield
// — you unwrap the meat and it weighs what it weighs.
function coppa(): Formula {
  return {
    recipeId: 'coppa',
    components: [
      { ingredientId: MEAT, percent: 100, inBasis: true },
      { ingredientId: CURE_SALT, percent: 2.75, inBasis: false },
      { ingredientId: SUGAR, percent: 0.5, inBasis: false },
    ],
    referenceYield: { kind: 'basis', grams: 1000 },
    schemaVersion: 1,
  };
}

describe('basis-driven solve', () => {
  it('answers a 2.4 kg green weight, with no ferment or cure in existence', () => {
    const solved = solveFormula(coppa(), basisYield(2400));
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const { solution } = solved;

    expect(solution.basisGrams).toBe(2400);
    // 2.75% of 2 400 g is 66 g of salt; 0.5% is 12 g of sugar.
    expect(solution.components.find((c) => c.ingredientId === CURE_SALT)?.grams).toBe(66);
    expect(solution.components.find((c) => c.ingredientId === SUGAR)?.grams).toBe(12);
    expect(solution.totalGrams).toBe(2478);
  });

  it('has no units to report — weighing the meat says nothing about how many', () => {
    const solved = solveFormula(coppa(), basisYield(2400));
    if (!solved.ok) throw new Error(solved.reason.kind);
    expect(solved.solution.units).toBeNull();
  });

  it('leaves the total intact — there is no handling allowance to separate them (#1274)', () => {
    const solved = solveFormula(coppa(), basisYield(2400));
    if (!solved.ok) throw new Error(solved.reason.kind);
    expect(solved.solution.usableGrams).toBe(solved.solution.totalGrams);
  });
});

describe('the two directions are the same equation', () => {
  it('round-trips: solve for a target, feed the basis back, get the same dough', () => {
    const derived = deriveFormula({
      recipeId: 'focaccia',
      components: [
        { ingredientId: 'ing-flour', grams: 500, inBasis: true },
        { ingredientId: 'ing-water', grams: 400, inBasis: false },
        { ingredientId: 'ing-salt', grams: 12, inBasis: false },
        { ingredientId: 'ing-oil', grams: 90, inBasis: false },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);

    const forward = solveFormula(derived.formula, targetYield({ count: 2, unitDoughGrams: 900 }));
    if (!forward.ok) throw new Error(forward.reason.kind);

    const backward = solveFormula(derived.formula, basisYield(forward.solution.basisExactGrams));
    if (!backward.ok) throw new Error(backward.reason.kind);

    expect(backward.solution.totalExactGrams).toBeCloseTo(forward.solution.totalExactGrams, 9);
    // No handling allowance since #1274: usable is exactly the total, 2 × 900 g.
    expect(backward.solution.usableExactGrams).toBeCloseTo(1800, 9);
    expect(backward.solution.components.map((c) => c.grams)).toEqual(
      forward.solution.components.map((c) => c.grams),
    );
  });
});

describe('a solve that cannot be satisfied', () => {
  it('refuses a formula with nothing in it', () => {
    const solved = solveFormula({ ...coppa(), components: [] });
    expect(solved).toEqual({ ok: false, reason: { kind: 'emptyFormula' } });
  });

  it('refuses a formula with no basis — there is no 100% to be a percentage of', () => {
    const formula = coppa();
    const solved = solveFormula({
      ...formula,
      components: formula.components.map((c) => ({ ...c, inBasis: false })),
    });
    expect(solved).toEqual({ ok: false, reason: { kind: 'noBasis' } });
  });

  it('refuses a basis that has been edited off 100%, and says what it sums to', () => {
    const formula = coppa();
    const solved = solveFormula({
      ...formula,
      components: formula.components.map((c) => (c.inBasis ? { ...c, percent: 70 } : c)),
    });
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.reason).toEqual({ kind: 'basisNotNormalised', sumPercent: 70 });
  });

  it('tolerates the rounding noise of a three-way basis split', () => {
    const derived = deriveFormula({
      recipeId: 'three-flours',
      components: [
        { ingredientId: 'ing-a', grams: 100, inBasis: true },
        { ingredientId: 'ing-b', grams: 100, inBasis: true },
        { ingredientId: 'ing-c', grams: 100, inBasis: true },
        { ingredientId: 'ing-water', grams: 210, inBasis: false },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    // 33.3333 × 3 = 99.9999, which is a basis and must not be refused.
    expect(derived.formula.components.slice(0, 3).map((c) => c.percent)).toEqual([
      33.3333, 33.3333, 33.3333,
    ]);
    expect(solveFormula(derived.formula).ok).toBe(true);
  });

  it('never returns NaN or a negative gram figure for a nonsense yield', () => {
    for (const grams of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
      const solved = solveFormula(coppa(), { kind: 'basis', grams });
      expect(solved.ok).toBe(false);
      if (solved.ok) continue;
      expect(solved.reason.kind).toBe('unsolvableYield');
    }
  });
});

describe('the bound seam', () => {
  // No bound VALUE ships in this phase; these declare one in the test to prove
  // the enforcement exists. Phase 04's nitrite limits are the load-bearing
  // customer — the scaler must refuse rather than extrapolate, and that must not
  // be a decision a screen can be talked out of.
  const YEAST = 'ing-instant-yeast';

  function loafWithYeastRail(yeastPercent: number): Formula {
    return {
      recipeId: 'rail-loaf',
      components: [
        { ingredientId: 'ing-flour', percent: 100, inBasis: true },
        { ingredientId: 'ing-water', percent: 70, inBasis: false },
        {
          ingredientId: YEAST,
          percent: yeastPercent,
          inBasis: false,
          minPercent: 0.2,
          maxPercent: 2,
        },
      ],
      referenceYield: { kind: 'basis', grams: 500 },
      schemaVersion: 1,
    };
  }

  it('resolves normally inside the rail', () => {
    expect(solveFormula(loafWithYeastRail(1.4)).ok).toBe(true);
  });

  it('refuses above the rail, and says enough for a caller to re-propose', () => {
    const solved = solveFormula(loafWithYeastRail(3));
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.reason).toEqual({
      kind: 'boundViolation',
      violations: [
        { ingredientId: YEAST, percent: 3, bound: 'max', minPercent: 0.2, maxPercent: 2 },
      ],
    });
  });

  it('refuses below the rail too', () => {
    const solved = solveFormula(loafWithYeastRail(0.05));
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    if (solved.reason.kind !== 'boundViolation') throw new Error(solved.reason.kind);
    expect(solved.reason.violations[0]?.bound).toBe('min');
  });

  it('refuses rather than extrapolating — no grams come back at all', () => {
    const solved = solveFormula(loafWithYeastRail(3), basisYield(10_000));
    expect(solved.ok).toBe(false);
  });
});
