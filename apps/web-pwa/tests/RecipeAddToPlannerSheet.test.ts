import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  emptyWeek,
  setDayChefs,
  setDayNote,
  setDayRecipes,
  type MealPlanWeek,
  type Member,
  type Recipe,
} from '@salt/domain';

// The "Add to planner" night picker (issue #1438). What matters here is that the
// nights are READ rather than decoded: one night per row, named in words, in the
// order they happen, opening on tonight with the week just gone reachable above
// it. A native `<input type="date">` would hand all of that to the platform and
// give a different answer on every device — which is why this is hand-rolled, and
// the only half of the old month grid's argument that survived it.
//
// The other half is that each row says what is already on that night and who is
// cooking it, which is what makes a free night visible without opening the
// planner. Those reads are display-only and mocked here at `loadWeekForDisplay`;
// the property that they never become the WRITE path's evidence is a service
// concern and is pinned in `mealPlanService.sync.test.ts`, not here.
//
// Nothing here LAYS OUT from `firstDayOfWeek` any more — a list has no week rows —
// so the only thing it is asked is which document a night's summary comes out of,
// which is why the tests below fix it at 'mon' and assert week starts, never cells.

const {
  mockFirstDayOfWeek,
  mockAddRecipeToDay,
  mockLoadWeekForDisplay,
  mockCurrentMember,
  mockMembers,
  mockRecipesById,
  mockAddToast,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockFirstDayOfWeek: makeStore<string>('mon'),
    mockAddRecipeToDay: vi.fn(),
    mockLoadWeekForDisplay: vi.fn(),
    mockCurrentMember: makeStore<unknown>(null),
    mockMembers: makeStore<unknown[]>([]),
    mockRecipesById: makeStore<ReadonlyMap<string, unknown>>(new Map()),
    mockAddToast: vi.fn(),
  };
});

vi.mock('../src/lib/mealPlanService.js', () => ({
  addRecipeToDay: mockAddRecipeToDay,
  firstDayOfWeek: mockFirstDayOfWeek,
  loadWeekForDisplay: mockLoadWeekForDisplay,
}));
vi.mock('../src/lib/membersService.js', () => ({
  currentMember: mockCurrentMember,
  members: mockMembers,
}));
vi.mock('../src/lib/recipeService.js', () => ({ recipesById: mockRecipesById }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockAddToast }));

import RecipeAddToPlannerSheet from '../src/routes/recipes/RecipeAddToPlannerSheet.svelte';

