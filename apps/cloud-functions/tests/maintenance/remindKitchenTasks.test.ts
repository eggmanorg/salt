import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DefrostDoc, MealPlanWeekDoc, PushSubscriptionDoc } from '@salt/domain/schemas';
import type { KitchenTask } from '@salt/domain';

// Unit-level (mock-based, no emulator) coverage of the 09:00 Kitchen reminder
// (issue #1683). DefrostSchema / PushSubscriptionSchema and `@salt/domain`'s
// `kitchenTasks` are kept REAL, so what is asserted here is what Kitchen itself
// would compute. The preamble is `remindShoppingDay.test.ts`'s, mock for mock.
//
// The night is STORED on the defrost (#1696). The mock still serves a planner —
// `mealPlanConfig` and `mealPlans` answer if asked — so a test can prove the
// handler never asks.

vi.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_opts: unknown, handler: unknown) => handler,
}));

let mockVapidKey = 'test-vapid-key';
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => mockVapidKey }),
}));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('firebase-functions', () => ({ logger: mockLogger }));

// Typed as the real function, not inferred (#1135) — see remindShoppingDay.test.ts.
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

// Collection-aware Firestore mock. `mockReads` records every collection/doc the
// handler touched, which is how "one read and return", "no recipe read" and "no
// planner read" are asserted.
type FakeDoc = { id: string; data: () => unknown; ref: { delete: () => Promise<void> } };
let mockDefrostDocs: FakeDoc[] = [];
let mockDefrostsThrow = false;
let mockConfig: unknown = undefined;
let mockWeeks: Record<string, unknown> = {};
let mockSubsDocs: FakeDoc[] = [];
const mockReads: string[] = [];

const mockDb = {
  collection: (name: string) => {
    if (name === 'defrosts') {
      return {
        get: async () => {
          mockReads.push('defrosts');
          if (mockDefrostsThrow) throw new Error('firestore exploded');
          return { docs: mockDefrostDocs };
        },
      };
    }
    if (name === 'mealPlanConfig') {
      return {
        doc: (id: string) => ({
          get: async () => {
            mockReads.push(`mealPlanConfig/${id}`);
            return { exists: mockConfig !== undefined, data: () => mockConfig };
          },
        }),
      };
    }
    if (name === 'mealPlans') {
      return {
        doc: (id: string) => ({
          get: async () => {
            mockReads.push(`mealPlans/${id}`);
            const week = mockWeeks[id];
            return { exists: week !== undefined, data: () => week };
          },
        }),
      };
    }
    if (name === 'pushSubscriptions') {
      return {
        get: async () => {
          mockReads.push('pushSubscriptions');
          return { docs: mockSubsDocs };
        },
      };
    }
    mockReads.push(name);
    return { get: async () => ({ docs: [] }), doc: () => ({ get: async () => ({}) }) };
  },
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
}));

const { remindKitchenTasks, kitchenReminderCopy } =
  await import('../../src/maintenance/remindKitchenTasks.js');

const run = () => (remindKitchenTasks as unknown as () => Promise<void>)();

// 08:00Z on Wednesday 2026-10-14 is 09:00 BST — the instant the cron fires.
const CRON_INSTANT = new Date('2026-10-14T08:00:00.000Z');
const TODAY = '2026-10-14';
const TOMORROW = '2026-10-15';

function defrost(overrides: Partial<DefrostDoc> = {}): DefrostDoc {
  return {
    schemaVersion: 1,
    freezerNumber: 47,
    name: 'pork loin',
    location: 'Garage · shelf B',
    recipeId: 'chilli',
    recipeTitle: 'chilli',
    amount: 1,
    committedAt: '2026-10-10T18:00:00.000Z',
    forDate: TOMORROW,
    ...overrides,
  };
}

function fakeDoc(id: string, data: unknown): FakeDoc {
  return { id, data: () => data, ref: { delete: vi.fn(async () => undefined) } };
}

function defrostDoc(d: DefrostDoc): FakeDoc {
  return fakeDoc(`${String(d.freezerNumber).padStart(3, '0')}_${d.recipeId ?? 'manual'}`, d);
}

