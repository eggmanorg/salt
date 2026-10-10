import { RecipeKindSchema } from '../../schemas/recipe.js';
import type { Recipe, RecipeKind } from '../entities/Recipe.js';
import { isCookable, takesComponents, takesIngredients } from './capabilities.js';
import { hasComponents } from './components.js';

// Which labels an entry may be switched between (issue #1646).
//
// A switch must never hide what the entry holds. So both ends must be a kind that
// shows ingredients AND a method (`takesIngredients && isCookable`) — today
// recipe, cocktail, cure, bread and ferment — and a meal (an entry with components) may
// move only to a kind that `takesComponents`, or its dishes would drop out of
// view. Specials and placeholders have neither ingredients nor a method, so
// nothing switches into them and they switch into nothing.
//
// Derived from the capability table rather than a column of its own, so a new
// kind is placed by the answers it already gives.
function isRelabelable(kind: RecipeKind): boolean {
  return takesIngredients(kind) && isCookable(kind);
}

/**
 * The labels this entry may wear, in the enum's order, ALWAYS including the one
 * it wears now. A single-element answer means "no choice to offer" — which is
 * what a special or a placeholder gets.
 */
export function relabelChoices(
  recipe: Pick<Recipe, 'kind' | 'componentRecipeIds'>,
): readonly RecipeKind[] {
  if (!isRelabelable(recipe.kind)) return [recipe.kind];
  const meal = hasComponents(recipe);
  return RecipeKindSchema.options.filter(
    (kind) => kind === recipe.kind || (isRelabelable(kind) && (!meal || takesComponents(kind))),
  );
}
