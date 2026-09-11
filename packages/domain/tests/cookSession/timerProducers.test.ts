import { describe, it, expect } from 'vitest';
import {
  withTimerStarted,
  withTimerDismissed,
  checkInTimerId,
  isCheckInTimerId,
  isCheckInOf,
} from '@salt/domain';
import type { CookActiveTimerDoc, CookSessionDoc } from '@salt/domain/schemas';

// Step timers (issue #556, widened in #748). `endsAt` is an ABSOLUTE end-time
// supplied by the caller — the module never computes it from a clock — which is
// what lets a reload reconstruct the remaining time. The whole entry comes from
// the caller, and `id` is its identity: one live timer per id (and since a step
// timer's id IS its step id, that still means one live timer per step).

function timer(id: string, endsAt: string, overrides: Partial<CookActiveTimerDoc> = {}) {
  return {
    id,
    stepId: id,
    label: null,
    durationMinutes: null,
    endsAt,
    notify: false,
    ...overrides,
  } satisfies CookActiveTimerDoc;
}

function session(activeTimers: CookActiveTimerDoc[]): CookSessionDoc {
  return {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    serveAt: null,
    servings: null,
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    checkedIngredientIds: ['i1'],
    checkedPrepIds: [],
    completedStepIds: ['s1'],
    activeTimers,
    createdAt: '2026-07-22T18:30:00.000Z',
    updatedAt: '2026-07-22T18:30:00.000Z',
  };
}

const T1 = '2026-07-22T18:35:00.000Z';
const T2 = '2026-07-22T18:40:00.000Z';
const T3 = '2026-07-22T19:10:00.000Z';

describe('withTimerStarted', () => {
  it('adds a timer to an empty session', () => {
    expect(withTimerStarted(session([]), timer('s1', T1)).activeTimers).toEqual([timer('s1', T1)]);
  });

  it('carries the whole entry through verbatim', () => {
    const entry = timer('s7', T3, {
      notify: true,
      label: 'Simmer the sauce',
      durationMinutes: 25,
    });
    const [written] = withTimerStarted(session([]), entry).activeTimers;
    expect(written).toEqual(entry);
  });

  it('carries an ad-hoc timer — minted id, no step — through untouched', () => {
    const adHoc = timer('adhoc-1', T2, { stepId: null, label: 'Rice', durationMinutes: 12 });
    expect(withTimerStarted(session([]), adHoc).activeTimers).toEqual([adHoc]);
  });

  it('keeps timers running under other ids', () => {
    const next = withTimerStarted(session([timer('s1', T1)]), timer('s2', T2, { notify: true }));
    expect(next.activeTimers).toEqual([timer('s1', T1), timer('s2', T2, { notify: true })]);
  });

  it('REPLACES an existing timer with the same id — one live timer per id', () => {
    const restarted = timer('s1', T2, { notify: true, durationMinutes: 9 });
    const next = withTimerStarted(session([timer('s1', T1)]), restarted);
    expect(next.activeTimers).toEqual([restarted]);
  });

  it('moves a restarted timer to the end of the list', () => {
    // The timers bar reads in list order, so the freshly started one lands last.
    const next = withTimerStarted(session([timer('s1', T1), timer('s2', T2)]), timer('s1', T3));
    expect(next.activeTimers.map((t) => t.id)).toEqual(['s2', 's1']);
  });

  it('is pure — never mutates the input session', () => {
    const s = session([timer('s1', T1)]);
    withTimerStarted(s, timer('s2', T2));
    withTimerStarted(s, timer('s1', T3, { notify: true }));
    expect(s.activeTimers).toEqual([timer('s1', T1)]);
  });

  it('does not stamp updatedAt or disturb tick / step state', () => {
    const s = session([]);
    const next = withTimerStarted(s, timer('s1', T1));
    expect(next.updatedAt).toBe(s.updatedAt);
    expect(next.checkedIngredientIds).toEqual(s.checkedIngredientIds);
    expect(next.completedStepIds).toEqual(s.completedStepIds);
  });
});

