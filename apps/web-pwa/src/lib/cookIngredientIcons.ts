import { derived } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { isCanonIconRenderable, resolveIngredientProductForm } from '@salt/domain';
import type { CanonItem, ProductForm } from '@salt/domain';
import type { IngredientDoc } from '@salt/domain/schemas';
import { canonItems } from './canonService.js';
import { productForms } from './productFormService.js';
import { addToast } from './toastStore.js';
import { addItemToDefaultList, deleteItemFromList } from './shoppingListService.svelte.js';

// The picture beside an ingredient, and the gesture that puts that ingredient on
// the shopping list — for every cook surface (issues #714, #871, #994).
//
// THE POINT OF PUTTING THIS HERE. Plain cook mode and guided cook draw the same
// ingredient rows, and until #994 each carried its own byte-identical copy of the
// whole family: the canon lookup, the product-form preference, the tri-state
// thumbnail, the cache-bust nonce, the alt text, and the press-and-hold add. Two
// copies is two places the cache-bust rule (`iconRequestedAt ?? updatedAt`,
// ui-spec-v04 §14.4), the form fallback, or the toast wording can drift — and the
// drift would be invisible, because a cook only ever sees one screen at a time.
// This is the same call kitchenToolService's `toolPicture` makes for the tool
// pictograms, for the same reason. Do not add a third private copy to a page.
//
// It is a DERIVED STORE OF A LOOKUP rather than plain functions, and that is
// reactivity rather than taste: a plain function reading a snapshot has no
// tracked dependency on the stores, so canon and product forms arriving after
// first paint — which is exactly what happens on a cold load — would leave every
// tile bare until something unrelated re-rendered the page.
//
// NOT the same thing as ShoppingListPage's `thumbnailFor`/`iconVersionFor`: that
// pair is keyed by a bare `canonId` off a list row and has no product form to
// prefer, so it resolves a strictly smaller question.

/** The ingredient lookup a cook surface calls, resolved against one snapshot. */
export interface IngredientIconLookup {
  /** The renderable icon URL for this ingredient, or null for a bare tile. */
  thumbnailFor(ingredient: IngredientDoc): string | null;
  /** The display-time cache-bust nonce for that same icon, or undefined. */
  iconVersionFor(ingredient: IngredientDoc): string | number | undefined;
}

function lookupFor(
  items: readonly CanonItem[],
  forms: readonly ProductForm[],
): IngredientIconLookup {
  // Ingredients already carry a `canonId` from canonicalisation, and canon items
  // already carry a generated icon — so a cook screen shows the picture for free.
  // Canon sync is app-wide (App.svelte), so this is a read of an already-live
  // store, not a new subscription.
  const canonIconMap = new Map(
    items.map((ci) => [
      ci.id,
      { thumbnail: ci.thumbnail, version: ci.iconRequestedAt ?? ci.updatedAt },
    ]),
  );

  // A line that names a PRODUCT FORM shows the form's own picture (issue #871):
  // "lime juice" is a bottle or a squeezed half, not a whole lime, and mise en
  // place is exactly where that distinction earns its keep — you are looking for
  // the thing itself, with your hands full.
  //
  // Guarded on the parent inside `resolveIngredientProductForm`: a form counts
  // only when it belongs to the canon item this ingredient actually matched.
  //
  // FALLS BACK when the form has no renderable icon of its own — not generated
  // yet, or hidden. That is not a nicety: generation is edge-triggered, so every
  // form that existed before this shipped has a null thumbnail until it is
  // regenerated, and preferring the form unconditionally would blank an icon that
  // shows a picture today. `isCanonIconRenderable` is the same tri-state
  // read-boundary guard the tiles themselves use.
  function formIconFor(
    ingredient: IngredientDoc,
  ): { thumbnail: string; version: string | number | undefined } | null {
    // `items` is the live canon list this lookup already holds, so the
    // contested-phrase rule (issue #1180) costs no extra read here.
    const form = resolveIngredientProductForm(
      ingredient.parsed?.item,
      ingredient.canonId,
      forms,
      items,
    );
    if (!form || !isCanonIconRenderable(form.thumbnail) || form.thumbnail === null) return null;
    return { thumbnail: form.thumbnail, version: form.iconRequestedAt ?? form.updatedAt };
  }

  return {
    // Tri-state thumbnail. null (→ bare tile) for ingredients that never matched
    // a canon item, which is also what an unmatched row shows on the shopping
    // list.
    thumbnailFor(ingredient) {
      const form = formIconFor(ingredient);
      if (form) return form.thumbnail;
      if (!ingredient.canonId) return null;
      return canonIconMap.get(ingredient.canonId)?.thumbnail ?? null;
    },
    iconVersionFor(ingredient) {
      const form = formIconFor(ingredient);
      if (form) return form.version;
      if (!ingredient.canonId) return undefined;
      return canonIconMap.get(ingredient.canonId)?.version;
    },
  };
}

/**
 * The shared lookup, recomputed whenever canon or the product forms change.
 * Subscribe to it (`$ingredientIcons.thumbnailFor(ingredient)`) so a tile fills
 * in the moment the vocabulary lands.
 */
export const ingredientIcons: Readable<IngredientIconLookup> = derived(
  [canonItems, productForms],
  ([$canonItems, $productForms]) => lookupFor($canonItems, $productForms),
);

/**
 * Alt text for the icon. The parsed item name ("plum tomatoes") beats the raw
 * line ("400g tinned plum tomatoes, drained") for a screen reader announcing a
 * picture.
 */
export function ingredientLabel(ingredient: IngredientDoc): string {
  return ingredient.parsed?.item ?? ingredient.rawText;
}

/**
 * Ran out of something? Hold it (issue #714).
 *
 * Every cook surface that names an ingredient — the mise row, the step's
 * first-use chip, a bowl's contents — answers a press-and-hold by putting that
 * ingredient on the shopping list. It's the one thing a cook wants mid-recipe
 * that cook mode otherwise makes you leave the page for, and holding is the only
 * gesture spare: a tap already toggles the mise row and expands the chip, and a
 * fling already pages the deck.
 *
 * The NAME only — `ingredientLabel`, the same string the canon icon is labelled
 * with — never `IngredientText`'s rendering. "400g tinned plum tomatoes,
 * drained" is what this recipe needs; what you have to buy is tomatoes, in
 * whatever size the shop sells. The server's canon-match trigger takes it from
 * there and files it under an aisle, exactly as it would a typed entry.
 *
 * Targets the DEFAULT list, not whichever list the shopping page was last on —
 * the household has one list it shops from, and cook mode has no list context of
 * its own.
 */
export async function addIngredientToShoppingList(ingredient: IngredientDoc): Promise<void> {
  const name = ingredientLabel(ingredient);
  const result = await addItemToDefaultList(name);
  if (result.kind !== 'ok') {
    // No list to add to is the expected shape of failure here, and it is not the
    // cook's mistake — say what happened and move on. Anything else already
    // reported itself through the service's gate.
    const message =
      result.error.kind === 'NotFound'
        ? "You haven't made a shopping list yet"
        : `Couldn't add ${name} to the shopping list`;
    addToast(message, result.error.kind === 'NotFound' ? 'default' : 'destructive');
    return;
  }
  const { itemId, listId, listName } = result.value;
  addToast(`Added ${name} to ${listName}`, 'success', {
    action: {
      label: 'Undo',
      onClick: () => void deleteItemFromList(listId, itemId),
    },
  });
}
