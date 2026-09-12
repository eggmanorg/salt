// Web Share Target (issue #589) — Android/Chromium only.
//
// The manifest declares a GET share target with `action: '/'` (see vite.config.ts),
// so an OS share lands on the app's own entry URL with the shared payload in the
// query string BEFORE the hash: `/?url=…&text=…&title=…`. GET is deliberate — a
// POST target would have to be intercepted in the service worker, and this repo's
// SW is Workbox-generated, never hand-authored (#141, #544). `action: '/'` is
// forced by hosting: firebase.json declares no rewrites and the app is hash-routed,
// so any prettier action path would 404.
//
// Two moving parts, split so the fragile half runs early and the async half runs
// late:
//   1. captureShareTarget() — called from main.ts before mount. Reads
//      location.search once, then history.replaceState's it away (the same
//      clean-the-URL move the magic-link flow makes) so a reload can't re-import.
//   2. runPendingShareImport() — called once auth has resolved, because the import
//      goes through an authenticated callable.
//
// Rule 3: the pending share lives in module memory, never in browser storage.
// Rule 10: a share with no usable link is an EXPECTED input — it takes the
// friendly-toast path and is never reported as an error.

import { push } from 'svelte-spa-router';
import { addToast, dismissToast } from './toastStore.js';
import {
  importRecipeFromUrl,
  stashImportedDraft,
  urlImportMessage,
  isSignedOutFailure,
  stashPendingImportUrl,
} from './recipeService.js';

/**
 * A captured share. `url` is null when something was shared but no http(s) link
 * could be found in it — a real case (a plain-text share, or an app that shares
 * only a caption), distinct from "no share happened at all" (represented by a
 * null payload).
 */
export type SharePayload = { url: string | null };

// First http(s) URL anywhere in the string. Instagram/WhatsApp share a caption
// *containing* a link rather than a bare URL, so the whole payload is scanned.
// Trailing punctuation that commonly hugs a pasted link is trimmed; anything
// non-http (mailto:, javascript:, app deep links) is deliberately not matched —
// the CF import only accepts http(s) anyway.
const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function extractSharedUrl(params: URLSearchParams): string | null {
  // `url` first: when the sharing app fills it, it is the clean canonical link.
  // `text` and `title` are fallbacks for apps that stuff everything into text.
  for (const key of ['url', 'text', 'title']) {
    const raw = params.get(key);
    if (!raw) continue;
    const match = URL_RE.exec(raw);
    if (!match) continue;
    const cleaned = match[0].replace(/[.,;:!?)\]}'"]+$/, '');
    // Final sanity check — a regex match can still be an unparseable URL.
    try {
      return new URL(cleaned).href;
    } catch {
      continue;
    }
  }
  return null;
}

// True when the query string looks like a share-target hand-off at all. Any other
// query string (or none) must be left alone — this hook is not a general router.
function isShareQuery(params: URLSearchParams): boolean {
  return params.has('url') || params.has('text') || params.has('title');
}

let _pending: SharePayload | null = null;

// Bounded, never-throwing host for display. A URL that got this far parses, but
// the progress message must not be the thing that breaks an import.
function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the web';
  }
}

/**
 * Read the share-target query string once, at boot, and strip it from the URL.
 * Idempotent and never throws — a browser without history.replaceState just keeps
 * the query (worst case: a manual reload re-imports).
 */
export function captureShareTarget(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!isShareQuery(params)) return;
    _pending = { url: extractSharedUrl(params) };
    // Drop the query AND point the route at Recipes in one rewrite. Setting the
    // hash here — before mount, so svelte-spa-router reads it as its initial
    // route — is what stops the app booting onto the default tab (the shopping
    // list) and flashing an unrelated screen while the import runs. Recipes is
    // where the import lands either way, so it's also the right place to fail.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}#/recipes`);
  } catch {
    /* Best-effort: a share we can't read is simply not a share. */
  }
}

/** Single-use read of the captured share, mirroring takeImportedDraft(). */
export function takePendingShare(): SharePayload | null {
  const p = _pending;
  _pending = null;
  return p;
}

// Navigate, reporting success as a boolean. `push` both throws and rejects on an
// unroutable path, so the two are collapsed here rather than at each call site.
async function goTo(path: string): Promise<boolean> {
  try {
    await push(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the import for a captured share. Walks the exact path the "Import from URL"
 * button walks (importRecipeFromUrl → stashImportedDraft → /recipes/{id}) so there
 * is only one import flow to maintain.
 *
 * `signedIn` false drops the share with a toast rather than resuming after
 * sign-in: carrying it across an auth redirect would need browser storage (Rule 3),
 * and anyone sharing into Salt is on a device where they already signed in.
 */
export async function runPendingShareImport(signedIn: boolean): Promise<void> {
  const pending = takePendingShare();
  if (!pending) return;

  if (!signedIn) {
    addToast('Sign in to Salt, then share the link again.', 'destructive');
    return;
  }

  if (pending.url === null) {
    addToast("That share didn't contain a web link to import.", 'destructive');
    await goTo('/recipes');
    return;
  }

  // Tell the user something is happening. A toast rather than anything
  // page-owned: the extraction takes several seconds, and this runs at boot from
  // a share, so whatever screen is up is usually still loading — ListPage renders
  // a bare spinner while its store syncs and would swallow an in-page banner
  // exactly when it is needed. The toast lives in the app shell, so it shows on
  // every route and in every load state. Held open for the whole import (the
  // client gives up long before this) and dismissed explicitly below.
  const progressToastId = addToast(
    `Importing recipe from ${displayHost(pending.url)} in the background…`,
    'default',
    { duration: 120_000 },
  );

  // importRecipeFromUrl returns Failure rather than throwing (Rule 10), but this
  // runs from a fire-and-forget effect at boot: an unexpected throw would become
  // an unhandled rejection with no UI to show for it, so it is folded onto the
  // same friendly path as a failed import.
  let result: Awaited<ReturnType<typeof importRecipeFromUrl>> | null = null;
  try {
    result = await importRecipeFromUrl(pending.url, 'share');
  } catch {
    result = null;
  } finally {
    dismissToast(progressToastId);
  }

  if (result === null || result.kind !== 'ok') {
    // A share that died on a dead session (issue #740) hands the link to the
    // recipe list, which reopens the import sheet with it already filled in and
    // offers the way back to sign-in. Shared links are the case where re-copying
    // hurts most — the user came from another app and may not be able to get
    // back to it.
    if (result !== null && isSignedOutFailure(result.error)) {
      stashPendingImportUrl(pending.url);
    }
    addToast(
      result === null
        ? 'Could not import that link — please try again.'
        : urlImportMessage(result.error),
      'destructive',
    );
    await goTo('/recipes');
    return;
  }

  // Already persisted server-side and flagged unreviewed (issue #616), so this
  // opens the existing recipe — its own PAGE since issue #1319 Phase 7, where the
  // unreviewed banner lives and everything is editable in place. The stash just
  // saves that page a listener round-trip. A navigation failure is cosmetic — the
  // recipe is safely in the collection — so the toast points at where it landed.
  stashImportedDraft(result.value);
  if (!(await goTo(`/recipes/${result.value.id}`))) {
    addToast(`Imported "${result.value.title}" — find it in Recipes.`, 'default');
  }
}
