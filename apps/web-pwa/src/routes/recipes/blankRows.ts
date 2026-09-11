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
// WHAT IT DROPS TODAY IS STEPS, AND NOTHING ELSE. Issue #1319's Phase 5 adds the
// ingredient rows and the groups they empty to this same function rather than
// inventing a second answer; until it lands, an ingredient row typed blank
// survives every one of the three exits above.
//
// It is a module, not a method on a component, because the caller is the PAGE
// (all three exits above) while the rows belong to its children — and because a
// pure function over a `Recipe` is testable without mounting anything.

import type { Recipe } from '@salt/domain';

/**
 * The recipe with its blank rows gone, or the very same object when there are
 * none.
 *
 * The identity return is load-bearing: every caller writes only when this
 * hands back something different, so leaving edit mode on a recipe nobody has
 * changed issues no write at all.
 *
 * A step is blank when it has neither words, a note, nor a timer — the note
 * half of the rule is the retired editor's `pruneDraft`, kept verbatim so a
 * recipe that survived that save survives this one; the timer half is new
 * (#1336 review, blocking 3): a step carrying a note OR a timer but no words is
 * NOT blank, because both are something a cook set deliberately, and dropping
 * either would lose it. This is only a safe test for "deliberate" because
 * `RecipeMethodRail.svelte`'s `setTimer` never lets an abandoned `+ Timer`
 * reach the document as `{ durationMinutes: 0, description: null }` — a
 * persisted `timer` here always carries a real duration or a label.
 */
export function dropBlankRows(recipe: Recipe): Recipe {
  const steps = recipe.steps.filter(
    (s) => s.text.trim() !== '' || s.note !== null || s.timer !== null,
  );
  if (steps.length === recipe.steps.length) return recipe;
  return { ...recipe, steps };
}
