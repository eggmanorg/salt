import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Recipe } from '@salt/domain';

// The "Add to planner" day picker. What matters here is that this is
// OUR calendar and not the OS's: it lays out from the household's own
// `firstDayOfWeek`, it reaches any date by month, and it commits only the day you
// picked. A native `<input type="date">` would put all three of those in the
// platform's hands and give a different answer on every device.

const { mockFirstDayOfWeek, mockAddRecipeToDay, mockAddToast } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockFirstDayOfWeek: makeStore<string>('mon'),
    mockAddRecipeToDay: vi.fn(),
    mockAddToast: vi.fn(),
  };
});

vi.mock('../src/lib/mealPlanService.js', () => ({
  firstDayOfWeek: mockFirstDayOfWeek,
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

// A fixed "today" so the seeded month and selection are assertable. Wednesday.
const TODAY = new Date('2026-08-12T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
  mockFirstDayOfWeek._set('mon');
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

function dayCell(date: string): HTMLElement {
  const cell = document.querySelector(`[data-testid="planner-add-day"][data-date="${date}"]`);
  expect(cell).not.toBeNull();
  return cell as HTMLElement;
}

describe('RecipeAddToPlannerSheet — the calendar', () => {
  it('opens on this month with today selected', async () => {
    renderSheet();

    await waitFor(() => expect(screen.getByTestId('planner-add-month')).toBeInTheDocument());
    expect(screen.getByTestId('planner-add-month')).toHaveTextContent('August 2026');
    expect(dayCell('2026-08-12')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('recipe-add-to-planner-confirm')).toHaveTextContent(
      'Add to Wednesday 12 August',
    );
  });

  it('lays the grid out from the household first day of the week', async () => {
    // August 2026 starts on a Saturday. Monday-start weeks put 27 July in the
    // first cell; Friday-start weeks put 31 July there.
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument());
    let cells = screen.getAllByTestId('planner-add-day');
    expect(cells[0]).toHaveAttribute('data-date', '2026-07-27');

    cleanup();
    mockFirstDayOfWeek._set('fri');
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument());
    cells = screen.getAllByTestId('planner-add-day');
    expect(cells[0]).toHaveAttribute('data-date', '2026-07-31');
    // Whole weeks, always.
    expect(cells.length % 7).toBe(0);
  });

  it('reaches other months without leaving the sheet', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('planner-add-month')).toBeInTheDocument());

    await user.click(screen.getByTestId('planner-add-next-month'));
    expect(screen.getByTestId('planner-add-month')).toHaveTextContent('September 2026');

    await user.click(screen.getByTestId('planner-add-prev-month'));
    await user.click(screen.getByTestId('planner-add-prev-month'));
    expect(screen.getByTestId('planner-add-month')).toHaveTextContent('July 2026');
    // Past months are reachable: recording what was actually eaten is legitimate.
    expect(dayCell('2026-07-04')).toBeInTheDocument();
  });
});

describe('RecipeAddToPlannerSheet — committing', () => {
  it('writes only the day that was picked, and only on confirm', async () => {
    const user = userEvent.setup();
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument());

    await user.click(dayCell('2026-08-21'));
    // Selecting is not committing.
    expect(mockAddRecipeToDay).not.toHaveBeenCalled();
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

  it('says so rather than claiming an add when the dish is already on that day', async () => {
    mockAddRecipeToDay.mockResolvedValue({ kind: 'ok', value: 'already-there' });
    const user = userEvent.setup();
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument());

    await user.click(screen.getByTestId('recipe-add-to-planner-confirm'));

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith('Failed to add to the planner.', 'destructive'),
    );
    expect(screen.getByTestId('planner-add-calendar')).toBeInTheDocument();
  });
});
