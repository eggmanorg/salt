// The #1643 net of ../scan-rematch-candidates.ts, lifted out so a test can reach
// it — the script reads Firestore at import time (docs/one-shot-scripts.md §2).
//
// WHAT IT CATCHES. Since #1643 the parser records BOTH amounts a line states —
// the metric estimate in `quantity`/`unit`, and the number of whole things in
// `statedCount` — and `preferredIngredientUnit` decides from canon and form data
// which one the line is read in. Every line parsed before that holds only the
// metric estimate: "1 red onion" is 150 g with no 1 beside it, so a line the data
// now wants as a count cannot be read as one. Its count survives only in
// `rawText`, and a re-read recovers it.
//
// THE LOAD-BEARING DISTINCTION is ABSENT versus NULL `statedCount`. Absent means
// the line has never been through the #1643 parse; null means it has, and the
// recipe gave no count ("300 g cauliflower"). The parse flow writes an absent
// count as an explicit null (`parseRecipeIngredients.ts`), and `RecipeSchema`
// keeps an absent key absent, so a re-read line leaves this net however it was
// authored — which is what lets the post-run scan reach zero instead of
// re-listing the 23 weight-authored counted lines forever. Pinned by
// countedLineNet.test.ts, through the real schema.
//
// The legacy count shape (`unit: null` with a quantity — the old prompt's count,
// nearly all garlic cloves) is NOT in the net: it already reads as a count, and
// re-reading 42 working lines to gain a weight bracket is risk for no fix.
//
// `missing_count` is the second half: a counted-form line with only grams. A
// stale one is also `unread` and is reported as such; one that survives a
// re-read (the recipe genuinely gave "400 g chicken thighs" against a counted
// form) stays here, because no re-read can give it a count — it needs a person.

import { ingredientMatchIssue, preferredIngredientUnit } from '@salt/domain';
import type { CanonItem, Ingredient, ProductForm } from '@salt/domain';

export type CountedLineReason = 'unread' | 'missing_count';

/** Why a line is in the #1643 net, or null when it is not. */
export function countedLineReason(
  ing: Ingredient,
  canonById: ReadonlyMap<string, CanonItem>,
  forms: readonly ProductForm[],
): CountedLineReason | null {
  if (ing.parsed === null || ing.canonId === null) return null;
  const canon = canonById.get(ing.canonId);
  if (canon === undefined) return null;
  if (ing.parsed.unit !== null && ing.parsed.statedCount === undefined) {
    const { unit } = preferredIngredientUnit(ing.parsed, canon, forms, [...canonById.values()]);
    if (unit === 'count') return 'unread';
  }
  return ingredientMatchIssue(ing, canonById, forms) === 'missing_count' ? 'missing_count' : null;
}
