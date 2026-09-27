import { addToast } from './toastStore.js';
import { createWakeLock, isWakeLockSupported, type WakeLockController } from './wakeLock.js';

/**
 * The app's one keep-the-screen-awake switch (issue #1620).
 *
 * One module-level controller, so every `KeepAwakeButton` — the title bar's and
 * each cook screen's — reads and flips the same state. Two buttons are two views
 * of one switch, never two switches that could disagree about whether the screen
 * is being held.
 *
 * It has no teardown: nothing here listens for a button unmounting, so leaving a
 * cook does not turn the switch off (pinned in keepAwake.test.ts). It goes off
 * when someone taps a button, or with the page itself. What the switch does NOT
 * promise is that the platform holds a lock at every instant it is on — the OS
 * drops a wake lock while the page is hidden, and `createWakeLock` re-acquires
 * when it is shown again. That lifetime is the decision #1620 records; before it,
 * each cook screen owned its own lock and released it on leave.
 *
 * In memory only. A reload starts with it off, which is also what the browser
 * requires: a wake lock is requested from a user gesture. Persisting the switch
 * would need browser storage, and Rule 3 allows exactly three keys.
 *
 * The Wake Lock API handling itself — re-acquire on `visibilitychange`, rollback
 * on refusal, never throwing — is `createWakeLock`'s and is not repeated here.
 */

// Created on first use rather than at import, so the feature check reads the
// platform when it is asked rather than when the module happened to load.
let wake: WakeLockController | null = null;
let held = $state(false);
// Plain `let`, not `$state` — a re-entrancy guard only read inside `toggle`.
let toggling = false;

function controller(): WakeLockController | null {
  if (!isWakeLockSupported()) return null;
  wake ??= createWakeLock();
  return wake;
}

// The icon alone is a quiet affordance, so every change is confirmed by a toast.
// The ON path reports what actually happened: `enable()` resolves false when the
// browser or OS refuses, and the switch must not claim a lock it never got.
async function toggle(): Promise<void> {
  if (toggling) return;
  toggling = true;
  try {
    const lock = controller();
    if (held) {
      await lock?.disable();
      held = false;
      addToast('Screen can sleep again', 'success');
      return;
    }
    const acquired = (await lock?.enable()) ?? false;
    held = acquired;
    if (acquired) addToast('Screen will stay awake', 'success');
    else addToast("Your browser wouldn't let the screen stay awake.", 'destructive');
  } finally {
    toggling = false;
  }
}

export const keepAwake = {
  /** Whether the Screen Wake Lock API is there to offer at all. */
  get supported(): boolean {
    return isWakeLockSupported();
  },
  /** Whether the screen is being held awake — the one state every button shows. */
  get held(): boolean {
    return held;
  },
  toggle,
};

/**
 * Test-only: forget the held state and the controller. The switch is a module
 * singleton by design, so a suite that turns it on in one test would otherwise
 * start the next test with it on.
 */
export function __resetKeepAwakeForTest(): void {
  wake = null;
  held = false;
  toggling = false;
}
