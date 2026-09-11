import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkInTimerId } from '@salt/domain';
import type { CookActiveTimerDoc, CookSessionDoc } from '@salt/domain/schemas';

// The watcher is a plain module over a clock, so these tests own the clock
// outright: `setInterval` is faked to drive ticks on demand, and `Date.now` is
// spied SEPARATELY (note `toFake` deliberately excludes Date). Keeping them
// independent is the whole point — it is what lets a test move the wall clock
// WITHOUT running a tick, which is exactly what a frozen page does and the one
// case a fully-faked clock cannot express.
const { mockCookSession, mockKitchenTimers, mockChime, mockToast, mockRouter } = vi.hoisted(() => {
  let value: CookSessionDoc | null = null;
  let kitchen: unknown = null;
  return {
    mockCookSession: {
      subscribe(fn: (v: CookSessionDoc | null) => void) {
        fn(value);
        return () => {};
      },
      _set(v: CookSessionDoc | null) {
        value = v;
      },
    },
    mockKitchenTimers: {
      subscribe(fn: (v: unknown) => void) {
        fn(kitchen);
        return () => {};
      },
      _set(v: unknown) {
        kitchen = v;
      },
    },
    mockChime: { playChime: vi.fn(), primeChime: vi.fn() },
    mockToast: { addToast: vi.fn(), dismissToast: vi.fn() },
    mockRouter: { push: vi.fn() },
  };
});

vi.mock('../src/lib/cookSessionService.js', () => ({ cookSession: mockCookSession }));
vi.mock('../src/lib/kitchenTimerService.js', () => ({ kitchenTimers: mockKitchenTimers }));
vi.mock('../src/lib/chime.js', () => mockChime);
vi.mock('../src/lib/toastStore.js', () => mockToast);
vi.mock('svelte-spa-router', () => mockRouter);

import { initCookTimerAlerts } from '../src/lib/cookTimerAlerts.js';

const RECIPE_ID = 'recipe-1';
const UID = 'user-1';
const COOK_HASH = `#/recipes/${RECIPE_ID}/cook`;
const START = 1_800_000_000_000;

let clock = START;
const iso = (ms: number) => new Date(ms).toISOString();

function makeSession(activeTimers: CookActiveTimerDoc[]): CookSessionDoc {
  return {
    id: `${RECIPE_ID}_${UID}`,
    schemaVersion: 1,
    ownerUid: UID,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtStart: iso(START - 3_600_000),
    checkedIngredientIds: [],
    checkedPrepIds: [],
    completedStepIds: [],
    activeTimers,
    serveAt: null,
    servings: null,
    createdAt: iso(START - 60_000),
    updatedAt: iso(START - 60_000),
  };
}

function makeTimer(overrides: Partial<CookActiveTimerDoc> = {}): CookActiveTimerDoc {
  return {
    id: 'step-2',
    stepId: 'step-2',
    label: null,
    durationMinutes: null,
    endsAt: iso(START + 60_000),
    notify: true,
    ...overrides,
  };
}

/** A timer running with a minute left when the watcher starts. */
function runningTimer(): CookActiveTimerDoc {
  return makeTimer();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  clock = START;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  mockCookSession._set(null);
  mockKitchenTimers._set(null);
  // Somewhere else in the app — the case the watcher exists for.
  window.location.hash = '#/shopping';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('cookTimerAlerts', () => {
  it('chimes and offers a way back when a timer it watched runs out', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();
    expect(mockChime.playChime).not.toHaveBeenCalled();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    expect(mockToast.addToast).toHaveBeenCalledTimes(1);

    // The toast is the only route back from wherever the chef had wandered to.
    const options = mockToast.addToast.mock.calls[0]?.[2] as {
      action: { label: string; onClick: () => void };
    };
    options.action.onClick();
    expect(mockRouter.push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook`);

    stop();
  });

  it('chimes without a toast when the chef is already watching the cook page', () => {
    window.location.hash = COOK_HASH;
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    // The chip on that page flips to "Finished" on its own, so a toast would add
    // nothing and would sit over its Dismiss button.
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    expect(mockToast.addToast).not.toHaveBeenCalled();

    stop();
  });

  it('stays silent for a timer that ran out while the page was frozen', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    // iOS suspends a backgrounded PWA: the wall clock keeps moving but no tick
    // runs, so the watcher resumes to find the timer long finished. No window
    // client was visible, so push-sw.js did not suppress and the chef already got
    // the OS notification.
    clock = START + 180_000;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();
    expect(mockToast.addToast).not.toHaveBeenCalled();

    stop();
  });

  it('stays silent for a timer that had already finished when it started', () => {
    // A fresh app load, or a cook picked up on another device — never seen
    // running here, so never ours to announce.
    mockCookSession._set(makeSession([makeTimer({ endsAt: iso(START - 30_000) })]));
    const stop = initCookTimerAlerts();

    vi.advanceTimersByTime(5_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();

    stop();
  });

  it('alerts once, not on every tick after the timer finishes', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 5; i++) {
      clock = START + 60_400 + i * 1_000;
      vi.advanceTimersByTime(1_000);
    }
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    expect(mockToast.addToast).toHaveBeenCalledTimes(1);

    stop();
  });

  it('treats an adjusted timer as a new one to announce', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);

    // Adjusting rewrites `endsAt`, which is part of the key — so the same timer
    // alerts again when its new end-time lands.
    mockCookSession._set(makeSession([makeTimer({ endsAt: iso(START + 120_000) })]));
    clock = START + 61_000;
    vi.advanceTimersByTime(1_000);
    clock = START + 120_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(2);

    stop();
  });

  it('announces the timer by its own name', () => {
    mockCookSession._set(makeSession([makeTimer({ label: 'Simmer the sauce' })]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockToast.addToast).toHaveBeenCalledWith(
      'Simmer the sauce',
      'default',
      expect.anything(),
    );

    stop();
  });

  // ─── Guided cook and its check-ins (issue #751, Phase 3) ────────────────────

  it('treats the guided cook page as watching the cook too', () => {
    window.location.hash = `${COOK_HASH}/guided`;
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    // Same reason as the plain page: the chip in front of them flips to "Finished".
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    expect(mockToast.addToast).not.toHaveBeenCalled();

    stop();
  });

  it('returns a chef who wandered off mid-guided-cook to the GUIDED page', () => {
    window.location.hash = `${COOK_HASH}/guided`;
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();

    // Observed running while they were on the guided page, then they wandered off.
    vi.advanceTimersByTime(1_000);
    window.location.hash = '#/shopping';
    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    const options = mockToast.addToast.mock.calls[0]?.[2] as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    // Not `/cook`: that would drop them out of the mode they were cooking in.
    expect(mockRouter.push).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}/cook/guided`);

    stop();
  });

  it('says what a check-in says, and says it even on the cook page', () => {
    // A check-in fires by definition while the cook is standing at the hob, and it
    // has no chip to flip — it leaves on its own. Suppressing the toast would mean
    // a chime with nothing to read.
    window.location.hash = `${COOK_HASH}/guided`;
    mockCookSession._set(
      makeSession([
        // The braise itself, still an hour off.
        makeTimer({ endsAt: iso(START + 3_600_000) }),
        makeTimer({
          id: checkInTimerId('step-2', 20),
          label: 'Check the heat',
          durationMinutes: 20,
          endsAt: iso(START + 60_000),
        }),
      ]),
    );
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockToast.addToast).toHaveBeenCalledTimes(1);
    const [message, , options] = mockToast.addToast.mock.calls[0] as [
      string,
      string,
      { action?: unknown },
    ];
    expect(message).toBe('Check the heat');
    // Nothing to acknowledge and nowhere to go — they are already there.
    expect(options.action).toBeUndefined();

    stop();
  });

  it('stops ticking once torn down', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    const stop = initCookTimerAlerts();
    stop();

    clock = START + 60_400;
    vi.advanceTimersByTime(5_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();
  });
});

