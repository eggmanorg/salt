/**
 * Stamp a recipe's audit attribution (issue #845).
 *
 * The ONE implementation of the rule, in the domain because it is now applied on
 * BOTH sides of the callable boundary: the browser stamps every in-place edit,
 * and the librarian flow stamps the recipe it authors and writes itself (issue
 * #1431, which moved that write out of the browser). Three lines is exactly the
 * size that gets retyped rather than imported, and one rule written twice is how
 * the propose/apply pair drifted (#764).
 *
 * `createdBy` is fill-once; `lastEditedBy` is re-stamped on every write. A recipe
 * is added once and edited forever, so a later editor never becomes its creator.
 *
 * An empty name leaves BOTH fields exactly as they were. A placeholder ("Unknown",
 * "Someone") reads as a person, `''` already means "no attribution on record", and
 * clobbering a real creator because a roster had not loaded — or because a Cloud
 * Function was handed no name — is worse than recording nothing.
 *
 * Identity-free by construction: it takes a display NAME, never a user or a uid.
 * Both fields are audit only — displayed and nothing else, never read on a gate
 * and never a scope (CLAUDE.md → Data model conventions), which is what makes it
 * safe for the name to arrive from the client on the `authorRecipe` wire.
 *
 * Generic over the two fields rather than over `Recipe`: the browser holds a
 * `Recipe` and the Cloud Function a `RecipeDoc`, and the rule has no opinion about
 * anything else on either.
 */
export function stampAttribution<T extends { createdBy: string; lastEditedBy: string }>(
  recipe: T,
  memberName: string,
): T {
  if (!memberName) return recipe;
  return { ...recipe, createdBy: recipe.createdBy || memberName, lastEditedBy: memberName };
}
