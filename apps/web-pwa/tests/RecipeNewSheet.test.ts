import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// The New sheet — the door for the entries that cannot be imported (issue #1319
// Phase 6).
//
// What this suite is built to catch, rather than what the component happens to do:
//
//   IT ASKS ONLY FOR WHAT THE ENTRY CANNOT EXIST WITHOUT. A "When you CBA" entry
//   and a placeholder are a name and a description; a meal is a name and at least
//   one dish. The field SETS are asserted per mode, both what is there and what is
//   not, because the whole point of retiring the editor is that there is no second
//   form for tags, timings or a source.
//
//   NOTHING IS WRITTEN UNTIL CREATE, AND CREATE IS REFUSED UNTIL THE ENTRY IS
//   REAL. Opening the menu by mistake and backing out must not leave an untitled
//   document in the library, and "a meal requires a dish" is what makes
//   `sectionOf`'s `hasComponents` true the instant the document exists — no empty
//   meal is ever minted (issue #752's objection, honoured rather than overruled).
//
//   IT DROPS YOU ON THE ENTRY'S OWN PAGE ALREADY EDITING. The write, the edit-mode
//   request and the navigation are asserted as one sequence, because two of the
//   three happening without the last is a document nobody can finish writing.
//
//   A REOPENED SHEET HOLDS NOTHING FROM THE LAST ONE. A name typed into an entry
//   somebody backed out of must not arrive on the next one, and the id the dish
//   ordering is computed against is re-minted with it.

const { mockRecipes } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return { mockRecipes: makeStore<readonly Recipe[]>([]) };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('@salt/observability', () => ({ trackUsageEvent: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  persistRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import { push } from 'svelte-spa-router';
import { trackUsageEvent } from '@salt/observability';
import { addToast } from '../src/lib/toastStore.js';
import { persistRecipe } from '../src/lib/recipeService.js';
import RecipeNewSheet from '../src/routes/recipes/RecipeNewSheet.svelte';
import { clearEditOnArrival, takeEditOnArrival } from '../src/routes/recipes/editOnArrival.js';

const NOW = '2026-01-01T00:00:00.000Z';

function dish(id: string, title: string, elapsed: number | null = null): Recipe {
  const base = emptyRecipe(id, NOW);
  return {
    ...base,
    title,
    metadata: {
      ...base.metadata,
      phases:
        elapsed === null ? [] : [{ label: 'Cook', handsOnMinutes: 0, handsOffMinutes: elapsed }],
    },
  };
}

const CHICKEN = dish('chicken', 'Roast chicken', 90);
const POTATOES = dish('potatoes', 'Roast potatoes', 45);
const GRAVY = dish('gravy', 'Onion gravy', 20);
const TAKEAWAY: Recipe = { ...emptyRecipe('takeaway', NOW, 'outing'), title: 'Takeaway — Indian' };
const PLACEHOLDER: Recipe = {
  ...emptyRecipe('stock-photo', NOW, 'placeholder'),
  title: 'A good dinner',
};

const LIBRARY: readonly Recipe[] = [CHICKEN, POTATOES, GRAVY, TAKEAWAY, PLACEHOLDER];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(persistRecipe).mockResolvedValue({ kind: 'ok', value: undefined });
  mockRecipes._set(LIBRARY);
  clearEditOnArrival();
});

afterEach(() => {
  cleanup();
  // No `document.body.style.pointerEvents` reset: `tests/setup.ts` already does it
  // globally, and repeating it here is UT-C3 (docs/unit-test-spec.md).
  document.body.innerHTML = '';
  mockRecipes._set([]);
});

function show(mode: 'outing' | 'meal' | 'placeholder', open = true) {
  return render(RecipeNewSheet, { props: { mode, open } });
}

function nameBox(): HTMLElement {
  return screen.getByTestId('recipe-new-name');
}

function createButton(): HTMLElement {
  return screen.getByTestId('recipe-new-create');
}

async function typeName(value: string): Promise<void> {
  await fireEvent.input(nameBox(), { target: { value } });
}

// `fireEvent`, not `userEvent`, for the reason MealDayEditor.recipePicker.test.ts
// records: a synthetic focus shuffle can tear a bits-ui listbox down before the
// click lands.
async function openPicker(): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-new-dish-picker'));
}

async function pickDish(title: string): Promise<void> {
  await openPicker();
  await fireEvent.click(await screen.findByRole('option', { name: title }));
}

/** The document as the one `persistRecipe` call composed it. */
function written(): Recipe {
  return vi.mocked(persistRecipe).mock.calls[0]![0];
}

function dishRowTitles(): string[] {
  return screen
    .queryAllByTestId('recipe-new-dish-row')
    .map((el) => el.querySelector('span.truncate')?.textContent?.trim() ?? '');
}

