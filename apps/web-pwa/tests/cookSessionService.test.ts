import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { CookSessionDoc } from '@salt/domain/schemas';
import type { DomainError, ReadResult } from '@salt/shared-types';

// ─── Shared report() spy ────────────────────────────────────────────────────────
// The service caches getErrorReporter() in module scope, so the adapter mock must
// hand back a STABLE report() we can assert on across tests. The mock delegates to
// the REAL category gate (isReportableCategory) so "expected failures stay quiet"
// exercises the actual report/suppress boundary rather than a forked predicate.
const { reportSpy, gatedReport } = vi.hoisted(() => {
  const reportSpy = vi.fn();
  return { reportSpy, gatedReport: reportSpy };
});

vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    isReportableCategory: actual.isReportableCategory,
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        gatedReport(error, category);
      },
    })),
  };
});

// ─── Mock firebase-sync (no real Firestore in unit tests) ───────────────────────
// isAuthTransitioning is pulled in by src/lib/errorReporting.ts, not the service.
vi.mock('@salt/firebase-sync', () => ({
  subscribeCookSession: vi.fn(() => vi.fn()),
  saveCookSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteCookSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  cookSession,
  cookSessionEnded,
  isLoadingCookSession,
  getCookSessionSnapshot,
  initCookSessionSync,
  persistCookSession,
  removeCookSession,
} from '../src/lib/cookSessionService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const SESSION_ID = 'recipe-1_user-1';
const OTHER_SESSION_ID = 'recipe-2_user-1';

// Old enough that any real wall-clock stamp the service writes is newer.
const OLD = '2020-01-01T00:00:00.000Z';

const STORAGE_ERR: DomainError = { kind: 'StorageError', reason: 'unavailable' };
const NETWORK_ERR: DomainError = { kind: 'NetworkError', reason: 'offline' };
const AUTH_ERR: DomainError = { kind: 'AuthError', reason: 'forbidden' };

function makeSession(overrides: Partial<CookSessionDoc> = {}): CookSessionDoc {
  return {
    id: SESSION_ID,
    schemaVersion: 1,
    ownerUid: 'user-1',
    recipeId: 'recipe-1',
    recipeUpdatedAtAtStart: OLD,
    checkedIngredientIds: [],
    checkedPrepIds: [],
    completedStepIds: [],
    activeTimers: [],
    serveAt: null,
    servings: null,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

type SessionCb = (session: CookSessionDoc | null) => void;
type ErrorCb = (err: DomainError, rawError?: unknown) => void;

function wireSubscription() {
  let sessionCb: SessionCb | null = null;
  let errorCb: ErrorCb | null = null;
  const unsub = vi.fn();
  fs.subscribeCookSession.mockImplementation((_id, onSession, onError) => {
    sessionCb = onSession as SessionCb;
    errorCb = onError as ErrorCb;
    return unsub;
  });
  return {
    emit: (s: CookSessionDoc | null) => sessionCb!(s),
    emitError: (err: DomainError, rawError?: unknown) => errorCb!(err, rawError),
    unsub,
  };
}

// Hold saveCookSession open so a test can emit snapshots while a write is still
// unacknowledged — the only window in which an "absent" snapshot is ambiguous.
function deferSave() {
  let settle: (r: ReadResult<void, DomainError>) => void = () => {};
  fs.saveCookSession.mockReturnValue(
    new Promise<ReadResult<void, DomainError>>((resolve) => {
      settle = resolve;
    }),
  );
  return {
    settle: async (pending: Promise<unknown>) => {
      settle({ kind: 'ok', value: undefined });
      await pending;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportSpy.mockReset();
  fs.saveCookSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.deleteCookSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.isAuthTransitioning.mockReturnValue(false);
});

describe('cookSessionService — subscription', () => {
  it('watches the one deterministic session id it was given', () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    expect(fs.subscribeCookSession).toHaveBeenCalledTimes(1);
    expect(fs.subscribeCookSession.mock.calls[0]![0]).toBe(SESSION_ID);
  });

  it('stays in a loading state until the first snapshot arrives', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    expect(get(isLoadingCookSession)).toBe(true);
    emit(null);
    expect(get(isLoadingCookSession)).toBe(false);
  });

  it('makes an incoming snapshot the session the page cooks from', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    const doc = makeSession({ checkedIngredientIds: ['ing-1'] });
    emit(doc);
    expect(get(cookSession)).toEqual(doc);
    expect(getCookSessionSnapshot()).toEqual(doc);
  });

  it('reports no session to resume when the document does not exist', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(null);
    expect(get(cookSession)).toBeNull();
  });

  it('hands back the unsubscribe the adapter created, for the page to dispose', () => {
    const { unsub } = wireSubscription();
    const dispose = initCookSessionSync(SESSION_ID);
    expect(dispose).toBe(unsub);
  });
});

describe('cookSessionService — optimistic writes', () => {
  it('shows a local edit before the write has reached Firestore', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());

    let settle: (r: ReadResult<void, DomainError>) => void = () => {};
    fs.saveCookSession.mockReturnValue(
      new Promise<ReadResult<void, DomainError>>((resolve) => {
        settle = resolve;
      }),
    );

    const pending = persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));
    // Still in flight — the store must already reflect the tick.
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);
    expect(fs.saveCookSession).toHaveBeenCalledTimes(1);

    settle({ kind: 'ok', value: undefined });
    await expect(pending).resolves.toEqual({ kind: 'ok', value: undefined });
  });

  it('stamps a fresh updatedAt instead of trusting the caller’s', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);

    await persistCookSession(makeSession({ updatedAt: OLD }));

    const saved = fs.saveCookSession.mock.calls[0]![0]!;
    expect(saved.updatedAt).not.toBe(OLD);
    expect(saved.updatedAt > OLD).toBe(true);
    expect(getCookSessionSnapshot()?.updatedAt).toBe(saved.updatedAt);
  });

  it('persists the whole document, not a patch of the changed field', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);

    const doc = makeSession({ checkedIngredientIds: ['ing-1'], completedStepIds: ['step-1'] });
    await persistCookSession(doc);

    const saved = fs.saveCookSession.mock.calls[0]![0]!;
    expect(saved).toEqual({ ...doc, updatedAt: saved.updatedAt });
  });

  it('clears the session locally the moment it is deleted', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());

    await removeCookSession(SESSION_ID);

    expect(getCookSessionSnapshot()).toBeNull();
    expect(fs.deleteCookSession).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe('cookSessionService — last-write-wins guard', () => {
  it('never rolls a local edit back to a snapshot that predates it', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: [] }));

    await persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);

    // In-flight echo of the pre-edit document.
    emit(makeSession({ checkedIngredientIds: [], updatedAt: OLD }));
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);
  });

  it('accepts a snapshot newer than the local edit, so another device wins', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());

    await persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));

    const fromOtherDevice = makeSession({
      checkedIngredientIds: ['ing-1', 'ing-2'],
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    emit(fromOtherDevice);
    expect(getCookSessionSnapshot()).toEqual(fromOtherDevice);
  });

  it('keeps a just-created session when the snapshot has not caught up', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(null); // no session yet

    const save = deferSave();
    const pending = persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));

    // The create is still unacknowledged, so an "absent" snapshot queued before it
    // proves nothing — it must not blank the session we just created.
    emit(null);
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);
    expect(get(cookSessionEnded)).toBe(false);

    await save.settle(pending);
  });

  it('drops the absence it swallowed rather than replaying it once the write lands', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(null);

    const save = deferSave();
    const pending = persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));
    emit(null);
    await save.settle(pending);

    // The write won: the document exists again, so the absence it overtook is stale
    // and must not be applied retroactively.
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);
    expect(get(cookSessionEnded)).toBe(false);
  });

  it('cannot have a deleted session resurrected by a late snapshot', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: ['ing-1'] }));

    await removeCookSession(SESSION_ID);

    // A snapshot still in flight when the delete landed.
    emit(makeSession({ checkedIngredientIds: ['ing-1'], updatedAt: OLD }));
    expect(getCookSessionSnapshot()).toBeNull();
  });

  // Issue #559. With no write of ours outstanding, an "absent" snapshot is the
  // truth: the cook was finished or restarted on another device. Clearing the store
  // is only half of it — `cookSessionEnded` is what stops the page reading the same
  // null as "no session yet" and writing the deleted session straight back.
  it('lets go of the session when another device finishes the cook', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: ['ing-1'] }));

    emit(null);

    expect(getCookSessionSnapshot()).toBeNull();
    expect(get(cookSessionEnded)).toBe(true);
  });

  it('does not call it an ending elsewhere when there was no session to end', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);

    emit(null); // first snapshot: this cook has never been started

    expect(get(cookSessionEnded)).toBe(false);
  });

  it('does not call a local Complete an ending elsewhere', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: ['ing-1'] }));

    await removeCookSession(SESSION_ID);
    emit(null); // the delete echoing back

    expect(getCookSessionSnapshot()).toBeNull();
    expect(get(cookSessionEnded)).toBe(false);
  });
});

