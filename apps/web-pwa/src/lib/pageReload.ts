// The ONE programmatic page reload (issue #1667, Phase 2).
//
// Three things reload the page on their own: the service-worker update flow,
// the stale-chunk recovery (both pwa.ts) and the stuck-write recovery
// (stallRecovery.ts). Each used to keep — or would have kept — its own
// in-memory `reloading` latch, so two of them firing in the same tick would
// each call `location.reload()`. Routing all three through this one latch is
// what makes "they cannot double-fire" true rather than coincidental.
//
// In memory only: a fresh page instance starts unlatched, which is the point —
// the latch covers the window between asking for a reload and the navigation
// happening, never the next page. Loop guards that must survive a reload are
// each caller's own (pwa.ts's PRELOAD_RELOAD_GUARD_KEY; stallRecovery.ts's
// storage-free page-age guard).

let reloading = false;

/** True once any caller has asked for a reload on this page instance. */
export function isPageReloading(): boolean {
  return reloading;
}

/**
 * Reloads the page unless a reload has already been asked for on this page
 * instance. Returns whether THIS call asked for it.
 */
export function reloadPage(): boolean {
  if (reloading) return false;
  reloading = true;
  window.location.reload();
  return true;
}