// A timer with no cook behind it (issue #842). The watcher's second pass, which
// shares the one dedupe map with the first — a timer is alerted once, not once
// per kind.
describe('cookTimerAlerts — standalone kitchen timers (#842)', () => {
  const KITCHEN_HASH = '#/mine';

  function kitchenDoc(timers: Record<string, unknown>[]) {
    return { ownerUid: UID, timers };
  }

  function kitchenTimer(over: Record<string, unknown> = {}) {
    return {
      id: 'k1',
      label: 'Eggs',
      endsAt: iso(START + 60_000),
      durationMinutes: 10,
      notify: true,
      ...over,
    };
  }

  it('chimes and offers the way back to the kitchen when one runs out', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();
    expect(mockChime.playChime).not.toHaveBeenCalled();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    // The timer's own name, as it would read on the lock screen.
    expect(mockToast.addToast).toHaveBeenCalledWith('Eggs', 'default', expect.anything());

    const options = mockToast.addToast.mock.calls[0]?.[2] as {
      action: { label: string; onClick: () => void };
    };
    options.action.onClick();
    expect(mockRouter.push).toHaveBeenCalledWith('/mine');

    stop();
  });

  // The card flips to "Finished" in front of them — the same visible
  // acknowledgement that earns a cook timer its suppression on the cook page.
  it('chimes without a toast when the chef is already looking at My Kitchen', () => {
    window.location.hash = KITCHEN_HASH;
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    expect(mockToast.addToast).not.toHaveBeenCalled();
    stop();
  });

  it('alerts once, however many ticks pass', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(1);
    stop();
  });

  // Never seen running: it finished before the watcher was here, or was started
  // on another device, so it was never ours to announce.
  it('stays silent for one that had already fired when it started watching', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer({ endsAt: iso(START - 60_000) })]));
    const stop = initCookTimerAlerts();

    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();
    stop();
  });

  // A page frozen across the end-time already got the OS notification; alerting
  // on return would be the second alert for a timer they have been told about.
  it('stays silent when the page was frozen across the end-time', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 120_000;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();
    stop();
  });

  // Re-timing changes `endsAt`, which makes it a new timer to be alerted for.
  it('alerts again for a timer that was re-timed after it fired', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);
    expect(mockChime.playChime).toHaveBeenCalledTimes(1);

    mockKitchenTimers._set(kitchenDoc([kitchenTimer({ endsAt: iso(START + 120_000) })]));
    clock = START + 90_000;
    vi.advanceTimersByTime(1_000);
    clock = START + 120_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does nothing at all for a member who has never started one', () => {
    mockKitchenTimers._set(null);
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).not.toHaveBeenCalled();
    stop();
  });

  // Both kinds ticking at once, neither swallowing the other.
  it('alerts a cook timer and a standalone one that finish together', () => {
    mockCookSession._set(makeSession([runningTimer()]));
    mockKitchenTimers._set(kitchenDoc([kitchenTimer()]));
    const stop = initCookTimerAlerts();

    clock = START + 60_400;
    vi.advanceTimersByTime(1_000);

    expect(mockChime.playChime).toHaveBeenCalledTimes(2);
    expect(mockToast.addToast).toHaveBeenCalledTimes(2);
    stop();
  });
});
