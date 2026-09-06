import { normaliseName, type CanonItem } from '../../canon/index.js';
import { resolveProductForm, type ProductForm } from '../../productForm/index.js';
import type { Ingredient } from '../entities/Ingredient.js';
import type { Recipe } from '../entities/Recipe.js';

/**
 * A match problem that a recipe line CANNOT show you by itself.
 *
 * Deliberately not "every line that isn't matched". A `pending`/`failed` line is
 * already visible where it matters — the recipe page marks it ✗ and offers
 * Canonicalise — so folding it in here would light a pip on every half-finished
 * recipe and teach you to ignore the pip. What earns a pip is a line that looks
 * finished and is not:
 *
 * - `dangling_canon` — the line points at a canon item that has since been
 *   deleted or merged away. It reads as matched and buys nothing.
 * - `missing_amount` — the line holds no parsed data at all, so it has no
 *   amount to scale with servings and contributes nothing to the shopping list.
 *   It reads as matched because it IS matched: canon and parse are two separate
 *   joins, and for months a batch-authored line could lose the second one and
 *   keep the first (issue #949). Re-matching is exactly the remedy — the
 *   single-line path re-parses before it matches.
 * - `missing_form` — the line names something OTHER than the canon item it
 *   matched, is measured by mass or volume, and the thing it buys is sold by the
 *   count, with no product form bridging the two. It reads as matched and buys
 *   "90 ml lime" instead of three limes (issue #855). A product form is exactly
 *   the missing piece, and re-matching is what mints one. Reported only when the
 *   matched canon ALREADY carries at least one product form — see the guard
 *   below for why a form-less canon is out of this marker's reach (issue #867).
 */
export type IngredientMatchIssue = 'dangling_canon' | 'missing_amount' | 'missing_form';

/**
 * What (if anything) is silently wrong with one ingredient's match.
 *
 * `canonById` doubles as the live-canon set: a `canonId` absent from it is by
 * definition dangling. Pass the whole map rather than an id set because
 * `missing_form` needs the matched item's `unit`.
 *
 * Ordered cheapest-first on purpose. `resolveProductForm` walks every form's
 * every phrase, and this runs per ingredient per recipe across a whole list, so
 * the count/metric pre-checks — which reject the overwhelming majority of lines
 * on two field reads — are what keep that affordable.
 */
export function ingredientMatchIssue(
  ing: Ingredient,
  canonById: ReadonlyMap<string, CanonItem>,
  forms: readonly ProductForm[],
): IngredientMatchIssue | null {
  if (ing.canonId === null) return null; // never matched — visible already, see above
  const canon = canonById.get(ing.canonId);
  if (canon === undefined) return 'dangling_canon';
  // Before the count/metric pre-checks, not after: a line with NO parsed data is
  // wrong whatever its canon is sold by, and the checks below all read fields it
  // does not have. It is also the cheapest test here — one field read.
  if (ing.parsed === null) return 'missing_amount';
  if (canon.unit !== 'count') return null;
  if (ing.parsed.unit === null) return null;
  // The line names the canon item ITSELF, so there is no second product to
  // bridge to and no form can exist: "2 tsp garlic, finely grated" parses to 12 g
  // of `garlic` and matches canon Garlic, which is sold by the count. Without
  // this guard that reads as a missing form, but garlic-by-weight is not a form
  // OF garlic — it is garlic, measured. `arbitrateProductForm` says exactly that
  // (`modifier_kind: "none"`) and mints nothing, so the marker was demanding
  // something the pipeline correctly refuses to make. It misfired broadly, too:
  // every count-sold canon — onion, carrot, potato, tomato, lemon — trips it the
  // moment a recipe gives that ingredient in grams.
  //
  // A product form bridges a DIFFERENTLY-NAMED thing to its parent (lime JUICE →
  // Lime, garlic CLOVE → Garlic). Same name, no bridge.
  //
  // Compared against the canon's NAME only, deliberately never its synonyms:
  // `appendCanonSynonym` writes the matched item name onto the canon, so canon
  // Garlic already carries "garlic clove" and a synonym-aware check would hide
  // precisely the case worth flagging. The cost is a genuine synonym match under
  // a different name (say "coriander" → canon "Cilantro") still flagging; that is
  // rarer than the class this suppresses, and far less harmful than going blind
  // to the real one.
  //
  // This is the exact-name predicate, and it is the THIRD site asking it — the
  // other two are `findClosestMatch` stage 1 and `findExactCanonMatch`, which
  // #971 collapsed onto `exactNameMatch`. #971's census missed this one because
  // the variable is `canon`, not `item` (issue #1269). It stays written out
  // here rather than joining them: `exactNameMatch` answers "which of these
  // items does this text name" over a LIST, and the question here is a scalar
  // identity check against one already-matched canon. What must not drift is
  // the folding, and that is `normaliseName` — single-sourced, and shared with
  // both other sites. Anything asking this question again gets a bullet in
  // `docs/matching-pipeline.md`'s census, so the next grep does not miss it.
  if (normaliseName(ing.parsed.item) === normaliseName(canon.name)) return null;
  // A canon item with NO forms at all is beyond this marker's reach. A null from
  // `resolveProductForm` says "no form matched this text", which is a different
  // statement from "this line is missing its form", and the gap between the two
  // was the whole false-positive class: for a canon nobody buys in any shape but
  // itself — Bay Leaves, Celery, Red Onion, Daikon Radish — ANY gram-measured
  // line whose wording merely differs from the canon's name read as a missing
  // form, and #865 has since taught the pipeline that no form should ever be
  // minted for those. The pip was demanding what the pipeline correctly refuses
  // to make, so re-matching could never clear it.
  //
  // A canon that already carries a form is one the household is known to buy in
  // some other shape, so a line resolving to none of them is stale or missing
  // its bridge — actionable. Minting a canon's FIRST form is
  // `arbitrateProductForm`'s job during a re-match, not something a card badge
  // can ask for; that case is silent on purpose (issue #867).
  //
  // Cheaper than `resolveProductForm` — one field read per form against its
  // phrase-by-phrase normalising — so it belongs on this side of the call, per
  // the ordering note above.
  if (!forms.some((f) => f.parentCanonId === ing.canonId)) return null;
  // The canon list the contested-phrase rule needs (issue #1180) is already in
  // hand — `canonById` IS the live canon set, per this function's own contract
  // above — so no caller of this query gains a parameter. Materialised here
  // rather than at the top because this is the one branch that reaches it, and
  // the ordering note above is about how few lines get this far.
  const form = resolveProductForm(ing.parsed.item, forms, [...canonById.values()]);
  // A form that resolves to some OTHER parent is not this line's bridge — the
  // same guard every other product-form read applies.
  return form !== null && form.parentCanonId === ing.canonId ? null : 'missing_form';
}

/** How many of a recipe's lines are silently mis-matched. 0 for an entry with no ingredients. */
export function recipeMatchIssueCount(
  recipe: Recipe,
  canonById: ReadonlyMap<string, CanonItem>,
  forms: readonly ProductForm[],
): number {
  let count = 0;
  for (const group of recipe.ingredients) {
    for (const ing of group.items) {
      if (ingredientMatchIssue(ing, canonById, forms) !== null) count++;
    }
  }
  return count;
}
