import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DOUGH_DEPTH_CM,
  basisYield,
  doughAmountGrams,
  doughGramsFromArea,
  doughGramsFromVolumeMl,
  solveFormula,
  targetYield,
} from '../../src/index.js';
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

// ─── The one guessed number (issue #1274 phase 2, rule-12 claim 3) ─────────────
//
// THE CLAIM AND ITS BOUNDARY, together: the tray coefficient is a DOMESTIC
// STARTING POINT, right to within ~15% on the two anchors anyone can check, and
// not a fact. These tests assert exactly that and no more — they are not a
// pretence that 0.45 g/ml is measured, they are the check that it has not drifted
// away from the two vessels we can reason about.
//
// The tolerance is deliberately loose because the claim is loose. A tight
// assertion here would be a stronger statement than anyone can make, and the
// figure is one editable box away from mattering anyway.
describe('an un-named vessel, by measurement', () => {
  const WITHIN = 0.15;

  function assertWithin(actual: number, anchor: number, what: string): void {
    const drift = Math.abs(actual - anchor) / anchor;
    expect(drift, `${what}: ${actual.toFixed(0)} g against ~${anchor} g`).toBeLessThanOrEqual(
      WITHIN,
    );
  }

  it('lands a 2 litre dish near the ~900 g of dough one takes', () => {
    assertWithin(doughGramsFromVolumeMl(2000), 900, 'a 2 l dish');
  });

  it('lands a 30 × 40 cm tray near the ~1000 g a real focaccia weighs', () => {
    assertWithin(doughGramsFromArea(30, 40), 1000, 'a 30 × 40 cm tray at the default depth');
  });

  it('gives the same answer whichever way the same vessel is described', () => {
    // The reason there is ONE coefficient over volume rather than two. A second,
    // area-based one would disagree with this by up to 70% on the same tray
    // depending which path the user happened to take, which is a trap.
    expect(doughGramsFromArea(30, 40, 2)).toBeCloseTo(doughGramsFromVolumeMl(30 * 40 * 2), 9);
    expect(doughGramsFromArea(20, 25, 4)).toBeCloseTo(doughGramsFromVolumeMl(2000), 9);
  });

  it('fills a tray to the dough, not to its walls', () => {
    // A tray is not filled to the top. Asking for the pan's wall height reads
    // about 70% high, which is why the default is a DOUGH depth.
    expect(DEFAULT_DOUGH_DEPTH_CM).toBe(2);
    expect(doughGramsFromArea(30, 40)).toBe(doughGramsFromArea(30, 40, DEFAULT_DOUGH_DEPTH_CM));
  });

  it('scales linearly, so twice the vessel is twice the dough', () => {
    expect(doughGramsFromVolumeMl(4000)).toBeCloseTo(2 * doughGramsFromVolumeMl(2000), 9);
    expect(doughGramsFromArea(30, 40, 4)).toBeCloseTo(2 * doughGramsFromArea(30, 40, 2), 9);
  });

  it('does not touch a named tin — a UK tin is already sold by the dough it takes', () => {
    // 900 g of tin is 900 g of dough, directly. Running it through the coefficient
    // would replace a convention that is right with an estimate that is not, and
    // this is what that difference looks like.
    expect(doughGramsFromVolumeMl(900)).not.toBeCloseTo(900, 0);
  });
});
