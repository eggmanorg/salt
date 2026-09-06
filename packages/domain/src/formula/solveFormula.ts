import type { Formula, FormulaComponent, ReferenceYield } from '../schemas/formula.js';
import type { BoundViolation, FormulaFailure } from './failure.js';
import { roundGrams } from './rounding.js';
import { doughAmountGrams } from './doughAmount.js';

// The bidirectional yield solve (issue #782). One equation, two unknowns you can
// choose between:
//
//   total = basis × (Σ all percentages ÷ 100)
//
//   - target-driven (bread): "12 × 120 g" of dough is known → solve for basis.
//   - basis-driven (ferments, cures): the meat weighs 2.4 kg → solve for total.
//
// Both ship together and neither is privileged in the types, because building the
// target direction alone bakes "yield is the input" into the shape and is awkward
// to unpick — the same argument the contract doc makes.

// Basis percentages are compared to 100 with this tolerance, in percentage
// points. Derived percentages are rounded to four decimals, so a three-way basis
// split lands at 99.9999 and must not be refused.
export const BASIS_PERCENT_TOLERANCE = 0.01;

export type SolvedComponent = {
  ingredientId: string;
  percent: number;
  // What you weigh, through the one rounding authority.
  grams: number;
  // The same figure unrounded, for anything that needs to compute rather than
  // display — and so no caller ever needs to re-derive it and round differently.
  exactGrams: number;
};

export type SolvedUnits = {
  count: number;
  // DOUGH weight per unit — what you scale onto the bench, echoed back from the
  // declared amount so a caller holding only the solution can still say what it
  // makes. There is no baked figure beside it and there is not meant to be
  // (issue #1274): see `DoughAmountSchema`.
  unitDoughGrams: number;
};

export type FormulaSolution = {
  // The 100%: the flours, the vegetables, the green weight.
  basisGrams: number;
  basisExactGrams: number;
  // Everything weighed into the bowl.
  totalGrams: number;
  totalExactGrams: number;
  // What is actually portioned. EQUAL to the total, always, since #1274 deleted
  // the handling allowance that was the only thing that ever separated them — the
  // two names survive because they are two different questions, and a loss
  // allowance built against a real requirement (#778 phase 04's trim loss) is
  // where they would part company again.
  usableGrams: number;
  usableExactGrams: number;
  components: SolvedComponent[];
  // Null for a basis-driven solve: weighing the meat says nothing about how many
  // of anything you end up with.
  units: SolvedUnits | null;
};

export type SolveFormulaResult =
  { ok: true; solution: FormulaSolution } | { ok: false; reason: FormulaFailure };

function boundViolationsIn(components: readonly FormulaComponent[]): BoundViolation[] {
  const violations: BoundViolation[] = [];
  for (const component of components) {
    const { ingredientId, percent, minPercent, maxPercent } = component;
    // Both declared bounds ride along on either violation, so a caller can show
    // the window that was missed rather than just the edge that was hit.
    const declared = {
      ...(minPercent !== undefined ? { minPercent } : {}),
      ...(maxPercent !== undefined ? { maxPercent } : {}),
    };
    if (minPercent !== undefined && percent < minPercent) {
      violations.push({ ingredientId, percent, bound: 'min', ...declared });
    } else if (maxPercent !== undefined && percent > maxPercent) {
      violations.push({ ingredientId, percent, bound: 'max', ...declared });
    }
  }
  return violations;
}

/**
 * Resolve a formula's percentages into grams at a given yield.
 *
 * The yield defaults to the formula's own `referenceYield`, which is the same
 * type — asking for "the recipe as written" and asking for twelve rolls are the
 * same call with a different argument.
 *
 * Pure and total: no clock, no I/O, no throw, and never a NaN or a negative gram
 * figure — anything that would produce one comes back as a typed failure instead.
 */
export function solveFormula(
  formula: Formula,
  atYield: ReferenceYield = formula.referenceYield,
): SolveFormulaResult {
  const { components } = formula;

  if (components.length === 0) return { ok: false, reason: { kind: 'emptyFormula' } };

  const basisComponents = components.filter((component) => component.inBasis);
  if (basisComponents.length === 0) return { ok: false, reason: { kind: 'noBasis' } };

  const sumBasisPercent = basisComponents.reduce((sum, c) => sum + c.percent, 0);
  if (Math.abs(sumBasisPercent - 100) > BASIS_PERCENT_TOLERANCE) {
    return { ok: false, reason: { kind: 'basisNotNormalised', sumPercent: sumBasisPercent } };
  }

  // Bounds are checked against the stored percentages, which is the whole point:
  // scaling is linear, so a percentage that is unsafe at 500 g of flour is unsafe
  // at 841 g. The solve refuses to hand out grams at all rather than extrapolate.
  const violations = boundViolationsIn(components);
  if (violations.length > 0) {
    return { ok: false, reason: { kind: 'boundViolation', violations } };
  }

  const sumAllPercent = components.reduce((sum, c) => sum + c.percent, 0);

  let basisExactGrams: number;
  let totalExactGrams: number;
  let usableExactGrams: number;
  let units: SolvedUnits | null = null;

  if (atYield.kind === 'basis') {
    basisExactGrams = atYield.grams;
    totalExactGrams = basisExactGrams * (sumAllPercent / 100);
    usableExactGrams = totalExactGrams;
  } else {
    // `shape` is the wire key; the thing is a `DoughAmount` (see
    // `schemas/formula.ts` for why the JSON spelling is deliberately stale).
    const { shape } = atYield;
    usableExactGrams = doughAmountGrams(shape);
    totalExactGrams = usableExactGrams;
    basisExactGrams = totalExactGrams / (sumAllPercent / 100);
    units = { count: shape.count, unitDoughGrams: shape.unitDoughGrams };
  }

  const derived = [basisExactGrams, totalExactGrams, usableExactGrams];
  if (!derived.every((grams) => Number.isFinite(grams) && grams > 0)) {
    return {
      ok: false,
      reason: {
        kind: 'unsolvableYield',
        detail: `yield resolved to basis ${basisExactGrams} g / total ${totalExactGrams} g`,
      },
    };
  }

  return {
    ok: true,
    solution: {
      basisGrams: roundGrams(basisExactGrams),
      basisExactGrams,
      totalGrams: roundGrams(totalExactGrams),
      totalExactGrams,
      usableGrams: roundGrams(usableExactGrams),
      usableExactGrams,
      components: components.map((component) => {
        const exactGrams = basisExactGrams * (component.percent / 100);
        return {
          ingredientId: component.ingredientId,
          percent: component.percent,
          grams: roundGrams(exactGrams),
          exactGrams,
        };
      }),
      units,
    },
  };
}