/** A week starting `startDate`, with `plan` mapping dates to their recipe ids. */
function week(startDate: string, plan: Record<string, string[]>): MealPlanWeekDoc {
  const days: MealPlanWeekDoc['days'] = {};
  for (const [date, recipeIds] of Object.entries(plan)) {
    days[date] = { note: '', recipeIds, chefs: [], attendees: [], guests: 0 };
  }
  return { id: startDate, schemaVersion: 1, startDate, days, updatedAt: '2026-10-10T00:00:00Z' };
}

function makeSub(id: string): PushSubscriptionDoc {
  return {
    id,
    schemaVersion: 1,
    ownerUid: `uid-${id}`,
    endpoint: `https://push.example/${id}`,
    keys: { p256dh: `p256-${id}`, auth: `auth-${id}` },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function payloadOf(call = 0) {
  return mockSendWebPush.mock.calls[call]?.[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(CRON_INSTANT);
  mockVapidKey = 'test-vapid-key';
  mockDefrostDocs = [];
  mockDefrostsThrow = false;
  mockConfig = { firstDayOfWeek: 'mon', schemaVersion: 1 };
  mockWeeks = {};
  mockSubsDocs = [fakeDoc('a', makeSub('a')), fakeDoc('b', makeSub('b'))];
  mockReads.length = 0;
  mockSendWebPush.mockResolvedValue('sent' as const);
});

describe('remindKitchenTasks', () => {
  it('returns after the one defrosts read when Kitchen holds nothing', async () => {
    await run();

    expect(mockReads).toEqual(['defrosts']);
    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });

  it("broadcasts one push for tomorrow's stored night, reading no recipe and no planner", async () => {
    mockDefrostDocs = [defrostDoc(defrost())];

    await run();

    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
    expect(payloadOf(0)).toEqual({
      type: 'kitchen-reminder',
      tag: `kitchen::${TODAY}`,
      url: '/#/mine',
      title: "Defrost the pork loin for tomorrow's chilli",
      body: 'Garage · shelf B · #0047',
      renotify: false,
    });
    expect(payloadOf(1)).toEqual(payloadOf(0));
    // The title comes from the doc's denormalised `recipeTitle`; nothing else is read.
    expect(mockReads).toEqual(['defrosts', 'pushSubscriptions']);
    expect(mockLogger.info).toHaveBeenCalledWith('remindKitchenTasks: reminded', {
      date: TODAY,
      due: 1,
      sent: 2,
      pruned: 0,
    });
  });

  it('collapses several due items into one notification', async () => {
    mockDefrostDocs = [
      defrostDoc(defrost()),
      defrostDoc(defrost({ freezerNumber: 12, name: 'beef stock', recipeId: 'ragu' })),
    ];
    mockSubsDocs = [fakeDoc('a', makeSub('a'))];

    await run();

    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(payloadOf()).toMatchObject({
      title: 'Defrost 2 things for tomorrow',
      body: 'beef stock, pork loin',
    });
  });

  it('sends nothing when the stored night is the day after tomorrow', async () => {
    mockDefrostDocs = [defrostDoc(defrost({ forDate: '2026-10-16' }))];

    await run();

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('sends nothing when the stored night is tonight (its morning was yesterday)', async () => {
    mockDefrostDocs = [defrostDoc(defrost({ forDate: TODAY }))];

    await run();

    expect(mockSendWebPush).not.toHaveBeenCalled();
  });

  it('sends nothing for an undated pack, stored null or written before #1696', async () => {
    const { forDate: _omitted, ...legacy } = defrost({ freezerNumber: 3 });
    mockDefrostDocs = [
      defrostDoc(defrost({ forDate: null })),
      defrostDoc(defrost({ freezerNumber: 12, recipeId: null, recipeTitle: null, forDate: null })),
      fakeDoc('003_chilli', legacy),
    ];

    await run();

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('a past stored night sends nothing, whatever the planner says', async () => {
    // The re-buzz #1696 exists to stop: an un-ticked pack from three weeks ago,
    // and its recipe planned again for tomorrow. Were the night re-derived from
    // the planner, this item would be due today.
    mockDefrostDocs = [defrostDoc(defrost({ forDate: '2026-09-24' }))];
    mockWeeks = { '2026-10-12': week('2026-10-12', { [TOMORROW]: ['chilli'] }) };

    await run();

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockReads).toEqual(['defrosts']);
  });

  it('skips an invalid defrost doc while the valid one still sends', async () => {
    mockDefrostDocs = [fakeDoc('999_bad', { name: 'no number' }), defrostDoc(defrost())];
    mockSubsDocs = [fakeDoc('a', makeSub('a'))];

    await run();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'remindKitchenTasks: invalid defrost doc, skipping',
      expect.objectContaining({ defrostId: '999_bad' }),
    );
    expect(mockSendWebPush).toHaveBeenCalledTimes(1);
    expect(payloadOf()).toMatchObject({ title: "Defrost the pork loin for tomorrow's chilli" });
  });

  it("prunes a subscription that is gone, reports one that failed, and skips one that won't parse", async () => {
    mockDefrostDocs = [defrostDoc(defrost())];
    const dead = fakeDoc('dead', makeSub('dead'));
    const flaky = fakeDoc('flaky', makeSub('flaky'));
    const junk = fakeDoc('junk', { endpoint: 42 });
    mockSubsDocs = [dead, junk, flaky];
    mockSendWebPush.mockResolvedValueOnce('gone' as const).mockResolvedValueOnce('failed' as const);

    await run();

    expect(mockSendWebPush).toHaveBeenCalledTimes(2);
    expect(dead.ref.delete).toHaveBeenCalledTimes(1);
    expect(flaky.ref.delete).not.toHaveBeenCalled();
    expect(junk.ref.delete).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'remindKitchenTasks: reminded',
      expect.objectContaining({ sent: 0, pruned: 1 }),
    );
  });

  it('sends nothing when VAPID is not provisioned', async () => {
    mockVapidKey = '';
    mockDefrostDocs = [defrostDoc(defrost())];

    await run();

    expect(mockSendWebPush).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith('remindKitchenTasks: VAPID not provisioned', {
      date: TODAY,
    });
  });

  it('never throws out of the scheduled handler, and always flushes', async () => {
    mockDefrostsThrow = true;

    await expect(run()).resolves.toBeUndefined();
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), 'SyncError');
    expect(mockFlush).toHaveBeenCalled();
  });
});

describe('kitchenReminderCopy', () => {
  function task(overrides: Partial<DefrostDoc> = {}): KitchenTask {
    const d = defrost(overrides);
    return {
      kind: 'defrost',
      id: `defrost:${d.freezerNumber}`,
      dueDate: TODAY,
      forDate: TOMORROW,
      defrost: d,
    };
  }

  it('names the item, the meal and where the bag is for a single defrost', () => {
    expect(kitchenReminderCopy([task()])).toEqual({
      title: "Defrost the pork loin for tomorrow's chilli",
      body: 'Garage · shelf B · #0047',
    });
  });

  it('drops the meal from the title when the defrost carries no recipe title', () => {
    expect(kitchenReminderCopy([task({ recipeTitle: null })])).toEqual({
      title: 'Defrost the pork loin for tomorrow',
      body: 'Garage · shelf B · #0047',
    });
  });

  it('refuses a kind it has no words for rather than dropping it silently', () => {
    // Unreachable through the type system — the switch stops compiling first — so
    // the forged kind needs a cast. The handler's catch turns this into a report.
    const forged = { ...task(), kind: 'stock' } as unknown as KitchenTask;
    expect(() => kitchenReminderCopy([forged])).toThrow('no copy for kind stock');
  });

  it('counts several and lists their names', () => {
    expect(
      kitchenReminderCopy([
        task(),
        task({ freezerNumber: 3, name: 'peas' }),
        task({ freezerNumber: 9, name: 'stock' }),
      ]),
    ).toEqual({ title: 'Defrost 3 things for tomorrow', body: 'pork loin, peas, stock' });
  });
});
