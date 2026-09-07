import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from 'firebase-functions';
import type { BatchDoc, BatchStageDoc, PushSubscriptionDoc } from '@salt/domain/schemas';
import { FakeTimestamp } from '../support/fakeTimestamp.js';

// Unit-level (mock-based, no emulator) coverage of the batch stage-reminder DISPATCH
// handler (issue #812, phase 3 of epic #778): re-read the live batch, no-op stale
// and duplicate dispatches, then BROADCAST a push naming the stage and the dish to
// every subscription — pruning the dead and reporting the failed. BatchSchema and
// PushSubscriptionSchema are kept REAL.

vi.mock('firebase-functions/v2/tasks', () => ({
  onTaskDispatched: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => 'test-vapid-key' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile, while
// `mockResolvedValue` is pinned to the one literal used here (#1135).
const mockSendWebPush = vi.fn<typeof import('../../src/adapters/sendWebPush.js').sendWebPush>(
  async () => 'sent' as const,
);
vi.mock('../../src/adapters/sendWebPush.js', () => ({
  sendWebPush: mockSendWebPush,
}));

const mockReport = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
vi.mock('@salt/observability/server', async (importOriginal) => ({
  // Spread the real module so an export the ENTRYPOINT WRAPPER needs
  // (runWithSuppliedTraceContext) cannot go missing from this mock the way it
  // did when the wrapper landed — a one-export factory is exactly what goes
  // stale. Only the calls this suite asserts on are overridden below.
  ...((await importOriginal()) as Record<string, unknown>),
  flushServerObservability: mockFlush,
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: mockReport })),
}));

// Collection-aware Firestore mock. State is mock-prefixed so the hoisted vi.mock
// factory may reference it. Each test sets the snapshots/docs it needs.
let mockBatchSnap: { exists: boolean; data: () => unknown } = {
  exists: false,
  data: () => undefined,
};
let mockLedgerSnap: { exists: boolean } = { exists: false };
let mockSubsDocs: Array<{ data: () => unknown; ref: { delete: () => Promise<void> } }> = [];
const mockTxSet = vi.fn();
// The ledger doc id is part of the contract — it is the SHARED `timerDeliveries`
// collection with a `batch_` prefix, not a collection of its own — so the mock
// records what was asked for.
let mockLedgerDocId = '';
let mockLedgerCollection = '';
// pushSubscriptions must be read UNFILTERED: a batch is family-shared and has no
// owner, so a `.where('ownerUid', …)` here would be a bug. The mock exposes no
// `where` at all, so an owner-filtered read would throw.
let mockSubsQueried = false;

const mockDb = {
  collection: (name: string) => {
    if (name === 'batches') {
      return { doc: () => ({ get: async () => mockBatchSnap }) };
    }
    if (name === 'timerDeliveries') {
      mockLedgerCollection = name;
      return {
        doc: (id: string) => {
          mockLedgerDocId = id;
          return { id };
        },
      };
    }
    if (name === 'pushSubscriptions') {
      return {
        get: async () => {
          mockSubsQueried = true;
          return { docs: mockSubsDocs };
        },
      };
    }
    return { doc: () => ({}) };
  },
  runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
    fn({ get: async () => mockLedgerSnap, set: mockTxSet }),
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
  Timestamp: FakeTimestamp,
}));

const { onBatchStageDispatch } = await import('../../src/triggers/onBatchStageDispatch.js');
const { TIMER_DELIVERY_RETENTION_MS } =
  await import('../../src/triggers/timerDeliveryRetention.js');

const BATCH_ID = 'batch-1';
const STAGE_ID = 'shape';
const PLANNED_START = '2026-08-14T22:20:00.000Z';

