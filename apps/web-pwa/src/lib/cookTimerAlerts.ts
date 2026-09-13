import { get } from 'svelte/store';
import { push } from 'svelte-spa-router';
import { isCheckInTimerId } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';
import { cookSession } from './cookSessionService.js';
import { kitchenTimers } from './kitchenTimerService.js';
import { addToast } from './toastStore.js';
import { playChime } from './chime.js';

// App-level timer alerts (issue #544 follow-up; standalone timers, #842). The
// chime used to live in
// CookModePage, which left a hole: a timer finishing while the chef was on the
// shopping list alerted NOWHERE. push-sw.js suppresses the OS notification
// whenever any window client is visible, and the cook page — the only thing that
// could chime — was unmounted. This watcher is the single in-app alert owner, so
// it runs for as long as the app is open, wherever the chef has navigated to.
//
// It reads the EXISTING cookSession store rather than opening a subscription of
// its own, because two things make that enough:
//   - the store is module-level, and CookModePage's teardown only drops the
//     Firestore listener, so the last snapshot survives navigation;
//   - `endsAt` is ABSOLUTE, so firing a timer needs a clock, not fresh data.
//
// Two cases that deliberately belong to the push instead:
//   - a cook STARTED on another device while we are elsewhere in the app —
//     nothing ever subscribed us to it, so there is no snapshot to tick;
//   - a timer cancelled on another device after we left the cook page still
//     alerts here (the dispatch handler re-reads the live session and no-ops; an
//     in-memory snapshot cannot). A spurious toast, never a missed timer.

const TICK_MS = 1_000;

// A lag longer than one tick means the page was FROZEN across the end-time (iOS
// suspends a backgrounded PWA and stops timers; browsers throttle hidden tabs).
// A frozen page has no visible window client, so push-sw.js did NOT suppress and
// the chef already got the OS notification — alerting on return would be a second
// alert for a timer they have already been told about.
const GRACE_MS = 2_000;

// Long enough to notice from across the kitchen, and it carries an action.
const TOAST_MS = 12_000;

function timerKey(sessionId: string, timerId: string, endsAt: string): string {
  return `${sessionId}::${timerId}@${endsAt}`;
}

// Standalone timers key off the same builder with a reserved prefix in place of
// a session id, so both kinds share ONE dedupe map and a timer can never be
// alerted twice by two sets that disagree. `kitchen::` cannot collide with a
// cook session id, which is always `cookSessionId`'s `${recipeId}_${uid}`.
function kitchenTimerKey(timerId: string, endsAt: string): string {
  return timerKey('kitchen', timerId, endsAt);
}

// A standalone timer's HOME: the page that draws it, where its card flips to
// "Finished" in front of the chef — the same visible acknowledgement that earns a
// cook timer's chip its suppression on the cook page.
//
// There are two of them since issue #1327. My Kitchen is where a timer from nowhere
// in particular lives; a timer armed on a batch cook page lives THERE, and sending
// the chef to Mine for it — the thing option (a) would have shipped — is exactly
// what `origin` exists to prevent.
//
// Taken from the timer's OWN origin rather than from a route match, so a timer from
// batch A firing while the chef stands on batch B's cook page still toasts, and
// still offers the way back to A. `origin` is null for every My Kitchen timer and
// for every timer written before the field, so both land on the kitchen path
// exactly as before.
const KITCHEN_PATH = '/mine';

function timerHomePath(batchId: string | null): string {
  return batchId === null ? KITCHEN_PATH : `/batches/${batchId}/cook`;
}

function viewingPath(path: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hash === `#${path}`;
}

function plainCookPath(session: CookSessionDoc): string {
  return `/recipes/${session.recipeId}/cook`;
}

// Which cook page the chef is looking at for THIS session, or null for anywhere
// else in the app. TWO routes lead to one session — plain cook mode and the guided
// cook (issue #751) — and they are not interchangeable: the guided one is the same
// cook read through the recipe's plan. Hash-routed app, so the live route is the
// hash; read directly rather than through the router so this stays a plain module
// with no component or store coupling.
function viewedCookPath(session: CookSessionDoc): string | null {
  if (typeof window === 'undefined') return null;
  const plain = plainCookPath(session);
  if (window.location.hash === `#${plain}`) return plain;
  if (window.location.hash === `#${plain}/guided`) return `${plain}/guided`;
  return null;
}

