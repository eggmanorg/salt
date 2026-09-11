// Dropping the blank rows an in-place edit leaves behind (issue #1319).
//
// The retired editor pruned on SAVE: ingredient rows with no text, groups left
// empty once those went, and stepless steps. Under autosave there is no save, and
// pruning on a keystroke would delete the row you just added before you had a
// chance to type in it. **Done** is the one deliberate boundary left in the flow
// — it already flushes the coalescer and clears `needs_approval` — so the prune
// composes in beside them, in `RecipeViewPage.svelte`'s `finishEditing`.
//
// WHAT IT DROPS TODAY IS STEPS, AND NOTHING ELSE. Issue #1319's Phase 5 adds the
// ingredient rows and the groups they empty to this same function rather than
// inventing a second answer; until it lands, an ingredient row typed blank
// survives Done. Stated rather than left to be discovered from the name.
//
// It is a module, not a method on a component, because the caller is the PAGE
// (`finishEditing`) while the rows belong to its children — and because a pure
// function over a `Recipe` is testable without mounting anything.

import type { Recipe } from '@salt/domain';

/**
 * The recipe with its blank rows gone, or the very same object when there are
 * none.
 *
 * The identity return is load-bearing: `finishEditing` writes only when this
 * hands back something different, so pressing Done on a recipe nobody has
 * changed issues no write at all.
 *
 * A step is blank when it has neither words nor a note — the same rule the
 * retired editor's `pruneDraft` used, kept verbatim so a recipe that survived
 * that save survives this one. A step carrying a note but no words is NOT blank:
 * it is a caution somebody wrote deliberately, and dropping it would lose it.
 */
export function dropBlankRows(recipe: Recipe): Recipe {
  const steps = recipe.steps.filter((s) => s.text.trim() !== '' || s.note !== null);
  if (steps.length === recipe.steps.length) return recipe;
  return { ...recipe, steps };
}
