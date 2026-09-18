import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Recipe } from '@salt/domain';

// The "Add to planner" night picker (issue #1438). What matters here is that the
// nights are READ rather than decoded: one night per row, named in words, in the
// order they happen, opening on tonight with the week just gone reachable above
// it. A native `<input type="date">` would hand all of that to the platform and
// give a different answer on every device — which is why this is hand-rolled, and
// the only half of the old month grid's argument that survived it.
//
// Nothing here lays out from `firstDayOfWeek` any more, and the absence of a test
// for it is deliberate: a list has no week rows, so where the household's week
// starts decides which DOCUMENT a night lives in and nothing this component draws.

const { mockAddRecipeToDay, mockAddToast } = vi.hoisted(() => ({
  mockAddRecipeToDay: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock('../src/lib/mealPlanService.js', () => ({
  addRecipeToDay: mockAddRecipeToDay,
}));
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
  mockAddRecipeToDay.mockResolvedValue({ kind: 'ok', value: 'added' });
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
