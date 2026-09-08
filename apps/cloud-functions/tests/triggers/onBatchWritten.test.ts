import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BatchDoc, BatchStageDoc, PushSubscriptionDoc } from '@salt/domain/schemas';

// Unit-level (mock-based, no emulator) coverage of the batch stage-reminder ENQUEUE
// trigger (issue #812, phase 3 of epic #778): work out which stages earn a
// notification, diff them against the prior write, and enqueue one Cloud Task each.
// BatchSchema and `remindableStages` are kept REAL, so the parse guard and the
// reminder rule are both genuinely exercised here as well as in the domain suite.
//
// Since #831 it also FREEZES THE AUDIENCE into each task: which uids had the `bread`
// flag at the moment the reminder was scheduled. PushSubscriptionSchema is kept real
// too, so the skip-invalid path in that resolution is genuinely exercised.

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => 'test-posthog-key' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockEnqueue = vi.fn(async () => undefined);
const mockTaskQueue = vi.fn(() => ({ enqueue: mockEnqueue }));
vi.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue: mockTaskQueue }),
}));

// The audience resolution reads `pushSubscriptions` unfiltered (Admin SDK, bypassing
// the owner-scoped rules) and batch-resolves uid → email through Auth. State is
// mock-prefixed so the hoisted vi.mock factories may reference it.
let mockSubsDocs: Array<{ data: () => unknown }> = [];
let mockSubsQueried = false;
const mockSubsGet = vi.fn(async () => {
  mockSubsQueried = true;
  return { docs: mockSubsDocs };
});
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ get: mockSubsGet }) }),
}));

// uid → email. A uid missing from here has no email at all, which cannot match an
// email-targeted release condition.
let mockEmails: Record<string, string> = {};
const mockGetUsers = vi.fn(async (identifiers: Array<{ uid: string }>) => ({
  users: identifiers
    .filter(({ uid }) => uid in mockEmails)
    .map(({ uid }) => ({ uid, email: mockEmails[uid] })),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ getUsers: mockGetUsers }),
}));

const mockReport = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
// Which uids the `bread` flag is on for. The adapter's own semantics (unconfigured
// ⇒ true, every failure ⇒ false) are pinned in the observability suite; here the
// read is a seam.
let mockFlaggedUids: string[] = [];
const mockFeatureEnabled = vi.fn(async (_key: string, distinctId: string) =>
  mockFlaggedUids.includes(distinctId),
);
vi.mock('@salt/observability/server', async (importOriginal) => ({
  // Spread the real module so an export the ENTRYPOINT WRAPPER needs
  // (runWithSuppliedTraceContext) cannot go missing from this mock the way it
  // did when the wrapper landed — a one-export factory is exactly what goes
  // stale. Only the calls this suite asserts on are overridden below.
  ...((await importOriginal()) as Record<string, unknown>),
  flushServerObservability: mockFlush,
  isServerFeatureEnabled: mockFeatureEnabled,
  // reportServerError.js constructs this at module load — it must exist on the mock.
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: mockReport })),
}));

const { onBatchWritten } = await import('../../src/triggers/onBatchWritten.js');

const BATCH_ID = 'batch-1';
// "Now" for every test. The trigger reads the clock exactly once (the horizon and
// past-time guards), so freezing it makes every planned time below checkable by hand.
const NOW = new Date('2026-08-14T18:00:00.000Z');
const at = (offsetMinutes: number) =>
  new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

// The epic's overnight loaf, on a clock: mix(active), bulk(wait), shape(active),
// retard(wait), preheat(wait), bake(active). Remindable: mix, shape, preheat, bake.
const LOAF: Array<[string, 'active' | 'wait', number]> = [
  ['mix', 'active', 60],
  ['bulk', 'wait', 80],
  ['shape', 'active', 260],
  ['retard', 'wait', 275],
  ['preheat', 'wait', 755],
  ['bake', 'active', 775],
];

function stage(
  id: string,
  kind: 'active' | 'wait',
  startOffsetMinutes: number,
  overrides: Partial<BatchStageDoc> = {},
): BatchStageDoc {
  return {
    id,
    label: id,
    kind,
    environment: null,
    duration: { kind: 'fixed', minutes: 20 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: at(startOffsetMinutes),
    plannedEndAt: at(startOffsetMinutes + 20),
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...overrides,
  };
}

const loafStages = (): BatchStageDoc[] => LOAF.map(([id, kind, off]) => stage(id, kind, off));

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
    stages: loafStages(),
    rationale: null,
    ambientCelsius: null,
    createdAt: '2026-08-14T17:00:00.000Z',
    updatedAt: '2026-08-14T17:00:00.000Z',
    ...overrides,
  };
}

