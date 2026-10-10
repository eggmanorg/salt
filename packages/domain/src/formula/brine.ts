import type { Formula, FormulaComponent } from '../schemas/formula.js';
import { reconciledBasisPercents } from './deriveFormula.js';
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
// It also holds the one rewrite a stated strength needs on the day: `withBasisWeighed`
// (below) re-splits the basis to what was actually weighed and keeps such a line's
// strength against its member's new grams.
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

// ─── Weighing each part of the basis (issue #1657, phase 2) ───────────────────
//
// A brined pickle is started from what actually went in: 1.2 kg of cucumbers, and
// however much water it took to cover them. That ratio is not the recipe's stored
// 50/50, and the basis-led solve can only split a TOTAL by the stored ratio — so the
// re-split happens HERE, upstream of it, as a formula rewrite in the shape
// `withCureSaltSubstituted` and `withComponentPercentScaled` already have. The
// contract doc's scale verb names it ("basis re-splits"); it is not a new yield kind,
// and `solveFormula` is handed an ordinary formula and an ordinary basis yield.

/** A formula re-split to what was weighed, and the basis to solve it at. */
export type BasisWeighed = {
  /** The re-split formula — a local object for one run, never a document to save. */
  formula: Formula;
  /** Every member's grams, typed or followed, added up: solve at `basisYield(basisGrams)`. */
  basisGrams: number;
};

/**
 * Re-split `formula`'s basis to the grams weighed for each member.
 *
 * FOUR THINGS, and nothing else:
 *
 * 1. Each basis member is re-measured from its grams — the typed figure, or, for a
 *    member with none, the figure that FOLLOWS the typed ones at the recipe's own
 *    ratio: Σ typed grams ÷ Σ typed stored percent × the member's stored percent.
 *    The new percentages are reconciled to 100 by `deriveFormula`'s own
 *    largest-remainder rule (`reconciledBasisPercents`), so the solve sees a basis
 *    that sums to 100 exactly as a derived one does.
 * 2. Every other line keeps its percentage — 2% of the basis is 2% of the new basis,
 *    and a curing salt stays a percentage of the meat.
 * 3. A plain salt stated against one member (`statedStrength`) is re-expressed so
 *    that strength holds against the member's new grams: 3% of 1500 g of water is
 *    45 g, whatever share of the basis the water now is.
 * 4. The basis total comes back beside it, for the caller to solve at.
 *
 * NULL WHEN NOTHING WAS WEIGHED — no entry naming a basis member with a finite,
 * positive figure. That is no answer yet, not a lenient one, and the caller solves
 * the formula as it stands (`referenceYieldFrom`'s null, for the same reason). Also
 * null when the typed members' stored percentages sum to nothing, which a derived
 * formula cannot produce (every component has positive grams) but a hand-edited one
 * can: there is no ratio for a blank box to follow.
 *
 * An entry naming no basis member is ignored, and so is one that is not a finite,
 * positive number — a blank box and a nonsense one both follow the others.
 *
 * PURE, and a new formula every time. Bounds are not re-stamped and nothing is
 * checked: a curing salt's percentage does not move, so its window still holds or
 * still fails exactly as before, and `solveFormula` is still what refuses.
 */
export function withBasisWeighed(
  formula: Formula,
  gramsByBasisId: ReadonlyMap<string, number>,
): BasisWeighed | null {
  const members = formula.components.filter((component) => component.inBasis);
  const weighed = (member: FormulaComponent): number | null => {
    const grams = gramsByBasisId.get(member.ingredientId);
    return grams !== undefined && Number.isFinite(grams) && grams > 0 ? grams : null;
  };

  let typedGrams = 0;
  let typedPercent = 0;
  for (const member of members) {
    const grams = weighed(member);
    if (grams === null) continue;
    typedGrams += grams;
    typedPercent += member.percent;
  }
  if (typedGrams === 0 || !(typedPercent > 0)) return null;

  const gramsPerPercent = typedGrams / typedPercent;
  const weighedMembers = members.map((member) => ({
    member,
    grams: weighed(member) ?? member.percent * gramsPerPercent,
  }));
  const basisGrams = weighedMembers.reduce((sum, entry) => sum + entry.grams, 0);
  const memberGrams = new Map(
    weighedMembers.map((entry) => [entry.member.ingredientId, entry.grams]),
  );

  const measured = weighedMembers.map(({ member, grams }) => ({
    member,
    exactPercent: (grams / basisGrams) * 100,
  }));
  const reconciled = reconciledBasisPercents(measured);
  const basisPercentOf = new Map(measured.map((entry) => [entry.member, reconciled.get(entry)]));

  return {
    formula: {
      ...formula,
      components: formula.components.map((component) => {
        const basisPercent = basisPercentOf.get(component);
        if (basisPercent !== undefined) return { ...component, percent: basisPercent };
        // Read against the ORIGINAL components: the strength is the one the recipe
        // states, and the member's new grams are what it is now held against.
        const strength = statedStrength(component, formula.components);
        const heldAgainst = strength === null ? undefined : memberGrams.get(strength.ingredientId);
        if (strength === null || heldAgainst === undefined) return component;
        const grams = gramsAtStrength(strength.percent, heldAgainst);
        return { ...component, percent: roundPercent((grams / basisGrams) * 100) };
      }),
    },
    basisGrams,
  };
}
