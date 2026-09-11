// Dropping the blank rows an in-place edit leaves behind (issue #1319).
//
// The retired editor pruned on SAVE: ingredient rows with no text, groups left
// empty once those went, and stepless steps. Under autosave there is no save, and
// pruning on a keystroke would delete the row you just added before you had a
// chance to type in it. So the prune runs at every point edit mode actually
// ENDS, not just the one that first shipped it: `RecipeViewPage.svelte`'s
// `finishEditing` (Done — it already flushes the coalescer and clears
// `needs_approval`), its id-keyed `$effect` (the route moving to a different
// recipe while still editing — a "Made from" tap reuses this same component
// instance), and its `onDestroy` (leaving the page outright — Back, a nav tap,
// or the card's own New → Manual). Wiring the prune into only `finishEditing`
// left the other two silently keeping a wordless step forever — the exact
// outcome this rule exists to prevent (#1336 review, blocking 2).
//
// IT NOW DROPS BOTH HALVES OF THE RETIRED EDITOR'S `pruneDraft`: stepless steps
// (#1336, Phase 4) and blank ingredient rows with the groups they empty (Phase
// 5). The two halves are independent — a recipe can need one and not the other —
// and `dropBlankRows` is the only place either rule is expressed.
//
// It is a module, not a method on a component, because the caller is the PAGE
// (all three exits above) while the rows belong to its children — and because a
// pure function over a `Recipe` is testable without mounting anything.

import type { IngredientGroup, Recipe } from '@salt/domain';

/**
 * The recipe with its blank rows gone, or the very same object when there are
 * none.
 *
 * The identity return is load-bearing: every caller writes only when this
 * hands back something different, so leaving edit mode on a recipe nobody has
 * changed issues no write at all. THE BOUNDARY of that claim, stated rather
 * than rounded up to an absolute: "nobody has changed" means the DOCUMENT
 * carries no blank row and no empty group. One that already does — written by
 * the retired editor's own `Add group` with nothing typed into it, or by an
 * import — is rewritten by the first Done anyone presses on it, which is the
 * right answer: that press is the one moment a human has been through it.
 *
 * A STEP is blank when it has neither words, a note, nor a timer — the note
 * half of the rule is the retired editor's `pruneDraft`, kept verbatim so a
 * recipe that survived that save survives this one; the timer half is new
 * (#1336 review, blocking 3): a step carrying a note OR a timer but no words is
 * NOT blank, because both are something a cook set deliberately, and dropping
 * either would lose it. This is only a safe test for "deliberate" because
 * `RecipeMethodRail.svelte`'s `setTimer` never lets an abandoned `+ Timer`
 * reach the document as `{ durationMinutes: 0, description: null }` — a
 * persisted `timer` here always carries a real duration or a label.
 *
 * AN INGREDIENT ROW is blank when its `rawText` is empty once trimmed, and that
 * is the whole of the rule — deliberately narrower than the step's, because an
 * ingredient has nothing a step's note or timer is analogous to. `parsed`,
 * `canonId` and `matchState` are the MATCH, which is derived from the text and
 * which `clearIngredientMatch` resets on every reword, so they cannot outlive
 * the words that produced them; `isOptional` and `firstUsedInStepId` are flags
 * ABOUT a line and say nothing on their own. So an empty line carries nothing a
 * human chose, and the retired editor's own test for it
 * (`i.rawText.trim() !== ''`) is kept verbatim.
 *
 * A GROUP goes when it has no rows left, named or not — again the editor's rule
 * verbatim (`.filter((g) => g.items.length > 0)`). A heading with nothing under
 * it is not a part of a recipe, and the `+ Add a group` slot is an imperative
 * that writes the group it promises, so this is what keeps a stray tap on it
 * from leaving a heading behind forever.
 */
export function dropBlankRows(recipe: Recipe): Recipe {
  const steps = recipe.steps.filter(
    (s) => s.text.trim() !== '' || s.note !== null || s.timer !== null,
  );
  const ingredients = pruneIngredients(recipe.ingredients);
  // Length comparison for the steps and for the GROUPS; per-group identity for
  // the rows inside a group that survived. `pruneIngredients` returns each group
  // unchanged when none of its rows went, so a surviving group is `!==` its
  // original one exactly when it lost a row — and when no group was dropped the
  // two arrays are index-aligned, which is what makes the positional comparison
  // sound.
  const changed =
    steps.length !== recipe.steps.length ||
    ingredients.length !== recipe.ingredients.length ||
    ingredients.some((g, i) => g !== recipe.ingredients[i]);
  if (!changed) return recipe;
  return { ...recipe, steps, ingredients };
}

function pruneIngredients(groups: readonly IngredientGroup[]): IngredientGroup[] {
  return groups
    .map((g) => {
      const items = g.items.filter((i) => i.rawText.trim() !== '');
      return items.length === g.items.length ? g : { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}