describe('RecipeNewSheet — what each entry is asked for', () => {
  it('asks a "When you CBA" entry for a name and a description, and nothing else', async () => {
    show('outing');

    await waitFor(() => expect(nameBox()).toBeInTheDocument());
    expect(screen.getByTestId('recipe-new-description')).toBeInTheDocument();
    // No dish picker: an outing has no dish to compose.
    expect(screen.queryByTestId('recipe-new-dish-picker')).toBeNull();
  });

  it('asks a placeholder for a name and a description, and nothing else', async () => {
    show('placeholder');

    await waitFor(() => expect(nameBox()).toBeInTheDocument());
    expect(screen.getByTestId('recipe-new-description')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-new-dish-picker')).toBeNull();
  });

  it('asks a meal for a name and a dish — and offers no description box', async () => {
    show('meal');

    await waitFor(() => expect(screen.getByTestId('recipe-new-dish-picker')).toBeInTheDocument());
    expect(nameBox()).toBeInTheDocument();
    // The description is a tap away on the meal's own page; the sheet asks only
    // for what a meal cannot exist without.
    expect(screen.queryByTestId('recipe-new-description')).toBeNull();
  });

  it('names the entry it is creating', async () => {
    show('outing');
    await waitFor(() => expect(screen.getByText('When you CBA')).toBeInTheDocument());

    cleanup();
    show('meal');
    await waitFor(() => expect(screen.getByText('A meal')).toBeInTheDocument());
  });
});

describe('RecipeNewSheet — nothing is written until it is real', () => {
  // The disabled button is the ENFORCEMENT, not a hint in front of a second check
  // inside the handler — so this asserts both halves: the button is disabled AND
  // clicking it writes nothing. That is what makes removing the handler's own
  // unreachable `canCreate` re-check safe rather than a quiet loss.
  it('refuses Create with no name, and clicking it anyway writes nothing', async () => {
    show('outing');

    await waitFor(() => expect(createButton()).toBeDisabled());
    await fireEvent.click(createButton());
    expect(persistRecipe).not.toHaveBeenCalled();
  });

  it('refuses Create on whitespace alone', async () => {
    show('outing');
    await typeName('   ');

    await waitFor(() => expect(createButton()).toBeDisabled());
  });

  it('refuses a meal until it has a dish — no empty meal can be minted', async () => {
    show('meal');
    await typeName('Sunday roast');

    // A name is not enough: without a dish the document would be an ordinary
    // recipe under another name, which is exactly what #752 refused.
    await waitFor(() => expect(createButton()).toBeDisabled());

    await pickDish('Onion gravy');

    await waitFor(() => expect(createButton()).toBeEnabled());
  });

  it('refuses a meal again once its last dish is removed', async () => {
    show('meal');
    await typeName('Sunday roast');
    await pickDish('Onion gravy');
    await waitFor(() => expect(createButton()).toBeEnabled());

    await fireEvent.click(screen.getByTestId('recipe-new-dish-remove-gravy'));

    await waitFor(() => expect(createButton()).toBeDisabled());
    expect(dishRowTitles()).toEqual([]);
  });
});

describe('RecipeNewSheet — what it writes', () => {
  it('writes an outing with its name and description, trimmed', async () => {
    show('outing');
    await typeName('  Curry from the corner  ');
    await fireEvent.input(screen.getByTestId('recipe-new-description'), {
      target: { value: '  Ask for it extra hot.  ' },
    });

    await fireEvent.click(createButton());

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    const doc = written();
    expect(doc.kind).toBe('outing');
    expect(doc.title).toBe('Curry from the corner');
    expect(doc.description).toBe('Ask for it extra hot.');
    expect(doc.componentRecipeIds).toEqual([]);
  });

  it('leaves an empty description null rather than storing a blank string', async () => {
    show('outing');
    await typeName('A night off');

    await fireEvent.click(createButton());

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    expect(written().description).toBeNull();
  });

  it('writes a placeholder under its own kind', async () => {
    show('placeholder');
    await typeName('Something warm');

    await fireEvent.click(createButton());

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    expect(written().kind).toBe('placeholder');
  });

  it('writes a meal as an ordinary recipe that already has its dishes', async () => {
    show('meal');
    await typeName('Sunday roast');
    await pickDish('Onion gravy');
    await pickDish('Roast chicken');

    await fireEvent.click(createButton());

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    const doc = written();
    // There is no `meal` kind — a meal is a recipe that has components, which is
    // what makes `sectionOf` file it under Meals with nothing else stored.
    expect(doc.kind).toBe('recipe');
    // Ordering is the domain's (`insertComponentByElapsedTime`, longest-cooking
    // first), so the 90-minute chicken leads the 20-minute gravy despite being
    // picked second. The sheet computes no index of its own.
    expect(doc.componentRecipeIds).toEqual(['chicken', 'gravy']);
    expect(doc.description).toBeNull();
  });
});

describe('RecipeNewSheet — where it leaves you', () => {
  it('closes, asks for edit mode and navigates to the entry — in that order', async () => {
    show('outing');
    await typeName('A night off');

    await fireEvent.click(createButton());

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const id = written().id;
    expect(push).toHaveBeenCalledWith(`/recipes/${id}`);
    // The page it lands on reads this on the same turn it mounts.
    expect(takeEditOnArrival(id)).toBe(true);
    // And the sheet is gone rather than sitting over the page you just landed on.
    await waitFor(() => expect(screen.queryByTestId('recipe-new-name')).toBeNull());
  });

  it('records the creation as a hand-written one', async () => {
    show('placeholder');
    await typeName('Something warm');

    await fireEvent.click(createButton());

    await waitFor(() => expect(trackUsageEvent).toHaveBeenCalledTimes(1));
    expect(trackUsageEvent).toHaveBeenCalledWith('recipe.created', {
      recipe_id: written().id,
      recipe_kind: 'placeholder',
      recipe_method: 'manual',
    });
  });

  it('says so when the write fails, and goes nowhere (Rule 10)', async () => {
    vi.mocked(persistRecipe).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    show('outing');
    await typeName('A night off');

    await fireEvent.click(createButton());

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addToast).mock.calls[0]![1]).toBe('destructive');
    // Nothing landed, so there is nowhere to go and nothing to edit — and the
    // sheet is still holding what was typed.
    expect(push).not.toHaveBeenCalled();
    expect(nameBox()).toHaveValue('A night off');
  });
});

