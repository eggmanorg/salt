import type { DoughAmount, ReferenceYield } from '../schemas/formula.js';

// What a formula declares it makes (issues #782, #1274) — how many, and how many
// grams each.
//
// This file used to hold a table of eleven named shapes and a bake-loss figure per
// entry. Both are gone: a yield is a DOUGH WEIGHT, the recipe is what says whether
// it is a ciabatta or a focaccia, and the vessel is a fact about tonight rather
// than about the recipe. `schemas/formula.ts`'s `DoughAmountSchema` carries the
// reasoning; the short version is that "900 g tin loaf" never said whether 900 g
// was the pan, the dough or the cooked bread.
//
// There is deliberately NO table of tin sizes here to replace it. A vessel size
// carries no thing-name and no loss figure, so "450 g" and "900 g" say nothing a
// number box does not — they are quick-fill chips on the two screens that ask, and
// UI affordance is not domain data.
//
// The one estimate in the feature lives at the bottom of this file, for vessels
// that have no trade name to be sold by. Read its comment before touching it.

/**
 * The whole dough a declared amount comes to.
 *
 * One line, and it lives here because it is the DEFINITION of a dough amount
 * rather than a display convenience — `solveFormula` resolves a target yield
 * through it, and every screen that prints "1.8 kg of dough" reads the same
 * expression. A second copy is how a batch page and the freeze that wrote it come
 * to disagree.
 */
export function doughAmountGrams(amount: DoughAmount): number {
  return amount.count * amount.unitDoughGrams;
}

export function targetYield(amount: DoughAmount): ReferenceYield {
  return { kind: 'target', shape: amount };
}

export function basisYield(grams: number): ReferenceYield {
  return { kind: 'basis', grams };
}

// ─── An un-named vessel (issue #1274, phase 2) ─────────────────────────────────
//
// A tray, a roasting tin, a baking dish: things sold with no trade name, so
// nothing about them says how much dough they take. This is the ONE GUESSED NUMBER
// in the feature, and everything about how it is used is arranged around that.
//
// ITS BOUNDARY, stated rather than hidden: a DOMESTIC STARTING POINT, right to
// within ~15% on the two anchors anyone can check, and not a fact. Dough per litre
// genuinely varies by style, by how full you fill a tray and by how much rise you
// want. It wants a baker's eye once real bakes are logged.
//
// ONE COEFFICIENT, OVER VOLUME, and that is a decision. Two — one for deep vessels
// and one for flat ones — would disagree by up to 70% on the same tray depending
// which way the user described it, which is a trap rather than a refinement.
// Reducing everything to a volume gives one number that lands within ~10% on both
// anchors: a 2 litre dish → ~900 g, and a 30 × 40 cm tray at 2 cm → ~1080 g against
// a real ~1000 g focaccia.
//
// A NAMED TIN DOES NOT COME THROUGH HERE. A UK tin is sold by the dough it takes,
// so 900 g of tin is 900 g of dough directly — running it through this would
// replace a convention that is already right with an estimate that is not.
//
// AND THE RESULT IS NEVER LOAD-BEARING. There is exactly one caller, the UI, which
// writes the figure into an ORDINARY EDITABLE BOX. The coefficient therefore never
// reaches a document and cannot become an input to any scaling. That is the
// deliberate difference from the bake loss this issue deleted, which WAS stored and
// WAS read back.
export const DOUGH_GRAMS_PER_ML = 0.45;

/** Dough for a vessel described by its volume. Exact and unrounded — the caller rounds. */
export function doughGramsFromVolumeMl(millilitres: number): number {
  return millilitres * DOUGH_GRAMS_PER_ML;
}

// How deep the dough sits in a tray when no depth is given. A tray is NOT filled to
// its walls — asking for the pan's wall height reads about 70% high — so this is
// the dough, not the vessel.
export const DEFAULT_DOUGH_DEPTH_CM = 2;

/**
 * Dough for a vessel described by its footprint, at a dough depth.
 *
 * Multiplies out to a volume and delegates, so there is ONE coefficient and the two
 * input paths cannot disagree about the same vessel. 1 cm³ is 1 ml.
 */
export function doughGramsFromArea(
  lengthCm: number,
  widthCm: number,
  depthCm: number = DEFAULT_DOUGH_DEPTH_CM,
): number {
  return doughGramsFromVolumeMl(lengthCm * widthCm * depthCm);
}
