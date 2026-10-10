import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { ErrorReportingPort } from '@salt/domain';
import type { WriteHealth } from '@salt/firebase-sync';
import type { StallRecovery } from '../src/lib/stallRecovery.js';

// The monitor around the stuck-write detector (issue #1667, Phase 1). The
// detector itself is tested in firebase-sync; here it is a scripted stub, and
// what is pinned is the reporting policy: one report per stuck episode, none
// for a page the detector did not evaluate (hidden/offline).

vi.mock('@salt/firebase-sync', () => ({ checkWriteHealth: vi.fn() }));
vi.mock('../src/lib/errorReporter.js', () => ({ getErrorReporter: vi.fn() }));

import { checkWriteHealth } from '@salt/firebase-sync';
import { getErrorReporter } from '../src/lib/errorReporter.js';
import {
  startSyncHealthMonitor,
  syncHealthReport,
  SYNC_HEALTH_INTERVAL_MS,
} from '../src/lib/syncHealth.js';

const STALL: WriteHealth = {
  kind: 'err',
  error: { kind: 'SyncError', reason: 'write-stalled' },
  probes: { appCheck: 'pending', auth: 'settled' },
};
const CONFIRMED: WriteHealth = { kind: 'ok', value: 'confirmed' };
const NOT_EVALUATED: WriteHealth = { kind: 'ok', value: 'not-evaluated' };

let report: Mock<ErrorReportingPort['report']>;
let check: Mock<() => Promise<WriteHealth>>;
let decideRecovery: Mock<() => StallRecovery>;
let applyRecovery: Mock<(d: StallRecovery) => void>;
let stop: (() => void) | undefined;

// Scripts the detector's answers in order; the last one repeats.
function script(...results: WriteHealth[]) {
  let i = 0;
  check.mockImplementation(async () => results[Math.min(i++, results.length - 1)]!);
}

async function start() {
  stop = startSyncHealthMonitor({ check, reporter: { report }, decideRecovery, applyRecovery });
  await vi.advanceTimersByTimeAsync(0);
}

const nextInterval = () => vi.advanceTimersByTimeAsync(SYNC_HEALTH_INTERVAL_MS);

beforeEach(() => {
  vi.useFakeTimers();
  report = vi.fn();
  check = vi.fn();
  decideRecovery = vi.fn(() => 'skipped-young-page');
  applyRecovery = vi.fn();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startSyncHealthMonitor', () => {
  it('reports a stall once per episode, however many checks it spans', async () => {
    script(STALL);
    await start();
    await nextInterval();
    await nextInterval();

    expect(check).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'SyncError');
  });

  it('opens a new episode once a check has come back confirmed', async () => {
    script(STALL, CONFIRMED, STALL);
    await start();
    await nextInterval();
    await nextInterval();

    expect(report).toHaveBeenCalledTimes(2);
  });

  it('does not end an episode on a check it could not evaluate', async () => {
    // A wedged phone pocketed (hidden) and taken out again is one episode.
    script(STALL, NOT_EVALUATED, STALL);
    await start();
    await nextInterval();
    await nextInterval();

    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports nothing while the detector says offline or hidden', async () => {
    script(NOT_EVALUATED);
    await start();
    await nextInterval();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(check).toHaveBeenCalledTimes(3);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports probe states and the error kind, and nothing else', async () => {
    script(STALL);
    await start();

    const err = report.mock.calls[0]?.[0] as Error;
    expect(err.name).toBe('WriteStallError');
    expect(err.message).toBe(
      'Firestore writes unconfirmed past the stall threshold while visible and online ' +
        '(appCheck=pending, auth=settled, recovery=skipped-young-page) [SyncError/write-stalled]',
    );
  });

  it('checks again when the page becomes visible', async () => {
    script(CONFIRMED);
    await start();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it('never runs two checks at once', async () => {
    let release!: (r: WriteHealth) => void;
    check.mockImplementation(() => new Promise((r) => (release = r)));
    await start();
    await nextInterval();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(check).toHaveBeenCalledTimes(1);
    release(CONFIRMED);
  });

  it('stops checking and reporting once stopped', async () => {
    script(STALL);
    stop = startSyncHealthMonitor({ check, reporter: { report } });
    stop();
    await nextInterval();

    expect(check).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports nothing for a check that finishes after it was stopped', async () => {
    let release!: (r: WriteHealth) => void;
    check.mockImplementation(() => new Promise((r) => (release = r)));
    stop = startSyncHealthMonitor({ check, reporter: { report } });
    stop();
    release(STALL);
    await vi.advanceTimersByTimeAsync(0);

    expect(report).not.toHaveBeenCalled();
  });

  it('does not check when the page goes hidden', async () => {
    script(CONFIRMED);
    await start();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    visibility.mockRestore();

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('defaults to the real detector and the shared reporter', async () => {
    // The default recovery reads the real page; a young page never reloads.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.mocked(checkWriteHealth).mockResolvedValue(STALL);
    vi.mocked(getErrorReporter).mockReturnValue({ report } as never);
    stop = startSyncHealthMonitor();
    await vi.advanceTimersByTimeAsync(SYNC_HEALTH_INTERVAL_MS);

    expect(checkWriteHealth).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('startSyncHealthMonitor — recovery (Phase 2)', () => {
  it('reports the stall first, then applies the reload decision', async () => {
    decideRecovery.mockReturnValue('reload');
    const order: string[] = [];
    report.mockImplementation(() => order.push('report'));
    applyRecovery.mockImplementation((d) => order.push(`apply:${d}`));
    script(STALL);
    await start();

    expect(order).toEqual(['report', 'apply:reload']);
    expect((report.mock.calls[0]?.[0] as Error).message).toContain('recovery=reload');
  });

  it('asks again on every stalled check, so a deferred recovery is retried — reported once', async () => {
    decideRecovery.mockReturnValueOnce('deferred-draft').mockReturnValue('reload');
    script(STALL);
    await start();
    await nextInterval();

    expect(applyRecovery.mock.calls.map(([d]) => d)).toEqual(['deferred-draft', 'reload']);
    expect(report).toHaveBeenCalledTimes(1);
    expect((report.mock.calls[0]?.[0] as Error).message).toContain('recovery=deferred-draft');
  });

  it('never decides or reloads on a confirmed or not-evaluated check', async () => {
    script(CONFIRMED, NOT_EVALUATED);
    await start();
    await nextInterval();

    expect(decideRecovery).not.toHaveBeenCalled();
    expect(applyRecovery).not.toHaveBeenCalled();
  });

  it('never reloads for a rejected check — it is not the stall the recovery is for', async () => {
    script({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
      probes: null,
    });
    await start();

    expect(report).toHaveBeenCalledTimes(1);
    expect(decideRecovery).not.toHaveBeenCalled();
    expect(applyRecovery).not.toHaveBeenCalled();
  });
});

describe('syncHealthReport', () => {
  it('names a rejected check, with its classified kind and reason', () => {
    const err = syncHealthReport({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
      probes: null,
    });
    expect(err.message).toBe(
      'Firestore writes pending-writes check rejected [StorageError/unavailable]',
    );
  });

  it('omits the reason for a kind that has none', () => {
    const err = syncHealthReport({ kind: 'err', error: { kind: 'ConflictError' }, probes: null });
    expect(err.message).toBe('Firestore writes pending-writes check rejected [ConflictError]');
  });
});
