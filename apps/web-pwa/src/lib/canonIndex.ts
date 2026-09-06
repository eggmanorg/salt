// The canon index, and the gate that says whether it may be judged yet
// (issues #855, #867).
//
// APP-LOCAL on purpose. Neither of these is a rule about what a canon item IS —
// the domain already owns that, and `recipeMatchIssueCount` /
// `ingredientMatchIssue` already take a `ReadonlyMap<string, CanonItem>`. What
// lives here is how the surfaces that call them prepare their arguments, which
// is presentation plumbing. It sits in `lib/` rather than beside the recipe
// routes because one of its consumers is `lib/recipeService.ts`, and nothing in
// `lib/` imports from `routes/`.
//
// It is its own module so both halves can be unit tested without mounting a
// component — the shape `routes/recipes/cookTimerDuration.ts` establishes.

import type { CanonItem } from '@salt/domain';

/**
 * Canon by id, for the domain's match queries.
 *
 * Built once per canon change rather than once per card: `recipeMatchIssueCount`
 * rejects almost every line on two field reads before it ever walks the product
 * forms, so the map is the only per-render cost worth avoiding. Both stores that
 * feed it are app-wide (`App.svelte`), so this costs no extra read.
 *
 * Duplicate ids resolve last-wins, which is `new Map`'s own behaviour and not a
 * rule this function adds — canon ids are document ids and cannot collide.
 */
export function canonIndex(items: readonly CanonItem[]): ReadonlyMap<string, CanonItem> {
  return new Map(items.map((c) => [c.id, c]));
}

/**
 * Whether the match markers may be shown at all.
 *
 * NOTHING is judged until both collections have actually landed. Canon leads and
 * arrives after first paint, and an empty canon makes every matched line look
 * dangling — so without this gate the whole library flashes `review` on every cold
 * load, which is exactly how a marker gets trained out of a person.
 *
 * The length check backs up the load flags rather than duplicating them:
 * `isLoadingAisles` starts false, so a surface that never initialises sync (a
 * test, a stray mount) would otherwise read "loaded" over an empty store.
 * Product forms get the flag but NOT a length check — an empty form table is a
 * legitimate state, and precisely the one these markers exist for (issue #855).
 *
 * ── Why this is one function and not two identical expressions ───────────────
 *
 * The recipe list's card pip and the recipe view's row markers must answer this
 * question IDENTICALLY, or the card says a recipe has three problems and the
 * recipe you open shows you none — the defect issue #867 was filed for. That
 * agreement used to be held by a comment on each page asking the next author to
 * keep them in step. It is now held by there being one answer, and by the
 * three-clause tables in `RecipeListPage.test.ts` and
 * `RecipeViewPage.matchMarkers.test.ts`, which assert every clause on both
 * surfaces (issue #1055).
 *
 * `IngredientMatchSheet` deliberately has NO gate: it is opened by a tap, long
 * after the stores have landed, and gating it would change when it renders.
 *
 * A second copy of either half fails `apps/web-pwa/tests/sharedHelperGuard.test.ts`,
 * which walks the whole of `src`. The agreement is enforced, not requested.
 */
export function matchMarkersReady(
  loadingAisles: boolean,
  loadingProductForms: boolean,
  canonCount: number,
): boolean {
  return !loadingAisles && !loadingProductForms && canonCount > 0;
}