describe('withTimerDismissed', () => {
  it('removes the timer with the given id', () => {
    expect(withTimerDismissed(session([timer('s1', T1)]), 's1').activeTimers).toEqual([]);
  });

  it('removes an ad-hoc timer by its minted id', () => {
    const adHoc = timer('adhoc-1', T2, { stepId: null });
    const next = withTimerDismissed(session([timer('s1', T1), adHoc]), 'adhoc-1');
    expect(next.activeTimers).toEqual([timer('s1', T1)]);
  });

  it('leaves every other timer running', () => {
    const next = withTimerDismissed(session([timer('s1', T1), timer('s2', T2)]), 's1');
    expect(next.activeTimers).toEqual([timer('s2', T2)]);
  });

  it('is idempotent — dismissing an unknown id changes nothing', () => {
    const next = withTimerDismissed(session([timer('s1', T1)]), 's9');
    expect(next.activeTimers).toEqual([timer('s1', T1)]);
  });

  it('handles a session with no timers at all', () => {
    expect(withTimerDismissed(session([]), 's1').activeTimers).toEqual([]);
  });

  it('is pure — never mutates the input session', () => {
    const s = session([timer('s1', T1)]);
    withTimerDismissed(s, 's1');
    expect(s.activeTimers).toHaveLength(1);
  });

  it('does not stamp updatedAt', () => {
    const s = session([timer('s1', T1)]);
    expect(withTimerDismissed(s, 's1').updatedAt).toBe(s.updatedAt);
  });
});

// ─── Guided check-ins (issue #751, Phase 3) ──────────────────────────────────
//
// A check-in is an ORDINARY entry with a DERIVED id, so the existing enqueue
// trigger carries it with no server change. Everything below is about the two
// things that derivation buys: telling a check-in from the timer it hangs off,
// and knowing which set of them survives a duration the cook changed.

// Minutes past the base T1 (18:35), which is where the fixture's timers start.
const at = (minutes: number) => new Date(Date.parse(T1) + minutes * 60_000).toISOString();

function checkIn(mainId: string, atMinutes: number): CookActiveTimerDoc {
  return timer(checkInTimerId(mainId, atMinutes), at(atMinutes), {
    stepId: mainId,
    label: `Check at ${atMinutes}`,
    durationMinutes: atMinutes,
    notify: true,
  });
}

describe('checkInTimerId', () => {
  it('derives an id from the timer and how far into it the reminder sits', () => {
    expect(checkInTimerId('step-2', 20)).not.toBe(checkInTimerId('step-2', 120));
    expect(checkInTimerId('step-2', 20)).not.toBe(checkInTimerId('step-3', 20));
    // Stable: the same reminder on the same timer derives the same id every time,
    // which is what lets a re-time recognise the ones already armed.
    expect(checkInTimerId('step-2', 20)).toBe(checkInTimerId('step-2', 20));
  });

  it('tells a check-in from a timer the cook started', () => {
    expect(isCheckInTimerId(checkInTimerId('step-2', 20))).toBe(true);
    expect(isCheckInTimerId('step-2')).toBe(false);
    expect(isCheckInTimerId(crypto.randomUUID())).toBe(false);
  });

  it('tells WHOSE check-in it is', () => {
    expect(isCheckInOf(checkInTimerId('step-2', 20), 'step-2')).toBe(true);
    expect(isCheckInOf(checkInTimerId('step-2', 20), 'step-3')).toBe(false);
    // A timer is not its own check-in, and neither is a check-in of another's.
    expect(isCheckInOf('step-2', 'step-2')).toBe(false);
  });
});

describe('withTimerStarted — arming check-ins', () => {
  it('arms the supplied check-ins behind the timer that owns them', () => {
    const main = timer('s1', at(60), { durationMinutes: 60 });
    const next = withTimerStarted(session([]), main, [checkIn('s1', 20), checkIn('s1', 40)]);
    expect(next.activeTimers).toEqual([main, checkIn('s1', 20), checkIn('s1', 40)]);
  });

  it('arms none when the caller offers none — plain cook mode never has a plan', () => {
    const main = timer('s1', at(60));
    expect(withTimerStarted(session([]), main).activeTimers).toEqual([main]);
  });

  it('refuses a reminder the started duration does not contain', () => {
    // The plan says "check at 40 minutes"; the cook started the timer for ten.
    const main = timer('s1', at(10), { durationMinutes: 10 });
    const next = withTimerStarted(session([]), main, [checkIn('s1', 5), checkIn('s1', 40)]);
    expect(next.activeTimers).toEqual([main, checkIn('s1', 5)]);
  });

  it('drops a duplicate id rather than key two entries the same', () => {
    const main = timer('s1', at(60));
    const next = withTimerStarted(session([]), main, [checkIn('s1', 20), checkIn('s1', 20)]);
    expect(next.activeTimers).toHaveLength(2);
  });

  it('RESTARTING a timer restarts its reminders, dropping the previous run-s', () => {
    const before = session([timer('s1', at(60)), checkIn('s1', 20)]);
    // Dismissed first, so this is a fresh start rather than a re-time.
    const cleared = withTimerDismissed(before, 's1');
    const main = timer('s1', at(90), { durationMinutes: 90 });
    const next = withTimerStarted(cleared, main, [checkIn('s1', 30)]);
    expect(next.activeTimers).toEqual([main, checkIn('s1', 30)]);
  });

  it('leaves another timer-s check-ins alone', () => {
    const before = session([timer('s2', at(50)), checkIn('s2', 10)]);
    const main = timer('s1', at(60));
    const next = withTimerStarted(before, main, [checkIn('s1', 20)]);
    expect(next.activeTimers).toEqual([
      timer('s2', at(50)),
      checkIn('s2', 10),
      main,
      checkIn('s1', 20),
    ]);
  });

  it('is pure — never mutates the input session', () => {
    const s = session([timer('s1', at(60)), checkIn('s1', 20)]);
    withTimerStarted(s, timer('s1', at(30), { durationMinutes: 30 }));
    expect(s.activeTimers).toEqual([timer('s1', at(60)), checkIn('s1', 20)]);
  });
});

