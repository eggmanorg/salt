import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  checkInTimerId,
  emptyWeek,
  setDayChefs,
  setDayNote,
  setDayRecipes,
  type Recipe,
} from '@salt/domain';
import type { CookActiveTimerDoc, CookSessionDoc } from '@salt/domain/schemas';

// The personal view's composition layer (issues #634, #682). Everything it reads
// is a store that is already subscribed app-wide, so these tests drive fake stores
// and assert the projection: my timers, my open cooks, and what still wants a look.

const {
  mockRecipes,
  mockSessions,
  mockChats,
  mockKitchenWeeks,
  mockToday,
  mockMember,
  mockKitchenTimers,
  mockRecipesById,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  const recipes = makeStore<unknown[]>([]);
  return {
    mockRecipes: recipes,
    // The id index the service resolves attached recipes through (#940). Derived
    // from the SAME store, so it stays in step with every `mockRecipes._set`
    // rather than being a second thing each test has to remember to seed.
    mockRecipesById: {
      subscribe(fn: (v: ReadonlyMap<string, unknown>) => void) {
        return recipes.subscribe((list) =>
          fn(new Map((list as { id: string }[]).map((r) => [r.id, r]))),
        );
      },
    },
    mockSessions: makeStore<unknown[]>([]),
    mockChats: makeStore<unknown[]>([]),
    mockKitchenWeeks: makeStore<unknown[]>([]),
    mockToday: makeStore<string>(''),
    mockMember: makeStore<unknown>(null),
    mockKitchenTimers: makeStore<unknown>(null),
  };
});

// `recipesById` is derived from the same store the mock already serves, so the
// index the service now resolves through stays in step with `mockRecipes._set`
// (issue #1055 Phase 4). Both are exported because the service still wants the
// ARRAY for its single-session lookups and the INDEX for list resolution.
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  recipesById: mockRecipesById,
}));
vi.mock('../src/lib/kitchenTimerService.js', () => ({ kitchenTimers: mockKitchenTimers }));
vi.mock('../src/lib/cookSessionService.js', () => ({ myCookSessions: mockSessions }));
vi.mock('../src/lib/chatService.js', () => ({ sessions: mockChats }));
vi.mock('../src/lib/mealPlanService.js', () => ({
  kitchenWeeks: mockKitchenWeeks,
  kitchenAnchorDate: mockToday,
}));
vi.mock('../src/lib/membersService.js', () => ({ currentMember: mockMember }));

import {
  firedTimers,
  liveCooks,
  mineOpenCount,
  myTimers,
  needsReviewRecipes,
  recentChats,
  timerNowMs,
  tonight,
  upcomingChefNights,
} from '../src/lib/personalViewService.js';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');

