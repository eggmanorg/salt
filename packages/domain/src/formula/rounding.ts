// The single rounding authority for gram figures (issue #782).
//
// Every gram a caller can obtain — a component, a basis, a total, a baked unit —
// comes through `roundGrams`, and the exact float is always available beside it.
// The batch (phase 02) freezes resolved quantities and the shopping list extracts
// from them, so a screen rounding independently would give three surfaces three
// answers.
//
// Rounded GRAM parts are deliberately NOT reconciled to sum to the rounded total:
// the total is solved, not summed, and largest-remainder would make one
// component's figure depend on the others — surprising when you edit a single
// percentage. The worked example shows the consequence honestly (parts 1 484 g,
// solved total 1 483 g) and the test suite asserts that 1 g rather than papering
// over it.
//
// THAT ARGUMENT IS ABOUT GRAMS, AND ONLY ABOUT GRAMS. Derived BASIS PERCENTAGES
// are deliberately reconciled, by exactly the largest-remainder adjustment
// rejected above (`deriveFormula`, issue #1364) — a different call knowingly made
// on a different quantity. The coupling costs the same thing in both places: one
// member's figure depends on its neighbours (33.3334 against their 33.3333). What
// differs is what it buys and what it costs. A gram is weighed, and the residual
// is half a gram on a scale. A basis percentage is weighed by nobody, the residual
// is a ten-thousandth of a point two orders below anything displayed, and leaving
// it unreconciled means the basis sums to 99.9999 — so every percentage measured
// against it creeps upward on every commit of the formula screen, without bound.

// At or above this, whole grams; below it, one decimal. Matches what a 1 g
// domestic scale can actually weigh while still giving a 2.5 g cure-salt figure
// its decimal at phase 04. Tunable without touching the solve.
export const GRAM_DECIMAL_THRESHOLD = 10;

export function roundGrams(exact: number): number {
  // Total by construction: the solve guards its inputs, but a NaN must never
  // reach a scale as "NaN g".
  if (!Number.isFinite(exact)) return 0;
  return Math.abs(exact) >= GRAM_DECIMAL_THRESHOLD
    ? Math.round(exact)
    : Math.round(exact * 10) / 10;
}

// Derived percentages are rounded too, but for a different reason and to a
// different scale: 350 / 500 × 100 is 70.00000000000001 in IEEE 754, and that
// noise would be persisted. Four decimals is 0.0001% of the basis — under a
// milligram on a domestic loaf — so nothing measurable is lost.
export const PERCENT_DECIMALS = 4;

export function roundPercent(exact: number): number {
  if (!Number.isFinite(exact)) return 0;
  const factor = 10 ** PERCENT_DECIMALS;
  return Math.round(exact * factor) / factor;
}
