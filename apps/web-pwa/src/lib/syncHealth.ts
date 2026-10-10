import type { ErrorReportingPort } from '@salt/domain';
import { checkWriteHealth, type WriteHealth } from '@salt/firebase-sync';
import { getErrorReporter } from './errorReporter.js';

// Runs firebase-sync's stuck-write detector and reports what it finds
// (issue #1667, Phase 1).
//
// On 9 Oct 2026 two phones queued writes for one to two hours with nothing
// reported: a write that never settles never becomes a Failure, so no catch or
// reportIfFailed ever ran. This closes that gap from the other side — instead
// of waiting on a write's own promise, it periodically asks whether everything
// Firestore holds has been confirmed (see writeHealth.ts for what that check
// can and cannot see).
//
// WHEN IT CHECKS: once at start, whenever the page becomes visible (the resume
// from a background freeze is exactly when 9 Oct wedged), whenever the browser
// comes back online, and every SYNC_HEALTH_INTERVAL_MS. Checks never overlap.
// A check on a hidden or offline page, or one with nothing pending, costs
// nothing — the detector returns at once.
//
// ONE REPORT PER EPISODE. An episode opens at the first failed check and closes
// only when a later check comes back `confirmed`; every failed check inside it
// is silent. `not-evaluated` (hidden, offline) neither opens nor closes one, so
// a wedged phone that is pocketed and taken out again does not report twice.
//
// The report carries state only — the error kind/reason and the two probe
// states — never document contents or anything the user typed.

/**
 * Gap between periodic checks. A check that finds a stall itself takes
 * WRITE_STALL_THRESHOLD_MS to say so, so this is about how often a healthy page
 * re-asks, not detection latency; the visibility trigger is what catches the
 * resume case promptly.
 */
export const SYNC_HEALTH_INTERVAL_MS = 60_000;

export interface SyncHealthMonitorDeps {
  check?: () => Promise<WriteHealth>;
  reporter?: ErrorReportingPort;
  intervalMs?: number;
}

/** The Error a failed check is reported as. Exported for the test. */
export function syncHealthReport(result: Extract<WriteHealth, { kind: 'err' }>): Error {
  const { error, probes } = result;
  const reason = 'reason' in error ? `/${error.reason}` : '';
  const detail = probes
    ? 'unconfirmed past the stall threshold while visible and online ' +
      `(appCheck=${probes.appCheck}, auth=${probes.auth})`
    : 'pending-writes check rejected';
  const err = new Error(`Firestore writes ${detail} [${error.kind}${reason}]`);
  err.name = 'WriteStallError';
  return err;
}

/** Starts the monitor; returns the function that stops it. */
export function startSyncHealthMonitor(deps: SyncHealthMonitorDeps = {}): () => void {
  const check = deps.check ?? (() => checkWriteHealth());
  const reporter = deps.reporter ?? getErrorReporter();
  let stopped = false;
  let checking = false;
  let inEpisode = false;

  const tick = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      const result = await check();
      if (stopped) return;
      if (result.kind === 'ok') {
        if (result.value === 'confirmed') inEpisode = false;
        return;
      }
      if (inEpisode) return;
      inEpisode = true;
      reporter.report(syncHealthReport(result), result.error.kind);
    } finally {
      checking = false;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') void tick();
  };
  const onOnline = () => void tick();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  const interval = setInterval(() => void tick(), deps.intervalMs ?? SYNC_HEALTH_INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
  };
}