function recipe(id: string, title: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    componentRecipeIds: [],
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 2,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    image: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function withSteps(id: string, title: string, count: number, overrides: Partial<Recipe> = {}) {
  return recipe(id, title, {
    steps: Array.from({ length: count }, (_u, i) => ({
      id: `${id}-s${i}`,
      text: `step ${i}`,
      timer: null,
      note: null,
    })),
    ...overrides,
  } as Partial<Recipe>);
}

function session(
  recipeId: string,
  completedStepIds: string[] = [],
  activeTimers: CookActiveTimerDoc[] = [],
): CookSessionDoc {
  return {
    id: `${recipeId}_uid-a`,
    schemaVersion: 1,
    ownerUid: 'uid-a',
    recipeId,
    recipeUpdatedAtAtStart: '2026-07-01T00:00:00.000Z',
    checkedIngredientIds: [],
    checkedPrepIds: [],
    completedStepIds,
    activeTimers,
    serveAt: null,
    servings: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const timer = (
  stepId: string,
  offsetMs: number,
  overrides: Partial<CookActiveTimerDoc> = {},
): CookActiveTimerDoc => ({
  id: stepId,
  stepId,
  label: null,
  durationMinutes: null,
  endsAt: new Date(NOW + offsetMs).toISOString(),
  notify: false,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockRecipes._set([]);
  mockSessions._set([]);
  mockChats._set([]);
  mockKitchenWeeks._set([]);
  mockToday._set('');
  mockMember._set(null);
  mockKitchenTimers._set(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liveCooks', () => {
  it('resumes a session at the first step not yet done', () => {
    mockRecipes._set([withSteps('r1', 'Noodle Bowl', 5)]);
    mockSessions._set([session('r1', ['r1-s0', 'r1-s1'])]);

    expect(get(liveCooks)[0]).toMatchObject({
      stepNumber: 3,
      stepCount: 5,
      completedCount: 2,
    });
    expect(get(liveCooks)[0]?.recipe.title).toBe('Noodle Bowl');
  });

  it('carries EVERY open cook, newest first — a two-pan dinner is two cooks', () => {
    mockRecipes._set([withSteps('r1', 'Noodle Bowl', 5), withSteps('r2', 'Side Salad', 2)]);
    // The adapter query orders newest-first; the projection preserves that order.
    mockSessions._set([session('r2'), session('r1', ['r1-s0'])]);

    expect(get(liveCooks).map((c) => c.recipe.title)).toEqual(['Side Salad', 'Noodle Bowl']);
  });

  it('ignores step ids that are no longer in the recipe', () => {
    // A step edited out from under the cook must not inflate progress.
    mockRecipes._set([withSteps('r1', 'Noodle Bowl', 2)]);
    mockSessions._set([session('r1', ['r1-s0', 'gone-1', 'gone-2'])]);
    expect(get(liveCooks)[0]?.completedCount).toBe(1);
  });

  it('skips a session whose recipe was deleted rather than showing a broken card', () => {
    mockRecipes._set([withSteps('r2', 'Still here', 2)]);
    mockSessions._set([session('deleted'), session('r2')]);
    expect(get(liveCooks).map((c) => c.recipe.id)).toEqual(['r2']);
  });

  it('is empty with no sessions — another member does not see my cook', () => {
    expect(get(liveCooks)).toEqual([]);
  });
});

describe('myTimers', () => {
  function timedRecipe(id: string, title: string) {
    return recipe(id, title, {
      steps: [
        {
          id: `${id}-s0`,
          text: 'simmer',
          timer: { durationMinutes: 10, description: 'Simmer the sauce' },
          note: null,
        },
        { id: `${id}-s1`, text: 'rest', timer: { durationMinutes: 5 }, note: null },
      ],
    } as Partial<Recipe>);
  }

  it('lists a running timer with its label, recipe and duration', () => {
    mockRecipes._set([timedRecipe('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s0', 4 * 60_000)])]);

    expect(get(myTimers)).toMatchObject([
      { id: 'r1_uid-a::r1-s0', label: 'Simmer the sauce', durationMs: 600_000 },
    ]);
    // `recipe` lives on the cook arm of the union only (#842), so the assertion
    // has to name the kind — which is itself worth pinning here.
    const [first] = get(myTimers);
    expect(first?.kind === 'cook' ? first.recipe.title : null).toBe('Ragu');
  });

  it('lists a fired-but-undismissed timer alongside the running ones (#682)', () => {
    // The gap this phase closes: an expired timer stays in `activeTimers` until it
    // is dismissed, and "fired" is derived from the clock, not from a field.
    mockRecipes._set([timedRecipe('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s0', -30_000), timer('r1-s1', 60_000)])]);

    expect(get(myTimers)).toHaveLength(2);
    expect(get(firedTimers).map((t) => t.timer.id)).toEqual(['r1-s0']);
  });

  it('sorts soonest-ending first, so anything already fired floats to the top', () => {
    mockRecipes._set([timedRecipe('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s1', 60_000), timer('r1-s0', -30_000)])]);
    expect(get(myTimers).map((t) => t.timer.id)).toEqual(['r1-s0', 'r1-s1']);
  });

  it('falls back to "Step N" without a label, and "Timer" once the step is gone', () => {
    mockRecipes._set([timedRecipe('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s1', 60_000), timer('deleted', 90_000)])]);

    expect(get(myTimers).map((t) => t.label)).toEqual(['Step 2', 'Timer']);
    // No step means no duration to scale a progress fill against.
    expect(get(myTimers)[1]?.durationMs).toBeNull();
  });

  it('skips timers on a session whose recipe was deleted', () => {
    mockSessions._set([session('gone', [], [timer('s0', 60_000)])]);
    expect(get(myTimers)).toEqual([]);
  });

  it('skips a guided check-in — a nudge is not something that wants a hand (#751)', () => {
    // Check-ins ride `activeTimers` as ordinary entries, but this page answers
    // "what of mine wants a hand?" and a check-in never does: nothing to confirm,
    // nothing to dismiss. Listing them would put a Dismiss button on a nudge.
    mockRecipes._set([timedRecipe('r1', 'Ragu')]);
    mockSessions._set([
      session(
        'r1',
        [],
        [
          timer('r1-s0', 60_000),
          timer(checkInTimerId('r1-s0', 5), -30_000, {
            stepId: 'r1-s0',
            label: 'Give it a stir',
          }),
        ],
      ),
    ]);

    expect(get(myTimers).map((t) => t.timer.id)).toEqual(['r1-s0']);
    // And a FIRED one must not inflate the badge with something nobody has to act
    // on — it is the one that would, since `firedTimers` feeds the count.
    expect(get(firedTimers)).toEqual([]);
    expect(get(mineOpenCount)).toBe(1); // the open cook, and nothing else
  });
});

