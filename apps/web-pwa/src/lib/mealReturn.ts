/**
 * Where a create flow goes when it finishes — the "return target" of the four
 * ways into a new recipe, reached FROM a meal (issue #752, Phase 3).
 *
 * Start a dish from a meal — import a URL, photograph a page, chat one up, or
 * type it out — and when it saves it has to attach itself to that meal and put
 * you back on it. So each of those flows has to carry one string, the meal's id,
 * from the moment you tap "New" to the moment the new dish is saved.
 *
 * IT LIVES IN THE URL, AND NOWHERE ELSE. `?meal=<id>` rides on the hash route of
 * every hop, and that is the whole mechanism. Not a module-level stash, not a
 * store, not a field on the draft:
 *
 *   - A reload must not lose it. `recipeService`'s `_pendingImportUrl` /
 *     `_pendingImportDraft` and `shareTarget`'s `_pending` are module state, and
 *     every one of them dies on a refresh. That is tolerable for a draft the
 *     server already persisted; it is not tolerable for the only record of where
 *     the user is trying to get back to, because losing it strands a saved dish
 *     with no way to say what it was for.
 *   - The paths that need it are MULTI-STEP by construction: the chat path is two
 *     hops (`/chat` → `/chat/{id}`) and the dish it attaches does not exist
 *     until the conversation makes one, so the meal id has to outlive a
 *     navigation. Anything that does not survive one cannot serve it.
 *
 *     THE JUSTIFICATION HAS NARROWED, and this is the honest version of it. It
 *     used to rest on the import paths too — the callable persisted the recipe
 *     and routed to `/recipes/{id}/edit`, a whole navigation later. #1319 Phase 7
 *     moved that attach to the moment the dish is created, and Phase 8 deleted
 *     the route, so the imports no longer carry the param at all. Chat is the
 *     only consumer left. One consumer is still enough to need the URL — the
 *     reasoning above applies unchanged to it — but "the import paths need this"
 *     is no longer a reason anyone can check.
 *   - Browser storage is forbidden (CLAUDE.md Rule 3), and rightly: this is
 *     page-scoped navigation intent, not user data.
 *
 * A URL is the one place a browser already keeps a small piece of "where I am"
 * across reloads, back/forward and a shared link — so the round trip is reload-
 * safe at every hop for free, with nothing to clean up when it is abandoned.
 * Abandon a create and the id goes with the page you left; nothing was written.
 *
 * Both functions are pure: no clock, no router, no I/O. Call sites read the live
 * value inside a `$derived` as `readMealParam(router.querystring)` — the router's
 * `querystring` is reactive, so a hop that changes it re-derives on its own.
 */

/**
 * The meal id carried by a route's querystring, or `null` when there is none.
 *
 * Absent, empty and whitespace-only all read as `null` — a hand-typed
 * `?meal=` must behave exactly like no parameter at all rather than pointing the
 * save path at a meal id of `''`.
 */
export function readMealParam(querystring: string | undefined): string | null {
  if (querystring === undefined || querystring === '') return null;
  const raw = new URLSearchParams(querystring).get('meal');
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `path` with the meal id attached, ready for `push()`.
 *
 * `null` (or a blank id) returns the path untouched, so a call site can hand
 * over whatever it has without branching. A path that already carries a
 * querystring gets `&`, so this composes with any future route parameter. The id
 * is encoded — it is a document id today, but a value going into a URL is
 * escaped on the way in, not trusted to be safe.
 */
export function withMealParam(path: string, mealId: string | null): string {
  if (mealId === null) return path;
  const trimmed = mealId.trim();
  if (trimmed === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}meal=${encodeURIComponent(trimmed)}`;
}
