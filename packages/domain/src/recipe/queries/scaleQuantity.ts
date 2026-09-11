import type { Quantity } from '../entities/Quantity.js';
import { roundGrams } from '../../formula/rounding.js';

// A parsed ingredient quantity restated for a different number of servings, AS A
// HUMAN WOULD WRITE IT (issue #1314).
//
// ─── This is the DRAWING path, and it is not the BUYING path ──────────────────
//
// There are now two ways an ingredient amount gets multiplied, and they must not
// become one:
//
//   drawing — here. Rounds to a figure somebody can act on: "450g", "4½". Used
//             only by `IngredientText`, the one component that writes an
//             ingredient line anywhere in the app.
//   buying  — `buildRecipeAddPlan` (apps/web-pwa/src/lib/recipeService.ts).
//             Multiplies at full float precision and feeds the canon and
//             product-form pack maths, which round once, at the end, in their own
//             units ("90 ml lime juice → 3 limes").
//
// Route the shopping plan through this function and every amount rounds twice:
// once to a readable figure, then again into packs — so the shopper is handed a
// different number from the one on the screen they were looking at. The two paths
// share `quantityToNumber` and nothing else, and a test in
// `apps/web-pwa/tests/recipeService.scaling.test.ts` goes red if the plan starts
// consuming a rounded display figure.
//
// ─── What a scaled number is rounded to ───────────────────────────────────────
//
//   a measure (`unit` 'g' or 'ml') — `roundGrams`, the single rounding authority
//     for a weighed figure (issue #782). Whole grams at or above 10, one decimal
//     below it. "399.94g flour" is not a number anybody weighs.
//
//   a count (`unit === null`) — the nearest half, rendered by the caller as a
//     fraction ("4½"). "2⅔ eggs" asserts a precision the scaling never had. A
//     POSITIVE count never rounds away to zero: it floors at ½, because a row
//     reading "0 eggs" is an ingredient the cook silently leaves out.
//
// **Stated limit (CLAUDE.md Rule 12).** `roundGrams` is named for grams and its
// 10g decimal threshold was chosen for a domestic scale. Reusing it for
// millilitres is a DELIBERATE widening — a domestic jug has the same practical
// granularity — not an oversight. It is preferred to a second rounding rule,
// which is the defect `roundGrams` was created to end. If a unit ever arrives
// whose granularity is genuinely different, that is the moment to reconsider,
// and not before.
//
// ─── A range keeps both ends ──────────────────────────────────────────────────
//
// A range scales end-wise and stays a range. It is deliberately NOT reduced to a
// number here: `quantityToNumber` is the one place in the codebase that decides
// which end of a range a single figure means (issue #917, it is the top), and a
// second opinion about that is exactly what this file must not grow. Scaling both
// ends asks the question not at all, so it cannot answer it differently.
//
// A scaled count range can land on a half ("1–2" at 1.5× is "1.5–3"); the caller
// renders a range as `min–max`, so that half reads as a decimal rather than as a
// glyph. Accepted rather than fixed: making range ends render as vulgar fractions
// would change how every UNSCALED stored range reads, for a case the parser
// almost never produces.
//
// Pure: no clock, no I/O. `factor === 1` returns the very quantity passed in, so
// an unscaled page renders exactly what it rendered before this existed —
// including a stored "1 ½" keeping its exact fraction instead of being re-derived
// through a decimal.

// The granularity of a scaled count. Halves, and nothing finer — see the header.
const COUNT_STEP = 0.5;

function roundCount(exact: number): number {
  if (!Number.isFinite(exact)) return 0;
  const rounded = Math.round(exact / COUNT_STEP) * COUNT_STEP;
  // A positive amount is an ingredient that IS in the dish. Rounding it to zero
  // deletes it from the list without saying so.
  return exact > 0 && rounded === 0 ? COUNT_STEP : rounded;
}

function scaleValue(value: number, factor: number, unit: 'g' | 'ml' | null): number {
  return unit === null ? roundCount(value * factor) : roundGrams(value * factor);
}

// A scaled COUNT that landed on a half becomes a `mixed` quantity, which is the
// shape the renderer already turns into "4½" (issue #179's exact-fraction arm).
// A measure never does: "4½g" is not how a scale is read, and 4.5 is.
function countAsQuantity(value: number): Quantity {
  const whole = Math.floor(value);
  return value - whole === COUNT_STEP && whole >= 0
    ? { type: 'mixed', whole, numerator: 1, denominator: 2 }
    : { type: 'single', value };
}

function toQuantity(value: number, unit: 'g' | 'ml' | null): Quantity {
  return unit === null ? countAsQuantity(value) : { type: 'single', value };
}

/**
 * `quantity` restated at `factor` times its stated amount, rounded for reading.
 *
 * A `factor` of exactly 1 — and any factor that is not a finite positive number —
 * returns `quantity` itself untouched. The second half of that is defensive: the
 * factor is derived from a URL parameter at the only call site, and a pure query
 * with a UI caller has nothing useful to throw.
 */
export function scaleQuantity(
  quantity: Quantity,
  factor: number,
  unit: 'g' | 'ml' | null,
): Quantity {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return quantity;
  switch (quantity.type) {
    case 'single':
      return toQuantity(scaleValue(quantity.value, factor, unit), unit);
    case 'range':
      return {
        type: 'range',
        min: scaleValue(quantity.min, factor, unit),
        max: scaleValue(quantity.max, factor, unit),
      };
    case 'mixed':
      return toQuantity(
        scaleValue(quantity.whole + quantity.numerator / quantity.denominator, factor, unit),
        unit,
      );
  }
}