// A timer that belongs to nobody's cook (issue #842). It rides the SAME list as
// the cook timers, because everything downstream — the sort, the fired filter,
// the nav badge — has to treat the two kinds identically, and one list is the
// only way to guarantee that.
describe('myTimers — standalone kitchen timers (#842)', () => {
  const kitchenTimer = (id: string, offsetMs: number, over: Record<string, unknown> = {}) => ({
    id,
    label: 'Eggs',
    endsAt: new Date(NOW + offsetMs).toISOString(),
    durationMinutes: 10,
    notify: true,
    ...over,
  });
  const kitchenDoc = (timers: unknown[]) => ({ ownerUid: 'uid-a', timers });

  it('lists one with its own name and duration, and no recipe', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer('k1', 4 * 60_000)]));
    const [t] = get(myTimers);
    expect(t).toMatchObject({ kind: 'kitchen', label: 'Eggs', durationMs: 600_000 });
    expect(t).not.toHaveProperty('recipe');
    expect(t).not.toHaveProperty('session');
  });

  it('needs no cook and no recipe to appear at all', () => {
    mockRecipes._set([]);
    mockSessions._set([]);
    mockKitchenTimers._set(kitchenDoc([kitchenTimer('k1', 60_000)]));
    expect(get(myTimers)).toHaveLength(1);
  });

  it('is absent when the member has never started one', () => {
    mockKitchenTimers._set(null);
    expect(get(myTimers)).toEqual([]);
  });

  // Not marked out as a different species: one sort, on `endsAt` alone.
  it('interleaves with cook timers, soonest-ending first', () => {
    mockRecipes._set([timedRecipeFor('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s0', 5 * 60_000)])]);
    mockKitchenTimers._set(
      kitchenDoc([kitchenTimer('k1', 9 * 60_000), kitchenTimer('k2', 60_000)]),
    );
    expect(get(myTimers).map((t) => t.timer.id)).toEqual(['k2', 'r1-s0', 'k1']);
  });

  it('gives a standalone timer a row key that cannot collide with a cook timer', () => {
    mockRecipes._set([timedRecipeFor('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('r1-s0', 60_000)])]);
    mockKitchenTimers._set(kitchenDoc([kitchenTimer('r1-s0', 120_000)]));
    const ids = get(myTimers).map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('kitchen::r1-s0');
  });

  it('counts a fired one toward the badge, exactly as a fired cook timer does', () => {
    mockKitchenTimers._set(kitchenDoc([kitchenTimer('k1', -30_000), kitchenTimer('k2', 60_000)]));
    expect(get(firedTimers).map((t) => t.timer.id)).toEqual(['k1']);
    expect(get(mineOpenCount)).toBe(1);
  });

  // Without this the countdown on a kitchen with no cook in it would sit still —
  // a worse failure than showing no countdown at all.
  it('arms the one-second clock on its own, with no cook anywhere', () => {
    const seen: number[] = [];
    const unsub = timerNowMs.subscribe((v) => seen.push(v));
    const before = seen.length;
    vi.advanceTimersByTime(3000);
    expect(seen.length).toBe(before);

    mockKitchenTimers._set(kitchenDoc([kitchenTimer('k1', 60_000)]));
    const armed = seen.length;
    vi.advanceTimersByTime(3000);
    expect(seen.length).toBeGreaterThan(armed);
    unsub();
  });
});

// Shared with the standalone-timer block above; the original lives inside the
// `myTimers` describe, which cannot reach across.
function timedRecipeFor(id: string, title: string) {
  return recipe(id, title, {
    steps: [
      {
        id: `${id}-s0`,
        text: 'simmer',
        timer: { durationMinutes: 10, description: 'Simmer the sauce' },
        note: null,
      },
    ],
  } as Partial<Recipe>);
}

describe('timerNowMs', () => {
  it('does not tick while nothing is running, and ticks every second once one is', () => {
    // The badge subscribes this from every page, so an interval that ran for ever
    // to serve a badge reading zero would be pure waste.
    const seen: number[] = [];
    const unsub = timerNowMs.subscribe((v) => seen.push(v));
    seen.length = 0;

    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]);

    mockRecipes._set([recipe('r1', 'Ragu')]);
    mockSessions._set([session('r1', [], [timer('s0', 60_000)])]);
    seen.length = 0;
    const from = Date.now();

    vi.advanceTimersByTime(3_000);
    expect(seen).toEqual([from + 1_000, from + 2_000, from + 3_000]);

    // Dismissing the last timer disarms it again.
    mockSessions._set([session('r1')]);
    seen.length = 0;
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]);

    unsub();
  });
});

