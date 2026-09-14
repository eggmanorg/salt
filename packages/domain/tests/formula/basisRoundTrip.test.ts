import { describe, it, expect } from 'vitest';
import { deriveFormula, solveFormula, targetYield } from '../../src/index.js';
import type { FormulaComponentInput } from '../../src/formula/index.js';

// THE RESTATE IS A FIXED POINT, FOR A BASIS OF ANY SIZE (issue #1364) — the
// rule-12 pin that `FormulaPage.yieldWins.test.ts` could not be.
//
// That file asserts the same property against a one-flour basis, where it cannot
// fail: a single basis member is 100% exactly, so the divisor below is exactly 1
// and the arithmetic has nowhere to drift. The interesting case is a basis whose
// members do not round cleanly. Three equal flours land at 33.3333 each, the
// basis sums to 99.9999, and every percentage measured against it used to be
// divided by 0.999999 on each pass — one ten-thousandth of a point per commit,
// forever.
//
// So this file round-trips: derive the percentages from the weights, solve the
// weights back at the declared yield, carry `exactGrams` into the next derive —
// which is exactly what `FormulaPage`'s `rowsRestatedAt` does on every commit —
// and asserts that nothing moves. It goes red the moment the basis stops being
// reconciled to 100.

const TARGET = targetYield({ count: 1, unitDoughGrams: 900 });

/** One commit: derive → solve → the solved exact grams become the next weights. */
function restate(rows: readonly FormulaComponentInput[]): {
  percents: number[];
  rows: FormulaComponentInput[];
} {
  const derived = deriveFormula({ recipeId: 'r', components: rows, referenceYield: TARGET });
  if (!derived.ok) throw new Error(derived.reason.kind);
  const solved = solveFormula(derived.formula);
  if (!solved.ok) throw new Error(solved.reason.kind);
  return {
    percents: derived.formula.components.map((c) => c.percent),
    // `Row.exactGrams` on the page: the unrounded solved figure, not the rounded
    // one the box shows. Carrying less precision here would test a different bug.
    rows: solved.solution.components.map((component, index) => {
      const row = rows[index];
      if (row === undefined) throw new Error(`no row ${index}`);
      return { ...row, grams: component.exactGrams };
    }),
  };
}

function restatedPercentsOverPasses(
  start: readonly FormulaComponentInput[],
  passes: number,
): number[][] {
  const seen: number[][] = [];
  let rows = [...start];
  for (let pass = 0; pass < passes; pass += 1) {
    const next = restate(rows);
    seen.push(next.percents);
    rows = next.rows;
  }
  return seen;
}

const THREE_FLOURS: readonly FormulaComponentInput[] = [
  { ingredientId: 'f1', grams: 200, inBasis: true },
  { ingredientId: 'f2', grams: 200, inBasis: true },
  { ingredientId: 'f3', grams: 200, inBasis: true },
  { ingredientId: 'w', grams: 420, inBasis: false },
];

function basisOf(components: readonly { percent: number; inBasis: boolean }[]): number[] {
  return components.filter((c) => c.inBasis).map((c) => c.percent);
}

describe('a repeated restate over a multi-member basis', () => {
  it('moves no percentage, on any pass', () => {
    const passes = restatedPercentsOverPasses(THREE_FLOURS, 8);
    // The whole defect is that pass 1 looks right and pass 2 does not, so the
    // assertion has to be every pass against the first, not the first alone.
    expect(passes[0]).toEqual([33.3334, 33.3333, 33.3333, 70]);
    for (const percents of passes) expect(percents).toEqual([33.3334, 33.3333, 33.3333, 70]);
  });

  it('leaves the single-flour control alone — the shape the old pin was written in', () => {
    const single: readonly FormulaComponentInput[] = [
      { ingredientId: 'flour', grams: 500, inBasis: true },
      { ingredientId: 'water', grams: 350, inBasis: false },
      { ingredientId: 'salt', grams: 10, inBasis: false },
      { ingredientId: 'yeast', grams: 7, inBasis: false },
    ];
    for (const percents of restatedPercentsOverPasses(single, 6)) {
      expect(percents).toEqual([100, 70, 2, 1.4]);
    }
  });
});

