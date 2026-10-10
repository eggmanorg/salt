import type { FormulaComponent } from '../schemas/formula.js';
import { roundPercent } from './rounding.js';

// A salt read against ONE basis member rather than the whole basis (issue #1657) —
// "3% of the water" on a brined pickle whose basis is the cucumbers and the water.
//
// A VIEW OVER WHAT IS STORED, never a second figure. The component's `percent` is
// still percent of the basis and still the only number on the document; this module
// re-expresses it against the member `statedOf` names, and turns a held strength
// back into grams. No solve, no bound, no new yield kind: `solveFormula` neither
// reads `statedOf` nor changes because of it.
//
// "Of the water" is salt ÷ that line's weight — grams per kilo of water, the way a
// recipe writes "30 g per litre" — and not salt ÷ (salt + water). The two readings
// differ by under a gram a litre at 3% (30 g against 30.9 g) and by about 2.6 g at
// 5%; the recipe's reading is the one a cook can check against the page they are
// copying from.

/** A line's strength against the one basis member it is stated against. */
export type StatedStrength = {
  /** The basis member, by `ingredientId` — the label is the caller's join. */
  ingredientId: string;
  /**
   * Percent of that member's weight, at `roundPercent`'s four decimals. Read off
   * two stored percentages that are each rounded to four decimals, so it is within
   * about a ten-thousandth of a point of the gram ratio, not exactly it — 45 g on
   * 1500 g of water reads 3.0001 (`brine.test.ts`).
   */
  percent: number;
};

/**
 * The strength of `component` against its `statedOf` member, from the stored
 * percentages: `component% ÷ member% × 100`.
 *
 * Null when the line is stated against the whole basis — the ordinary answer — and
 * ALSO for a line not named `plain` (a curing salt is a percentage of the meat,
 * always), or a `statedOf` naming nothing this formula can measure against — a
 * member not on `components`, one not in the basis, or one at 0%. `deriveFormula`
 * never writes either, but a stored document is not a derived one (a hand edit, or
 * a writer that did not re-derive), and then "a percentage of the basis" is the
 * honest reading — it is what `percent` says.
 *
 * THE LIMIT, STATED: the derive's other two conditions — not the line itself, and a
 * basis of two or more — are NOT re-asked here. A hand-edited document breaking them
 * reads as 100% of itself, or as the same figure as the basis under a member's name;
 * both are true statements about the stored numbers, and neither moves a gram.
 */
export function statedStrength(
  component: FormulaComponent,
  components: readonly FormulaComponent[],
): StatedStrength | null {
  if (component.statedOf === null || component.saltProduct !== 'plain') return null;
  const member = components.find(
    (candidate) => candidate.ingredientId === component.statedOf && candidate.inBasis,
  );
  if (member === undefined || member.percent <= 0) return null;
  return {
    ingredientId: member.ingredientId,
    percent: roundPercent((component.percent / member.percent) * 100),
  };
}

/**
 * The grams a held strength implies for a member weighing `memberGrams`: 3% of
 * 1500 g of water is 45 g.
 *
 * EXACT, NOT ROUNDED. The caller hands this on to a solve or a box that already
 * carries the exact float beside the rounded one (`rounding.ts`); rounding here
 * would be a second rounding of the same figure.
 */
export function gramsAtStrength(strengthPercent: number, memberGrams: number): number {
  return (memberGrams * strengthPercent) / 100;
}