const RECIPE: Recipe = {
  cureCategory: null,
  producesCanonId: null,
  componentRecipeIds: [],
  kit: [],
  createdBy: '',
  lastEditedBy: '',
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Butter chicken',
  description: null,
  ingredients: [],
  steps: [],
  metadata: {
    servings: 4,
    tags: [],
  },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A fixed "today" so the window bounds and the seeded selection are assertable.
// Wednesday. The window runs 2026-08-05 … 2026-08-26 on open.
const TODAY = new Date('2026-08-12T09:00:00.000Z');
const TODAY_KEY = '2026-08-12';
// Monday-start weeks, so the opening window (2026-08-05 … 2026-08-26) spans four
// documents: 08-03, 08-10, 08-17, 08-24.
const OPENING_WEEKS = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'];

function member(id: string, name: string): Member {
  return {
    id,
    schemaVersion: 1,
    name,
    email: `${id}@example.com`,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const DANIEL = member('m-daniel', 'Daniel');
const SAM = member('m-sam', 'Sam');

/** Serve one week document per start date; anything unnamed is an unplanned week. */
function serveWeeks(byStart: Record<string, MealPlanWeek>): void {
  mockLoadWeekForDisplay.mockImplementation((start: string) =>
    Promise.resolve({ kind: 'ok', value: byStart[start] ?? null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
  mockFirstDayOfWeek._set('mon');
  mockCurrentMember._set(null);
  mockMembers._set([DANIEL, SAM]);
  mockRecipesById._set(new Map());
  mockAddRecipeToDay.mockResolvedValue({ kind: 'ok', value: 'added' });
  mockLoadWeekForDisplay.mockResolvedValue({ kind: 'ok', value: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

function renderSheet() {
  return render(RecipeAddToPlannerSheet, { props: { recipe: RECIPE, open: true } });
}

function nightRow(date: string): HTMLElement {
  const row = document.querySelector(`[data-testid="planner-add-night"][data-date="${date}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function nightDates(): string[] {
  return screen.getAllByTestId('planner-add-night').map((el) => el.dataset.date ?? '');
}

async function waitForList(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('planner-add-nights')).toBeInTheDocument());
}

describe('RecipeAddToPlannerSheet — the list of nights', () => {
  it('opens on a fortnight ahead with the week just gone above tonight', async () => {
    renderSheet();
    await waitForList();

    const dates = nightDates();
    expect(dates[0]).toBe('2026-08-05');
    expect(dates[dates.length - 1]).toBe('2026-08-26');
    // Seven nights back, tonight, fourteen ahead.
    expect(dates).toHaveLength(22);
    // In the order they happen, and each one exactly once.
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('names every night in words and marks tonight as tonight', async () => {
    renderSheet();
    await waitForList();

    expect(nightRow(TODAY_KEY)).toHaveTextContent('Tonight');
    expect(nightRow(TODAY_KEY)).toHaveAttribute('aria-current', 'date');
    // A night is named, never a bare number: the whole complaint was having to
    // work out which square was Friday.
    expect(nightRow('2026-08-21')).toHaveTextContent('Fri 21 Aug');
    expect(nightRow('2026-08-21')).not.toHaveAttribute('aria-current');
    // A past night is a perfectly ordinary night to plan — recording what was
    // actually eaten — so it is present and pickable, not disabled.
    expect(nightRow('2026-08-06')).toHaveTextContent('Thu 6 Aug');
    expect(nightRow('2026-08-06')).not.toBeDisabled();
  });

  it('opens with tonight selected and the footer naming it in full', async () => {
    renderSheet();
    await waitForList();

    expect(nightRow(TODAY_KEY)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('recipe-add-to-planner-confirm')).toHaveTextContent(
      'Add to Wednesday 12 August',
    );
  });

  it('has no month grid left to navigate', async () => {
    renderSheet();
    await waitForList();

    for (const gone of [
      'planner-add-calendar',
      'planner-add-day',
      'planner-add-month',
      'planner-add-prev-month',
      'planner-add-next-month',
    ]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it('extends a fortnight at a time and stops at eight weeks out', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(screen.getByTestId('planner-add-more'));
    expect(nightDates().at(-1)).toBe('2026-09-09');

    await user.click(screen.getByTestId('planner-add-more'));
    expect(nightDates().at(-1)).toBe('2026-09-23');

    await user.click(screen.getByTestId('planner-add-more'));
    // Eight weeks out, and the affordance goes with the ceiling rather than
    // sitting there doing nothing.
    expect(nightDates().at(-1)).toBe('2026-10-07');
    expect(screen.queryByTestId('planner-add-more')).toBeNull();
    // Still the same seven nights behind: extending reaches forward only.
    expect(nightDates()[0]).toBe('2026-08-05');
  });

  it('re-seeds the window and the selection when the sheet is reopened', async () => {
    const user = userEvent.setup();
    const rendered = renderSheet();
    await waitForList();

    await user.click(screen.getByTestId('planner-add-more'));
    await user.click(nightRow('2026-08-21'));
    expect(nightDates().at(-1)).toBe('2026-09-09');

    await rendered.rerender({ recipe: RECIPE, open: false });
    await rendered.rerender({ recipe: RECIPE, open: true });
    await waitForList();

    // A sheet reopened is offering tonight again, from the window it opens on —
    // not wherever the last recipe's planning wandered to.
    expect(nightDates().at(-1)).toBe('2026-08-26');
    expect(nightRow(TODAY_KEY)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('recipe-add-to-planner-confirm')).toHaveTextContent(
      'Add to Wednesday 12 August',
    );
  });
});

// The row's whole point: you can see which nights are free without opening the
// planner, and which of the busy ones are yours to cook.
describe('RecipeAddToPlannerSheet — what is planned, and who is cooking', () => {
  function mealOf(date: string): HTMLElement | null {
    return nightRow(date).querySelector('[data-testid="planner-add-night-meal"]');
  }
  function cookOf(date: string): HTMLElement | null {
    return nightRow(date).querySelector('[data-testid="planner-add-night-cook"]');
  }

  it("says the night's own words, its dishes, or that it is free — in that order", async () => {
    mockRecipesById._set(new Map([['r-pie', { ...RECIPE, id: 'r-pie', title: 'Fish pie' }]]));
    const week = setDayRecipes(
      setDayNote(emptyWeek('2026-08-10'), '2026-08-13', 'Roast chicken'),
      '2026-08-14',
      ['r-pie'],
    );
    serveWeeks({ '2026-08-10': week });
    renderSheet();

    await waitFor(() => expect(mealOf('2026-08-13')).toHaveTextContent('Roast chicken'));
    // No dinner text, but a recipe is on the night — so the night is not free,
    // and saying "Nothing planned" over the dish already there would be the worst
    // lie this particular control could tell.
    expect(mealOf('2026-08-14')).toHaveTextContent('Fish pie');
    expect(mealOf('2026-08-15')).toHaveTextContent('Nothing planned');
  });

  it('marks the nights that are yours, names the ones that are not', async () => {
    mockCurrentMember._set(DANIEL);
    let week = setDayNote(emptyWeek('2026-08-10'), '2026-08-13', 'Roast chicken');
    week = setDayChefs(week, '2026-08-13', [DANIEL.id]);
    week = setDayChefs(setDayNote(week, '2026-08-14', 'Fish pie'), '2026-08-14', [SAM.id]);
    week = setDayChefs(setDayNote(week, '2026-08-15', 'Curry'), '2026-08-15', [DANIEL.id, SAM.id]);
    setDayNote(week, '2026-08-16', 'Leftovers');
    serveWeeks({ '2026-08-10': setDayNote(week, '2026-08-16', 'Leftovers') });
    renderSheet();

    await waitFor(() => expect(cookOf('2026-08-13')).toHaveTextContent('You'));
    expect(cookOf('2026-08-14')).toHaveTextContent('Sam');
    expect(cookOf('2026-08-14')).not.toHaveTextContent('You');
    // Both "you" and the name: on a five-person roster, "who has it" is the
    // question straight after "is it mine".
    expect(cookOf('2026-08-15')).toHaveTextContent('You & Sam');
    // A planned night nobody has taken is arguably the most useful state — it is
    // a night you can take.
    expect(cookOf('2026-08-16')).toHaveTextContent('No cook');
  });

  it('reads the whole row out as one label, and keeps it on the picked night', async () => {
    // `aria-label` REPLACES a button's content rather than adding to it, so the
    // meal and the cook have to be in the label or a screen reader loses them.
    mockCurrentMember._set(DANIEL);
    const week = setDayChefs(
      setDayNote(emptyWeek('2026-08-10'), '2026-08-13', 'Roast chicken'),
      '2026-08-13',
      [DANIEL.id],
    );
    serveWeeks({ '2026-08-10': week });
    const user = userEvent.setup();
    renderSheet();

    await waitFor(() =>
      expect(nightRow('2026-08-13')).toHaveAttribute(
        'aria-label',
        'Thursday 13 August, Roast chicken, cooking: You',
      ),
    );

    await user.click(nightRow('2026-08-13'));
    expect(nightRow('2026-08-13')).toHaveAttribute('aria-pressed', 'true');
    expect(mealOf('2026-08-13')).toHaveTextContent('Roast chicken');
    expect(cookOf('2026-08-13')).toHaveTextContent('You');
  });

  it('shows no cook line at all on a night with nothing planned', async () => {
    mockCurrentMember._set(DANIEL);
    renderSheet();

    await waitFor(() => expect(mealOf('2026-08-15')).toHaveTextContent('Nothing planned'));
    expect(cookOf('2026-08-15')).toBeNull();
  });

  it('marks nothing as yours while the roster is still loading', async () => {
    // `currentMember` is null for a real window on every cold launch. Defaulting
    // to "not you" is the honest answer; falling back to the auth email would be
    // a second definition of the same fact.
    mockCurrentMember._set(null);
    const week = setDayChefs(
      setDayNote(emptyWeek('2026-08-10'), '2026-08-13', 'Roast chicken'),
      '2026-08-13',
      [DANIEL.id],
    );
    serveWeeks({ '2026-08-10': week });
    renderSheet();

    // Named, not guessed at: naming needs no current member.
    await waitFor(() => expect(cookOf('2026-08-13')).toHaveTextContent('Daniel'));
    expect(cookOf('2026-08-13')).not.toHaveTextContent('You');
  });

  it('never says a week it has not read is free', async () => {
    // The row that matters most: "Nothing planned" for a week nobody has looked
    // at is a confident lie about the one fact the row exists for.
    const pending: (() => void)[] = [];
    mockLoadWeekForDisplay.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ kind: 'ok', value: null }));
        }),
    );
    renderSheet();
    await waitForList();

    expect(mealOf(TODAY_KEY)).toBeNull();
    expect(cookOf(TODAY_KEY)).toBeNull();
    expect(
      nightRow(TODAY_KEY).querySelector('[data-testid="planner-add-night-unknown"]'),
    ).not.toBeNull();

    pending.forEach((release) => release());
    await waitFor(() => expect(mealOf(TODAY_KEY)).toHaveTextContent('Nothing planned'));
  });

  it('leaves a night pickable when its week could not be read', async () => {
    // The write path does its own read and returns a real Failure if that fails,
    // so a failed display read is no reason to take the night away — and it is
    // not reported either (offline is not a reportable error).
    mockLoadWeekForDisplay.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await waitFor(() =>
      expect(
        nightRow('2026-08-21').querySelector('[data-testid="planner-add-night-unknown"]'),
      ).not.toBeNull(),
    );
    expect(mealOf('2026-08-21')).toBeNull();

    await user.click(nightRow('2026-08-21'));
    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));

    expect(mockAddRecipeToDay).toHaveBeenCalledWith('2026-08-21', RECIPE);
  });

  it('reads each week the window spans once, and only the new ones on extending', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await waitFor(() => expect(mockLoadWeekForDisplay).toHaveBeenCalledTimes(4));
    expect(mockLoadWeekForDisplay.mock.calls.map((c) => c[0]).sort()).toEqual(OPENING_WEEKS);

    await user.click(screen.getByTestId('planner-add-more'));

    // 2026-09-09 is the new last night, so two documents join the set and the
    // four already in hand are not read again.
    await waitFor(() => expect(mockLoadWeekForDisplay).toHaveBeenCalledTimes(6));
    expect(
      mockLoadWeekForDisplay.mock.calls
        .slice(4)
        .map((c) => c[0])
        .sort(),
    ).toEqual(['2026-08-31', '2026-09-07']);
  });

  it('takes a fresh snapshot when the sheet is reopened', async () => {
    const rendered = renderSheet();
    await waitFor(() => expect(mockLoadWeekForDisplay).toHaveBeenCalledTimes(4));

    serveWeeks({
      '2026-08-10': setDayNote(emptyWeek('2026-08-10'), TODAY_KEY, 'Roast chicken'),
    });
    await rendered.rerender({ recipe: RECIPE, open: false });
    await rendered.rerender({ recipe: RECIPE, open: true });

    // The summary is a snapshot taken when the sheet opened, so a sheet reopened
    // later takes a new one rather than showing what the last one saw.
    await waitFor(() => expect(mealOf(TODAY_KEY)).toHaveTextContent('Roast chicken'));
  });
});

describe('RecipeAddToPlannerSheet — committing', () => {
  it('writes only the night that was picked, and only on confirm', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(nightRow('2026-08-21'));
    // Selecting is not committing.
    expect(mockAddRecipeToDay).not.toHaveBeenCalled();
    expect(nightRow('2026-08-21')).toHaveAttribute('aria-pressed', 'true');
    expect(nightRow(TODAY_KEY)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('recipe-add-to-planner-confirm')).toHaveTextContent(
      'Add to Friday 21 August',
    );

    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));
    // The whole RECIPE, not its id (#752): a meal expands to itself plus its
    // components, and that expansion is a pure function of the document — so the
    // service is handed the document rather than made to look it back up.
    expect(mockAddRecipeToDay).toHaveBeenCalledWith('2026-08-21', RECIPE);
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith('Added to Friday 21 August.', 'success'),
    );
  });

  it('commits a night from the week just gone as readily as one ahead', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(nightRow('2026-08-08'));
    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));

    expect(mockAddRecipeToDay).toHaveBeenCalledWith('2026-08-08', RECIPE);
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith('Added to Saturday 8 August.', 'success'),
    );
  });

  it('closes and writes nothing when the sheet is dismissed', async () => {
    // Nothing is written until the footer's confirm — which is the whole reason
    // picking a night selects rather than commits.
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(nightRow('2026-08-21'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('planner-add-nights')).toBeNull());
    expect(mockAddRecipeToDay).not.toHaveBeenCalled();
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('writes nothing when the sheet is dismissed from outside the footer', async () => {
    // Escape goes through the dialog itself rather than the Cancel button, which
    // is the path that clears the in-flight flag — the sheet is reopened from the
    // recipe page, not remounted, so a stale `busy` would arrive disabled.
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('planner-add-nights')).toBeNull());
    expect(mockAddRecipeToDay).not.toHaveBeenCalled();
  });

  it('says so rather than claiming an add when the dish is already on that night', async () => {
    mockAddRecipeToDay.mockResolvedValue({ kind: 'ok', value: 'already-there' });
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        'Already planned for Wednesday 12 August.',
        'success',
      ),
    );
  });

  it('keeps the sheet open and reports a failed write', async () => {
    mockAddRecipeToDay.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
    const user = userEvent.setup();
    renderSheet();
    await waitForList();

    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith('Failed to add to the planner.', 'destructive'),
    );
    expect(screen.getByTestId('planner-add-nights')).toBeInTheDocument();
  });
});
