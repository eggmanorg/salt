// Formula module (issue #782, phase 00 of epic #778) — composition as ratios
// against a declared basis, and the bidirectional yield solve that turns those
// ratios back into grams.
//
// Headless by design: no Firestore collection, no adapter, no screen, no Cloud
// Function. Pure arithmetic, no clock, no I/O (CLAUDE.md Rule 1), and every
// function is total — failures come back as a typed `FormulaFailure`, never a
// throw and never a NaN.
//
// Flat lightweight variant of the domain module pattern (see
// docs/domain-implementation.md), matching `shoppingDay` and `weather`: no
// entities/ports/commands/queries subfolders, because there is nothing to write
// and no infrastructure to abstract. This file is the module's only public
// surface; nothing outside may import its internals.
//
// Two things deliberately NOT here, and not anywhere: percentages leaking past
// this boundary onto `QuantitySchema`, and any fermentation model — scaling yeast
// when 500 g of flour becomes 841 g is maths, deciding what a fridge retard does
// to a dough is an opinion. Both are named in
// docs/formulas-schedules-batches.md's "what not to build".
export { DENSITY_G_PER_ML, DEFAULT_DENSITY_CLASS, gramsFromMillilitres } from './density.js';
export { GRAM_DECIMAL_THRESHOLD, PERCENT_DECIMALS, roundGrams, roundPercent } from './rounding.js';
// `amountFromQuantity` is gone (issue #917): reducing a `Quantity` to a number is
// the recipe module's job and is published as `quantityToNumber`. A formula's own
// copy of that reduction was how the shopping list and the mapping screen came to
// disagree about what "2–3 tbsp" means.
export { gramsFromParsed } from './gramsFromParsed.js';
export { deriveFormula } from './deriveFormula.js';
export { BASIS_KEYWORDS, guessBasisIngredientIds, looksScalable } from './guessBasis.js';
export type { BasisGuessEntry } from './guessBasis.js';
export type {
  DeriveFormulaInput,
  DeriveFormulaResult,
  FormulaComponentInput,
} from './deriveFormula.js';
export { solveFormula, BASIS_PERCENT_TOLERANCE } from './solveFormula.js';
export type {
  FormulaSolution,
  SolveFormulaResult,
  SolvedComponent,
  SolvedUnits,
} from './solveFormula.js';
export type { BoundViolation, FormulaFailure } from './failure.js';
export { doughAmountGrams, targetYield, basisYield } from './doughAmount.js';
// The proposal's leavening opinion, applied (issue #812 phase 2). Generic: bounds
// in, no ingredient names in the logic. The rail it declares is the one
// `solveFormula` has enforced since #782 — there is no second bounds check.
export { withComponentPercentScaled, LEAVENING_PERCENT_BOUNDS } from './adjustComponent.js';
export type { ComponentPercentBounds } from './adjustComponent.js';