function stage(overrides: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: STAGE_ID,
    label: 'Shape into the tin',
    kind: 'active',
    environment: null,
    duration: { kind: 'fixed', minutes: 15 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: PLANNED_START,
    plannedEndAt: '2026-08-14T22:35:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: BATCH_ID,
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 1000, totalGrams: 1700, usableGrams: 1700, units: null },
    stages: [stage()],
    rationale: null,
    ambientCelsius: null,
    createdAt: '2026-08-14T17:00:00.000Z',
    updatedAt: '2026-08-14T17:00:00.000Z',
    ...overrides,
  };
}

function makeSub(id: string, ownerUid = `uid-${id}`): PushSubscriptionDoc {
  return {
    id,
    schemaVersion: 1,
    ownerUid,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: `p256-${id}`, auth: `auth-${id}` },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function subDoc(sub: PushSubscriptionDoc) {
  return { data: () => sub, ref: { delete: vi.fn(async () => undefined) } };
}

function req(
  overrides: Partial<{
    stageId: string;
    plannedStartAt: string;
    notifyUids: readonly string[];
  }> = {},
) {
  return {
    data: { batchId: BATCH_ID, stageId: STAGE_ID, plannedStartAt: PLANNED_START, ...overrides },
  };
}

const sentEndpoints = () =>
  mockSendWebPush.mock.calls.map(
    (call) => (call as unknown as [unknown, { endpoint: string }])[1].endpoint,
  );

const lastPayload = () => mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockBatchSnap = { exists: true, data: () => makeBatch() };
  mockLedgerSnap = { exists: false };
  mockSubsDocs = [subDoc(makeSub('dev-1'))];
  mockLedgerDocId = '';
  mockLedgerCollection = '';
  mockSubsQueried = false;
  mockSendWebPush.mockResolvedValue('sent' as const);
});

