import type {
  DensityClass,
  Formula,
  FormulaComponent,
  ReferenceYield,
} from '../schemas/formula.js';
import type { FormulaFailure } from './failure.js';
import { roundPercent } from './rounding.js';

// Turn a recipe's gram figures plus a basis selection into percentages — the one
// direction that creates a formula (issue #782). Everything else in this module
// reads percentages back out.

export type FormulaComponentInput = {
  ingredientId: string;
  // Required, always. There is exactly one scaling mechanism: an ingredient
  // either carries a gram figure or is not a component. A second "passthrough"
  // set scaling on a plain yield ratio would give you 1.68 eggs at a 1.68× yield
  // and then need its own rounding rule; and a trace ingredient — 5 ml of oil for
  // greasing the bowl — would be scaled to 8.4 ml, which nobody wants. Those
  // arrive with no amount at all, `gramsFromParsed` returns null for them, and the
  // caller simply leaves them out.
  grams: number;
  inBasis: boolean;
  density?: DensityClass;
  minPercent?: number;
  maxPercent?: number;
};

export type DeriveFormulaInput = {
  recipeId: string;
  components: readonly FormulaComponentInput[];
  // Defaults to the basis weight the percentages were derived at, which is the
  // honest reference: these ratios came from this much flour. A caller that knows
  // the recipe as written makes 2 × 900 g of dough can say so instead.
  referenceYield?: ReferenceYield;
};

export type DeriveFormulaResult =
  { ok: true; formula: Formula } | { ok: false; reason: FormulaFailure };

/**
 * Derive a formula from grams. Pure; no clock, no I/O, no throw.
 *
 * The basis members' percentages sum to 100 by construction, so the result is
 * always solvable by `solveFormula` — a formula only becomes unnormalised once a
 * human edits it.
 */
export function deriveFormula(input: DeriveFormulaInput): DeriveFormulaResult {
  const { recipeId, components, referenceYield } = input;

  if (components.length === 0) return { ok: false, reason: { kind: 'emptyFormula' } };

  for (const component of components) {
    if (!Number.isFinite(component.grams) || component.grams <= 0) {
      return {
        ok: false,
        reason: {
          kind: 'invalidAmount',
          ingredientId: component.ingredientId,
          grams: component.grams,
        },
      };
    }
  }

  const basisGrams = components
    .filter((component) => component.inBasis)
    .reduce((sum, component) => sum + component.grams, 0);
  if (basisGrams <= 0) return { ok: false, reason: { kind: 'noBasis' } };

  const derived: FormulaComponent[] = components.map((component) => ({
    ingredientId: component.ingredientId,
    percent: roundPercent((component.grams / basisGrams) * 100),
    inBasis: component.inBasis,
    ...(component.density !== undefined ? { density: component.density } : {}),
    ...(component.minPercent !== undefined ? { minPercent: component.minPercent } : {}),
    ...(component.maxPercent !== undefined ? { maxPercent: component.maxPercent } : {}),
  }));

  return {
    ok: true,
    formula: {
      recipeId,
      components: derived,
      referenceYield: referenceYield ?? { kind: 'basis', grams: basisGrams },
      schemaVersion: 1,
    },
  };
}
