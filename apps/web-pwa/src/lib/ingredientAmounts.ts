import { derived } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { chooseIngredientAmount } from '@salt/domain';
import type { CanonItem, IngredientAmount, ProductForm } from '@salt/domain';
import type { IngredientDoc } from '@salt/domain/schemas';
import { canonItems } from './canonService.js';
import { canonIndex } from './canonIndex.js';
import { productForms } from './productFormService.js';

// Count or weight, for every surface that WRITES an ingredient line (issue
// #1643). The decision is the domain's `chooseIngredientAmount`; what lives here
// is the plumbing every surface would otherwise repeat — the canon lookup by id,
// the product-form list, the canon list the contested-phrase rule reads — held
// once so the recipe page, cook mode, guided cook and batch cook cannot disagree
// about how one line reads.
//
// A DERIVED STORE OF A LOOKUP, for the reason `cookIngredientIcons.ts` gives: a
// plain function reading a snapshot has no tracked dependency on the stores, so
// canon and product forms landing after first paint would leave every counted
// line reading in grams until something unrelated re-rendered. Subscribed, the
// line changes the moment the vocabulary arrives — and the moment an admin
// changes a canon item's unit or adds a form, which is the point of deciding at
// read time.

/** How one ingredient line is read, resolved against one canon/form snapshot. */
export interface IngredientAmountLookup {
  /** The amount the line is read in, or null when it holds none (see the domain query). */
  amountFor(ingredient: IngredientDoc): IngredientAmount | null;
}

/** Pure: the lookup for one snapshot. Exported so it is testable without the stores. */
export function amountLookupFor(
  canon: readonly CanonItem[],
  forms: readonly ProductForm[],
): IngredientAmountLookup {
  const canonById = canonIndex(canon);
  return {
    amountFor(ingredient) {
      if (ingredient.parsed === null) return null;
      // A dangling canonId reads as unmatched: there is no item to consult, so
      // the line reads metric (or as its legacy count), exactly as before.
      const matched =
        ingredient.canonId === null ? null : (canonById.get(ingredient.canonId) ?? null);
      return chooseIngredientAmount(ingredient.parsed, matched, forms, canon);
    },
  };
}

/** The shared lookup, recomputed whenever canon or the product forms change. */
export const ingredientAmounts: Readable<IngredientAmountLookup> = derived(
  [canonItems, productForms],
  ([$canonItems, $productForms]) => amountLookupFor($canonItems, $productForms),
);
