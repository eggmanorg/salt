import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe, isPlannable } from '@salt/domain';
import type { Day, Member, Recipe } from '@salt/domain';

import MealDayEditor from '../src/routes/mealplan/MealDayEditor.svelte';
import { kindOf, sectionOf } from '../src/routes/recipes/recipeKind.js';

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

// A library with something on every shelf the picker can reach, and three things
// on shelves it cannot (issue #1454). `sundayLunch` is the whole point of the
// feature: an ordinary `kind: 'recipe'` document that has gained components, so
// only `sectionOf` can tell you it is a meal.
const sundayLunch: Recipe = {
  ...emptyRecipe('m1', NOW),
  title: 'Sunday lunch',
  componentRecipeIds: ['r1', 'r2'],
};
const takeaway: Recipe = { ...emptyRecipe('s1', NOW, 'special'), title: 'Indian takeaway' };
const negroni: Recipe = { ...emptyRecipe('c1', NOW, 'cocktail'), title: 'Negroni' };
const coppa: Recipe = { ...emptyRecipe('cu1', NOW, 'cure'), title: 'Coppa' };
const holding: Recipe = {
  ...emptyRecipe('p1', NOW, 'placeholder'),
  title: 'A good dinner is planned',
};
/** Every shelf, reachable and unreachable, in one list. */
const wholeLibrary: Recipe[] = [bolognese, roast, sundayLunch, takeaway, negroni, coppa, holding];

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
    // The option's accessible name carries the `Meals` badge since #1454 — a meal
    // is stored as an ordinary recipe, so the badge is the only thing in the list
    // that says which of these is the whole dinner.
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
    await fireEvent.click(await screen.findByRole('option', { name: 'Sunday lunch Meals' }));

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
    await fireEvent.click(await screen.findByRole('option', { name: 'Sunday lunch Meals' }));

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

// ─── Shelf chips above the picker (issue #1454) ──────────────────────────────
// The library is long enough that a meal or a Chef's Special is hard to find
// among the recipes, so a row of chips narrows the box to one shelf. The chips
// are a way of LOOKING: they sit on top of the `isPlannable` / already-attached
// predicate and can only ever narrow it, which is the property the last test in
// this block pins.

/** Every shelf chip currently offered, in render order, by its `data-section`. */
function chipSections(): string[] {
  return screen
    .getAllByTestId('day-recipe-section-filter')
    .map((el) => el.getAttribute('data-section') ?? '');
}

function chipFor(section: string): HTMLElement {
  const chip = screen
    .getAllByTestId('day-recipe-section-filter')
    .find((el) => el.getAttribute('data-section') === section);
  if (!chip) throw new Error(`no shelf chip for "${section}"`);
  return chip;
}

/**
 * What the picker is offering right now, as each option READS — title, and the
 * shelf badge where it wears one. Asserting on the rendered text rather than on
 * the title alone is deliberate: the badge is the other half of this feature, so
 * every list assertion below checks both at once.
 */
function offeredTitles(): string[] {
  return screen.queryAllByRole('option').map((el) => el.textContent?.trim() ?? '');
}

/** Every attachable entry, as `offeredTitles` renders it, on an empty night. */
const ALL_OFFERED = [
  'Spaghetti Bolognese',
  'Sunday Roast',
  'Sunday lunch Meals',
  "Indian takeaway Chef's Specials",
];

