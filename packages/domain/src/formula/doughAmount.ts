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
