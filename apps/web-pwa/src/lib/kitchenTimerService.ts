import { subscribeKitchenTimers, saveKitchenTimers } from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import { withKitchenTimerStarted, withKitchenTimerDismissed } from '@salt/domain';
import type { KitchenTimerOrigin, KitchenTimersDoc } from '@salt/domain/schemas';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { primeChime } from './chime.js';
import { shouldNotifyFor } from './timerDefaults.js';
import { type DomainError, type ReadResult } from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';

// Standalone kitchen timers (issue #842). An optimistic store over the
// firebase-sync single-doc subscription for `kitchenTimers/{uid}` — every timer
// of mine that belongs to nobody's cook.
//
// Subscribed APP-WIDE from App.svelte at auth time, alongside my open cook
// sessions, for two reasons that both matter: the nav badge counts fired timers
// from every page, and the app-level chime watcher (cookTimerAlerts) has to be
// able to ring a timer that finishes while I am on the shopping list.
//
// The uid is held here rather than read from the auth store at each call site,
// because it is BOTH the document id and a pinned field — the security rule
// requires the two to agree — and a service that has already been told who it
// is syncing can synthesise the empty document for a member who has never
// started a timer, which is what makes the very first start an ordinary write.

// ─── Reactive store ─────────────────────────────────────────────────────────────

const _kitchenTimers = writable<KitchenTimersDoc | null>(null);
export const kitchenTimers: Readable<KitchenTimersDoc | null> = _kitchenTimers;

// Whose kitchen is currently synced. Null when signed out, which is the one
// state in which there is no honest answer to "what should I write?".
let syncedUid: string | null = null;

/**
 * The document to base the next write on.
 *
 * Returns the live document, or — when the member has never started a timer, so
 * no document exists yet — a fresh empty one for them. That absence is the
 * ordinary state on a new account rather than an error, so answering it with
 * null would make every caller re-implement the same bootstrap.
 *
 * Null only when nobody is signed in, where there is genuinely no kitchen to
 * write to.
 */
export function getKitchenTimersSnapshot(): KitchenTimersDoc | null {
  const current = get(_kitchenTimers);
  if (current) return current;
  if (!syncedUid) return null;
  return { ownerUid: syncedUid, timers: [] };
}

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

export function initKitchenTimerSync(uid: string): () => void {
  syncedUid = uid;
  _kitchenTimers.set(null);
  const errors = getErrorReporter();
  const unsub = subscribeKitchenTimers(
    uid,
    (incoming) => _kitchenTimers.set(incoming),
    (err, rawError) => {
      // A stream-level failure leaves the store empty: standalone timers simply
      // do not appear, and cook timers on the same page are unaffected. The
      // adapter's DomainError is reported per the observability gate.
      reportSubscriptionError(errors, err, rawError);
    },
  );
  return () => {
    unsub();
    syncedUid = null;
    _kitchenTimers.set(null);
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Persist the whole timers document, updating the store first.
 *
 * No `updatedAt` guard, unlike cookSessionService — this schema deliberately
 * carries no timestamp, because nothing reads one and LWW here is whole-document
 * and unconditional. The optimistic set is what makes the countdown appear on
 * the same frame as the tap rather than on the snapshot round-trip.
 */
export async function persistKitchenTimers(
  timers: KitchenTimersDoc,
): Promise<ReadResult<void, DomainError>> {
  _kitchenTimers.set(timers);
  return reportIfFailed(getErrorReporter(), await saveKitchenTimers(timers));
}

// ─── Starting and stopping ──────────────────────────────────────────────────────
//
// TWO SURFACES START THE SAME KIND OF TIMER: My Kitchen (#842) and the batch cook
// page (#1327, Phase 2). Both need the identical five-step composition — read the
// snapshot, prime the audio context, read the clock, re-derive `notify`, write the
// whole document through the producer — and every one of those steps has a reason
// that is easy to get subtly wrong in a second copy. They live here rather than at
// either call site for the reason `createCookTimers.startTimerEntry` is one
// function for cook mode's four entry points: a timer a chef set by hand must be
// indistinguishable from one a recipe described, the moment it is running.

/** What either surface hands over; everything else about the entry is derived. */
export interface KitchenTimerStart {
  /**
   * Identity, minted by the caller. A step timer on the batch cook page uses a
   * deterministic id so re-starting the same step re-times the one timer rather
   * than stacking a second (see `batchStepTimerId`); an ad-hoc timer mints a uuid.
   */
  id: string;
  label: string;
  durationMinutes: number;
  /** Where it was armed from, or `null` for a timer that came from the kitchen. */
  origin: KitchenTimerOrigin | null;
}

/**
 * Start — or re-time — one of this member's kitchen timers.
 *
 * Re-timing is the SAME call: one id, a fresh duration, through the same producer.
 * The entry is replaced whole, so `origin` must be supplied every time — a re-time
 * that omitted it would quietly unhook the timer from the step it is sitting on.
 *
 * Resolves `ok` with nothing written when nobody is signed in, which is the one
 * state with no honest kitchen to write to and is not a failure worth a toast.
 */
export async function startKitchenTimer(
  entry: KitchenTimerStart,
): Promise<ReadResult<void, DomainError>> {
  const doc = getKitchenTimersSnapshot();
  if (!doc) return { kind: 'ok', value: undefined };
  // Unlock the audio context on THIS user gesture, so the app-level watcher can
  // chime when the timer ends even on iOS Safari, which blocks audio not tied to
  // one. Starting a timer is the only gesture guaranteed to precede a chime — and
  // it sits in the shared start for the same reason cook mode's does: a surface
  // that forgot it would fail silently, months later, on one device.
  primeChime();
  // The clock is read HERE and never in the domain producer (CLAUDE.md Rule 1).
  // `notify` re-derives from the duration actually being started, so a timer
  // stretched over the push floor gains its backstop and one cut under it loses it.
  const now = Date.now();
  return persistKitchenTimers(
    withKitchenTimerStarted(
      doc,
      {
        id: entry.id,
        label: entry.label,
        endsAt: new Date(now + entry.durationMinutes * 60_000).toISOString(),
        durationMinutes: entry.durationMinutes,
        notify: shouldNotifyFor(entry.durationMinutes),
        origin: entry.origin,
      },
      now,
    ),
  );
}

/**
 * Cancel or dismiss — the same write either way, since the producer drops the
 * entry unconditionally and the two words are one operation seen from either side
 * of `endsAt`.
 *
 * Signed out mid-gesture resolves `ok` for the same reason as above.
 */
export async function dismissKitchenTimer(timerId: string): Promise<ReadResult<void, DomainError>> {
  const doc = getKitchenTimersSnapshot();
  if (!doc) return { kind: 'ok', value: undefined };
  return persistKitchenTimers(withKitchenTimerDismissed(doc, timerId));
}