describe('withTimerStarted — re-timing a running timer', () => {
  // The reminders are anchored to the ORIGINAL start, so extending the wait must
  // not push them out and shortening it must drop only the ones the wait no
  // longer contains.
  const running = () =>
    session([
      timer('s1', at(180), { durationMinutes: 180 }),
      checkIn('s1', 20),
      checkIn('s1', 120),
    ]);

  it('EXTENDING moves nothing — every reminder stays exactly where it was', () => {
    const next = withTimerStarted(running(), timer('s1', at(300), { durationMinutes: 300 }));
    expect(next.activeTimers).toEqual([
      timer('s1', at(300), { durationMinutes: 300 }),
      checkIn('s1', 20),
      checkIn('s1', 120),
    ]);
  });

  it('SHORTENING drops only the reminders the wait no longer reaches', () => {
    const next = withTimerStarted(running(), timer('s1', at(90), { durationMinutes: 90 }));
    expect(next.activeTimers).toEqual([
      timer('s1', at(90), { durationMinutes: 90 }),
      checkIn('s1', 20),
    ]);
  });

  it('never RE-ANCHORS: check-ins offered to a running timer are ignored', () => {
    // The page always offers the plan's reminders; on a re-time they must not
    // replace the ones already counting down from the original start.
    const reAnchored = timer(checkInTimerId('s1', 20), at(200), {
      stepId: 's1',
      label: 'Check at 20',
      durationMinutes: 20,
      notify: true,
    });
    const next = withTimerStarted(running(), timer('s1', at(300), { durationMinutes: 300 }), [
      reAnchored,
    ]);
    expect(next.activeTimers).toContainEqual(checkIn('s1', 20));
    expect(next.activeTimers).not.toContainEqual(reAnchored);
  });

  it('drops a reminder that has been overtaken exactly, never one still ahead', () => {
    // Shortened to land ON the 120-minute reminder: it no longer PRECEDES the end,
    // so it goes — the main timer says the same thing at the same moment.
    const next = withTimerStarted(running(), timer('s1', at(120), { durationMinutes: 120 }));
    expect(next.activeTimers.map((t) => t.id)).toEqual(['s1', checkInTimerId('s1', 20)]);
  });
});

describe('withTimerDismissed — and its check-ins', () => {
  it('takes the timer-s reminders down with it', () => {
    const s = session([timer('s1', at(180)), checkIn('s1', 20), checkIn('s1', 120)]);
    expect(withTimerDismissed(s, 's1').activeTimers).toEqual([]);
  });

  it('leaves another timer-s reminders running', () => {
    const s = session([
      timer('s1', at(180)),
      checkIn('s1', 20),
      timer('s2', at(50)),
      checkIn('s2', 10),
    ]);
    expect(withTimerDismissed(s, 's1').activeTimers).toEqual([
      timer('s2', at(50)),
      checkIn('s2', 10),
    ]);
  });

  it('calls off ONE reminder when the reminder itself is dismissed', () => {
    const s = session([timer('s1', at(180)), checkIn('s1', 20), checkIn('s1', 120)]);
    const next = withTimerDismissed(s, checkInTimerId('s1', 20));
    expect(next.activeTimers).toEqual([timer('s1', at(180)), checkIn('s1', 120)]);
  });
});