// ─── Attached-recipe id resolution (issue #1055) ─────────────────────────────
// `upcomingChefNights` and `tonight` each resolve `day.recipeIds` against the
// recipes store with the same expression, copied verbatim. Those two copies are
// about to be unified onto one helper, and nothing in the repo currently asserts
// what the expression guarantees — dropping its `.filter(...)` fails no test and
// shows up only as a type error. This characterisation table is what makes the
// unification legal: it runs at BOTH sites, so the surviving helper has to keep
// every property both callers already depend on.
//
// Order is the row that matters most on screen: the night lists what you attached,
// in the order you attached it, however the store happens to be sorted. Skipping
// is what keeps a recipe deleted since it was planned from rendering as a blank
// row. Duplication is deliberate — two portions of the same thing is a real plan.
const recipeIdResolutionCases = [
  {
    name: 'output order follows recipeIds, not the order of the recipes store',
    store: ['r2', 'r1'],
    attached: ['r1', 'r2'],
    expected: ['r1', 'r2'],
  },
  {
    name: 'an id deleted since it was attached is skipped, never a blank entry',
    store: ['r1', 'r2'],
    attached: ['r1', 'gone', 'r2'],
    expected: ['r1', 'r2'],
  },
  {
    name: 'a duplicated id still yields two entries',
    store: ['r1'],
    attached: ['r1', 'r1'],
    expected: ['r1', 'r1'],
  },
] as const;

/** The store contents a row asks for, in the row's own (deliberate) order. */
const storeOf = (ids: readonly string[]) => ids.map((id) => recipe(id, `Recipe ${id}`));

