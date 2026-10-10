import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stuck-write detector (issue #1667, Phase 1). Every case drives the real
// timers through fake ones: the stall is defined by time, so a test that does
// not advance past WRITE_STALL_THRESHOLD_MS is not testing the stall.

const { mockWaitForPendingWrites, mockGetToken, mockGetIdToken, auth, appCheck } = vi.hoisted(
  () => ({
    mockWaitForPendingWrites: vi.fn<() => Promise<void>>(),
    mockGetToken: vi.fn<() => Promise<unknown>>(),
    mockGetIdToken: vi.fn<() => Promise<string>>(),
    auth: { currentUser: null as null | { getIdToken: () => Promise<string> } },
    appCheck: { instance: undefined as object | undefined },
  }),
);

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({ name: 'mock-app' })) }));
vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => 'mock-db'),
  waitForPendingWrites: mockWaitForPendingWrites,
}));
vi.mock('firebase/app-check', () => ({ getToken: mockGetToken }));
vi.mock('firebase/auth', () => ({ getAuth: vi.fn(() => auth) }));
vi.mock('../src/init.js', () => ({ retainedAppCheck: vi.fn(() => appCheck.instance) }));

import {
  checkWriteHealth,
  WRITE_STALL_THRESHOLD_MS,
  TOKEN_PROBE_TIMEOUT_MS,
  type WriteHealthEnvironment,
} from '../src/writeHealth.js';

const never = <T>() => new Promise<T>(() => {});

function env(
  visible = true,
  online = true,
): WriteHealthEnvironment & {
  visible: boolean;
  online: boolean;
} {
  const e = {
    visible,
    online,
    isVisible: () => e.visible,
    isOnline: () => e.online,
  };
  return e;
}

