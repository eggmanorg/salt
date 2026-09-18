import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BatchDoc, BatchStageDoc, PushSubscriptionDoc } from '@salt/domain/schemas';

// Unit-level (mock-based, no emulator) coverage of the weekly "what is drying" nudge
// (issue #1406), modelled on `remindShoppingDay.test.ts`: one query for the running
// runs, the domain rule decides which want weighing, and each starter is sent their own
// notification. `BatchSchema`, `PushSubscriptionSchema`, `longRunsWantingReading`,
// `longRunNudge` and `dateInZone` are all kept REAL.
//
// THE LOAD-BEARING CASE IS THE AUDIENCE ONE ("sends only to the run's starter"). It is
// what pins the claim that the audience is the starter rather than a feature flag or
// the household, and its B-gets-nothing half is also what pins the accepted limit:
// starter away, nobody else nudged (CLAUDE.md rule 12).

// THE MOCK KEEPS THE OPTIONS RATHER THAN DISCARDING THEM (#1462, CLAUDE.md rule 12).
// "A ninety-day cure gets thirteen nudges, not ninety" is a claim about the CADENCE,
// and `longRuns.test.ts` can only pin the half of it the domain owns — it steps its own
// loop by seven days, which asserts the rule given a weekly firing rather than that the
// firing is weekly. The other half lives in the `onSchedule` options, and a mock that
// throws them away leaves the cron expression, the zone and `retryCount` asserted by
// nothing: moving the sweep to daily or monthly would leave this suite green and Daniel's
// phone the only thing that noticed.
const { mockScheduleOptions } = vi.hoisted(() => ({
  mockScheduleOptions: { current: undefined as Record<string, unknown> | undefined },
}));
vi.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (opts: Record<string, unknown>, handler: unknown) => {
    mockScheduleOptions.current = opts;
    return handler;
  },
}));

// Mutable so the not-provisioned case can be exercised: an environment with no VAPID
// pair must log and return rather than call the transport with empty keys.
const { mockSecretValue } = vi.hoisted(() => ({ mockSecretValue: { current: 'test-vapid-key' } }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => mockSecretValue.current }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile (#1135).
const mockSendWebPush = vi.fn<typeof import('../../src/adapters/sendWebPush.js').sendWebPush>(
  async () => 'sent' as const,
);
vi.mock('../../src/adapters/sendWebPush.js', () => ({
  sendWebPush: mockSendWebPush,
}));

const mockReport = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
vi.mock('@salt/observability/server', () => ({
  flushServerObservability: mockFlush,
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: mockReport })),
}));

// Collection-aware Firestore mock. State is mock-prefixed so the hoisted vi.mock
// factory may reference it. `mockBatchWheres` records the filter the handler applied to
// `batches`, and `mockSubsWheres` the uids it asked `pushSubscriptions` for — which is
// how the audience claim is asserted at the QUERY as well as at the send.
type SubRecord = { data: () => unknown; ref: { delete: () => Promise<void> } };

let mockBatchDocs: Array<{ id: string; data: () => unknown }> = [];
const mockBatchWheres: Array<[string, string, unknown]> = [];
let mockSubsByUid: Record<string, SubRecord[]> = {};
const mockSubsWheres: Array<[string, string, unknown]> = [];
const mockSubsListedUnfiltered = vi.fn();

const mockDb = {
  collection: (name: string) => {
    if (name === 'batches') {
      return {
        where: (field: string, op: string, value: unknown) => {
          mockBatchWheres.push([field, op, value]);
          return { get: async () => ({ docs: mockBatchDocs }) };
        },
        // A bare `.get()` on `batches` would be a full scan the handler must never do.
        get: async () => {
          throw new Error('remindBatchReadings must filter batches by state');
        },
      };
    }
    if (name === 'pushSubscriptions') {
      return {
        where: (field: string, op: string, value: unknown) => {
          mockSubsWheres.push([field, op, value]);
          return { get: async () => ({ docs: mockSubsByUid[String(value)] ?? [] }) };
        },
        // The whole-collection read `remindShoppingDay` does deliberately, and this
        // function must never do: it would be the household broadcast.
        get: async () => {
          mockSubsListedUnfiltered();
          return { docs: Object.values(mockSubsByUid).flat() };
        },
      };
    }
    return { doc: () => ({}) };
  },
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
}));