describe('RecipeNewSheet — the dish picker', () => {
  it('offers only dishes you make — never an outing or a placeholder', async () => {
    show('meal');
    await openPicker();

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['Roast chicken', 'Roast potatoes', 'Onion gravy']);
  });

  it('drops a chosen dish out of the picker, so choosing it twice is not on offer', async () => {
    show('meal');
    await pickDish('Roast chicken');
    await openPicker();

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['Roast potatoes', 'Onion gravy']);
  });

  it('says when the filter matches nothing rather than showing an empty list', async () => {
    show('meal');
    await openPicker();
    await fireEvent.input(screen.getByTestId('recipe-new-dish-picker'), {
      target: { value: 'zzzz' },
    });

    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toEqual([]);
  });

  it('clears the picker after a pick so the next one starts empty', async () => {
    show('meal');
    await pickDish('Onion gravy');

    await waitFor(() => expect(screen.getByTestId('recipe-new-dish-picker')).toHaveValue(''));
  });

  it('names a chosen dish that has since left the library rather than showing a blank row', async () => {
    show('meal');
    await pickDish('Onion gravy');
    expect(dishRowTitles()).toEqual(['Onion gravy']);

    mockRecipes._set(LIBRARY.filter((r) => r.id !== 'gravy'));

    await waitFor(() => expect(dishRowTitles()).toEqual(['No longer in the library']));
  });
});

describe('RecipeNewSheet — a reopened sheet starts clean', () => {
  it('forgets the name somebody typed and backed out of', async () => {
    const { rerender } = show('outing');
    await typeName('Abandoned');
    expect(nameBox()).toHaveValue('Abandoned');

    await rerender({ mode: 'outing', open: false });
    await rerender({ mode: 'outing', open: true });

    await waitFor(() => expect(nameBox()).toHaveValue(''));
  });

  it('forgets the dishes chosen for a meal somebody backed out of', async () => {
    const { rerender } = show('meal');
    await pickDish('Onion gravy');
    expect(dishRowTitles()).toEqual(['Onion gravy']);

    await rerender({ mode: 'meal', open: false });
    await rerender({ mode: 'meal', open: true });

    await waitFor(() => expect(dishRowTitles()).toEqual([]));
  });

  it('mints a new id per opening, so two entries are never written over one another', async () => {
    const { rerender } = show('outing');
    await typeName('First');
    await fireEvent.click(createButton());
    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));
    const firstId = written().id;

    await rerender({ mode: 'outing', open: false });
    await rerender({ mode: 'outing', open: true });
    await waitFor(() => expect(nameBox()).toHaveValue(''));
    await typeName('Second');
    await fireEvent.click(createButton());

    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(2));
    expect(vi.mocked(persistRecipe).mock.calls[1]![0].id).not.toBe(firstId);
  });

  it('is usable again after being dismissed while its write was still in flight', async () => {
    // A write that never settles, which is what a dismissal mid-flight leaves
    // behind. Reset on the way IN rather than in a close handler, so it holds
    // however the sheet was dismissed.
    vi.mocked(persistRecipe).mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = show('outing');
    await typeName('Interrupted');
    await fireEvent.click(createButton());
    await waitFor(() => expect(persistRecipe).toHaveBeenCalledTimes(1));

    await rerender({ mode: 'outing', open: false });
    await rerender({ mode: 'outing', open: true });
    await waitFor(() => expect(nameBox()).toHaveValue(''));
    await typeName('Second go');

    // Still `busy` and Create would be dead for the rest of the session.
    await waitFor(() => expect(createButton()).toBeEnabled());
  });
});
