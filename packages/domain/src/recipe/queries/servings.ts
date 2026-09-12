// A recipe's stated servings count when it can serve as a scaling base, and
// `null` when it cannot (issue #1123).
//
// Every scaler wrote `metadata.servings ?? 1`, which guards a MISSING count — and
// 0 is not missing. It is the one value that makes `target / base` meaningless,
// so a recipe stored at 0 scaled a shopping list by `Infinity`, or by `NaN` when
// the review sheet seeded its own stepper from that same 0. A `NaN` amount is
// then rejected by `ShoppingListItemSchema` on the way back in, so the row does
// not reappear at all — an ingredient silently absent from the list.
//
// It lives here, in the pure module, because the three places that need it — the
// plan builder, the review sheet's seed and the made-header's default — are in
// two files that must not re-derive the rule between them, and because the
// STORED schema stays permissive on purpose: `RecipeMetadataSchema` is the read
// boundary for a production collection, where rejecting a bad `servings` would
// skip the whole recipe rather than fix one field.
export function usableServings(stated: number | null): number | null {
  return stated !== null && Number.isFinite(stated) && stated > 0 ? stated : null;
}

/**
 * A recipe being read at a chosen number of servings: the base, the active count,
 * and the factor every amount on the screen is drawn at.
 *
 * `null` is the whole of "this recipe cannot be read at another number" — no
 * usable stated count, per `usableServings` above. Callers narrow through this one
 * nullable rather than re-checking, so there is no second place that can disagree
 * about whether the servings pill is a control or a label.
 */
export interface ServingsScale {
  /** The recipe's own stated count, once `usableServings` has accepted it. */
  base: number;
  /** How many this reading is for. Equal to `base` when the recipe is as written. */
  active: number;
  /** The factor `scaleQuantity` is called with. Exactly 1 when as written. */
  factor: number;
  /** Whether this reading is for a different number than the recipe states. */
  isScaled: boolean;
}

/**
 * The base/active/factor rule, held in ONE place (issue #1321).
 *
 * Three screens read a recipe at a chosen number — the recipe page and both cook
 * screens — and they disagree only about where the chosen number COMES FROM: a
 * URL parameter, a pinned cook session, or neither. That difference is theirs to
 * keep. What must not be theirs is the arithmetic underneath it, which was written
 * out twice and could therefore drift into two rules that answer differently for
 * the same recipe. Each caller resolves its own `requested` and hands it here.
 *
 * `requested` is what that screen asked for, or `null` for "as written" — and a
 * request aimed at a recipe with no usable base is ignored rather than honoured,
 * because there is nothing to scale it against.
 *
 * Pure: no clock, no router, no I/O.
 */
export function servingsScale(
  stated: number | null,
  requested: number | null,
): ServingsScale | null {
  const base = usableServings(stated);
  if (base === null) return null;
  // A requested count is subject to the same rule as a stated one: `usableServings`
  // is what makes a number a servings count, wherever it arrived from.
  const active = usableServings(requested) ?? base;
  const factor = active / base;
  return { base, active, factor, isScaled: factor !== 1 };
}