const { remindBatchReadings } = await import('../../src/maintenance/remindBatchReadings.js');

// The cron fires Friday 10:00 Europe/London. 2026-09-18 is a Friday; 09:00Z is 10:00
// BST, the exact instant.
const CRON_INSTANT = new Date('2026-09-18T09:00:00.000Z');
const HUNG_AT = '2026-09-07T18:00:00.000Z';

function waitStage(overrides: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'dry',
    label: 'Dry',
    kind: 'wait',
    environment: null,
    // A DECLARED ninety-day dry — one of the two real shapes a long wait takes (the
    // other is observational: `duration: null` with an `until` condition, pinned in
    // `packages/domain/tests/batch/longRuns.test.ts`). `duration` and the planned
    // span below always agree, which the PR's original fixture did not (#1449
    // review finding 1): it paired `duration: null` with this same 90-day span, a
    // shape `resolveSchedule` can never actually produce.
    duration: { kind: 'fixed', minutes: 90 * 24 * 60 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: HUNG_AT,
    // Ninety days.
    plannedEndAt: '2026-12-06T18:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...overrides,
  };
}

function runningBatch(overrides: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: 'batch-coppa',
    schemaVersion: 1,
    recipeId: 'coppa',
    recipeTitle: 'Coppa',
    recipeKind: 'cure',
    cureCategory: 'dry_cured_whole_muscle',
    target: null,
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 2400, totalGrams: 2460, usableGrams: 2460, units: null },
    stages: [waitStage()],
    rationale: null,
    ambientCelsius: null,
    checkedIngredientIds: [],
    completedStepIds: [],
    startedBy: 'uid-a',
    createdAt: HUNG_AT,
    updatedAt: HUNG_AT,
    ...overrides,
  };
}

/** The bread shape: the longest wait it has is an overnight retard. */
function breadBatch(): BatchDoc {
  return runningBatch({
    id: 'batch-bread',
    recipeId: 'overnight-white-tin',
    recipeTitle: 'Overnight white tin',
    recipeKind: 'recipe',
    cureCategory: null,
    stages: [
      waitStage({
        id: 'retard',
        label: 'Overnight retard',
        duration: { kind: 'fixed', minutes: 16 * 60 },
        plannedStartAt: '2026-09-17T21:00:00.000Z',
        plannedEndAt: '2026-09-18T13:00:00.000Z',
      }),
    ],
  });
}

function batchDoc(batch: BatchDoc): { id: string; data: () => unknown } {
  return { id: batch.id, data: () => batch };
}