// "Cooking soon" (#755). The window and the span are the domain helper's; what is
// asserted here is the RESOLUTION — the member id, the entries that name the meal,
// and the distance from the same today the weeks were subscribed for.
describe('upcomingChefNights', () => {
  const ALEX = { id: 'alex@e.org', name: 'Alex Green' };
  const MONDAY = '2026-08-03';
  const NEXT_MONDAY = '2026-08-10';

  function week(start: string, dates: string[]) {
    return dates.reduce((w, d) => setDayChefs(w, d, [ALEX.id]), emptyWeek(start));
  }

  it('is my nights, soonest first, with how far off each one is', () => {
    mockMember._set(ALEX);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([week(MONDAY, ['2026-08-04', '2026-08-05', '2026-08-08'])]);

    expect(get(upcomingChefNights).map((n) => [n.date, n.daysAway])).toEqual([
      ['2026-08-05', 0],
      ['2026-08-08', 3],
    ]);
  });

  it('spans the week boundary, so the last days of a cycle still show what is next', () => {
    mockMember._set(ALEX);
    mockToday._set('2026-08-07');
    mockKitchenWeeks._set([week(MONDAY, ['2026-08-08']), week(NEXT_MONDAY, ['2026-08-11'])]);

    expect(get(upcomingChefNights).map((n) => n.date)).toEqual(['2026-08-08', '2026-08-11']);
  });

  it('resolves attached entries live from the recipes store', () => {
    mockRecipes._set([recipe('r1', 'Ragu'), recipe('r2', 'Focaccia')]);
    mockMember._set(ALEX);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([
      setDayRecipes(week(MONDAY, ['2026-08-06']), '2026-08-06', ['r1', 'r2']),
    ]);

    expect(get(upcomingChefNights)[0]?.recipes.map((r) => r.title)).toEqual(['Ragu', 'Focaccia']);
  });

  it('drops an entry that has since been deleted rather than carrying a dead title', () => {
    mockRecipes._set([recipe('r1', 'Ragu')]);
    mockMember._set(ALEX);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([
      setDayRecipes(week(MONDAY, ['2026-08-06']), '2026-08-06', ['r1', 'gone']),
    ]);

    expect(get(upcomingChefNights)[0]?.recipes.map((r) => r.id)).toEqual(['r1']);
  });

  // Site 1 of the shared table above.
  it.each(recipeIdResolutionCases)(
    'resolves attached ids: $name',
    ({ store, attached, expected }) => {
      mockRecipes._set(storeOf(store));
      mockMember._set(ALEX);
      mockToday._set('2026-08-05');
      mockKitchenWeeks._set([setDayRecipes(week(MONDAY, ['2026-08-06']), '2026-08-06', attached)]);

      expect(get(upcomingChefNights)[0]?.recipes).toEqual(
        expected.map((id) => expect.objectContaining({ id })),
      );
    },
  );

  it('carries the day itself, so a note-only night can still say what it is', () => {
    mockMember._set(ALEX);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([setDayNote(week(MONDAY, ['2026-08-06']), '2026-08-06', 'leeks')]);

    expect(get(upcomingChefNights)[0]?.day.note).toBe('leeks');
    expect(get(upcomingChefNights)[0]?.recipes).toEqual([]);
  });

  it('is empty when the sign-in matches nobody on the roster', () => {
    // Better to show no section than to claim every night in the house is yours.
    mockMember._set(null);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([week(MONDAY, ['2026-08-06', '2026-08-07'])]);

    expect(get(upcomingChefNights)).toEqual([]);
  });

  it('is empty before the page has opened any week', () => {
    mockMember._set(ALEX);
    expect(get(upcomingChefNights)).toEqual([]);
  });

  it('stays out of the nav badge — a night you are cooking is not a summons', () => {
    mockMember._set(ALEX);
    mockToday._set('2026-08-05');
    mockKitchenWeeks._set([week(MONDAY, ['2026-08-06'])]);

    expect(get(upcomingChefNights)).toHaveLength(1);
    expect(get(mineOpenCount)).toBe(0);
  });
});

describe('tonight', () => {
  const MONDAY = '2026-08-03';
  const TODAY = '2026-08-05';

  // Site 2 of the shared table above: the same three properties, asserted through
  // the other copy of the expression, so unifying them cannot quietly change one.
  it.each(recipeIdResolutionCases)(
    'resolves attached ids: $name',
    ({ store, attached, expected }) => {
      mockRecipes._set(storeOf(store));
      mockToday._set(TODAY);
      mockKitchenWeeks._set([setDayRecipes(emptyWeek(MONDAY), TODAY, attached)]);

      expect(get(tonight)?.recipes).toEqual(expected.map((id) => expect.objectContaining({ id })));
    },
  );
});