describe('deriveFormula reconciles the basis to exactly 100', () => {
  it('hands the rounding residual to one basis member rather than losing it', () => {
    const derived = deriveFormula({ recipeId: 'r', components: THREE_FLOURS });
    if (!derived.ok) throw new Error(derived.reason.kind);
    // 33.3333 × 3 is 99.9999. Largest remainder gives the missing ten-thousandth
    // to the first member, which is the stated cost: that figure now depends on
    // its neighbours (see `rounding.ts`).
    expect(basisOf(derived.formula.components)).toEqual([33.3334, 33.3333, 33.3333]);
    expect(basisOf(derived.formula.components).reduce((sum, p) => sum + p, 0)).toBe(100);
  });

  // WHERE "SUMS TO 100" IS EXACT, AND WHERE IT IS NOT — the boundary, stated
  // rather than asserted away. The reconciliation is exact in the ten-thousandths
  // `roundPercent` stores: the basis members' unit counts sum to 1 000 000, on
  // every split, always. Adding those stored floats back up in IEEE 754 is a
  // separate act and can land one ULP off — a seven-way split sums to
  // 100.00000000000001 — which is why the assertion below counts units and the
  // float sum is checked to within an ULP rather than to the bit. Inert
  // downstream: `solveFormula` compares that float sum to 100 with
  // `BASIS_PERCENT_TOLERANCE`, four hundred billion times the gap.
  it('reconciles every basis to exactly 100, however the split rounds', () => {
    const splits: readonly (readonly number[])[] = [
      [200, 200, 200],
      [100, 100, 100, 100, 100, 100, 100],
      [1, 1, 1],
      [350, 150],
      [333, 333, 334],
      [500],
      [17, 83, 111, 9],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    ];
    for (const split of splits) {
      const derived = deriveFormula({
        recipeId: 'r',
        components: [
          ...split.map((grams, index) => ({ ingredientId: `b${index}`, grams, inBasis: true })),
          { ingredientId: 'w', grams: 420, inBasis: false },
        ],
      });
      if (!derived.ok) throw new Error(derived.reason.kind);
      const basis = basisOf(derived.formula.components);
      const units = basis.reduce((total, p) => total + Math.round(p * 10 ** 4), 0);
      // Reported with the split so a failure names which one broke.
      expect({ split, units }).toEqual({ split, units: 100 * 10 ** 4 });
      expect(Math.abs(basis.reduce((total, p) => total + p, 0) - 100)).toBeLessThan(
        Number.EPSILON * 100,
      );
    }
  });

  // WHICH MEMBER GETS THE RESIDUAL, pinned (issue #1370). Every other assertion in
  // this file is blind to that: the sums are unchanged whoever carries it, and the
  // fixtures above are exact ties, where a stable sort hands it to the first member
  // from either end. So reversing the comparator in `reconciledBasisPercents` used
  // to leave this whole suite green while giving the unit to the member that lost
  // LEAST of one — the opposite of largest remainder, and every basis member on the
  // far side of its true share. This split has no tie: the remainders are 0.6667,
  // 0.3333 and 0 for one unit to hand out.
  it('hands the residual to the largest remainder, not merely to someone', () => {
    const derived = deriveFormula({
      recipeId: 'r',
      components: [
        { ingredientId: 'b0', grams: 1, inBasis: true },
        { ingredientId: 'b1', grams: 2, inBasis: true },
        { ingredientId: 'b2', grams: 3, inBasis: true },
      ],
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    // b0 lost the most to the floor and is rounded UP; b2 is exact and is left
    // alone. Smallest-remainder-first would read [16.6666, 33.3333, 50.0001].
    expect(basisOf(derived.formula.components)).toEqual([16.6667, 33.3333, 50]);
  });

  it('never moves a basis member further than one ten-thousandth off its true share', () => {
    const split = [100, 100, 100, 100, 100, 100, 100];
    const derived = deriveFormula({
      recipeId: 'r',
      components: split.map((grams, index) => ({
        ingredientId: `b${index}`,
        grams,
        inBasis: true,
      })),
    });
    if (!derived.ok) throw new Error(derived.reason.kind);
    // Reconciliation is not licence to move a figure: every member is still its
    // own share to the last place `roundPercent` keeps.
    for (const component of derived.formula.components) {
      expect(Math.abs(component.percent - 100 / split.length)).toBeLessThanOrEqual(0.0001);
    }
  });
});