function makeSub(id: string, ownerUid: string): PushSubscriptionDoc {
  return {
    id,
    schemaVersion: 1,
    ownerUid,
    endpoint: `https://push.example/${id}`,
    keys: { p256dh: `p256-${id}`, auth: `auth-${id}` },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function subDoc(sub: PushSubscriptionDoc): SubRecord {
  return { data: () => sub, ref: { delete: vi.fn(async () => undefined) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(CRON_INSTANT);
  mockBatchDocs = [];
  mockBatchWheres.length = 0;
  mockSubsWheres.length = 0;
  mockSubsByUid = { 'uid-a': [subDoc(makeSub('a1', 'uid-a'))] };
  mockSendWebPush.mockResolvedValue('sent' as const);
  mockSecretValue.current = 'test-vapid-key';
});

describe('remindBatchReadings — the cadence itself (#1462)', () => {
  // These are the deploy-time constants nothing else can reach. The handler cannot
  // observe them, so no behavioural test can: they are asserted here or nowhere.
  it('fires once a week, on Friday morning, in the zone the week key is built in', () => {
    // '0 10 * * 5' — minute 0, hour 10, every day-of-month, every month, weekday 5.
    // Spelt out rather than compared loosely, because every one of those fields is a
    // way to turn thirteen nudges into ninety.
    expect(mockScheduleOptions.current?.schedule).toBe('0 10 * * 5');
    // The zone the cron fires in must be the zone `dateInZone` builds the week key in,
    // or the notification tag and the firing day can disagree across a BST boundary.
    expect(mockScheduleOptions.current?.timeZone).toBe('Europe/London');
  });

  it('never retries, because there is no exactly-once ledger behind it', () => {
    // `retryCount: 0` is load-bearing, not tidiness: a retry would re-send an ambient
    // weekly nudge with nothing to collapse it beyond the week-keyed tag, and the
    // function deliberately carries no `timerDeliveries`-style ledger.
    expect(mockScheduleOptions.current?.retryCount).toBe(0);
  });

  it('runs in europe-west2, like every other Salt function', () => {
    expect(mockScheduleOptions.current?.region).toBe('europe-west2');
  });
});

describe('remindBatchReadings', () => {
  it('asks the one run by name, with its day number, and opens the batches list', async () => {
    mockBatchDocs = [batchDoc(runningBatch())];

    await (remindBatchReadings as unknown as Function)();

    // Only the running runs are ever fetched; "is it in a long wait" is the domain
    // rule's question, not a query's.
    expect(mockBatchWheres).toEqual([['state', '==', 'running']]);
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(mockSendWebPush.mock.calls[0]?.[2]).toEqual({
      type: 'batch-readings',
      // Keyed to the WEEK, in the zone the cron fires in.
      tag: 'batch-readings::2026-09-18',
      url: '/#/batches',
      // Hung on the evening of the 7th (Europe/London calendar date), swept on the
      // morning of the 18th: eleven calendar dates apart, so day twelve (#1449 review
      // finding 3 — counted by `dateInZone`/`daysBetween`, not raw 24-hour blocks off
      // the two instants, which would answer eleven here).
      title: 'Coppa — day 12',
      body: 'Weigh it and add a note.',
      renotify: false,
    });
    expect(mockFlush).toHaveBeenCalled();
  });

  it('collapses several of one person’s runs into ONE notification', async () => {
    mockBatchDocs = [
      batchDoc(runningBatch({ id: 'batch-coppa' })),
      batchDoc(runningBatch({ id: 'batch-bresaola', recipeTitle: 'Bresaola' })),
    ];

    await (remindBatchReadings as unknown as Function)();

    // One device, one push — not one per run.
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    const payload = mockSendWebPush.mock.calls[0]?.[2] as { title: string; body: string };
    expect(payload.title).toBe('2 runs under way');
    expect(payload.body).toBe('Weigh them and add a note.');
  });

  it('SENDS ONLY TO THE RUN’S STARTER, never to anyone else in the house', async () => {
    // The claim this suite exists for. A's run, with subscriptions for both A and B:
    // A's endpoints are sent to and none of B's are. The second half is also the
    // accepted limit — if A is away, B is not told about A's coppa, deliberately.
    mockBatchDocs = [batchDoc(runningBatch({ startedBy: 'uid-a' }))];
    mockSubsByUid = {
      'uid-a': [subDoc(makeSub('a1', 'uid-a')), subDoc(makeSub('a2', 'uid-a'))],
      'uid-b': [subDoc(makeSub('b1', 'uid-b'))],
    };

    await (remindBatchReadings as unknown as Function)();

    // Filtered at the query, so B's docs are never even read.
    expect(mockSubsWheres).toEqual([['ownerUid', '==', 'uid-a']]);
    expect(mockSubsListedUnfiltered).not.toHaveBeenCalled();
    const endpoints = mockSendWebPush.mock.calls.map((call) => call[1].endpoint);
    expect(endpoints).toEqual(['https://push.example/a1', 'https://push.example/a2']);
    expect(endpoints.join(' ')).not.toContain('/b1');
  });

  it('gives two starters their own notification each, about their own runs', async () => {
    mockBatchDocs = [
      batchDoc(runningBatch({ id: 'batch-a', recipeTitle: 'Coppa', startedBy: 'uid-a' })),
      batchDoc(runningBatch({ id: 'batch-b', recipeTitle: 'Kraut', startedBy: 'uid-b' })),
    ];
    mockSubsByUid = {
      'uid-a': [subDoc(makeSub('a1', 'uid-a'))],
      'uid-b': [subDoc(makeSub('b1', 'uid-b'))],
    };

    await (remindBatchReadings as unknown as Function)();

    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
    const byEndpoint = new Map(
      mockSendWebPush.mock.calls.map((call) => [
        call[1].endpoint,
        (call[2] as { title: string }).title,
      ]),
    );
    expect(byEndpoint.get('https://push.example/a1')).toBe('Coppa — day 12');
    expect(byEndpoint.get('https://push.example/b1')).toBe('Kraut — day 12');
  });

  it('SENDS NOTHING AT ALL when only bread is running — production today', async () => {
    mockBatchDocs = [batchDoc(breadBatch())];

    await (remindBatchReadings as unknown as Function)();

    expect(mockSubsWheres).toEqual([]);
    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });

  it('sends nothing for a run whose starter was never recorded', async () => {
    mockBatchDocs = [batchDoc(runningBatch({ startedBy: null }))];

    await (remindBatchReadings as unknown as Function)();

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('does not re-buzz a duplicate delivery in the same week', async () => {
    // `renotify: false` plus the week-keyed tag is what stands in for an exactly-once
    // ledger: the second push replaces the first silently.
    mockBatchDocs = [batchDoc(runningBatch())];

    await (remindBatchReadings as unknown as Function)();
    const first = mockSendWebPush.mock.calls[0]?.[2] as { tag: string; renotify: boolean };

    await (remindBatchReadings as unknown as Function)();
    const second = mockSendWebPush.mock.calls[1]?.[2] as { tag: string; renotify: boolean };

    expect(first.tag).toBe(second.tag);
    expect(first.renotify).toBe(false);
    expect(second.renotify).toBe(false);
  });

  it('prunes a subscription the push service reports as gone', async () => {
    mockBatchDocs = [batchDoc(runningBatch())];
    const dead = subDoc(makeSub('dead', 'uid-a'));
    const live = subDoc(makeSub('live', 'uid-a'));
    mockSubsByUid = { 'uid-a': [dead, live] };
    mockSendWebPush.mockResolvedValueOnce('gone' as const).mockResolvedValueOnce('sent' as const);

    await (remindBatchReadings as unknown as Function)();

    expect(dead.ref.delete).toHaveBeenCalledTimes(1);
    expect(live.ref.delete).not.toHaveBeenCalled();
    // A dead device must not stop the person's other phone being asked.
    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('reports a transient send failure without pruning', async () => {
    mockBatchDocs = [batchDoc(runningBatch())];
    const sub = subDoc(makeSub('a1', 'uid-a'));
    mockSubsByUid = { 'uid-a': [sub] };
    mockSendWebPush.mockResolvedValue('failed' as const);

    await (remindBatchReadings as unknown as Function)();

    expect(sub.ref.delete).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it('skips a corrupt batch doc and still asks about the sound one', async () => {
    mockBatchDocs = [
      { id: 'batch-broken', data: () => ({ id: 'batch-broken', state: 'running' }) },
      batchDoc(runningBatch()),
    ];

    await (remindBatchReadings as unknown as Function)();

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect((mockSendWebPush.mock.calls[0]?.[2] as { title: string }).title).toBe('Coppa — day 12');
  });

  it('skips an invalid subscription doc without stopping the rest', async () => {
    mockBatchDocs = [batchDoc(runningBatch())];
    mockSubsByUid = {
      'uid-a': [
        { data: () => ({ endpoint: 42 }), ref: { delete: vi.fn(async () => undefined) } },
        subDoc(makeSub('a1', 'uid-a')),
      ],
    };

    await (remindBatchReadings as unknown as Function)();

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
  });

  it('sends nothing, and never throws, when VAPID is not provisioned', async () => {
    // An environment the feature was never provisioned in. Log and return rather than
    // throw — Scheduler would only replay the same deterministic failure — and never
    // call the transport with empty keys.
    mockBatchDocs = [batchDoc(runningBatch())];
    mockSecretValue.current = '';

    await expect((remindBatchReadings as unknown as Function)()).resolves.toBeUndefined();

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockSubsWheres).toEqual([]);
    // Not an error worth reporting to PostHog: it is configuration, not a failure.
    expect(mockReport).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });

  it('never throws out of the scheduled handler, and always flushes', async () => {
    mockBatchDocs = [
      {
        id: 'batch-explodes',
        get data(): () => unknown {
          throw new Error('firestore exploded');
        },
      },
    ];

    await expect((remindBatchReadings as unknown as Function)()).resolves.toBeUndefined();
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), 'SyncError');
    expect(mockFlush).toHaveBeenCalled();
  });
});