function snap(data: unknown): { exists: true; data: () => unknown } {
  return { exists: true, data: () => data };
}
const deleted = { exists: false as const, data: () => undefined };

function event(before: unknown, after: unknown, batchId = BATCH_ID) {
  return { data: { before, after }, params: { batchId } };
}

// One device per person by default; `dev-a2` is Ada's second handset, so the
// resolution has a duplicate uid to collapse before it asks Auth or PostHog.
function makeSub(id: string, ownerUid: string): PushSubscriptionDoc {
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

const subDoc = (sub: PushSubscriptionDoc) => ({ data: () => sub });

const enqueuedStageIds = () =>
  mockEnqueue.mock.calls.map((call) => (call as unknown as [{ stageId: string }])[0].stageId);

const enqueuedNotifyUids = () =>
  (mockEnqueue.mock.calls[0] as unknown as [{ notifyUids: readonly string[] }])[0].notifyUids;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // Two people, three devices. Ada has the flag; Bram does not.
  mockSubsDocs = [
    subDoc(makeSub('dev-a1', 'uid-ada')),
    subDoc(makeSub('dev-a2', 'uid-ada')),
    subDoc(makeSub('dev-b1', 'uid-bram')),
  ];
  mockEmails = { 'uid-ada': 'ada@example.test', 'uid-bram': 'bram@example.test' };
  mockFlaggedUids = ['uid-ada'];
  mockSubsQueried = false;
  mockSubsGet.mockImplementation(async () => {
    mockSubsQueried = true;
    return { docs: mockSubsDocs };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('onBatchWritten — which stages get a task', () => {
  it('enqueues the loaf reminders and NOTHING for the overnight retard', async () => {
    // The pinning behaviour of the whole phase, end to end through the trigger:
    // mix, shape, preheat, bake — and silence across the eight hours in the fridge.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedStageIds()).toEqual(['mix', 'shape', 'preheat', 'bake']);
  });

  it('region-qualifies the queue name', async () => {
    // firebase-admin parses a BARE name with no location and falls back to
    // us-central1 rather than inheriting the caller's region — which built a
    // us-central1 queue URL for the cook timer and killed every push in every
    // environment. The mock cannot tell us the queue was wrong, so pin the string.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(mockTaskQueue).toHaveBeenCalledWith(
      'locations/europe-west2/functions/onBatchStageDispatch',
    );
  });

  it('carries IDS ONLY in the task payload, scheduled at the planned start', async () => {
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    // `notifyUids` is ids too, so the rule holds: no recipe title, no stage label.
    expect(mockEnqueue).toHaveBeenNthCalledWith(
      1,
      { batchId: BATCH_ID, stageId: 'mix', plannedStartAt: at(60), notifyUids: ['uid-ada'] },
      { scheduleTime: new Date(at(60)) },
    );
  });

  it('does NOT enqueue for an abandoned run', async () => {
    const batch = makeBatch({ state: 'abandoned' });

    await (onBatchWritten as unknown as Function)(event(deleted, snap(batch)));

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTaskQueue).not.toHaveBeenCalled();
  });

  it('returns without enqueue when the batch was deleted', async () => {
    await (onBatchWritten as unknown as Function)(event(snap(makeBatch()), deleted));

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTaskQueue).not.toHaveBeenCalled();
  });

  it('logs and returns on a batch doc that fails validation', async () => {
    await (onBatchWritten as unknown as Function)(event(deleted, snap({ id: 'junk' })));

    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe('onBatchWritten — a skipped stage (issue #1275)', () => {
  // Skipping is filtered HERE, at enqueue, and not in `remindableStages`, which is
  // pure and planned-only. The loaf timeline above is the pin either way.

  const withSkipped = (id: string) =>
    makeBatch({
      stages: loafStages().map((s) =>
        s.id === id ? { ...s, skipped: { at: at(0), note: 'already done' } } : s,
      ),
    });

  it('sends no reminder for the skipped stage', async () => {
    await (onBatchWritten as unknown as Function)(event(deleted, snap(withSkipped('shape'))));

    expect(enqueuedStageIds()).not.toContain('shape');
  });

  it('still sends the one AFTER it', async () => {
    // The rule survives a skip untouched. `preheat` earns its reminder because it
    // follows the `wait` retard, and skipping the shape has nothing to do with that.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(withSkipped('shape'))));

    expect(enqueuedStageIds()).toEqual(['mix', 'preheat', 'bake']);
  });

  it('skipping the FIRST stage costs only its own reminder', async () => {
    await (onBatchWritten as unknown as Function)(event(deleted, snap(withSkipped('mix'))));

    expect(enqueuedStageIds()).toEqual(['shape', 'preheat', 'bake']);
  });
});

describe('onBatchWritten — the diff', () => {
  it('does NOT re-enqueue reminders unchanged since the prior write', async () => {
    // A batch is written on every advance, every rationale edit, every updatedAt
    // bump. Without the diff each of those would re-queue every remaining reminder.
    const batch = makeBatch();

    await (onBatchWritten as unknown as Function)(
      event(snap(batch), snap({ ...batch, updatedAt: '2026-08-14T17:30:00.000Z' })),
    );

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('enqueues a RE-TIMED stage, because its planned start is a new key', async () => {
    // The cancellation-free design: nothing deletes the old task, it simply matches
    // nothing when it fires.
    const before = makeBatch();
    const after = makeBatch({
      stages: before.stages.map((s) => (s.id === 'bake' ? stage('bake', 'active', 800) : s)),
    });

    await (onBatchWritten as unknown as Function)(event(snap(before), snap(after)));

    expect(enqueuedStageIds()).toEqual(['bake']);
    expect(mockEnqueue).toHaveBeenCalledWith(
      { batchId: BATCH_ID, stageId: 'bake', plannedStartAt: at(800), notifyUids: ['uid-ada'] },
      { scheduleTime: new Date(at(800)) },
    );
  });

  it('stays quiet about the stage a cook has just started', async () => {
    // Advancing a stage stamps the successor's actualStartAt at the same instant it
    // re-times it. Pinging someone to start what they are already standing over is
    // noise, so a stage that has begun (or finished) earns no reminder.
    const before = makeBatch();
    const after = makeBatch({
      stages: before.stages.map((s) => {
        if (s.id === 'bulk') return { ...s, actualEndAt: at(75) };
        if (s.id === 'shape') return stage('shape', 'active', 75, { actualStartAt: at(75) });
        return s;
      }),
    });

    await (onBatchWritten as unknown as Function)(event(snap(before), snap(after)));

    expect(enqueuedStageIds()).not.toContain('shape');
  });
});

describe('onBatchWritten — the clock guards', () => {
  it('skips a stage whose moment has already passed', async () => {
    // "I am mixing NOW" anchors the first stage at the instant the button was
    // tapped; Cloud Tasks would dispatch that immediately and ping someone about
    // what they are visibly doing. The valuable half of the first-stage rule — a
    // back-solved "mix at 13:20" hours ahead — is untouched, and covered above.
    const batch = makeBatch({
      stages: [
        stage('mix', 'active', -1),
        stage('bulk', 'wait', 20),
        stage('shape', 'active', 200),
      ],
    });

    await (onBatchWritten as unknown as Function)(event(deleted, snap(batch)));

    expect(enqueuedStageIds()).toEqual(['shape']);
  });

  it('does NOT enqueue a stage beyond the Cloud Tasks 30-day horizon', async () => {
    // Cloud Tasks refuses a scheduleTime more than 30 days ahead. Bread never gets
    // near it; a 90-day cure (phase 04) will, and this is the guard it must find
    // rather than the surprise it would otherwise meet.
    const batch = makeBatch({
      stages: [
        stage('rub', 'active', 60),
        stage('dry', 'wait', 80),
        // 90 days out — well past the horizon.
        stage('slice', 'active', 90 * 24 * 60),
      ],
    });

    await (onBatchWritten as unknown as Function)(event(deleted, snap(batch)));

    // The reachable reminder still goes; only the unreachable one is dropped.
    expect(enqueuedStageIds()).toEqual(['rub']);
  });

  it('enqueues a stage just INSIDE the horizon', async () => {
    const batch = makeBatch({
      stages: [
        stage('rub', 'active', 60),
        stage('dry', 'wait', 80),
        stage('slice', 'active', 29 * 24 * 60),
      ],
    });

    await (onBatchWritten as unknown as Function)(event(deleted, snap(batch)));

    expect(enqueuedStageIds()).toEqual(['rub', 'slice']);
  });
});

describe('onBatchWritten — the frozen audience', () => {
  it('carries ONLY the uids the flag is on for', async () => {
    // The whole point of #831 here: Ada started the batch and is testing bread; Bram
    // shares the household, the data and the push subscriptions, and must not be
    // woken at 06:45 by a feature he cannot see.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedNotifyUids()).toEqual(['uid-ada']);
  });

  it('asks once per PERSON, not once per device', async () => {
    // Ada has two handsets. Two flag evaluations for one person would be two `/flags`
    // round trips on a path that already runs on every stage advance.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(mockFeatureEnabled).toHaveBeenCalledTimes(2);
    expect(mockGetUsers).toHaveBeenCalledTimes(1);
    expect(mockGetUsers).toHaveBeenCalledWith([{ uid: 'uid-ada' }, { uid: 'uid-bram' }]);
  });

  it('evaluates the flag as the browser does — uid as distinct id, email as a person property', async () => {
    // The release condition targets an email while the person is identified by uid.
    // Ask it any other way and the condition never matches.
    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(mockFeatureEnabled).toHaveBeenCalledWith('bread', 'uid-ada', {
      email: 'ada@example.test',
    });
  });

  it('does not pass a uid with no email — it cannot match the condition', async () => {
    mockEmails = { 'uid-bram': 'bram@example.test' };
    mockFlaggedUids = ['uid-ada', 'uid-bram'];

    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedNotifyUids()).toEqual(['uid-bram']);
    expect(mockFeatureEnabled).not.toHaveBeenCalledWith('bread', 'uid-ada', expect.anything());
  });

  it('skips a subscription that fails validation without losing the rest', async () => {
    mockSubsDocs = [{ data: () => ({ id: 'junk' }) }, subDoc(makeSub('dev-a1', 'uid-ada'))];

    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedNotifyUids()).toEqual(['uid-ada']);
  });

  it('freezes an EMPTY audience when nobody has the flag — never a broadcast', async () => {
    // Empty is a real instruction, not an absence: dispatch honours it and wakes
    // nobody. With the flag off for everyone, starting a batch produces no pushes.
    mockFlaggedUids = [];

    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedNotifyUids()).toEqual([]);
  });

  it('resolves NOTHING when no stage is due', async () => {
    // The early-out comes first on purpose: the overwhelming majority of batch writes
    // enqueue nothing, and must cost no subscription read, no Auth lookup and no flag
    // evaluation.
    const batch = makeBatch();

    await (onBatchWritten as unknown as Function)(
      event(snap(batch), snap({ ...batch, updatedAt: '2026-08-14T17:30:00.000Z' })),
    );

    expect(mockSubsQueried).toBe(false);
    expect(mockGetUsers).not.toHaveBeenCalled();
    expect(mockFeatureEnabled).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED and reports when the Auth lookup blows up', async () => {
    // Not a broadcast. A notification reaching someone who did nothing to ask for it
    // is the harm this exists to prevent — and a silent blackout must be visible.
    mockGetUsers.mockRejectedValueOnce(new Error('auth unavailable'));

    await expect(
      (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch()))),
    ).resolves.toBeUndefined();

    expect(enqueuedNotifyUids()).toEqual([]);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED and reports when the subscription read blows up', async () => {
    mockSubsGet.mockRejectedValueOnce(new Error('firestore down'));

    await (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch())));

    expect(enqueuedNotifyUids()).toEqual([]);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});

describe('onBatchWritten — failure handling', () => {
  it('reports a failed enqueue and still queues the rest', async () => {
    // One failure must not fail the trigger and re-fire it, which would re-enqueue
    // everything that DID succeed. The dispatch ledger de-dupes any eventual double.
    mockEnqueue.mockRejectedValueOnce(new Error('queue does not exist'));

    await expect(
      (onBatchWritten as unknown as Function)(event(deleted, snap(makeBatch()))),
    ).resolves.toBeUndefined();

    expect(mockEnqueue).toHaveBeenCalledTimes(4);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});
