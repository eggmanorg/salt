import type { RecipeKindDoc } from '../schemas/recipe.js';
import type { FormulaComponent } from '../schemas/formula.js';
import { statedStrength } from './brine.js';

// Is a ferment's salt inside its usual range? (issue #1657, phase 3)
//
// A NOTE, NEVER A RAIL. This returns facts — `ok`, or which side of a range a figure
// falls and what it was measured against — and the screen words them. It is not a
// `Failure`, it declares no `minPercent`/`maxPercent`, and nothing reads it on the
// way to Save or Start. That seam is the wrong one on purpose: `solveFormula`
// refuses any line outside its declared bounds, cure salt or not, so a 1.5–3% window
// stamped on kraut salt would stop a 4% kraut from saving. Cure salt stays the one
// place Salt says no (`cureSalt.ts`); this is the `cureSaltFitness` species beside
// it — a sentence the cook is free to ignore.
//
// NO FERMENTATION MODEL. It reads one figure off the formula and compares it with a
// table. No time, no temperature, no prediction of what the jar will do — those are
// in `docs/formulas-schedules-batches.md` → *What not to build*.

/**
 * A usual range, both ends present. Not `ComponentPercentBounds`, whose ends are
 * optional because it is the shape of a REFUSING bound on a component — this one is
 * never stamped on anything.
 */
export type FermentSaltRange = { readonly minPercent: number; readonly maxPercent: number };

/**
 * The usual range of a ferment's plain salt, one per way of stating it. DATA and a
 * STARTING GUESS, in the species of `LEAVENING_PERCENT_BOUNDS`: expected to be tuned
 * by eye, and tuned here — there is no second copy.
 *
 *   • `ofBasis` — a percentage of the whole basis. Dry-salted vegetables (the basis
 *     is the cabbage) and a brined jar stated against everything in it (the basis is
 *     the vegetables and the water) share it, which is why two keys cover all three
 *     ways a ferment is salted.
 *   • `ofMember` — a percentage of one basis member, in practice the water: the
 *     strength of a brine as a recipe writes it, "30 g per litre".
 *
 * THE KNOWN LIMIT: a kimchi soaking brine (around 10%, rinsed off before packing)
 * draws a note that is wrong for it. One range per way of stating, not per ferment
 * type, was the decision; the note costs a sentence and blocks nothing.
 */
export const FERMENT_SALT_RANGES: Readonly<{
  ofBasis: FermentSaltRange;
  ofMember: FermentSaltRange;
}> = {
  ofBasis: { minPercent: 1.5, maxPercent: 3 },
  ofMember: { minPercent: 2, maxPercent: 5 },
};

/**
 * Which kinds the range speaks to. A named predicate, as `isLongRunKind` is, so no
 * screen ever compares a kind to decide whether the note appears (CLAUDE.md → *Data
 * model conventions*; `cureKindComparisonGuard.test.ts`).
 *
 * EXHAUSTIVE BY TYPE — a `Record<RecipeKindDoc, boolean>` — so a new kind fails to
 * compile until it answers here. Not a column on `capabilities.ts`: a note is words,
 * not a capability (`docs/formulas-schedules-batches.md` → *Kind versus presence*).
 * A cure's plain salt is measured by its own trade and a bread's by the baker's
 * percentage; neither is a ferment's figure, so the same 1% draws nothing on them.
 */
const HAS_FERMENT_SALT_RANGE: Readonly<Record<RecipeKindDoc, boolean>> = {
  recipe: false,
  special: false,
  cocktail: false,
  placeholder: false,
  cure: false,
  bread: false,
  ferment: true,
};

/** Whether a recipe of this kind has its plain salt compared with `FERMENT_SALT_RANGES`. */
export function hasFermentSaltRange(kind: RecipeKindDoc): boolean {
  return HAS_FERMENT_SALT_RANGE[kind];
}

/** What the range has to say about a formula's plain salt. Figures and ids, never sentences. */
export type FermentSaltNote =
  // Nothing to say — every silence in one arm, because the screen prints nothing for
  // all of them: not a ferment, no line named Plain salt, or a salt inside its range.
  | { kind: 'ok' }
  | {
      kind: 'below' | 'above';
      /** The salt line spoken about — the first component named `plain`. */
      ingredientId: string;
      /** The basis member the figure is a percentage of, or `null` for the whole basis. */
      statedOf: string | null;
      /** The figure compared: percent of the basis, or of `statedOf`, as stored or derived. */
      percent: number;
      /** The range it fell outside — one of `FERMENT_SALT_RANGES`'s two. */
      range: FermentSaltRange;
    };

/**
 * Compared at ONE DECIMAL PLACE, rounded exactly as the PWA's `formatPercent` rounds
 * (`toFixed(1)`), so the comparison sees the figure the screen prints beside the note.
 * Without it, 35 g of salt on 700 g of water — which `statedStrength` reads back as
 * 5.0001% from two four-decimal percentages — would be "above 2–5%" while the screen
 * says "5%". `toFixed` rather than `Math.round` because the two disagree at binary
 * half-points: 1.45 prints as "1.4". `fermentSalt.test.ts` pins both.
 */
function asPrinted(percent: number): number {
  return Number(percent.toFixed(1));
}

/**
 * Is this formula's plain salt inside the usual range for a ferment?
 *
 * THE CLAIM'S REAL BOUNDARY (CLAUDE.md rule 12):
 *
 *   • IT SPEAKS ONLY TO A FERMENT, asked through `hasFermentSaltRange`. The same
 *     figures on a cure or a bread are `ok`.
 *   • IT SPEAKS ONLY ABOUT THE FIRST COMPONENT NAMED `plain`, and nothing guesses
 *     which line is the salt — `cureSalt.ts` deliberately has no bare "salt" keyword,
 *     because it would reach "curing salt". A ferment whose salt line is not named
 *     Plain salt gets no note. A formula naming two plain salts is spoken about by
 *     the first; the second is not added in.
 *   • `components` ARE THE FORMULA'S — every one is in the formula. A screen holding
 *     excluded rows hands in what Save would write, not the rows.
 *   • THE WAY IT IS STATED PICKS THE RANGE: a line stated against one member
 *     (`statedStrength`) is compared as a percentage of that member against
 *     `ofMember`; every other plain salt as a percentage of the basis against
 *     `ofBasis`. A `statedOf` naming nothing measurable reads as the basis, exactly
 *     as `statedStrength` reads it.
 *   • IT GATES NOTHING. No `Failure`, no bound, no disabled control; a note on a 6%
 *     brine saves and starts exactly as it would without one.
 *
 * Pure and total: a lookup and two comparisons, no I/O, no clock.
 */
export function fermentSaltNote(input: {
  kind: RecipeKindDoc;
  components: readonly FormulaComponent[];
}): FermentSaltNote {
  const { kind, components } = input;
  if (!hasFermentSaltRange(kind)) return { kind: 'ok' };
  const salt = components.find((component) => component.saltProduct === 'plain');
  if (salt === undefined) return { kind: 'ok' };

  const stated = statedStrength(salt, components);
  const range = stated === null ? FERMENT_SALT_RANGES.ofBasis : FERMENT_SALT_RANGES.ofMember;
  const percent = stated === null ? salt.percent : stated.percent;
  const compared = asPrinted(percent);
  const side = compared < range.minPercent ? 'below' : compared > range.maxPercent ? 'above' : null;
  if (side === null) return { kind: 'ok' };
  return {
    kind: side,
    ingredientId: salt.ingredientId,
    statedOf: stated === null ? null : stated.ingredientId,
    percent,
    range,
  };
}
