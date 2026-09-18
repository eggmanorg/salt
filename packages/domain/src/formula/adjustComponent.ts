import type { Formula } from '../schemas/formula.js';
import { roundPercent } from './rounding.js';

// Applying a proposed adjustment to one component's percentage (issue #812, phase
// 2 of epic #778). The domain half of "yeast is an opinion, not a calculation":
// `proposeSchedule` says what it would do and why, in words, and hands over a
// MULTIPLICATIVE FACTOR; this is where that factor becomes a number, and it is the
// only place it does.
//
// GENERIC ON PURPOSE. Nothing here knows what yeast is. It takes an ingredient id,
// a factor and — optionally — the bounds to declare on the way through, so the
// same seam serves a cure's nitrite as well as a loaf's leavening. The concrete
// bread figures live in `LEAVENING_PERCENT_BOUNDS` below: checked-in reference
// data in `domain`, not a service and not a branch in the logic.
//
// ─── THE BOUNDS RAIL IS THE ONE THAT ALREADY EXISTS ────────────────────────────
//
// `minPercent`/`maxPercent` have been on `FormulaComponentSchema` since #782, and
// `solveFormula` already REFUSES on a violation (`boundViolationsIn` →
// `{ kind: 'boundViolation' }`). So this function does not check anything: it
// STAMPS the bounds onto the component it adjusted and lets the existing solve
// refuse. No second rail, no new failure type, and `freezeBatch` surfaces it as
// the `unsolvableFormula` it already surfaces every other solve refusal as.
//
// The rail catches the ABSURD — a factor of 40 that would put the yeast at 25% of
// the flour — and it is NEVER A DECIDER INSIDE THE RANGE. Between 0.2% and 2.5% of
// flour the baker and the model are having an argument about judgement, and the
// domain has no opinion in it.
//
// PURE and TOTAL: a new `Formula` back every time, the original untouched, no
// throw. A factor that is not a usable number, or an id the formula does not hold,
// returns the formula UNCHANGED rather than failing — an adjustment is an opinion
// offered, and an opinion that cannot be applied is simply not applied.
//
// ─── A NAMED PRODUCT REFUSES THE STAMP TOO (issue #1402 review, blocking 1) ────
//
// `boundsOn` in `deriveFormula` is documented as "the ONE place a bound is
// decided" — but this function was a second one in practice. It stamps
// `minPercent`/`maxPercent` straight onto whatever component the caller names,
// with no idea what that component IS. A cure-salt component's window comes from
// `CURE_SALT_PRODUCTS`, keyed by `saltProduct`, and nothing here stopped a caller
// — the bake sheet, on a MODEL-NAMED ingredient id — from overwriting that window
// with an unrelated one (`LEAVENING_PERCENT_BOUNDS`, sized for yeast) and letting
// a nitrite dose several times the safe ceiling solve, preview and freeze.
//
// So a component that already carries `saltProduct` is never touched here, full
// stop: not scaled, not restamped, returned exactly as it arrived. Its bounds are
// `boundsOn`'s to decide and only `boundsOn`'s — this must not become a second
// site that could disagree with it. Naming such a component is therefore an
// adjustment this seam treats exactly like an id the formula does not hold.

/** The bounds to declare on the component being adjusted. Both ends optional. */
export interface ComponentPercentBounds {
  minPercent?: number;
  maxPercent?: number;
}

/**
 * A bounds pair reduced to only its defined ends — never a stray `undefined` key
 * left over from whatever a component already carried.
 *
 * ONE HOME FOR THE STAMPING RULE (#1402 review, should-fix 4). `deriveFormula`'s
 * `boundsOn` and `cureSalt.ts`'s `withProductStamped` both express the same
 * decision — "the window that wins replaces whatever the component arrived with,
 * end for end" — and each used to build that patch independently. Two
 * implementations of one rule stay agreeing only by accident, which is exactly
 * what `plain`'s "product named, no window" case (both ends `undefined`) put to
 * the test. This is the one place the patch is built; both callers hand it a
 * bounds record and use what comes back.
 *
 * Lives here rather than in either caller because this module is a leaf —
 * `deriveFormula.ts` and `cureSalt.ts` already both import from it, and it
 * imports nothing from either, so there is no cycle to route around.
 */
export function boundsPatch(bounds: {
  readonly minPercent?: number | undefined;
  readonly maxPercent?: number | undefined;
}): ComponentPercentBounds {
  return {
    ...(bounds.minPercent === undefined ? {} : { minPercent: bounds.minPercent }),
    ...(bounds.maxPercent === undefined ? {} : { maxPercent: bounds.maxPercent }),
  };
}

// The one concrete figure in this file's neighbourhood, and it is data rather than
// logic. 0.2%–2.5% of flour is the whole domestic range for instant/dried yeast:
// below it there is not enough to leaven anything on any timescale, above it the
// dough is a bready panic. A cold overnight retard at 0.4% and a two-hour counter
// prove at 1.6% are both perfectly ordinary and this says nothing about either.
//
// Expected to be tuned by a baker's eye rather than by argument. It is now the
// only guessed figure in this module — #1274 deleted the bake-loss table that used
// to stand beside it.
export const LEAVENING_PERCENT_BOUNDS: Readonly<ComponentPercentBounds> = {
  minPercent: 0.2,
  maxPercent: 2.5,
};

/**
 * Scale one component's percentage by a factor, declaring bounds as it goes.
 *
 * The new percentage goes through `roundPercent` — the same rounding authority
 * every other percentage in the module uses — so a factor of 0.66 on 1.2% lands on
 * a figure a screen can show and a solve can reproduce, rather than on
 * 0.7919999999999999.
 *
 * Bounds are only ever stamped on the component being adjusted, and only when the
 * caller passes them: this must not quietly acquire an opinion about a component
 * nobody asked about.
 */
export function withComponentPercentScaled(
  formula: Formula,
  adjustment: { ingredientId: string; factor: number },
  bounds?: ComponentPercentBounds,
): Formula {
  const { ingredientId, factor } = adjustment;
  if (!Number.isFinite(factor) || factor <= 0) return formula;
  const target = formula.components.find((component) => component.ingredientId === ingredientId);
  if (target === undefined) return formula;
  // A cure-salt component's window is not this function's to touch — see the
  // header above. Refusing here is what keeps `boundsOn` the one place a bound is
  // decided, rather than one of two.
  if (target.saltProduct !== undefined) return formula;

  return {
    ...formula,
    components: formula.components.map((component) => {
      if (component.ingredientId !== ingredientId) return component;
      return {
        ...component,
        percent: roundPercent(component.percent * factor),
        ...(bounds?.minPercent === undefined ? {} : { minPercent: bounds.minPercent }),
        ...(bounds?.maxPercent === undefined ? {} : { maxPercent: bounds.maxPercent }),
      };
    }),
  };
}
