import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  CookActiveTimerDoc,
  CookSessionDoc,
  PushSubscriptionDoc,
  RecipeDoc,
} from '@salt/domain/schemas';
import { FakeTimestamp } from '../support/fakeTimestamp.js';

// Unit-level (mock-based, no emulator) coverage of the cook-timer DISPATCH handler
// (issue #544): re-read the live session, no-op stale/duplicate dispatches via the
// exactly-once ledger, then send a push naming the timer and the recipe to each
// owner subscription, pruning the dead and reporting the failed. CookSessionSchema,
// PushSubscriptionSchema and RecipeSchema are kept REAL.

vi.mock('firebase-functions/v2/tasks', () => ({
  onTaskDispatched: (_opts: unknown, handler: unknown) => handler,
}));

// Key-aware, so a case can unprovision ONE secret. Blanking them all would take
// VAPID down with Pushover and the routing under test would vanish entirely.
const mockSecrets: Record<string, string> = {};
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => mockSecrets[name] ?? 'test-vapid-private' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only the TRANSPORT is faked. `isApplePushEndpoint` is kept real, because the
// routing assertions below are meaningless against a stubbed one — the whole
// point is which endpoint lands in which channel.
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

// Pushover is the second, independent sink (issue #680). The transport and the
// uid→member→devices resolution are covered by their own suites; here we care
// only that the handler reacts correctly to each resolution outcome.
const mockSendPushover = vi.fn<typeof import('../../src/adapters/sendPushover.js').sendPushover>(
  async () => 'sent' as const,
);
vi.mock('../../src/adapters/sendPushover.js', () => ({
  sendPushover: mockSendPushover,
}));

const mockResolveTargets = vi.fn();
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
// factory may reference it. Each test sets the snapshots/docs it needs.
let mockCookSessionSnap: { exists: boolean; data: () => unknown } = {
  exists: false,
  data: () => undefined,
};
let mockLedgerSnap: { exists: boolean } = { exists: false };
let mockSubsDocs: Array<{ data: () => unknown; ref: { delete: () => Promise<void> } }> = [];
let mockRecipeGet: () => Promise<{ exists: boolean; data: () => unknown }> = async () => ({
  exists: false,
  data: () => undefined,
});
const mockTxSet = vi.fn();
// The exactly-once ledger's doc id is part of the contract (it is keyed by the
// TIMER id since #748, not the step id), so the mock records what was asked for.
let mockLedgerDocId = '';

