import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KitchenTimerDoc, KitchenTimersDoc, PushSubscriptionDoc } from '@salt/domain/schemas';
import { FakeTimestamp } from '../support/fakeTimestamp.js';

// Unit-level (mock-based, no emulator) coverage of the standalone kitchen-timer
// DISPATCH handler (issue #842): re-read the live document, no-op stale and
// duplicate dispatches, then send — Pushover first, web push routed per device to
// the OWNER's subscriptions only. `KitchenTimersSchema` and `PushSubscriptionSchema`
// are kept REAL.

vi.mock('firebase-functions/v2/tasks', () => ({
  onTaskDispatched: (_opts: unknown, handler: unknown) => handler,
}));

// Key-aware, so a case can unprovision ONE secret. Blanking them all would take
// VAPID down with Pushover and the fan-out under test would vanish entirely.
const mockSecrets: Record<string, string> = {};
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => mockSecrets[name] ?? 'test-secret' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only the TRANSPORT is faked. `isApplePushEndpoint` is kept real, because the
// routing assertions below are meaningless against a stubbed one — the whole
// point is which endpoint lands in which channel — and because a hand-rolled
// stub would be a substring check where the real one parses the hostname.
// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile, while
// `mockResolvedValue` is pinned to the one literal used here (#1135).
const mockSendWebPush = vi.fn<typeof import('../../src/adapters/sendWebPush.js').sendWebPush>(
  async () => 'sent' as const,
);
vi.mock('../../src/adapters/sendWebPush.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/sendWebPush.js')>()),
  sendWebPush: mockSendWebPush,
}));

const mockSendPushover = vi.fn<typeof import('../../src/adapters/sendPushover.js').sendPushover>(
  async () => 'sent' as const,
);
vi.mock('../../src/adapters/sendPushover.js', () => ({
  sendPushover: mockSendPushover,
}));

const mockResolveTargets = vi.fn<
  typeof import('../../src/adapters/pushoverRecipient.js').resolvePushoverTargets
