import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe } from '@salt/domain';
import type { Day, Member, Recipe } from '@salt/domain';

import MealDayEditor from '../src/routes/mealplan/MealDayEditor.svelte';

// The recipe picker inside the day's SHEET (#640, Phase 1).
//
// A modal dialog makes the rest of the page inert by putting
// `pointer-events: none` on <body>, and both Combobox and Select portal their
// popover to <body> by DEFAULT — which lands the list outside the live layer, so
// it renders in full and every option is dead. Nothing caught that before this
// file: no picker had ever been opened inside a sheet anywhere in the app.
//
// So these tests are pointed at the seam rather than at the picker: the list must
// come up INSIDE the sheet, and it must be reachable there — asserted directly
// against the resolved `pointer-events`, which is the thing that was broken.
//
// The picker itself is driven with `fireEvent`. `userEvent` emulates the
// browser's focus-on-pointerdown, and the combobox closes on input blur in a
// microtask, so a synthetic focus shuffle can tear the listbox down before the
// click lands — a jsdom artifact that makes the test depend on timing and on how
// many bits-ui dialogs the document has seen. `fireEvent` dispatches exactly the
// events the input and the option listen for.

const alex: Member = { id: 'm1', name: 'Alex' } as Member;
const noop = () => {};
const NOW = '2026-01-01T00:00:00.000Z';
const emptyDay: Day = { note: '', recipeIds: [], chefs: [], attendees: [], guests: 0 };

const bolognese: Recipe = { ...emptyRecipe('r1', NOW), title: 'Spaghetti Bolognese' };
const roast: Recipe = { ...emptyRecipe('r2', NOW), title: 'Sunday Roast' };

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    label: 'Mon',
    sublabel: '8',
    sheetTitle: 'Monday 8 June',
    day: emptyDay,
    members: [alex],
    recipes: [bolognese, roast],
    testid: 'day',
    onNoteChange: noop,
    onChefToggle: noop,
    onAttendeeToggle: noop,
    onAttendeeHomeTime: noop,
    onAttendeeNote: noop,
    onGuestsChange: noop,
    onRecipesChange: noop,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** Open the day's sheet, then open its recipe picker. */
async function openPicker(): Promise<void> {
  await userEvent.click(screen.getByTestId('day-summary'));
  await fireEvent.click(screen.getByTestId('day-recipe-picker'));
}

/** Narrow the picker the way typing does. */
async function filterPicker(text: string): Promise<void> {
  await fireEvent.input(screen.getByTestId('day-recipe-picker'), { target: { value: text } });
}

/** The nearest ancestor value of `pointer-events`, as the browser would resolve it. */
function effectivePointerEvents(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const own = node.style.pointerEvents;
    if (own) return own;
    node = node.parentElement;
  }
  return 'auto';
}

describe('MealDayEditor — the recipe picker inside the day sheet (#640)', () => {
  it('opens its list inside the sheet, not on the inert page behind it', async () => {
    render(MealDayEditor, { props: baseProps() });
    await openPicker();

    const dialog = screen.getByRole('dialog');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    // The whole point: the list is part of the live modal layer. On <body> it
    // would inherit the dialog's `pointer-events: none` and be unclickable.
    for (const option of options) {
      expect(dialog).toContainElement(option);
      expect(effectivePointerEvents(option)).not.toBe('none');
    }
    expect(document.body.style.pointerEvents).toBe('none');
  });

  it('filters as you type', async () => {
    render(MealDayEditor, { props: baseProps() });
    await openPicker();
    await filterPicker('bolog');

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Spaghetti Bolognese');
  });

  it('attaches the recipe you pick', async () => {
    const onRecipesChange = vi.fn();
    const onNoteChange = vi.fn();
    render(MealDayEditor, { props: baseProps({ onRecipesChange, onNoteChange }) });
    await openPicker();
    await filterPicker('roast');
    await fireEvent.click(await screen.findByRole('option', { name: 'Sunday Roast' }));

    expect(onRecipesChange).toHaveBeenCalledWith(['r2']);
    // …and an empty meal takes the recipe's title (Phase 3, #469) — unchanged
    // by the move into a sheet.
    expect(onNoteChange).toHaveBeenCalledWith('Sunday Roast');
  });

  it('attaches a MEAL as the whole dinner — the meal, then its dishes', async () => {
    // Picking a meal plans every dish of it in one go (#752, Phase 2), meal FIRST:
    // the note below and the day's card both read the first attached recipe, so
    // ordering the expansion is what makes them say "Sunday lunch" and wear its
    // photograph, without either mechanic learning what a meal is.
    const onRecipesChange = vi.fn();
    const onNoteChange = vi.fn();
    const meal: Recipe = {
      ...emptyRecipe('m-roast', NOW),
      title: 'Sunday lunch',
      componentRecipeIds: ['r2', 'r1'],
    };
    render(MealDayEditor, {
      props: baseProps({
        onRecipesChange,
        onNoteChange,
        recipes: [bolognese, roast, meal],
      }),
    });
    await openPicker();
    await filterPicker('lunch');
    await fireEvent.click(await screen.findByRole('option', { name: 'Sunday lunch' }));

    expect(onRecipesChange).toHaveBeenCalledWith(['m-roast', 'r2', 'r1']);
    expect(onNoteChange).toHaveBeenCalledWith('Sunday lunch');
  });

  it('adds only the dishes a night is missing, and leaves its order alone', async () => {
    // The gravy was attached on its own last night; attaching the meal now must
    // not duplicate it, and must not re-sort the night around it.
    const onRecipesChange = vi.fn();
    const meal: Recipe = {
      ...emptyRecipe('m-roast', NOW),
      title: 'Sunday lunch',
      componentRecipeIds: ['r1', 'r2'],
    };
    render(MealDayEditor, {
      props: baseProps({
        day: { ...emptyDay, note: 'Something already written', recipeIds: ['r2'] },
        onRecipesChange,
        recipes: [bolognese, roast, meal],
      }),
    });
    await openPicker();
    await filterPicker('lunch');
    await fireEvent.click(await screen.findByRole('option', { name: 'Sunday lunch' }));

    expect(onRecipesChange).toHaveBeenCalledWith(['r2', 'm-roast', 'r1']);
  });

  it('says so when nothing matches', async () => {
    render(MealDayEditor, { props: baseProps() });
    await openPicker();
    await filterPicker('zzz');

    // "Nothing found", not "No recipes found": since #637 the picker offers
    // "Chef's Specials" entries alongside recipes, so the empty state cannot name
    // only recipes.
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('stays recipe-free in the template editor, which passes no picker handler', async () => {
    render(MealDayEditor, { props: baseProps({ onRecipesChange: undefined }) });
    await userEvent.click(screen.getByTestId('day-summary'));
    expect(screen.queryByTestId('day-recipe-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-recipes')).not.toBeInTheDocument();
  });
});
