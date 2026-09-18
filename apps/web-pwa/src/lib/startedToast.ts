import { addToast, dismissToast } from './toastStore.js';

/**
 * Say, in words, that a long AI call has started — and keep saying it until the
 * call settles (issue #1439).
 *
 * The fault this exists for: an AI action triggered from a popover menu item
 * binds its busy flag to `disabled` on that item, and the popover unmounts
 * itself on click. The control carrying the only sign of work is gone before the
 * call is a second old, so the page sits silent for the length of a 120 s
 * callable. A toast is visible from anywhere on the page and outlives the
 * control that raised it, which is precisely the property the trigger lacks.
 *
 * `duration: 0` is a persistent toast — `Toast.svelte` bails out of its
 * auto-dismiss timer on `duration <= 0` — so nothing clears it but this helper's
 * `finally`. That is why the work goes INSIDE the callback rather than the
 * caller raising and clearing by hand: an early `return` from a guard, a thrown
 * error and a normal settle all leave through the same door, and nothing
 * enforces `maxToasts` to catch one that leaks.
 *
 * `'default'` is the variant on purpose: `docs/design/ui-spec-v03.md` §6.5 gives
 * it `role="status"` and no focus steal. Nothing has succeeded yet, and nothing
 * has failed.
 *
 * **The limit of this convention.** It is applied by hand at six call sites —
 * "Update recipe", "Save as new recipe" and "Save as recipe" on `/chat/:id`, and
 * "Update recipe" (which Refresh's second leg also runs through) and "Save as
 * new recipe" on the recipe page — each pinned by a unit test. Nothing enforces
 * it globally and nothing can: no lint rule can tell that a handler behind an
 * `onclick` eventually awaits a callable, nor that its trigger unmounts before
 * the await resolves. A seventh such site added later will not be caught by
 * anything here. Do not read this comment as a claim that every AI action in the
 * app acknowledges itself — it is not true, and it is not checked.
 */
export async function withStartedToast<T>(message: string, run: () => Promise<T>): Promise<T> {
  const id = addToast(message, 'default', { duration: 0 });
  try {
    return await run();
  } finally {
    dismissToast(id);
  }
}