describe('MealDayEditor — filtering the picker by shelf (#1454)', () => {
  it('offers a chip for every shelf that has something, and none for the rest', async () => {
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await userEvent.click(screen.getByTestId('day-summary'));

    // `LIST_SECTIONS` order — Recipes, Meals, Chef's Specials — with `All`
    // leading. A cocktail, a cure and a placeholder can never be dinner, so
    // their shelves have nothing to offer and get no chip.
    expect(chipSections()).toEqual(['all', 'recipe', 'meal', 'special']);
    expect(chipFor('all')).toHaveAttribute('aria-pressed', 'true');
    // Every word comes from SECTION_COPY, never typed here.
    expect(chipFor('meal')).toHaveTextContent('Meals');
    expect(chipFor('special')).toHaveTextContent("Chef's Specials");
  });

  it('shows no chip row at all when everything is on one shelf', async () => {
    render(MealDayEditor, { props: baseProps() });
    await userEvent.click(screen.getByTestId('day-summary'));

    expect(screen.queryByTestId('day-recipe-section-filters')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('day-recipe-section-filter')).toHaveLength(0);
  });

  it('narrows the box to the shelf you tap, and `All` restores it', async () => {
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await openPicker();
    expect(offeredTitles()).toEqual(ALL_OFFERED);

    await fireEvent.click(chipFor('meal'));
    expect(chipFor('meal')).toHaveAttribute('aria-pressed', 'true');
    expect(chipFor('all')).toHaveAttribute('aria-pressed', 'false');
    expect(offeredTitles()).toEqual(['Sunday lunch Meals']);

    await fireEvent.click(chipFor('special'));
    expect(offeredTitles()).toEqual(["Indian takeaway Chef's Specials"]);

    await fireEvent.click(chipFor('all'));
    expect(offeredTitles()).toEqual(ALL_OFFERED);
  });

  it('typing narrows within the chosen shelf', async () => {
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await openPicker();
    await fireEvent.click(chipFor('recipe'));
    // "Sunday" matches the roast AND the meal; the shelf keeps the meal out.
    await filterPicker('sunday');

    expect(offeredTitles()).toEqual(['Sunday Roast']);
  });

  it('keeps the list open and keeps what you typed when a chip is tapped', async () => {
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await openPicker();
    await filterPicker('sunday');
    expect(offeredTitles()).toEqual(['Sunday Roast', 'Sunday lunch Meals']);

    // The mechanism, asserted rather than assumed: the Combobox closes its popup
    // on input blur and, being `restrict`ed, clears the input with it. The chip
    // cancels its own mousedown default, so focus never leaves the input.
    // `fireEvent` returns false when the handler called `preventDefault`.
    expect(await fireEvent.mouseDown(chipFor('meal'))).toBe(false);
    await fireEvent.click(chipFor('meal'));

    expect(screen.getByTestId('day-recipe-picker')).toHaveValue('sunday');
    expect(offeredTitles()).toEqual(['Sunday lunch Meals']);
  });

  it('keeps the chosen shelf pressed after you attach something', async () => {
    // The chip row is rendered OUTSIDE the `{#key recipePickerKey}` wrapper that
    // remounts the Combobox to clear its input after each add — so attaching one
    // meal leaves you on Meals, ready for the next.
    const onRecipesChange = vi.fn();
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary, onRecipesChange }) });
    await openPicker();
    await fireEvent.click(chipFor('special'));
    await fireEvent.click(await screen.findByRole('option', { name: /Indian takeaway/ }));

    expect(onRecipesChange).toHaveBeenCalledWith(['s1']);
    expect(chipFor('special')).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to `All` when the shelf you are standing on runs out', async () => {
    // Attach the last meal and the Meals chip has nothing left to offer, so it
    // goes — and the box returns to All rather than showing you an empty list.
    // Stated in the issue as an accepted consequence, pinned here.
    const { rerender } = render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await openPicker();
    await fireEvent.click(chipFor('meal'));
    expect(offeredTitles()).toEqual(['Sunday lunch Meals']);

    await rerender(baseProps({ recipes: wholeLibrary, day: { ...emptyDay, recipeIds: ['m1'] } }));

    expect(chipSections()).toEqual(['all', 'recipe', 'special']);
    expect(chipFor('all')).toHaveAttribute('aria-pressed', 'true');
    expect(offeredTitles()).toEqual([
      'Spaghetti Bolognese',
      'Sunday Roast',
      "Indian takeaway Chef's Specials",
    ]);
  });

  it('labels a meal `Meals`, as a Chef’s Special already wears its own', async () => {
    // The badge moved from `kindOf` to `sectionOf` in the same change, and had
    // to: a meal is stored as an ordinary recipe, so a kind-derived badge leaves
    // the one entry the chips exist to help you find wearing nothing at all.
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary }) });
    await openPicker();

    expect(await screen.findByRole('option', { name: 'Sunday lunch Meals' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: "Indian takeaway Chef's Specials" }),
    ).toBeInTheDocument();
    // A plain recipe — the norm — still wears nothing.
    expect(screen.getByRole('option', { name: 'Sunday Roast' })).toBeInTheDocument();
  });

  it('RULE 12: no chip state can widen what may be attached', async () => {
    // The claim this pins: the chips sit strictly ON TOP of
    // `isPlannable(kindOf(r)) && !day.recipeIds.includes(r.id)` and can only ever
    // narrow it. An edit that let a chip reach past that predicate — a shelf
    // computed from the whole library rather than from the candidates, say —
    // turns this red. Verified red before it was kept, by filtering the
    // candidate list on the chip INSTEAD of on the predicate.
    const day: Day = { ...emptyDay, recipeIds: ['r1'] };
    render(MealDayEditor, { props: baseProps({ recipes: wholeLibrary, day }) });
    await openPicker();

    const attachable = new Set(
      wholeLibrary
        .filter((r) => isPlannable(kindOf(r)) && !day.recipeIds.includes(r.id))
        .map((r) => r.title),
    );
    // Every chip there is, `All` included — not a sample.
    for (const section of chipSections()) {
      await fireEvent.click(chipFor(section));
      const offered = offeredTitles();
      expect(offered.length).toBeGreaterThan(0);
      for (const title of offered) {
        // The badge is part of the option's text, so compare on the title it
        // starts with — and assert the badge agrees with `sectionOf` too.
        const recipe = wholeLibrary.find((r) => title.startsWith(r.title));
        expect(recipe, `offered "${title}" matches no recipe`).toBeDefined();
        expect(attachable.has(recipe!.title), `"${recipe!.title}" is not attachable`).toBe(true);
        if (section !== 'all') expect(sectionOf(recipe!)).toBe(section);
      }
    }
  });
});