// Runs a check to completion through every timer it can arm.
async function run(e: WriteHealthEnvironment = env()) {
  const pending = checkWriteHealth(e);
  await vi.advanceTimersByTimeAsync(WRITE_STALL_THRESHOLD_MS + TOKEN_PROBE_TIMEOUT_MS);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  appCheck.instance = { marker: 'app-check' };
  mockGetIdToken.mockResolvedValue('id-token');
  auth.currentUser = { getIdToken: mockGetIdToken };
  mockGetToken.mockResolvedValue({ token: 'app-check-token' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checkWriteHealth', () => {
  it('reports a stall, App Check pending, when writes and getToken never settle', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());
    mockGetToken.mockReturnValue(never());

    const result = await run();

    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'SyncError', reason: 'write-stalled' },
      probes: { appCheck: 'pending', auth: 'settled' },
    });
  });

  it('reports App Check settled when the token answers but writes stay stuck', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());

    const result = await run();

    expect(result).toMatchObject({
      kind: 'err',
      error: { kind: 'SyncError', reason: 'write-stalled' },
      probes: { appCheck: 'settled', auth: 'settled' },
    });
  });

  it('reports the probes absent when there is no App Check and no user', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());
    appCheck.instance = undefined;
    auth.currentUser = null;

    const result = await run();

    expect(result).toMatchObject({ probes: { appCheck: 'absent', auth: 'absent' } });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('does not call it a stall before the threshold', async () => {
    let resolve!: () => void;
    mockWaitForPendingWrites.mockReturnValue(new Promise<void>((r) => (resolve = r)));

    const pending = checkWriteHealth(env());
    await vi.advanceTimersByTimeAsync(WRITE_STALL_THRESHOLD_MS - 1);
    resolve();

    expect(await pending).toEqual({ kind: 'ok', value: 'confirmed' });
  });

  it('gives no SyncError while offline, and does not wait', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());

    const result = await run(env(true, false));

    expect(result).toEqual({ kind: 'ok', value: 'not-evaluated' });
    expect(mockWaitForPendingWrites).not.toHaveBeenCalled();
  });

  it('gives no SyncError when the page went offline during the wait', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());
    const e = env();

    const pending = checkWriteHealth(e);
    e.online = false;
    await vi.advanceTimersByTimeAsync(WRITE_STALL_THRESHOLD_MS + TOKEN_PROBE_TIMEOUT_MS);

    expect(await pending).toEqual({ kind: 'ok', value: 'not-evaluated' });
  });

  it('does not evaluate a hidden page', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());

    const result = await run(env(false, true));

    expect(result).toEqual({ kind: 'ok', value: 'not-evaluated' });
    expect(mockWaitForPendingWrites).not.toHaveBeenCalled();
  });

  it('gives no SyncError when the page was hidden during the wait', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());
    const e = env();

    const pending = checkWriteHealth(e);
    e.visible = false;
    await vi.advanceTimersByTimeAsync(WRITE_STALL_THRESHOLD_MS + TOKEN_PROBE_TIMEOUT_MS);

    expect(await pending).toEqual({ kind: 'ok', value: 'not-evaluated' });
  });

  it('succeeds when the pending writes are confirmed', async () => {
    mockWaitForPendingWrites.mockResolvedValue(undefined);

    expect(await run()).toEqual({ kind: 'ok', value: 'confirmed' });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('returns a Failure, never a throw, when the SDK rejects the wait', async () => {
    mockWaitForPendingWrites.mockRejectedValue(
      Object.assign(new Error('AsyncQueue failed'), { code: 'internal' }),
    );

    const result = await run();

    // The classification itself is classifyFirestoreError's (firestoreErrors.test.ts).
    expect(result).toMatchObject({ kind: 'err', probes: null });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('returns a Failure, never a throw, when the SDK throws synchronously', async () => {
    mockWaitForPendingWrites.mockImplementation(() => {
      throw new Error('terminated');
    });

    const result = await run();

    expect(result).toMatchObject({ kind: 'err', probes: null });
  });

  it('returns a Failure for a rejection that carries no error code', async () => {
    mockWaitForPendingWrites.mockRejectedValue(new Error('no code'));

    expect(await run()).toMatchObject({ kind: 'err', probes: null });
  });

  it('treats a user-change cancellation as not evaluated, not a fault', async () => {
    mockWaitForPendingWrites.mockRejectedValue(
      Object.assign(new Error('user changed'), { code: 'cancelled' }),
    );

    expect(await run()).toEqual({ kind: 'ok', value: 'not-evaluated' });
  });

  it('reports App Check settled when getToken throws synchronously', async () => {
    mockWaitForPendingWrites.mockReturnValue(never());
    mockGetToken.mockImplementation(() => {
      throw new Error('app-check/use-before-activation');
    });

    expect(await run()).toMatchObject({ probes: { appCheck: 'settled', auth: 'settled' } });
  });
});

// The default environment reads the real page state. Node has no `document`
// and its `navigator` has no `onLine`, so each side is stubbed explicitly.
describe('checkWriteHealth — default browser environment', () => {
  const runDefault = async () => {
    const pending = checkWriteHealth();
    await vi.advanceTimersByTimeAsync(WRITE_STALL_THRESHOLD_MS + TOKEN_PROBE_TIMEOUT_MS);
    return pending;
  };

  it('evaluates a visible, online page', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('navigator', { onLine: true });
    mockWaitForPendingWrites.mockResolvedValue(undefined);

    expect(await runDefault()).toEqual({ kind: 'ok', value: 'confirmed' });
  });

  it('does not evaluate a hidden page', async () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    vi.stubGlobal('navigator', { onLine: true });

    expect(await runDefault()).toEqual({ kind: 'ok', value: 'not-evaluated' });
    expect(mockWaitForPendingWrites).not.toHaveBeenCalled();
  });

  it('does not evaluate when the browser says offline', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('navigator', { onLine: false });

    expect(await runDefault()).toEqual({ kind: 'ok', value: 'not-evaluated' });
  });

  it('treats a runtime with no document or navigator as visible and online', async () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('navigator', undefined);
    mockWaitForPendingWrites.mockResolvedValue(undefined);

    expect(await runDefault()).toEqual({ kind: 'ok', value: 'confirmed' });
  });
});