export function initCookTimerAlerts(): () => void {
  // Both sets are keyed by owner (a session id, or the reserved `kitchen`) +
  // timer id + end-time, so adjusting a timer (which changes `endsAt`) is a new
  // timer to be alerted for, and a re-armed timer on a later cook is never
  // mistaken for one already handled. ONE pair of sets for both kinds: a timer
  // must be alerted once, not once per watcher.
  const observedRunning = new Set<string>();
  const alerted = new Set<string>();
  // The cook page this session was last seen on, so "Back to the cook" returns the
  // chef to the MODE they left. Which mode a cook is being read in is nowhere in
  // the session document (deliberately — it is a view, not a fact about the cook),
  // so the only honest source is where they last were. Keyed by session so a
  // second cook never inherits the first one's route.
  let lastSeenOn: { sessionId: string; path: string } | null = null;

  // The one place a fire is decided, shared by both kinds of timer. Answers
  // "should this timer alert right now?" and marks it resolved either way, so a
  // fire discovered late stays silent rather than surfacing on some later tick.
  // Returns false when there is nothing to announce.
  function claimFire(key: string, endsAtMs: number, now: number): boolean {
    if (endsAtMs > now) {
      observedRunning.add(key);
      return false;
    }
    // Never seen running — it finished before this watcher was here (a fresh
    // load, or the timer was started on another device), so it was never ours to
    // announce. Already alerted — nothing more to do.
    if (!observedRunning.has(key) || alerted.has(key)) return false;
    alerted.add(key);
    return now - endsAtMs <= GRACE_MS;
  }

  function check(): void {
    checkCookTimers();
    checkKitchenTimers();
  }

  // Standalone timers (issue #842) — no cook session to re-read, and only the
  // surface they were armed from to send the chef back to. A separate pass rather
  // than more branches inside the cook one: the two share the dedupe sets and the
  // grace window, and nothing else.
  function checkKitchenTimers(): void {
    const doc = get(kitchenTimers);
    if (!doc) return;
    const now = Date.now();
    for (const timer of doc.timers) {
      const key = kitchenTimerKey(timer.id, timer.endsAt);
      if (!claimFire(key, new Date(timer.endsAt).getTime(), now)) continue;
      playChime();
      const batchId = timer.origin?.batchId ?? null;
      const home = timerHomePath(batchId);
      // Standing on its home, the card is already saying so. Anywhere else the
      // toast carries the way back.
      if (viewingPath(home)) continue;
      addToast(timer.label, 'default', {
        duration: TOAST_MS,
        action: {
          label: batchId === null ? 'Go to the kitchen' : 'Back to the cook',
          onClick: () => push(home),
        },
      });
    }
  }

  function checkCookTimers(): void {
    const session = get(cookSession);
    if (!session) return;
    const now = Date.now();
    const viewedPath = viewedCookPath(session);
    if (viewedPath) lastSeenOn = { sessionId: session.id, path: viewedPath };
    const backPath =
      lastSeenOn?.sessionId === session.id ? lastSeenOn.path : plainCookPath(session);
    for (const timer of session.activeTimers) {
      const key = timerKey(session.id, timer.id, timer.endsAt);
      if (!claimFire(key, new Date(timer.endsAt).getTime(), now)) continue;
      playChime();
      // What it says on the lock screen, said here too: the timer's own name, which
      // for a guided check-in IS the reminder ("Check the heat"). Announcing every
      // one of them as "Timer finished" would be worse than saying nothing — the
      // main timer is still running, and the chef would go and look.
      const message = timer.label ?? 'Timer finished';
      // The suppression is earned by the chip flipping to "Finished" in front of
      // the chef. A guided check-in has no such chip — it fires and leaves, because
      // there is nothing to acknowledge — so on the cook page it takes the toast
      // instead, and drops the action: they are already there.
      if (viewedPath && !isCheckInTimerId(timer.id)) continue;
      addToast(message, 'default', {
        duration: TOAST_MS,
        ...(viewedPath
          ? {}
          : { action: { label: 'Back to the cook', onClick: () => push(backPath) } }),
      });
    }
  }

  // Observe anything already running before the first tick, so a timer started
  // moments before this ran is still eligible to alert.
  check();
  if (typeof setInterval !== 'function') return () => {}; // SSR guard
  const handle = setInterval(check, TICK_MS);
  return () => clearInterval(handle);
}
