import type { CanonItemUnit } from '@salt/shared-types';
import type { CanonItem } from '../../canon/index.js';

// The default toggle state for one ingredient row in the recipe-add review step
// (issue #185). `add` = goes on the list; `check` = lands flagged for verification
// (implies add). The user can override either before confirming.
export interface RecipeItemAddDefault {
  readonly add: boolean;
  readonly check: boolean;
}

/** What the recipe needs of the item, scaled, in the unit the row is written in. */
export interface RecipeItemNeed {
  readonly amount: number;
  readonly unit: CanonItemUnit;
}

/** The canon fields the default reads. */
export type RecipeItemAddCanon = Pick<
  CanonItem,
  'shoppingBehavior' | 'largeQuantityThreshold' | 'unit' | 'gramsPerItem'
>;

// Decide the default Add/Check toggles for a recipe ingredient being extracted to
// the shopping list, from its matched canon item's `shoppingBehavior`:
//   - `needed`  → buy it (add, no check)
//   - `check`   → buy it but verify (add + check)
//   - `stocked` → assume you have it (neither) UNLESS the recipe needs more than
//                 `largeQuantityThreshold` of it, in which case treat it like
//                 `needed` (see `exceedsThreshold` for how the two are compared).
// `canon === null` means the ingredient has no live canon match — there is no
// staple knowledge to lean on, so default to buying it (add, no check), matching
// the pre-#185 behaviour of never silently dropping an unmatched ingredient.
export function recipeItemAddDefault(
  canon: RecipeItemAddCanon | null,
  need: RecipeItemNeed | null,
): RecipeItemAddDefault {
  if (canon === null) return { add: true, check: false };
  switch (canon.shoppingBehavior) {
    case 'needed':
      return { add: true, check: false };
    case 'check':
      return { add: true, check: true };
    case 'stocked':
      return exceedsThreshold(canon, need)
        ? { add: true, check: false }
        : { add: false, check: false };
  }
}

// Whether the recipe needs more than the item's threshold (issue #1651). The
// threshold is a number in the item's `unit`, so the need is compared in that
// unit: as it stands when the units agree, or — for an item bought by the count —
// grams turned into items through its weight of one. Any other mismatch (grams
// against a count with no weight of one, ml against grams) means the threshold
// says nothing about this need, and the item keeps its `stocked` default.
// A threshold stored with no unit predates the unit being its own decision; it
// is compared as a bare number, as it always was.
function exceedsThreshold(canon: RecipeItemAddCanon, need: RecipeItemNeed | null): boolean {
  const threshold = canon.largeQuantityThreshold;
  if (threshold === undefined || need === null) return false;
  if (canon.unit === undefined || canon.unit === need.unit) return need.amount > threshold;
  if (canon.unit === 'count' && need.unit === 'g' && canon.gramsPerItem !== undefined) {
    return need.amount / canon.gramsPerItem > threshold;
  }
  return false;
}
