/**
 * How many people the reader is cooking this recipe for, right now (issue #1314).
 *
 * IT LIVES IN THE URL, AND NOWHERE ELSE. `?serves=N` rides on the hash route of
 * the recipe page and both cook routes, and that is the whole mechanism. The
 * reasoning is `mealReturn.ts`'s, one value over:
 *
 *   - A reload must not lose it. Losing it mid-cook silently reverts nineteen
 *     amounts to the ones the recipe states, with nothing on screen to say so —
 *     the failure class this repo treats as worse than a visible error. A
 *     module-level store dies on every refresh.
 *   - Browser storage is forbidden (CLAUDE.md Rule 3), and rightly: this is
 *     page-scoped reading intent, not user data.
 *   - It is NOT AN EDIT. The recipe document is family-shared and permanent; a
 *     view control must never write to it. A URL expires exactly the way
 *     "temporary" should — leave the recipe and it is gone, and opening it fresh
 *     tomorrow is back to as written.
 *
 * Both functions are pure: no clock, no router, no I/O. Call sites read the live
 * value inside a `$derived` as `readServingsParam(router.querystring)` — the
 * router's `querystring` is reactive, so a hop that changes it re-derives on its
 * own.
 */

/**
 * The ceiling on a hand-typed `?serves=`.
 *
 * The picker only ever offers 1–12 plus the recipe's own stated count, so nothing
 * in the app can produce a number above this. The cap exists for the address bar:
 * `?serves=1e9` is not a serving count anybody is cooking for, and reading it as
 * one would paint a page of nine-digit amounts. Anything beyond reads as no
 * parameter at all — the recipe as written, which is the safe answer.
 */
export const SERVINGS_PARAM_MAX = 100;

/**
 * The servings count carried by a route's querystring, or `null` when there is
 * none to use.
 *
 * `null` covers every way the value can be unusable, and they are deliberately
 * not distinguished: absent, empty, not a number, not a whole one, zero or
 * negative (which is `usableServings`' rule — a 0 is not a scaling base, issue
 * #1123), and above `SERVINGS_PARAM_MAX`. A caller that gets `null` shows the
 * recipe exactly as stored, which is what a nonsense URL should produce.
 */
export function readServingsParam(querystring: string | undefined): number | null {
  if (querystring === undefined || querystring === '') return null;
  const raw = new URLSearchParams(querystring).get('serves');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return null;
  return parsed >= 1 && parsed <= SERVINGS_PARAM_MAX ? parsed : null;
}

/**
 * `path` with the servings count attached, ready for `push()`.
 *
 * `null` returns the path untouched, so "back to as written" is this function
 * with nothing to add rather than a second helper — and the reset leaves a clean
 * URL rather than `?serves=4`. A path that already carries a querystring gets
 * `&`, so this composes with any other route parameter.
 */
export function withServingsParam(path: string, servings: number | null): string {
  if (servings === null) return path;
  return `${path}${path.includes('?') ? '&' : '?'}serves=${encodeURIComponent(String(servings))}`;
}