>(async () => ({ kind: 'send' as const, devices: ['daniel-phone'] }));
vi.mock('../../src/adapters/pushoverRecipient.js', () => ({
  resolvePushoverTargets: mockResolveTargets,
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
// factory may reference it.
let mockTimersSnap: { exists: boolean; data: () => unknown } = {
  exists: false,
  data: () => undefined,
};
let mockLedgerSnap: { exists: boolean } = { exists: false };
let mockSubsDocs: Array<{ data: () => unknown; ref: { delete: () => Promise<void> } }> = [];
const mockTxSet = vi.fn();
// The ledger doc id is part of the contract — the SHARED `timerDeliveries`
// collection with a `kitchen_` prefix, never a third collection — so record it.
let mockLedgerDocId = '';
let mockLedgerCollection = '';
// Unlike the batch reminder, this one MUST filter on ownerUid: a kitchen timer is
// owner-scoped, and broadcasting it would show one person's eggs to the household.
let mockSubsWhere: { field: string; value: unknown } | null = null;

const mockDb = {
  collection: (name: string) => {
    if (name === 'kitchenTimers') {
      return { doc: () => ({ get: async () => mockTimersSnap }) };
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
        where: (field: string, _op: string, value: unknown) => {
          mockSubsWhere = { field, value };
          return { get: async () => ({ docs: mockSubsDocs }) };
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

const { onKitchenTimerDispatch } = await import('../../src/triggers/onKitchenTimerDispatch.js');

// `onTaskDispatched` returns a `TaskQueueFunction`, which is ALSO an Express
// request handler and so declares TWO parameters. The `vi.mock` at the top of
// this file replaces it with the bare handler, which takes one — the task
// request. Call through this alias so the mismatch is stated once, here, rather
// than at each of the 28 call sites below (#1135).
const dispatch = onKitchenTimerDispatch as unknown as (
  request: ReturnType<typeof req>,
) => Promise<void>;
const { TIMER_DELIVERY_RETENTION_MS } =
  await import('../../src/triggers/timerDeliveryRetention.js');

const UID = 'uid-1';
const TIMER_ID = 'k1';
const ENDS_AT = '2026-08-16T18:10:00.000Z';
const ENDS_AT_MS = Date.parse(ENDS_AT);

function timer(overrides: Partial<KitchenTimerDoc> = {}): KitchenTimerDoc {
  return {
    id: TIMER_ID,
    label: 'Eggs',
    endsAt: ENDS_AT,
    durationMinutes: 10,
    notify: true,
    origin: null,
    ...overrides,
  };
}

function makeDoc(timers: KitchenTimerDoc[] = [timer()], ownerUid = UID): KitchenTimersDoc {
  return { ownerUid, timers };
}

function makeSub(id: string, endpoint: string, ownerUid = UID): PushSubscriptionDoc {
  return {
    id,
    schemaVersion: 1,
    ownerUid,
    endpoint,
    keys: { p256dh: `p256-${id}`, auth: `auth-${id}` },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function subDoc(sub: PushSubscriptionDoc) {
  return { data: () => sub, ref: { delete: vi.fn(async () => undefined) } };
}

const androidSub = () => subDoc(makeSub('a', 'https://fcm.googleapis.com/fcm/send/a'));
const appleSub = () => subDoc(makeSub('i', 'https://web.push.apple.com/i'));

function req(overrides: Partial<{ timerId: string; endsAt: string; uid: string }> = {}) {
  return { data: { uid: UID, timerId: TIMER_ID, endsAt: ENDS_AT, ...overrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTimersSnap = { exists: true, data: () => makeDoc() };
  mockLedgerSnap = { exists: false };
  mockSubsDocs = [];
  mockLedgerDocId = '';
  mockLedgerCollection = '';
  mockSubsWhere = null;
  mockSendWebPush.mockResolvedValue('sent');
  mockSendPushover.mockResolvedValue('sent');
  mockResolveTargets.mockResolvedValue({ kind: 'send', devices: ['daniel-phone'] });
  for (const key of Object.keys(mockSecrets)) delete mockSecrets[key];
});

describe('onKitchenTimerDispatch', () => {
  it('sends the timer’s own name via Pushover', async () => {
    await dispatch(req());

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    const message = mockSendPushover.mock.calls[0]?.[2] as { title: string; body: string };
    expect(message.title).toBe('Eggs');
  });

  // The name is read LIVE, which is why the task carries ids only: a timer renamed
  // after it was armed announces itself by the name the chef will be looking for.
  it('uses the name the timer has NOW, not the one it was armed with', async () => {
    mockTimersSnap = { exists: true, data: () => makeDoc([timer({ label: 'Eggs, soft' })]) };
    await dispatch(req());

    const message = mockSendPushover.mock.calls[0]?.[2] as { title: string };
    expect(message.title).toBe('Eggs, soft');
  });

  it('falls back to generic copy for a timer with a blank name', async () => {
    mockTimersSnap = { exists: true, data: () => makeDoc([timer({ label: '   ' })]) };
    await dispatch(req());

    const message = mockSendPushover.mock.calls[0]?.[2] as { title: string };
    expect(message.title).toBe('Timer finished');
  });

  // ─── The web-push payload the service worker will render ────────────────────

  it('carries its own type and an EXPLICIT url — never an id to reconstruct from', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [androidSub()];
    await dispatch(req());

    const payload = mockSendWebPush.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload['type']).toBe('kitchen-timer');
    expect(payload['url']).toBe('/#/mine');
    // A cook timer recovers a recipe id by slicing `sessionId`. That licence is
    // granted by that collection's composite id and must not spread here.
    expect(payload).not.toHaveProperty('sessionId');
  });

  it('tags per timer, so a second timer cannot replace the first one’s notification', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [androidSub()];
    await dispatch(req());

    const payload = mockSendWebPush.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload['tag']).toBe(`kitchen::${TIMER_ID}`);
    expect(payload['renotify']).toBe(true);
  });

  // ─── Staleness ──────────────────────────────────────────────────────────────

  it('says nothing when the member has no timers document', async () => {
    mockTimersSnap = { exists: false, data: () => undefined };
    await dispatch(req());
    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('says nothing when the timer was dismissed before it fired', async () => {
    mockTimersSnap = { exists: true, data: () => makeDoc([]) };
    await dispatch(req());
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  // Re-timing moves the notification: the task for the OLD end-time finds nothing.
  it('says nothing when the timer was re-timed to a different end', async () => {
    mockTimersSnap = {
      exists: true,
      data: () => makeDoc([timer({ endsAt: '2026-08-16T18:35:00.000Z' })]),
    };
    await dispatch(req());
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  it('says nothing for a timer id that is not in the document', async () => {
    await dispatch(req({ timerId: 'gone' }));
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  it('skips an invalid document rather than throwing', async () => {
    mockTimersSnap = { exists: true, data: () => ({ ownerUid: UID, timers: [{ id: 'k1' }] }) };
    await expect(dispatch(req())).resolves.toBeUndefined();
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  // ─── The shared exactly-once ledger ─────────────────────────────────────────

  it('claims the SHARED timerDeliveries ledger with a kitchen_ prefix', async () => {
    await dispatch(req());

    expect(mockLedgerCollection).toBe('timerDeliveries');
    // The uid is in the key because a timer id is only unique within one member.
    expect(mockLedgerDocId).toBe(`kitchen_${UID}_${TIMER_ID}_${ENDS_AT_MS}`);
    expect(mockTxSet).toHaveBeenCalledWith(expect.anything(), {
      // Timestamps, not numbers: the TTL policy on `expiresAt` acts on nothing
      // else (#1008), and `deliveredAt` converts alongside it.
      deliveredAt: expect.any(FakeTimestamp),
      expiresAt: expect.any(FakeTimestamp),
      uid: UID,
      timerId: TIMER_ID,
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

  it('sends nothing on a duplicate dispatch — Cloud Tasks is at-least-once', async () => {
    mockLedgerSnap = { exists: true };
    await dispatch(req());

    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  // ─── Whose devices ──────────────────────────────────────────────────────────

  it('reads only the OWNER’s subscriptions, filtered on the parsed ownerUid', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [androidSub()];
    await dispatch(req());

    expect(mockSubsWhere).toEqual({ field: 'ownerUid', value: UID });
  });

  // The field is read off the document, not taken from the task, so the send
  // target is proven by the same document that armed the timer.
  it('targets the ownerUid on the document, not the uid on the task', async () => {
    mockTimersSnap = { exists: true, data: () => makeDoc([timer()], 'uid-owner') };
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    await dispatch(req());

    expect(mockSubsWhere).toEqual({ field: 'ownerUid', value: 'uid-owner' });
  });

  it('resolves Pushover devices for the member on the task', async () => {
    await dispatch(req());
    expect(mockResolveTargets).toHaveBeenCalledWith(expect.anything(), UID);
  });

  // ─── Per-device routing (the cook timer's rule) ──────────────────────────────

  it('skips non-Apple web push once Pushover has delivered', async () => {
    mockSubsDocs = [androidSub()];
    await dispatch(req());

    expect(mockSendPushover).toHaveBeenCalled();
    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  // APNs is the channel that measurably works on an iPhone, and Pushover may have
  // reached a different device entirely — the two are not duplicates.
  it('always sends to an Apple endpoint, even when Pushover delivered', async () => {
    mockSubsDocs = [appleSub()];
    await dispatch(req());
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
  });

  it('falls back to every device when Pushover did not deliver', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [androidSub(), appleSub()];
    await dispatch(req());
    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
  });

  it('prunes a permanently dead subscription', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    const dead = androidSub();
    mockSubsDocs = [dead];
    mockSendWebPush.mockResolvedValue('gone');
    await dispatch(req());

    expect(dead.ref.delete).toHaveBeenCalled();
  });

  it('skips a subscription document that fails validation', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [
      { data: () => ({ id: 'bad' }), ref: { delete: vi.fn(async () => undefined) } },
      androidSub(),
    ];
    await dispatch(req());
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
  });

  // ─── Reporting ──────────────────────────────────────────────────────────────

  // The one failure of this feature that matters: someone waiting on a ping that
  // is never coming.
  it('reports a timer that reached nothing at all', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [];
    await dispatch(req());
    expect(mockReport).toHaveBeenCalled();
  });

  it('does not report when Pushover alone delivered', async () => {
    mockSubsDocs = [];
    await dispatch(req());
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('does not report when web push alone delivered', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [androidSub()];
    await dispatch(req());
    expect(mockReport).not.toHaveBeenCalled();
  });

  // Throwing would put the whole dispatch into a Cloud Tasks retry it cannot win.
  it('never throws out of the handler, and flushes observability', async () => {
    mockTimersSnap = {
      exists: true,
      get data(): () => unknown {
        throw new Error('firestore exploded');
      },
    } as unknown as { exists: boolean; data: () => unknown };

    await expect(dispatch(req())).resolves.toBeUndefined();
    expect(mockReport).toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });
});

// ─── The Pushover fan-out, pinned ahead of #987 Phase 4 ───────────────────────
//
// Phase 4 replaces this file's `deliverViaPushover` with one shared with the cook
// timer. These cases pin what that move must preserve: the three-way outcome
// mapping and the Apple-always / fallback-only routing it decides, the deep link
// and link title that are this kind's own — and, as its own assertion, that the
// fallback push stays unmodified on 'no-devices' (#988 dropped the install nudge
// everywhere; the advice lives once in /settings).
describe('onKitchenTimerDispatch — Pushover fan-out', () => {
  const ANDROID = 'https://fcm.googleapis.com/fcm/send/a';
  const APPLE = 'https://web.push.apple.com/i';
  const pushedTo = () =>
    mockSendWebPush.mock.calls.map((call) => (call[1] as { endpoint: string }).endpoint);

  beforeEach(() => {
    // The deep link is derived from the runtime's project id.
    vi.stubEnv('GCLOUD_PROJECT', 's2-prod-e46bd');
    mockSubsDocs = [androidSub(), appleSub()];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 'delivered' is the ONLY outcome that suppresses the non-Apple fallback. An
  // Apple endpoint is sent to in every row, because Pushover may well have
  // reached a different device entirely.
  // `as const` so each row's `kind` stays the LITERAL the adapter's discriminated
  // union needs — without it every one widens to `string` and the table stops
  // standing for the five outcomes it names (#1135).
  it.each([
    ['a delivered send', { kind: 'send', devices: ['daniel-phone'] }, 'sent', [APPLE]],
    ['a failed send', { kind: 'send', devices: ['daniel-phone'] }, 'failed', [ANDROID, APPLE]],
    ['no matching device', { kind: 'no-devices', firstName: 'Daniel' }, 'sent', [ANDROID, APPLE]],
    ['an unresolved lookup', { kind: 'unresolved', reason: 'network' }, 'sent', [ANDROID, APPLE]],
    ['suppression outside production', { kind: 'suppressed' }, 'sent', [ANDROID, APPLE]],
  ] as const)('fans web push out after %s', async (_case, targets, send, endpoints) => {
    mockResolveTargets.mockResolvedValue(targets);
    mockSendPushover.mockResolvedValue(send as 'sent' | 'failed');

    await dispatch(req());

    expect(pushedTo()).toEqual(endpoints);
  });

  it('fans web push out to every device when Pushover is not provisioned here', async () => {
    mockSecrets['PUSHOVER_APP_TOKEN'] = '';

    await dispatch(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(pushedTo()).toEqual([ANDROID, APPLE]);
  });

  it('links Pushover back to the kitchen, absolute and under its own title', async () => {
    await dispatch(req());

    const [, devices, message] = mockSendPushover.mock.calls[0]!;
    expect(devices).toEqual(['daniel-phone']);
    expect(message).toEqual({
      title: 'Eggs',
      body: 'Your kitchen timer just finished.',
      // Absolute: a native client opens this, so there is no origin to resolve a
      // path against. `/#/mine` — no id to reconstruct anything from.
      url: 'https://s2-prod-e46bd.web.app/#/mine',
      urlTitle: 'Go to the kitchen',
    });
  });

  // ─── Where a finished timer lands (issue #1327, Phase 2) ────────────────────
  //
  // BOTH sinks, in one case each, because the two are set from one `url` and the
  // whole value of `origin` is that a timer armed at the oven does not send the
  // chef to Mine. The origin is read off the LIVE document here, which is why the
  // task payload could stay ids-only.
  it('deep-links a batch timer back to the cook page it was armed from', async () => {
    mockTimersSnap = {
      exists: true,
      data: () => makeDoc([timer({ origin: { batchId: 'batch-9', stepId: 'step-2' } })]),
    };

    await dispatch(req());

    const [, , message] = mockSendPushover.mock.calls[0]!;
    expect(message).toMatchObject({
      url: 'https://s2-prod-e46bd.web.app/#/batches/batch-9/cook',
      urlTitle: 'Back to the cook',
    });
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['url']).toBe('/#/batches/batch-9/cook');
  });

  // An ad-hoc timer started from the batch cook page belongs to the batch and to
  // no step — a different fact from `origin: null`, and it must still land there.
  it('deep-links a batch timer with no step of its own to the same page', async () => {
    mockTimersSnap = {
      exists: true,
      data: () => makeDoc([timer({ origin: { batchId: 'batch-9', stepId: null } })]),
    };

    await dispatch(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['url']).toBe('/#/batches/batch-9/cook');
  });

  // The other half of the sentence, and the one a regression would break silently:
  // a My Kitchen timer — and every timer written before the field — still lands on
  // Mine.
  it('leaves a timer with no origin landing on My Kitchen', async () => {
    await dispatch(req());

    const [, , message] = mockSendPushover.mock.calls[0]!;
    expect(message).toMatchObject({
      url: 'https://s2-prod-e46bd.web.app/#/mine',
      urlTitle: 'Go to the kitchen',
    });
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['url']).toBe('/#/mine');
  });

  it('never appends an install nudge — the fallback push is unmodified (#988)', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });

    await dispatch(req());

    // The 'no-devices' outcome that once nudged a cook timer's fallback (#988).
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['body']).toBe('Your kitchen timer just finished.');
    expect(payload['body']).not.toContain('install Pushover');
  });
});