const mockDb = {
  collection: (name: string) => {
    if (name === 'cookSessions') {
      return { doc: () => ({ get: async () => mockCookSessionSnap }) };
    }
    if (name === 'recipes') {
      return { doc: () => ({ get: mockRecipeGet }) };
    }
    if (name === 'timerDeliveries') {
      return {
        doc: (id: string) => {
          mockLedgerDocId = id;
          return { id };
        },
      };
    }
    if (name === 'pushSubscriptions') {
      return { where: () => ({ get: async () => ({ docs: mockSubsDocs }) }) };
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

const { onCookTimerDispatch } = await import('../../src/triggers/onCookTimerDispatch.js');
const { TIMER_DELIVERY_RETENTION_MS } =
  await import('../../src/triggers/timerDeliveryRetention.js');

const STEP_ID = 'step-1';
const ENDS_AT = '2026-07-24T10:00:00.000Z';
const SESSION_ID = 'recipe-1_uid-1';

// A step timer's identity IS its step id, so TIMER_ID and STEP_ID coincide for the
// default fixture — the ad-hoc cases below are where they come apart.
const TIMER_ID = STEP_ID;

function makeTimer(overrides: Partial<CookActiveTimerDoc> = {}): CookActiveTimerDoc {
  return {
    id: TIMER_ID,
    stepId: STEP_ID,
    // Null by default so the step-lookup fallback (a legacy entry) stays exercised;
    // the label-precedence cases set it explicitly.
    label: null,
    durationMinutes: null,
    endsAt: ENDS_AT,
    notify: true,
    ...overrides,
  };
}

function makeSession(overrides: Partial<CookSessionDoc> = {}): CookSessionDoc {
  return {
    id: SESSION_ID,
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: 'recipe-1',
    recipeUpdatedAtAtStart: '2026-07-24T09:00:00.000Z',
    serveAt: null,
    servings: null,
    checkedIngredientIds: [],
    checkedPrepIds: [],
    completedStepIds: [],
    activeTimers: [makeTimer()],
    createdAt: '2026-07-24T09:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

// Subscriptions default to an APPLE endpoint, because that is the branch that
// always receives a web push. Pass `ANDROID_ENDPOINT` for the fallback-only side.
const APPLE_ENDPOINT = 'https://web.push.apple.com/';
const ANDROID_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/';

function makeSub(id: string, host: string = APPLE_ENDPOINT): PushSubscriptionDoc {
  return {
    id,
    schemaVersion: 1,
    ownerUid: 'uid-1',
    endpoint: `${host}${id}`,
    keys: { p256dh: `p256-${id}`, auth: `auth-${id}` },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function subDoc(sub: PushSubscriptionDoc) {
  return { data: () => sub, ref: { delete: vi.fn(async () => undefined) } };
}

// A recipe whose step STEP_ID carries a labelled timer, so the notification can
// name it exactly as the in-app timer chip does.
function makeRecipe(overrides: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    id: 'recipe-1',
    schemaVersion: 1,
    kind: 'recipe',
    title: "Shepherd's pie",
    description: null,
    ingredients: [],
    steps: [
      { id: 'step-0', text: 'Chop the onion.', timer: null, note: null },
      {
        id: STEP_ID,
        text: 'Simmer until thickened.',
        timer: { durationMinutes: 20, description: 'Simmer the sauce' },
        note: null,
      },
    ],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    image: null,
    createdAt: '2026-07-24T09:00:00.000Z',
    updatedAt: '2026-07-24T09:00:00.000Z',
    ...overrides,
  };
}

function recipeExists(recipe: RecipeDoc = makeRecipe()) {
  return async () => ({ exists: true, data: () => recipe });
}

function req(timerId: string = TIMER_ID) {
  return { data: { sessionId: SESSION_ID, timerId, endsAt: ENDS_AT } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCookSessionSnap = { exists: false, data: () => undefined };
  mockLedgerSnap = { exists: false };
  mockSubsDocs = [];
  mockLedgerDocId = '';
  mockRecipeGet = recipeExists();
  mockSendWebPush.mockResolvedValue('sent' as const);
  mockSendPushover.mockResolvedValue('sent' as const);
  mockResolveTargets.mockResolvedValue({ kind: 'send', devices: ['daniel-phone'] });
  // The deep link is derived from the runtime's project id — no new config, but
  // it does mean the tests must stand one up.
  for (const key of Object.keys(mockSecrets)) delete mockSecrets[key];
  vi.stubEnv('GCLOUD_PROJECT', 's2-prod-e46bd');
  // VAPID keys and the Pushover credentials are provided via the mocked
  // defineSecret (.value() → a test string), so the handler treats both sinks as
  // provisioned.
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('onCookTimerDispatch', () => {
  it('no-ops when the session is absent', async () => {
    mockCookSessionSnap = { exists: false, data: () => undefined };

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  it('no-ops when the payload names a timer this session does not have', async () => {
    // Including a task queued with the PRE-#748 payload shape, which carries no
    // timerId at all — an accepted, deliberate gap of a few minutes at deploy.
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)({
      data: { sessionId: SESSION_ID, endsAt: ENDS_AT },
    });

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  it('claims the ledger under the TIMER id, not the step id', async () => {
    mockCookSessionSnap = {
      exists: true,
      data: () => makeSession({ activeTimers: [makeTimer({ id: 'adhoc-7', stepId: null })] }),
    };

    await (onCookTimerDispatch as unknown as Function)(req('adhoc-7'));

    expect(mockLedgerDocId).toBe(`${SESSION_ID}_adhoc-7_${Date.parse(ENDS_AT)}`);
    expect(mockTxSet).toHaveBeenCalledWith(expect.anything(), {
      // Timestamps, not numbers: the TTL policy on `expiresAt` acts on nothing
      // else (#1008), and `deliveredAt` converts alongside it.
      deliveredAt: expect.any(FakeTimestamp),
      expiresAt: expect.any(FakeTimestamp),
      sessionId: SESSION_ID,
      timerId: 'adhoc-7',
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

  it("prefers the timer's OWN label over the step's description", async () => {
    // The point of #748: a timer started for 25 minutes under a name the cook
    // typed must be announced by that name, not by whatever the step still says.
    mockCookSessionSnap = {
      exists: true,
      data: () => makeSession({ activeTimers: [makeTimer({ label: 'Second simmer' })] }),
    };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['title']).toBe('Second simmer');
    expect(payload['body']).toBe("Shepherd's pie");
  });

  it('names an ad-hoc timer (no step to look up) from its own label', async () => {
    mockCookSessionSnap = {
      exists: true,
      data: () => makeSession({ activeTimers: [makeTimer({ stepId: null, label: 'Rice' })] }),
    };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['title']).toBe('Rice');
    expect(payload['body']).toBe("Shepherd's pie");
  });

  it('keeps the label even when the recipe cannot be read', async () => {
    mockCookSessionSnap = {
      exists: true,
      data: () => makeSession({ activeTimers: [makeTimer({ label: 'Rice' })] }),
    };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];
    mockRecipeGet = async () => ({ exists: false, data: () => undefined });

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['title']).toBe('Rice');
    expect(payload['body']).toBe('A cook timer just finished.');
  });

  it('no-ops when the timer is no longer present (removed/adjusted)', async () => {
    // Session exists but its timer was removed (activeTimers empty).
    mockCookSessionSnap = { exists: true, data: () => makeSession({ activeTimers: [] }) };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockSendPushover).not.toHaveBeenCalled();
  });

  it('no-ops on duplicate delivery (ledger doc already exists)', async () => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockLedgerSnap = { exists: true }; // already delivered
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
  });

  it('names the timer and the recipe in the payload sent to every subscription', async () => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockSubsDocs = [subDoc(makeSub('dev-1')), subDoc(makeSub('dev-2'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockTxSet).toHaveBeenCalledTimes(1); // ledger claimed
    expect(mockSendWebPush).toHaveBeenCalledTimes(2);

    // The timer's own label leads, the cook it belongs to follows — the same two
    // facts, in the same order, as the in-app timer chip.
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload).toEqual({
      type: 'cook-timer',
      tag: `cook::${SESSION_ID}`,
      sessionId: SESSION_ID,
      url: '/#/recipes/recipe-1/cook',
      title: 'Simmer the sauce',
      body: "Shepherd's pie",
    });
  });

  it('carries the cook route as an explicit url, taken from the SESSION recipeId', async () => {
    // Issue #1127. The service worker used to rebuild this route by slicing the
    // recipe id back out of `sessionId`; the sender has always held
    // `session.recipeId`, so it sends the route instead. A hash PATH, matching the
    // three sibling notification kinds — the ABSOLUTE link stays Pushover's.
    //
    // Driven off a session whose recipeId does NOT match the sessionId prefix, so
    // the assertion cannot be satisfied by the old slice: it proves the url comes
    // from the document rather than from the id.
    mockCookSessionSnap = { exists: true, data: () => makeSession({ recipeId: 'recipe-9' }) };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['url']).toBe('/#/recipes/recipe-9/cook');
    // `sessionId` is kept BESIDE it, not replaced: Cloud Tasks queued before this
    // shipped carry no `url`, and the service worker's slice still feeds off it.
    expect(payload['sessionId']).toBe(SESSION_ID);
  });

  it('BACK-COMPAT: a legacy timer entry (no id/label/duration) still dispatches', async () => {
    // A session written before #748 and still live across the deploy. The schema
    // backfills `id` from `stepId`, so the task queued for it matches and the
    // step lookup still names it.
    mockCookSessionSnap = {
      exists: true,
      data: () => ({
        ...makeSession(),
        activeTimers: [{ stepId: STEP_ID, endsAt: ENDS_AT, notify: true }],
      }),
    };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['title']).toBe('Simmer the sauce');
    expect(mockLedgerDocId).toBe(`${SESSION_ID}_${STEP_ID}_${Date.parse(ENDS_AT)}`);
  });

  it('falls back to the step description when the timer has no label of its own', async () => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];
    const recipe = makeRecipe();
    mockRecipeGet = recipeExists({
      ...recipe,
      steps: recipe.steps.map((s) =>
        s.id === STEP_ID ? { ...s, timer: { durationMinutes: 20, description: null } } : s,
      ),
    });

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    // Second step in the array → "Step 2", matching what the cook screen shows.
    expect(payload['title']).toBe('Step 2');
    expect(payload['body']).toBe("Shepherd's pie");
  });

  it.each([
    ['the recipe is gone', async () => ({ exists: false, data: () => undefined })],
    ['the recipe fails validation', async () => ({ exists: true, data: () => ({ id: 'junk' }) })],
    [
      'the read throws',
      async () => {
        throw new Error('firestore down');
      },
    ],
  ])('still notifies with generic copy when %s', async (_case, get) => {
    // The name is a nicety; the notification is the time-critical part, so no
    // failure to name a timer may cost us the delivery itself.
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockSubsDocs = [subDoc(makeSub('dev-1'))];
    mockRecipeGet = get as typeof mockRecipeGet;

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload['title']).toBe('Timer finished');
    expect(payload['body']).toBe('A cook timer just finished.');
  });

  it('prunes a subscription that returns gone', async () => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    const doc = subDoc(makeSub('dev-dead'));
    mockSubsDocs = [doc];
    mockSendWebPush.mockResolvedValue('gone' as const);

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(doc.ref.delete).toHaveBeenCalledTimes(1);
  });

  it('reports (does not throw) when sendWebPush returns failed', async () => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    const doc = subDoc(makeSub('dev-1'));
    mockSubsDocs = [doc];
    mockSendWebPush.mockResolvedValue('failed' as const);

    await expect((onCookTimerDispatch as unknown as Function)(req())).resolves.toBeUndefined();

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(doc.ref.delete).not.toHaveBeenCalled();
  });
});

// The Pushover sink (issue #680). It ships ALONGSIDE web push for the rollout,
// so the two are independent: neither may suppress or break the other.
describe('onCookTimerDispatch — Pushover sink', () => {
  beforeEach(() => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
  });

  it('sends to the resolved devices, naming the timer and linking back to the cook', async () => {
    mockResolveTargets.mockResolvedValue({
      kind: 'send',
      devices: ['daniel-phone', 'daniel-tablet'],
    });

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    const [, devices, message] = mockSendPushover.mock.calls[0]!;
    expect(devices).toEqual(['daniel-phone', 'daniel-tablet']);
    expect(message).toEqual({
      title: 'Simmer the sauce',
      body: "Shepherd's pie",
      // ABSOLUTE — a native client opens this, so there is no origin to resolve a
      // path against. Hash-routed, matching push-sw.js's notificationclick route.
      url: 'https://s2-prod-e46bd.web.app/#/recipes/recipe-1/cook',
      urlTitle: 'Back to the cook',
    });
  });

  it('sends without a link rather than a broken one when there is no project id', async () => {
    vi.stubEnv('GCLOUD_PROJECT', '');
    vi.stubEnv('GCP_PROJECT', '');

    await (onCookTimerDispatch as unknown as Function)(req());

    const [, , message] = mockSendPushover.mock.calls[0]!;
    expect((message as { url?: string }).url).toBeUndefined();
    expect((message as { title: string }).title).toBe('Simmer the sauce');
  });

  it('sends NOTHING via Pushover when no device matched the member prefix', async () => {
    // The fail-open guard. Pushover would broadcast to the whole family if we
    // sent an unresolvable device name, so a zero-match must not send at all.
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Daniel' });
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    // NOT reported: a member who has simply never installed Pushover lands here
    // on every timer, and they are covered by the web-push fallback.
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('sends nothing and does NOT report when suppressed in non-production', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'suppressed' });
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('sends nothing and does NOT report when resolution hits an operational blip', async () => {
    // An offline wobble is the expected, not the unexpected (§7.6).
    mockResolveTargets.mockResolvedValue({ kind: 'unresolved', reason: 'network' });
    mockSubsDocs = [subDoc(makeSub('dev-1'))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });
});

// Per-device routing (issue #680). Each device gets exactly ONE channel, chosen
// by the push endpoint's host — the only per-device platform signal in the system.
// Apple always takes web push (APNs is reliable there); everything else takes it
// only when Pushover did not deliver, because Android web push is throttled into
// uselessness by Doze and per-OEM battery management.
describe('onCookTimerDispatch — channel routing', () => {
  beforeEach(() => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
  });

  it('skips web push for a non-Apple device once Pushover has delivered', async () => {
    mockSubsDocs = [subDoc(makeSub('pixel', ANDROID_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('still sends web push to an Apple device when Pushover has delivered', async () => {
    // NOT a duplicate: Pushover reached an Android phone, this reaches the iPad.
    // The two sinks are covering two different devices.
    mockSubsDocs = [subDoc(makeSub('ipad', APPLE_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
  });

  it('falls back to web push on a non-Apple device when Pushover has no devices', async () => {
    // The member who never installed Pushover: an unreliable notification beats
    // silence, and the day they install it this stops on its own.
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Ryan' });
    mockSubsDocs = [subDoc(makeSub('new-phone', ANDROID_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('falls back to web push when the Pushover send itself fails', async () => {
    // Resolution succeeded, the transport did not — that is precisely when a
    // fallback should engage rather than report.
    mockSendPushover.mockResolvedValue('failed' as const);
    mockSubsDocs = [subDoc(makeSub('pixel', ANDROID_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('sends the fallback push UNMODIFIED when the member has no Pushover (#988)', async () => {
    // This is the case that used to append the install nudge. #988 (option 3)
    // dropped it: the install advice lives once in /settings, never on the
    // notification — so the body is exactly the dish, nothing appended.
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Ryan' });
    mockSubsDocs = [subDoc(makeSub('new-phone', ANDROID_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['body']).toBe("Shepherd's pie");
  });

  it('routes a mixed device set to one channel each', async () => {
    mockSubsDocs = [
      subDoc(makeSub('ipad', APPLE_ENDPOINT)),
      subDoc(makeSub('pixel', ANDROID_ENDPOINT)),
    ];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    const [, subscription] = mockSendWebPush.mock.calls[0]!;
    expect((subscription as { endpoint: string }).endpoint).toContain('apple.com');
  });

  it('still notifies via Pushover in non-production even with no subscriptions', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'suppressed' });
    mockSubsDocs = [];

    await (onCookTimerDispatch as unknown as Function)(req());

    // Suppressed + nothing to fall back to = genuinely undelivered, so this is
    // the one case that reports (see the total-non-delivery suite below).
    expect(mockSendWebPush).not.toHaveBeenCalled();
  });
});

// Reporting is now gated on TOTAL non-delivery. Either sink failing alone is a
// non-event — each is the other's backstop — but a timer that reached nothing at
// all leaves someone standing over a pan waiting for a ping that never comes.
describe('onCookTimerDispatch — total non-delivery', () => {
  beforeEach(() => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
  });

  it('reports when neither sink delivered', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Ryan' });
    mockSubsDocs = [];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(String(mockReport.mock.calls[0]![0])).toContain('no device');
  });

  it('reports when the only subscription is dead and Pushover has none', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Ryan' });
    mockSubsDocs = [subDoc(makeSub('dead', ANDROID_ENDPOINT))];
    mockSendWebPush.mockResolvedValue('gone' as const);

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it('does NOT report when Pushover alone delivered', async () => {
    mockSubsDocs = [];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockReport).not.toHaveBeenCalled();
  });

  it('does NOT report when web push alone delivered', async () => {
    mockResolveTargets.mockResolvedValue({ kind: 'no-devices', firstName: 'Ryan' });
    mockSubsDocs = [subDoc(makeSub('dev-1', ANDROID_ENDPOINT))];

    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockReport).not.toHaveBeenCalled();
  });
});

// The one Pushover outcome the cases above leave unpinned, and the one #987
// Phase 4's shared fan-out must not lose: OUR missing configuration, which is a
// different thing from their missing app. It is 'unavailable', so every device
// falls back — and it earns no nudge, because there is nothing for them to fix.
describe('onCookTimerDispatch — Pushover not provisioned', () => {
  beforeEach(() => {
    mockCookSessionSnap = { exists: true, data: () => makeSession() };
    mockSecrets['PUSHOVER_APP_TOKEN'] = '';
    mockSubsDocs = [subDoc(makeSub('pixel', ANDROID_ENDPOINT)), subDoc(makeSub('ipad'))];
  });

  it('falls back to every device without nudging, and does not report', async () => {
    await (onCookTimerDispatch as unknown as Function)(req());

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(mockSendWebPush.mock.calls.map((c) => (c[1] as { endpoint: string }).endpoint)).toEqual([
      `${ANDROID_ENDPOINT}pixel`,
      `${APPLE_ENDPOINT}ipad`,
    ]);
    const payload = mockSendWebPush.mock.calls[0]![2] as Record<string, string>;
    expect(payload['body']).toBe("Shepherd's pie");
    expect(mockReport).not.toHaveBeenCalled();
  });
});