describe('onBatchStageDispatch — staleness', () => {
  it('no-ops when the batch is gone', async () => {
    mockBatchSnap = { exists: false, data: () => undefined };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('logs and returns on a batch doc that fails validation', async () => {
    mockBatchSnap = { exists: true, data: () => ({ id: 'junk' }) };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('no-ops for an abandoned run — there is no next action', async () => {
    mockBatchSnap = { exists: true, data: () => makeBatch({ state: 'abandoned' }) };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('no-ops when the stage has been RE-TIMED since the task was queued', async () => {
    // The cancellation-free design in one test: nothing deletes the old task, it
    // simply matches nothing when it fires, and a fresh task exists for the new time.
    await (onBatchStageDispatch as unknown as Function)(
      req({ plannedStartAt: '2026-08-14T21:00:00.000Z' }),
    );

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('no-ops when the stage is no longer in the batch at all', async () => {
    await (onBatchStageDispatch as unknown as Function)(req({ stageId: 'nowhere' }));

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it.each([
    ['already finished', { actualEndAt: '2026-08-14T22:30:00.000Z' }],
    ['already under way', { actualStartAt: '2026-08-14T22:18:00.000Z' }],
    // Issue #1275. The enqueue filters what it could see at write time; this is
    // what catches a skip made AFTER the task was already queued — the same
    // re-read-and-no-op the cook timer does.
    ['skipped', { skipped: { at: '2026-08-14T22:18:00.000Z', note: 'out of milk' } }],
    ['skipped with no reason given', { skipped: { at: '2026-08-14T22:18:00.000Z', note: '' } }],
  ])('no-ops when the stage is %s', async (_case, overrides) => {
    mockBatchSnap = { exists: true, data: () => makeBatch({ stages: [stage(overrides)] }) };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });
});

describe('onBatchStageDispatch — the exactly-once ledger', () => {
  it('claims a batch-prefixed doc in the SHARED timerDeliveries collection', async () => {
    // Not a second collection of its own: #812 reuses the server-owned,
    // client-denied ledger #544 already provisioned, and the prefix keeps the two
    // producers' key spaces apart.
    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockLedgerCollection).toBe('timerDeliveries');
    expect(mockLedgerDocId).toBe(`batch_${BATCH_ID}_${STAGE_ID}_${Date.parse(PLANNED_START)}`);
    expect(mockTxSet).toHaveBeenCalledWith(expect.anything(), {
      // Timestamps, not numbers: the TTL policy on `expiresAt` acts on nothing
      // else (#1008), and `deliveredAt` converts alongside it.
      deliveredAt: expect.any(FakeTimestamp),
      expiresAt: expect.any(FakeTimestamp),
      batchId: BATCH_ID,
      stageId: STAGE_ID,
    });
    // The ledger must outlive any possible duplicate dispatch, and the offset
    // is the single shared constant — a site that drifted goes red here.
    const payload = mockTxSet.mock.calls[0]![1] as {
      deliveredAt: FakeTimestamp;
      expiresAt: FakeTimestamp;
    };
    expect(payload.expiresAt.toMillis() - payload.deliveredAt.toMillis()).toBe(
      TIMER_DELIVERY_RETENTION_MS,
    );
  });

  it('no-ops on a duplicate dispatch (ledger doc already present)', async () => {
    mockLedgerSnap = { exists: true };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
  });
});

describe('onBatchStageDispatch — the push', () => {
  it('BROADCASTS to every subscription, not one owner’s', async () => {
    // A batch is family-shared and carries no ownerUid — nobody in particular owns
    // the crock, so everyone with notifications on gets the reminder. The Firestore
    // mock exposes no `where`, so an owner-filtered read would throw here.
    mockSubsDocs = [subDoc(makeSub('dev-1')), subDoc(makeSub('dev-2')), subDoc(makeSub('dev-3'))];

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSubsQueried).toBe(true);
    expect(mockSendWebPush).toHaveBeenCalledTimes(3);
  });

  it('names the stage and the dish, and carries an EXPLICIT batch url', async () => {
    await (onBatchStageDispatch as unknown as Function)(req());

    expect(lastPayload()).toEqual({
      type: 'batch-stage',
      tag: `batch::${BATCH_ID}::${STAGE_ID}`,
      // Chosen server-side, never reconstructed in the service worker — a batch id
      // is an opaque UUID, so the cook timer's sessionId-slicing trick has nothing
      // to slice and must not spread.
      url: `/#/batches/${BATCH_ID}`,
      title: 'Shape into the tin',
      body: 'Overnight white tin',
      // The opposite of the shopping reminder: a timed call to act, hours from the
      // last one and deduped by a real ledger, must re-buzz rather than replace.
      renotify: true,
    });
  });

  it('uses the batch’s FROZEN recipe title, so a renamed dish still reads right', async () => {
    mockBatchSnap = { exists: true, data: () => makeBatch({ recipeTitle: 'Batch nine' }) };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(lastPayload()['body']).toBe('Batch nine');
  });

  it('falls back to generic copy for an unlabelled stage', async () => {
    mockBatchSnap = { exists: true, data: () => makeBatch({ stages: [stage({ label: '  ' })] }) };

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(lastPayload()['title']).toBe('A batch stage is due');
  });

  it('skips a subscription that fails validation without stopping the broadcast', async () => {
    mockSubsDocs = [
      { data: () => ({ id: 'junk' }), ref: { delete: vi.fn(async () => undefined) } },
      subDoc(makeSub('dev-2')),
    ];

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
  });

  it('prunes a subscription that returns gone', async () => {
    const doc = subDoc(makeSub('dev-dead'));
    mockSubsDocs = [doc];
    mockSendWebPush.mockResolvedValue('gone' as const);

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(doc.ref.delete).toHaveBeenCalledTimes(1);
  });

  it('reports — and does NOT throw — when a send fails', async () => {
    // Throwing out of an onTaskDispatched handler burns the retry budget on a
    // failure that will not change (Rule 10).
    const doc = subDoc(makeSub('dev-1'));
    mockSubsDocs = [doc];
    mockSendWebPush.mockResolvedValue('failed' as const);

    await expect((onBatchStageDispatch as unknown as Function)(req())).resolves.toBeUndefined();

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(doc.ref.delete).not.toHaveBeenCalled();
  });

  it('reports — and does NOT throw — when the read itself blows up', async () => {
    mockBatchSnap = {
      exists: true,
      get data() {
        throw new Error('firestore down');
      },
    } as unknown as typeof mockBatchSnap;

    await expect((onBatchStageDispatch as unknown as Function)(req())).resolves.toBeUndefined();

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalled();
  });
});

describe('onBatchStageDispatch — the frozen audience (#831)', () => {
  // The batch still has no owner and this handler still resolves nobody: it reads a
  // list decided upstream at enqueue, so a PostHog outage at 06:45 cannot cost the
  // preheat. Nothing here calls PostHog.

  it('BROADCASTS when the task carries NO list — a task queued before #831', async () => {
    // The back-compat case, and the one a reader gets wrong: absent is not "nobody",
    // it is today's behaviour. Reading it the other way would silently strand every
    // reminder already sitting in the queue.
    mockSubsDocs = [subDoc(makeSub('dev-1')), subDoc(makeSub('dev-2'))];

    await (onBatchStageDispatch as unknown as Function)(req());

    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
  });

  it('sends to NOBODY when the list is empty', async () => {
    // The opposite instruction to an absent field, and it must be honoured: nobody
    // passed the flag, so nobody is woken.
    mockSubsDocs = [subDoc(makeSub('dev-1')), subDoc(makeSub('dev-2'))];

    await (onBatchStageDispatch as unknown as Function)(req({ notifyUids: [] }));

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('sends only to the devices of the uids on the list', async () => {
    // Ada has the flag and two handsets; Bram shares the household and hears nothing.
    mockSubsDocs = [
      subDoc(makeSub('ada-1', 'uid-ada')),
      subDoc(makeSub('ada-2', 'uid-ada')),
      subDoc(makeSub('bram-1', 'uid-bram')),
    ];

    await (onBatchStageDispatch as unknown as Function)(req({ notifyUids: ['uid-ada'] }));

    expect(sentEndpoints()).toEqual([
      'https://fcm.googleapis.com/fcm/send/ada-1',
      'https://fcm.googleapis.com/fcm/send/ada-2',
    ]);
  });

  it('still prunes a dead subscription that IS on the list', async () => {
    // The filter sits AFTER the parse and BEFORE the send, so pruning is untouched
    // for everyone still being sent to.
    const doc = subDoc(makeSub('ada-dead', 'uid-ada'));
    mockSubsDocs = [doc];
    mockSendWebPush.mockResolvedValue('gone' as const);

    await (onBatchStageDispatch as unknown as Function)(req({ notifyUids: ['uid-ada'] }));

    expect(doc.ref.delete).toHaveBeenCalledTimes(1);
  });

  it('does NOT prune a live subscription merely withheld from this reminder', async () => {
    // Withholding is per-reminder; the device is perfectly healthy and still wants
    // its shopping reminders.
    const doc = subDoc(makeSub('bram-1', 'uid-bram'));
    mockSubsDocs = [doc];

    await (onBatchStageDispatch as unknown as Function)(req({ notifyUids: ['uid-ada'] }));

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(doc.ref.delete).not.toHaveBeenCalled();
  });

  it('counts the withheld in the log line, so a blackout is diagnosable', async () => {
    mockSubsDocs = [subDoc(makeSub('ada-1', 'uid-ada')), subDoc(makeSub('bram-1', 'uid-bram'))];

    await (onBatchStageDispatch as unknown as Function)(req({ notifyUids: ['uid-ada'] }));

    expect(logger.info).toHaveBeenCalledWith(
      'onBatchStageDispatch: reminded',
      expect.objectContaining({ sent: 1, withheld: 1 }),
    );
  });
});