describe('needsReviewRecipes', () => {
  const unreviewed = (id: string, title: string, overrides: Partial<Recipe> = {}) =>
    recipe(id, title, { needs_approval: true, ...overrides } as Partial<Recipe>);

  it('lists what carries the flag, newest first, with no time limit', () => {
    mockRecipes._set([
      unreviewed('old', 'Ancient import', { createdAt: '2025-01-01T00:00:00.000Z' }),
      unreviewed('new', 'Yesterday', { createdAt: '2026-08-04T00:00:00.000Z' }),
    ]);

    expect(get(needsReviewRecipes).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('leaves out everything the flag is not set on (issue #755)', () => {
    // The queue is the stored flag now, not "updatedAt === createdAt". A recipe
    // typed in by hand and never touched again has been read by the person who
    // typed it — it was never a review item, and used to be one.
    mockRecipes._set([
      unreviewed('flagged', 'URL import'),
      recipe('handwritten', 'Never edited'),
      recipe('cleared', 'Already reviewed', { needs_approval: false } as Partial<Recipe>),
    ]);
    expect(get(needsReviewRecipes).map((r) => r.id)).toEqual(['flagged']);
  });

  it('does not gate on kind — a flagged entry of any kind is in the queue', () => {
    // The isCookable gate went with the derived predicate: only the import flows
    // set the flag, so there is nothing to keep out.
    mockRecipes._set([
      unreviewed('c1', 'Negroni', { kind: 'cocktail' } as Partial<Recipe>),
      recipe('p1', 'Generic Comfort', { kind: 'placeholder' } as Partial<Recipe>),
      recipe('o1', 'Takeaway', { kind: 'outing' } as Partial<Recipe>),
    ]);
    expect(get(needsReviewRecipes).map((r) => r.id)).toEqual(['c1']);
  });
});

describe('recentChats', () => {
  function chat(id: string, title: string, updatedAt: string, recipeId: string | null = null) {
    return {
      id,
      schemaVersion: 1,
      ownerUid: 'uid-a',
      recipeId,
      title,
      messages: [],
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt,
      expiresAt: '2026-08-19T00:00:00.000Z',
    };
  }

  it('is newest-touched first, matching the chat list itself', () => {
    mockChats._set([
      chat('mid', 'Braising', '2026-08-03T00:00:00.000Z'),
      chat('newest', 'Sourdough', '2026-08-05T00:00:00.000Z'),
      chat('oldest', 'Stock', '2026-07-20T00:00:00.000Z'),
    ]);
    expect(get(recentChats).map((c) => c.id)).toEqual(['newest', 'mid', 'oldest']);
  });

  it('caps at five — a shortcut, not a second chat list', () => {
    mockChats._set(
      Array.from({ length: 9 }, (_u, i) =>
        chat(`c${i}`, `Chat ${i}`, `2026-08-0${i + 1}T00:00:00.000Z`),
      ),
    );
    const ids = get(recentChats).map((c) => c.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(['c8', 'c7', 'c6', 'c5', 'c4']);
  });

  it('includes recipe-attached sessions — a chat is a chat (#707 duplication accepted)', () => {
    mockChats._set([
      chat('general', 'General', '2026-08-02T00:00:00.000Z'),
      chat('attached', 'Ragu chat', '2026-08-04T00:00:00.000Z', 'r1'),
    ]);
    expect(get(recentChats).map((c) => c.id)).toEqual(['attached', 'general']);
  });

  it('is empty with no chats, so the section can be absent entirely', () => {
    expect(get(recentChats)).toEqual([]);
  });

  it("passes a long naive title through untouched — truncation is the row's job", () => {
    // Until generateChatTitle lands, a title is `text.slice(0, 60)` of the first
    // message. The store must not shorten or tidy it; the row truncates on display.
    const naive = 'how do i stop my sourdough starter from smelling like acetone';
    mockChats._set([chat('c1', naive, '2026-08-05T00:00:00.000Z')]);
    expect(get(recentChats)[0]?.title).toBe(naive);
  });

  it('stays out of the nav badge — a chat you had is not waiting on you', () => {
    mockChats._set([chat('c1', 'Sourdough', '2026-08-05T00:00:00.000Z')]);
    expect(get(recentChats)).toHaveLength(1);
    expect(get(mineOpenCount)).toBe(0);
  });
});

describe('mineOpenCount', () => {
  it('counts every open cook plus every FIRED timer, and nothing else', () => {
    expect(get(mineOpenCount)).toBe(0);

    mockRecipes._set([withSteps('r1', 'Noodle Bowl', 4), withSteps('r2', 'Side Salad', 2)]);
    mockSessions._set([session('r1')]);
    expect(get(mineOpenCount)).toBe(1);

    mockSessions._set([session('r1'), session('r2')]);
    expect(get(mineOpenCount)).toBe(2);

    // A timer still counting down is running to plan — it does not want a hand.
    mockSessions._set([session('r1', [], [timer('r1-s0', 60_000)]), session('r2')]);
    expect(get(mineOpenCount)).toBe(2);

    // Once it fires, it does.
    mockSessions._set([session('r1', [], [timer('r1-s0', -1_000)]), session('r2')]);
    expect(get(mineOpenCount)).toBe(3);
  });

  it('leaves the review queue out — a standing queue must not pin a badge', () => {
    mockRecipes._set([recipe('r1', 'Never reviewed', { needs_approval: true } as Partial<Recipe>)]);
    expect(get(needsReviewRecipes)).toHaveLength(1);
    expect(get(mineOpenCount)).toBe(0);
  });
});
