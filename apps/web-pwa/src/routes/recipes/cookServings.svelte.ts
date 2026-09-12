import { router } from 'svelte-spa-router';
import { servingsScale } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';
import { persistCookSession } from '../../lib/cookSessionService.js';
import { readServingsParam } from './servingsParam.js';

/**
 * How many a cook screen is cooking for, and the factor its amounts are drawn at
 * (issue #1314).
 *
 * There are two cook screens and they are the same cook — the same
 * `cookSessions/{recipeId}_{uid}` document — so this is written once and used by
 * both, for the reason `cookLifecycle.svelte.ts` exists (issue #994): a rule
 * about which number wins, held in two copies, is a rule that will eventually be
 * two rules.
 *
 * ─── Which number wins ───────────────────────────────────────────────────────
 *
 *   the URL   `?serves=N`, carried in from the recipe page. Authoritative when
 *             present, and the cook page PINS it onto the session as it opens.
 *   the session, when the URL carries none. That is what a resume is: reopening
 *             the same recipe on another device finds the same session (the id is
 *             deterministic) and must show the same amounts, with no link to
 *             carry them.
 *   the recipe, when neither says otherwise — as written.
 *
 * A recipe with no usable servings count (`usableServings`, issue #1123 — `null`
 * and `0` both fail) cannot be scaled at all, and a `?serves=` aimed at one is
 * ignored rather than honoured.
 *
 * WHICH number wins is this file's rule, above. What that number MEANS — the
 * base/active/factor arithmetic — is `servingsScale` in the pure module, shared
 * with the recipe page (issue #1321), for exactly the reason this file exists.
 *
 * It lives in `routes/recipes/` rather than `lib/` because `readServingsParam` is
 * the recipe routes' own parameter and `lib/` must not reach up into a route
 * folder to find it.
 */
export interface CookServingsOptions {
  /** The recipe being cooked, `null` while it loads. */
  recipe: () => Recipe | null;
  /** The live cook session, `null` before it resolves. */
  session: () => CookSessionDoc | null;
}

export function createCookServings(options: CookServingsOptions) {
  const fromUrl = $derived(readServingsParam(router.querystring));
  const scaling = $derived(
    servingsScale(
      options.recipe()?.metadata.servings ?? null,
      fromUrl ?? options.session()?.servings ?? null,
    ),
  );
  const base = $derived(scaling?.base ?? null);

  // ─── Pin the scale the cook OPENED with ──────────────────────────────────────
  //
  // Only when the URL carries a number: that is the one moment this screen learns
  // something the session does not already know. Arriving with no parameter is a
  // RESUME, and a resume reads the session rather than writing to it — otherwise
  // every cook ever started would take a write on open for a value it already had.
  //
  // The recipe's own number is stored as `null`, not as itself: "as written" is one
  // state, and a session recording `4` against a recipe later edited to serve 6
  // would claim a scale nobody chose.
  //
  // A whole-document write through `persistCookSession`, exactly as the tick lists
  // do — a client `setDoc` rewrites the whole cook session (CLAUDE.md, LWW), so
  // there is no partial write to add here.
  //
  // Guarded on the session's OWN value alone, not on anything this screen
  // remembers writing. `persistCookSession` sets the store optimistically to the
  // new value SYNCHRONOUSLY, before it awaits the network write, so this effect's
  // own re-run (triggered by that same store update) already sees
  // `s.servings === next` and returns on the first check — an instance-level
  // "already wrote this" flag is redundant with that, and it is actively wrong
  // across a session REPLACEMENT: a Restart deletes the session and writes a
  // fresh one (`servings: null`), so the old pinned value can survive in this
  // closure and wrongly refuse to re-pin the new document. Reading only the
  // session also makes this self-healing after the ordinary LWW case (CLAUDE.md):
  // if a concurrent whole-document `setDoc` clobbers this field, the next
  // snapshot disagrees with `next` again and gets re-pinned.
  $effect(() => {
    const s = options.session();
    const url = fromUrl;
    const b = base;
    if (!s || b === null || url === null) return;
    const next = url === b ? null : url;
    if (s.servings === next) return;
    void persistCookSession({ ...s, servings: next });
  });

  return {
    /** The recipe's own stated count when it can be a scaling base, else `null`. */
    get base(): number | null {
      return base;
    },
    /** How many this cook is for. `null` only when the recipe cannot be scaled. */
    get active(): number | null {
      return scaling?.active ?? null;
    },
    /** The factor every amount on the screen is drawn at. */
    get scale(): number {
      return scaling?.factor ?? 1;
    },
    /** Whether this cook is for a different number than the recipe states. */
    get isScaled(): boolean {
      return scaling?.isScaled ?? false;
    },
    /**
     * The two numbers to say out loud, or `null` when this cook is as written.
     *
     * One nullable rather than three checks at each call site: an unscaled cook and
     * an unscalable recipe are the same answer here, and a screen re-deriving that
     * implication is a screen that can get it wrong.
     */
    get scaled(): { active: number; base: number } | null {
      return scaling?.isScaled ? { active: scaling.active, base: scaling.base } : null;
    },
  };
}
