import type { CanonItem } from '../../canon/index.js';
import type { IngredientGroup } from '../entities/Ingredient.js';
import type { IngredientSearchTerms } from './searchRecipes.js';

// What each of a recipe's ingredients can be FOUND by (issue #1636) — the input
// `scoreRecipeSearch` reads for its ingredient field. PURE (CLAUDE.md rule 1):
// the caller hands over the canon it already holds; nothing here reads a store.
//
// Built by the caller rather than inside the scorer so the recipes page can build
// it once per library/canon change instead of once per keystroke, and so the chef
// can build it from a projected read without a whole `Recipe`.

/**
 * The two canon fields search reads. Narrower than `CanonItem` so the Cloud
 * Function can project exactly these and nothing else.
 */
export type CanonSearchNames = Pick<CanonItem, 'name' | 'synonyms'>;

/**
 * One entry per ingredient line, in document order.
 *
 * - `label` is the recipe's own word for the thing — `parsed.item`, or `rawText`
 *   for a line that was never parsed. It is what a "Uses …" line shows, so a hit
 *   found through a canon synonym still explains itself in the recipe's words.
 * - `terms` is `label` plus, when `canonId` resolves, the canon item's `name` and
 *   every one of its `synonyms`. An unlinked line (`canonId: null`) or one whose
 *   canon item has since been deleted is found by its own wording alone.
 *
 * `rawText` is the fallback ONLY when `parsed` is null: it carries quantities and
 * preparation ("400g tin chopped tomatoes, drained"), so reading it for a parsed
 * line would let "tin" find every recipe with a tin in it.
 *
 * Synonyms are passed through unfiltered, loose ones included ("pork" on Pork
 * Mince): a broad synonym can only surface a recipe that genuinely contains that
 * thing, and the label keeps the result honest.
 */
export function ingredientSearchTerms(
  groups: readonly IngredientGroup[],
  canonById: ReadonlyMap<string, CanonSearchNames>,
): IngredientSearchTerms[] {
  return groups.flatMap((group) =>
    group.items.map((ingredient) => {
      const label = ingredient.parsed?.item ?? ingredient.rawText;
      const canon = ingredient.canonId === null ? undefined : canonById.get(ingredient.canonId);
      return {
        label,
        terms: canon === undefined ? [label] : [label, canon.name, ...canon.synonyms],
      };
    }),
  );
}
