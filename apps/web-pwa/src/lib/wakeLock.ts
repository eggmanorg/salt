// Screen Wake Lock wrapper (cooking mode, Phase 1). A thin, feature-detected
// wrapper around the Screen Wake Lock API (`navigator.wakeLock`) so the app can
// keep the screen awake while the user has their hands full. This is a DISPLAY
// API, not storage — no Rule 3 concern.
//
// Everything here degrades gracefully and NEVER throws: an unsupported browser, a
// rejected acquire (e.g. the tab isn't visible, or the OS denies it), or a release
// on an already-released sentinel all resolve quietly. Failure is RETURNED, not
// thrown and not reported — `enable()` resolves to whether the lock is actually
// held, so the caller can confirm or correct its UI instead of assuming. Nothing
// here reaches ErrorReportingPort by design: a platform declining a wake lock is an
// expected outcome, not the kind of unexpected failure reporting exists to surface.
//
// The OS releases a wake lock automatically whenever the page is hidden (tab
// switch, screen off). `createWakeLock().enable()` re-acquires on `visibilitychange`
// when the document becomes visible again, so the lock survives a backgrounding.

// Minimal structural types — the DOM lib may not ship WakeLock typings in every TS
// config, and we only touch this narrow surface.
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  const wl = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  return wl ?? null;
}

// Feature-detect guard: the UI toggle is rendered only where this is true.
export function isWakeLockSupported(): boolean {
  return wakeLockApi() !== null;
}

export interface WakeLockController {
  // Acquire the lock and keep it (re-acquiring across visibility changes). Safe to
  // call when already enabled or when unsupported.
  //
  // Resolves TRUE when the lock is held and will be maintained, FALSE when the
  // browser or OS refused it — in which case nothing is held and nothing is pending,
  // so a false result needs no `disable()` to clean up. A bare boolean rather than a
  // `ReadResult<…, DomainError>` (as the Firestore-backed services use) because there
  // is exactly one failure mode with no payload worth carrying: the platform said no.
  enable(): Promise<boolean>;
  // Release the lock and stop re-acquiring. Safe to call when already disabled.
  disable(): Promise<void>;
}

// Create an idempotent wake-lock controller. This factory makes a fresh one per
// call; the app makes one, lazily, in `./keepAwake.svelte.ts` (issue #1620).
export function createWakeLock(): WakeLockController {
  let sentinel: WakeLockSentinelLike | null = null;
  // Desired state: true once the user enables, false once they disable. The
  // visibility handler re-acquires only while this is true.
  let wanted = false;
  let visibilityListener: (() => void) | null = null;

  // Resolves whether the lock is held once this settles. Already-held counts as
  // success; unsupported, denied, or raced-with-disable all count as failure.
  async function acquire(): Promise<boolean> {
    const api = wakeLockApi();
    if (!api) return false;
    if (sentinel !== null) return true;
    try {
      const s = await api.request('screen');
      // The OS may have flipped `wanted` off (disable() raced) or hidden the page
      // while awaiting — drop the freshly-acquired lock in that case.
      if (!wanted) {
        void s.release().catch(() => {});
        return false;
      }
      sentinel = s;
      // The sentinel auto-releases when the page is hidden; clear our handle so the
      // visibility handler re-acquires cleanly on return.
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
      });
      return true;
    } catch {
      // Denied / not visible / unsupported — degrade silently, return the failure.
      return false;
    }
  }

  async function enable(): Promise<boolean> {
    wanted = true;
    if (typeof document !== 'undefined' && visibilityListener === null) {
      visibilityListener = () => {
        if (wanted && document.visibilityState === 'visible') void acquire();
      };
      document.addEventListener('visibilitychange', visibilityListener);
    }
    const acquired = await acquire();
    // Roll back on refusal so the controller's state matches what we just reported:
    // leaving `wanted` true would keep the visibility handler armed and silently
    // acquire a lock later, behind a UI that says the toggle is off. `enable()` is
    // only ever called from a user gesture (so the page IS visible) — a failure here
    // is a real platform refusal, not the transient hidden-page case the handler exists
    // to recover from.
    if (!acquired) await disable();
    return acquired;
  }

  async function disable(): Promise<void> {
    wanted = false;
    if (visibilityListener !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityListener);
      visibilityListener = null;
    }
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) {
      try {
        await s.release();
      } catch {
        // Already released or the tab is gone — nothing to do.
      }
    }
  }

  return { enable, disable };
}
