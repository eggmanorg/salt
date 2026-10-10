import { getApp } from 'firebase/app';
import { getFirestore, waitForPendingWrites } from 'firebase/firestore';
import { getToken } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { success, failure } from '@salt/shared-types';
import type { DomainError, Failure, Success } from '@salt/shared-types';
import { classifyFirestoreError } from './firestoreErrors.js';
import { retainedAppCheck } from './init.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stuck-write detector (issue #1667, Phase 1).
//
// On 9 Oct 2026 two phones resumed from a background freeze and stopped
// sending writes for one to two hours. Every item looked saved locally, no
// write promise ever settled, so no Failure was ever produced and nothing was
// reported. The suspected mechanism: a Firestore stream start awaits an App
// Check token with no timeout, and App Check can hold one dead in-flight
// promise for the life of the page.
//
// This asks the one question that catches that whatever the cause: are the
// writes Firestore holds right now confirmed by the server within
// WRITE_STALL_THRESHOLD_MS? `waitForPendingWrites` resolves immediately when
// nothing is pending, so a check on a healthy idle page costs nothing.
//
// When the answer is no, the Failure carries two token probes so a report can
// tell the suspects apart: App Check's public `getToken` joins the SAME shared
// in-flight promise Firestore's stream start is waiting on, so `pending` there
// points at App Check; `settled` points elsewhere (e.g. a dead WebChannel).
//
// WHAT IT CANNOT SEE. "Online" here is `navigator.onLine`, which is true on a
// captive portal or a network too weak to carry a write. A stall reported on
// such a network is a real "the server has not confirmed" but not necessarily
// a wedged client; the probes are what separate them. Likewise a legitimately
// slow write — a large batch on a poor connection — that takes longer than the
// threshold is reported as a stall.
//
// Never throws (Rule 10): every SDK call is inside the try, and every outcome is
// a Success or a Failure.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long pending writes may stay unconfirmed, while visible and online,
 * before they count as stalled. Normal acks take 1–3 s (PostHog baseline,
 * #1667) and the SDK itself flips to `Offline` after 10 s of failed stream
 * starts, so 30 s is well past both: a write that has not landed by then is not
 * a slow ack.
 */
export const WRITE_STALL_THRESHOLD_MS = 30_000;

/**
 * How long a token probe may take before it is reported `pending`. A healthy
 * App Check exchange (reCAPTCHA `execute` + one fetch) or Auth refresh is well
 * under this; the stuck case never settles at all.
 */
export const TOKEN_PROBE_TIMEOUT_MS = 5_000;

/**
 * `pending` — the token request did not settle within TOKEN_PROBE_TIMEOUT_MS.
 * `settled` — it resolved or rejected (either way it is not the hang).
 * `absent` — there was nothing to ask: App Check not initialised (emulators, no
 * site key) or no signed-in user.
 */
export type TokenProbeState = 'pending' | 'settled' | 'absent';

export interface WriteStallProbes {
  readonly appCheck: TokenProbeState;
  readonly auth: TokenProbeState;
}

/**
 * `confirmed` — every write pending at the start of the check was acked (or
 * there were none). `not-evaluated` — the page was hidden or offline, at the
 * start or by the end of the wait, or the signed-in user changed mid-wait; none
 * of those is a stall.
 *
 * A Failure is either a stall (`SyncError` / `write-stalled`, with probes) or
 * the SDK rejecting the wait itself (classified, `probes: null`).
 */
export type WriteHealth =
  | Success<'confirmed' | 'not-evaluated'>
  | (Failure<DomainError> & { readonly probes: WriteStallProbes | null });

/** The page state the detector gates on. Injectable for tests. */
export interface WriteHealthEnvironment {
  isVisible(): boolean;
  isOnline(): boolean;
}

const browserEnvironment: WriteHealthEnvironment = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
};

type Settlement<T> =
  | { readonly state: 'resolved'; readonly value: T }
  | { readonly state: 'rejected'; readonly error: unknown }
  | { readonly state: 'pending' };

// Races `promise` against a timer. The timer is cleared on settle, and the
// promise always has a rejection handler attached, so a wait abandoned as
// `pending` can never surface later as an unhandled rejection.
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settlement<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: 'pending' }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ state: 'resolved', value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ state: 'rejected', error });
      },
    );
  });
}

async function probe(start: (() => Promise<unknown>) | null): Promise<TokenProbeState> {
  if (!start) return 'absent';
  let promise: Promise<unknown>;
  try {
    promise = start();
  } catch {
    return 'settled'; // threw synchronously — it answered, it is not the hang
  }
  const result = await settleWithin(promise, TOKEN_PROBE_TIMEOUT_MS);
  return result.state === 'pending' ? 'pending' : 'settled';
}

function firestoreCode(err: unknown): string {
  return ((err as { code?: string } | null)?.code ?? '').replace(/^firestore\//, '');
}

/**
 * Checks whether Firestore's pending writes are confirmed within `thresholdMs`
 * while the page is visible and online. See the header for what it can and
 * cannot see.
 */
export async function checkWriteHealth(
  env: WriteHealthEnvironment = browserEnvironment,
  thresholdMs: number = WRITE_STALL_THRESHOLD_MS,
): Promise<WriteHealth> {
  if (!env.isVisible() || !env.isOnline()) return success('not-evaluated');
  try {
    const app = getApp();
    const wait = await settleWithin(waitForPendingWrites(getFirestore(app)), thresholdMs);

    if (wait.state === 'resolved') return success('confirmed');

    if (wait.state === 'rejected') {
      // The SDK rejects outstanding waits when the signed-in user changes
      // (`waitForPendingWrites` d.ts) — a sign-out, not a fault.
      if (firestoreCode(wait.error) === 'cancelled') return success('not-evaluated');
      return { ...failure(classifyFirestoreError(wait.error)), probes: null };
    }

    // Still pending. A page that went hidden or offline during the wait has an
    // ordinary reason not to have synced.
    if (!env.isVisible() || !env.isOnline()) return success('not-evaluated');

    const appCheck = retainedAppCheck(app);
    const user = getAuth(app).currentUser;
    const [appCheckState, authState] = await Promise.all([
      probe(appCheck ? () => getToken(appCheck, false) : null),
      probe(user ? () => user.getIdToken(false) : null),
    ]);
    return {
      ...failure<DomainError>({ kind: 'SyncError', reason: 'write-stalled' }),
      probes: { appCheck: appCheckState, auth: authState },
    };
  } catch (err) {
    return { ...failure(classifyFirestoreError(err)), probes: null };
  }
}