describe('cookSessionService — re-subscribing', () => {
  it('starts a different session from an empty, loading state', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: ['ing-1'] }));

    initCookSessionSync(OTHER_SESSION_ID);

    expect(getCookSessionSnapshot()).toBeNull();
    expect(get(isLoadingCookSession)).toBe(true);
    expect(fs.subscribeCookSession.mock.calls[1]![0]).toBe(OTHER_SESSION_ID);

    const other = makeSession({ id: OTHER_SESSION_ID, recipeId: 'recipe-2' });
    emit(other);
    expect(getCookSessionSnapshot()).toEqual(other);
  });

  it('forgets that the last cook ended elsewhere, so the page can start a new one', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());
    emit(null);
    expect(get(cookSessionEnded)).toBe(true);

    initCookSessionSync(SESSION_ID);

    expect(get(cookSessionEnded)).toBe(false);
  });

  it('forgets the previous local-edit watermark when it re-subscribes', async () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());
    await persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));

    // Re-entering the same cook: the stored document is authoritative again,
    // even though it predates the edit made in the previous subscription.
    initCookSessionSync(SESSION_ID);
    emit(makeSession({ checkedIngredientIds: [], updatedAt: OLD }));
    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual([]);
  });
});

describe('cookSessionService — failures', () => {
  it('surfaces a failed write as a Failure rather than throwing', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    fs.saveCookSession.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });

    const result = await persistCookSession(makeSession());

    expect(result).toEqual({ kind: 'err', error: STORAGE_ERR });
    expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
  });

  it('surfaces a failed delete as a Failure rather than throwing', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    fs.deleteCookSession.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });

    const result = await removeCookSession(SESSION_ID);

    expect(result).toEqual({ kind: 'err', error: STORAGE_ERR });
    expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
  });

  it('keeps the optimistic edit on screen when the write fails, so the cook is not disrupted', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    fs.saveCookSession.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });

    await persistCookSession(makeSession({ checkedIngredientIds: ['ing-1'] }));

    expect(getCookSessionSnapshot()?.checkedIngredientIds).toEqual(['ing-1']);
  });

  it('does not report an offline write failure — that one is expected', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    fs.saveCookSession.mockResolvedValueOnce({ kind: 'err', error: NETWORK_ERR });

    await persistCookSession(makeSession());

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('does not report a successful write', async () => {
    wireSubscription();
    initCookSessionSync(SESSION_ID);
    await persistCookSession(makeSession());
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('reports a subscription error and stops showing the loading state', () => {
    const { emitError } = wireSubscription();
    initCookSessionSync(SESSION_ID);

    emitError(STORAGE_ERR);

    expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    expect(get(isLoadingCookSession)).toBe(false);
  });

  it('forwards the adapter’s raw error when it has one, for the real stack', () => {
    const { emitError } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    const raw = new Error('firestore exploded');

    emitError(STORAGE_ERR, raw);

    expect(reportSpy).toHaveBeenCalledWith(raw, 'StorageError');
  });

  it('does not report the permission-denied noise of a sign-out teardown', () => {
    const { emitError } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    fs.isAuthTransitioning.mockReturnValue(true);

    emitError(AUTH_ERR);

    expect(reportSpy).not.toHaveBeenCalled();
  });
});

// ─── A corrupt session document (#928 Phase 2) ──────────────────────────────────
//
// `subscribeCookSession` used to answer a document its schema refused with
// `null`, which is exactly what it delivers for a document that does not exist —
// so `applySnapshot` read a corrupt session as one ENDED ON ANOTHER DEVICE and
// evicted the user from cook mode, or, with an empty store, as "no session yet"
// and let the page write a fresh session over the corrupt one. It is a
// `StorageError`/`corruption` on `onError` now.
//
// These two rows are the pin. The first asserts the new behaviour; the second is
// the branch it must NOT have broken, because both arrive at the same store and
// only the adapter distinguishes them.
describe('cookSessionService — a document the schema refused', () => {
  it('keeps the session it holds, and does not report the cook as ended', () => {
    const { emit, emitError } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    const held = makeSession({ checkedIngredientIds: ['ing-1'] });
    emit(held);

    // No rawError: the corruption Failure comes from the PARSE, which has no
    // Firestore error behind it. That is the adapter's own contract, and passing
    // one here would test a call the adapter never makes.
    emitError({ kind: 'StorageError', reason: 'corruption' });

    expect(get(cookSession)).toEqual(held);
    expect(get(cookSessionEnded)).toBe(false);
    expect(get(isLoadingCookSession)).toBe(false);
    // The payload, not merely that a spy fired (UT-A1). `StorageError` is a
    // reported category under §7.6, which is what makes this change a gain: the
    // corruption is now visible instead of silent.
    expect(reportSpy).toHaveBeenCalledWith(
      { kind: 'StorageError', reason: 'corruption' },
      'StorageError',
    );
  });

  it('still treats a genuinely deleted document as the cook ending elsewhere', () => {
    const { emit } = wireSubscription();
    initCookSessionSync(SESSION_ID);
    emit(makeSession());

    emit(null);

    expect(get(cookSession)).toBeNull();
    expect(get(cookSessionEnded)).toBe(true);
    expect(reportSpy).not.toHaveBeenCalled();
  });
});
