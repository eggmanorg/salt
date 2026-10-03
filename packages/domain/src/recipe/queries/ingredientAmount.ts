import type { CanonItem } from '../../canon/index.js';
import {
  resolveIngredientProductForm,
  type CanonNaming,
  type ProductForm,
} from '../../productForm/index.js';
import type { ParsedIngredient } from '../entities/Ingredient.js';
import type { Quantity } from '../entities/Quantity.js';

// Which amount a recipe line is READ in — a count or a weight (issue #1643).
//
// The parser records both amounts a line states and never picks between them:
// `quantity`/`unit` carry the metric estimate, `statedCount` the number of whole
// things ("1 red onion" → 150 g AND 1). This decides which of the two the line is
// shown and shopped in, and it decides from DATA, never from the item's name:
//
//   1. a product form that resolves to the line's OWN canon item → that form's
//      `yield.formUnit` ("roast chicken carcass" → form Chicken carcass, counted;
//      "lime juice" → form Lime juice, ml);
//   2. otherwise the matched canon item's `unit`, when that is `count`
//      ("1 red onion" against canon Red Onion, sold by the count);
//   3. otherwise metric, exactly as before #1643.
//
// It is asked when the line is READ, every time, rather than frozen onto the
// line when it is matched — so changing a canon item's unit, or adding a form,
// changes every recipe at once without re-matching anything. The cost is that
// the answer can change under a recipe nobody edited; that is the point.
//
// What it does NOT do is convert. A count-preferred line authored by weight
// ("300 g cauliflower") stays a weight here; turning grams into a count needs a
// weight of one, which is the shopping list's job when it combines a row, and a
// form line is NEVER converted through its parent's weight (400 g of thighs ÷
// one chicken is not a thigh count). A count-preferred FORM line with no count to
// give is the case `ingredientMatchIssue` reports as `missing_count`.
//
// Two legacy shapes are read the way they always were, so nothing written before
// #1643 changes until it is re-read:
//   • `unit: null` with a quantity — the old prompt's count. A count with no
//     weight, whatever the data now prefers: there is no metric amount to fall
//     back to.
//   • a metric line with no `statedCount` — a weight with no count.

/** The amount a line is read in, plus — for a count — the weight it was estimated at. */
export interface IngredientAmount {
  /** Unscaled, exactly as stored: a range stays a range, a fraction stays a fraction. */
  quantity: Quantity;
  unit: 'count' | 'g' | 'ml';
  /**
   * The metric estimate standing beside a count — the "(about 500g)" a counted
   * line reads with. Only ever set when `unit` is `'count'`, and null when the
   * line holds no metric amount (a legacy count, or the parser gave none).
   */
  measure: { quantity: Quantity; unit: 'g' | 'ml' } | null;
  /**
   * The product form that resolved to the line's own canon item, if any. Carried
   * so a caller converting to a parent count does not resolve it a second time.
   */
  form: ProductForm | null;
}

/** The unit the data says this line should be read in, before asking whether it can be. */
export type PreferredIngredientUnit = 'count' | 'metric';

/**
 * The unit a matched line should be read in, per the data — rule 1 then 2 then
 * 3 in the file header. Exported so the match-issue query and the amount chooser
 * cannot disagree about it.
 *
 * `canon` is the line's MATCHED canon item, or null for a line that never
 * matched (which prefers metric: there is nothing to consult). `canonNaming` is
 * the whole canon list, a pass-through to `resolveProductForm`'s
 * contested-phrase rule (issue #1180).
 */
export function preferredIngredientUnit(
  parsed: ParsedIngredient,
  canon: CanonItem | null,
  forms: readonly ProductForm[],
  canonNaming: readonly CanonNaming[],
): { unit: PreferredIngredientUnit; form: ProductForm | null } {
  const form =
    canon === null ? null : resolveIngredientProductForm(parsed.item, canon.id, forms, canonNaming);
  if (form !== null) return { unit: form.yield.formUnit === 'count' ? 'count' : 'metric', form };
  return { unit: canon?.unit === 'count' ? 'count' : 'metric', form: null };
}

/**
 * Pick the amount a parsed line is read in. Null when the line carries no amount
 * at all (an equipment-prep line, "salt to taste") — it reads and buys nothing,
 * as before.
 */
export function chooseIngredientAmount(
  parsed: ParsedIngredient,
  canon: CanonItem | null,
  forms: readonly ProductForm[],
  canonNaming: readonly CanonNaming[],
): IngredientAmount | null {
  const { unit: preferred, form } = preferredIngredientUnit(parsed, canon, forms, canonNaming);

  const metric =
    parsed.quantity !== null && parsed.unit !== null
      ? { quantity: parsed.quantity, unit: parsed.unit }
      : null;
  // The structured count, or — on a legacy line — the old prompt's count, which
  // lived in `quantity` with a null unit.
  const count =
    parsed.statedCount ??
    (parsed.quantity !== null && parsed.unit === null ? parsed.quantity : null);

  if (preferred === 'count' && count !== null) {
    return { quantity: count, unit: 'count', measure: metric, form };
  }
  if (metric !== null) return { ...metric, measure: null, form };
  // Metric preferred but the line holds only a count: a legacy count line, or a
  // parse that gave no estimate. The count is the only amount there is.
  if (count !== null) return { quantity: count, unit: 'count', measure: null, form };
  return null;
}
