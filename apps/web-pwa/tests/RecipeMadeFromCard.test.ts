import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { emptyRecipe, resolveComponents } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// "Made from" — the dishes a meal is built out of, now written where they are read
// (issue #1319, Phase 3).
//
// What this suite is built to catch, rather than what the component happens to do:
//
//   READ MODE IS UNTOUCHED. A component card is still a tap that navigates to that
//   dish, and there is no pencil, no row and no picker on a page nobody has told
//   to be editable. The read markup itself stays pinned by the page's own
//   `RecipeViewPage.components.test.ts`, which still drives it through this card.
//
//   ADDING IS THE ONE IMMEDIATE WRITE, and it is `attachComponentToMeal` — so the
//   longest-cooking-first ordering and the self/duplicate guards stay in the
//   domain and are not re-expressed here. Remove and reorder go out through
//   `onEdit` like every other in-place edit, and the two paths are asserted
//   SEPARATELY so a later refactor that collapses them has to say so.
//
//   ADDING THE SAME DISH TWICE CHANGES NOTHING. The picker drops what is already
//   attached, so the second tap is not there to be made — which is the honest
//   place that outcome is enforced, and it is asserted on the picker's own options
//   rather than on a write nobody can issue.
//
//   A DANGLING ID IS A ROW YOU CAN SEE AND REMOVE. The read view skips a dish
//   deleted elsewhere; the EDIT rows iterate the stored ids instead, so reordering
//   cannot silently drop a reference the cook was never shown.
//
//   NO EDITING STATE OUTLIVES ITS RECIPE — and this surface holds no draft at all,
//   so unlike the timing strip a concurrent write to the SAME meal repaints the
//   rows. That is intended here (there is no text in flight to protect) and is
//   pinned as behaviour rather than left an untested consequence.
//
//   THE CARD DECIDES WHETHER IT EXISTS (issue #1343), and the two halves of that
//   gate are asserted separately. PRESENCE is what a reader sees — an ordinary
//   recipe shows no card at all. CAPABILITY is what an editor gets — a dashed
//   `+ Dishes` slot on a kind `takesComponents` admits, which is the only door
//   left that turns an ordinary recipe into a meal once the old editor is gone.
//
//   A MEAL IS NOT DEMOTED UNDER THE FINGER THAT EMPTIED IT — on a kind
//   `takesComponents` admits, which is every kind the conversion can reach.
//   Removing the last dish leaves the card, the rows and the picker where they
//   were; the slot comes back when the zone is closed and the card goes when edit
//   mode ends. Every step of that is a case below. The qualifier is load-bearing
//   and is NOT covered by a case: on a kind that takes no components but already
//   carries ids — the document "still shows the card for a kind that takes no
//   dishes but already carries some" mounts — emptying it drops both clauses of
//   the gate at once and the card does unmount. That state is unreachable in the
//   app today; `RecipeMadeFromCard.svelte`'s header says why, and says what would
//   have to change for it to stop being unreachable.

const { mockRecipes } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return { mockRecipes: makeStore<readonly Recipe[]>([]) };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  attachComponentToMeal: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import { push } from 'svelte-spa-router';
import { addToast } from '../src/lib/toastStore.js';
import { attachComponentToMeal } from '../src/lib/recipeService.js';
import RecipeMadeFromCard from '../src/routes/recipes/RecipeMadeFromCard.svelte';

const NOW = '2026-01-01T00:00:00.000Z';
const MEAL_ID = 'roast';

// Stands in for the page's own "New" menu — the card renders it and owns nothing
// about it, so a button with the page's testid is all this suite needs to see it
// survive both modes.
const NEW_MENU = createRawSnippet(() => ({
  render: () => '<button data-testid="meal-component-new-btn" type="button">New</button>',
}));

function dish(id: string, title: string, elapsed: number | null = null): Recipe {
  const base = emptyRecipe(id, NOW);
  return {
    ...base,
    title,
    metadata: {
      ...base.metadata,
      // The row's time comes from the strip and nothing else (issue #1213).
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

function meal(componentRecipeIds: string[]): Recipe {
  return { ...emptyRecipe(MEAL_ID, NOW), title: 'Sunday roast', componentRecipeIds };
}

/** The same entry under another kind — what `takesComponents` is asked about. */
function ofKind(kind: 'cocktail' | 'outing' | 'placeholder', ids: string[] = []): Recipe {
  return { ...emptyRecipe(MEAL_ID, NOW, kind), title: 'Sunday roast', componentRecipeIds: ids };
}

/** Did the card mount at all? Its title is the only thing it always renders. */
function cardIsThere(): boolean {
  return screen.queryByText('Made from') !== null;
}

let onEdit: ReturnType<typeof vi.fn>;

/**
 * Mount the card the way the page mounts it: the library in the store, and
 * `components` resolved by the REAL `resolveComponents` the page uses rather than
 * a hand-written list — so a fixture cannot quietly disagree with the one-level
 * resolution this card is documented against (#1319 standing requirement 4).
 */
function props(recipe: Recipe, editing: boolean, library: readonly Recipe[]) {
  return {
    recipe,
    editing,
    onEdit,
    components: resolveComponents(recipe, [recipe, ...library]),
    newMenu: NEW_MENU,
  };
}

function show(recipe: Recipe, editing: boolean, library: readonly Recipe[] = LIBRARY) {
  mockRecipes._set([recipe, ...library]);
  onEdit = vi.fn();
  return render(RecipeMadeFromCard, { props: props(recipe, editing, library) });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

async function openRows(): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-edit-components'));
}

function rowTitles(): string[] {
  return screen
    .queryAllByTestId('recipe-edit-component-row')
    .map((el) => el.querySelector('span.truncate')?.textContent?.trim() ?? '');
}

function readTitles(): string[] {
  return screen
    .queryAllByTestId('recipe-component-card')
    .map((el) => el.querySelector('span.truncate')?.textContent?.trim() ?? '');
}

// `fireEvent`, not `userEvent`, for the reason MealDayEditor.recipePicker.test.ts
// records: a synthetic focus shuffle can tear a bits-ui listbox down before the
// click lands.
async function openPicker(): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-edit-component-picker'));
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  mockRecipes._set([]);
  vi.clearAllMocks();
});

describe('RecipeMadeFromCard — reading the dishes', () => {
  it('offers no pencil, no rows and no picker until the page is in edit mode', () => {
    show(meal(['chicken', 'gravy']), false);

    expect(readTitles()).toEqual(['Roast chicken', 'Onion gravy']);
    expect(screen.queryByTestId('recipe-edit-components')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-component-rows')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-component-picker')).toBeNull();
  });

  it('still navigates to a dish when its card is tapped', async () => {
    show(meal(['chicken']), false);

    await fireEvent.click(screen.getByTestId('recipe-component-card'));

    expect(push).toHaveBeenCalledWith('/recipes/chicken');
  });

  it('says so plainly when every dish has been deleted, and still offers the editor', async () => {
    show(meal(['chicken']), true, []);

    expect(readTitles()).toEqual([]);
    expect(
      screen.getByText('The dishes this was built from are no longer in the library.'),
    ).toBeInTheDocument();

    // The reference is what is left to remove, so the region stays editable.
    await openRows();
    expect(rowTitles()).toEqual(['No longer in the library']);
  });

  it('keeps the "New" menu the page passes in, in both modes', async () => {
    show(meal(['chicken']), true);
    expect(screen.getByTestId('meal-component-new-btn')).toBeInTheDocument();

    await openRows();
    expect(screen.getByTestId('meal-component-new-btn')).toBeInTheDocument();
  });
});

describe('RecipeMadeFromCard — editing the dishes', () => {
  it('shows one row per stored dish, in stored order, once the pencil is pressed', async () => {
    show(meal(['chicken', 'potatoes', 'gravy']), true);
    expect(rowTitles()).toEqual([]);

    await openRows();

    expect(rowTitles()).toEqual(['Roast chicken', 'Roast potatoes', 'Onion gravy']);
  });

  it('removes a dish without touching the others', async () => {
    show(meal(['chicken', 'potatoes']), true);
    await openRows();

    await fireEvent.click(screen.getByTestId('recipe-edit-component-remove-chicken'));

    expect(lastEdit().componentRecipeIds).toEqual(['potatoes']);
  });

  it('moves a dish down, and the two ends are inert', async () => {
    show(meal(['chicken', 'potatoes', 'gravy']), true);
    await openRows();

    const down = screen.getAllByLabelText('Move dish down');
    expect(down[2]!).toBeDisabled();
    expect(screen.getAllByLabelText('Move dish up')[0]!).toBeDisabled();

    await fireEvent.click(down[0]!);

    expect(lastEdit().componentRecipeIds).toEqual(['potatoes', 'chicken', 'gravy']);
  });

  it('removes a reference whose dish was deleted elsewhere, keeping the rest', async () => {
    show(meal(['chicken', 'deleted-elsewhere']), true);
    // The read view skips it entirely; the editor shows it, which is the only
    // place it can be got rid of.
    expect(readTitles()).toEqual(['Roast chicken']);

    await openRows();
    expect(rowTitles()).toEqual(['Roast chicken', 'No longer in the library']);

    await fireEvent.click(screen.getByTestId('recipe-edit-component-remove-deleted-elsewhere'));

    expect(lastEdit().componentRecipeIds).toEqual(['chicken']);
  });

  it('keeps a dangling reference in place when the list is reordered', async () => {
    show(meal(['chicken', 'deleted-elsewhere', 'gravy']), true);
    await openRows();

    await fireEvent.click(screen.getAllByLabelText('Move dish down')[0]!);

    expect(lastEdit().componentRecipeIds).toEqual(['deleted-elsewhere', 'chicken', 'gravy']);
  });

  it('closes back to the read list when Done is pressed', async () => {
    show(meal(['chicken']), true);
    await openRows();
    expect(rowTitles()).toEqual(['Roast chicken']);

    await fireEvent.click(screen.getByTestId('recipe-edit-components-done'));

    expect(rowTitles()).toEqual([]);
    expect(readTitles()).toEqual(['Roast chicken']);
  });
});

describe('RecipeMadeFromCard — adding a dish', () => {
  it('offers only dishes you make — never itself, an outing or a placeholder', async () => {
    show(meal([]), true);
    await openRows();
    await openPicker();

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['Roast chicken', 'Roast potatoes', 'Onion gravy']);
  });

  it('drops an attached dish out of the picker, so adding it twice is not on offer', async () => {
    show(meal(['chicken']), true);
    await openRows();
    await openPicker();

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(options).toEqual(['Roast potatoes', 'Onion gravy']);
  });

  it('says when the filter matches nothing rather than showing an empty list', async () => {
    show(meal([]), true);
    await openRows();
    await openPicker();
    await fireEvent.input(screen.getByTestId('recipe-edit-component-picker'), {
      target: { value: 'zzzz' },
    });

    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toEqual([]);
  });

  it('attaches through the domain-ordered write path, not through onEdit', async () => {
    show(meal([]), true);
    await openRows();
    await openPicker();

    await fireEvent.click(await screen.findByRole('option', { name: 'Onion gravy' }));

    await waitFor(() => expect(attachComponentToMeal).toHaveBeenCalledWith(MEAL_ID, 'gravy'));
    // Where it lands is the domain's answer (`insertComponentByElapsedTime`), so
    // this surface composes no `componentRecipeIds` of its own for an attach.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('says so when the attach fails (Rule 10), rather than failing silently', async () => {
    vi.mocked(attachComponentToMeal).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'recipe', id: MEAL_ID },
    });
    show(meal([]), true);
    await openRows();
    await openPicker();

    await fireEvent.click(await screen.findByRole('option', { name: 'Onion gravy' }));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addToast).mock.calls[0]![1]).toBe('destructive');
  });

  it('clears the picker after an attach so the next one starts empty', async () => {
    show(meal([]), true);
    await openRows();
    await openPicker();

    await fireEvent.click(await screen.findByRole('option', { name: 'Onion gravy' }));

    await waitFor(() => expect(screen.getByTestId('recipe-edit-component-picker')).toHaveValue(''));
  });
});

describe('RecipeMadeFromCard — what the rows are fed from', () => {
  // Standing requirement 1 (#1326/#1331's recurring finding). `/recipes/:id` is one
  // route, so a "Made from" tap moves `params.id` and reuses this instance. The
  // page's own id-keyed `$effect` closes `editing` first, but this holds
  // `editing: true` across the swap to pin that nothing here carries the old
  // document's list into the new one.
  it('shows the new meal’s dishes when the document changes under an open editor', async () => {
    const { rerender } = show(meal(['chicken']), true);
    await openRows();
    expect(rowTitles()).toEqual(['Roast chicken']);

    const other: Recipe = { ...meal(['gravy']), id: 'other-meal' };
    await rerender(props(other, true, LIBRARY));

    expect(rowTitles()).toEqual(['Onion gravy']);
  });

  // The other half, and the OPPOSITE answer to the timing strip's (#1332 review,
  // blocking 1): this surface holds no draft, because every gesture on it is a tap
  // that writes as it happens and there is no text in flight for a snapshot to
  // land on top of. So a concurrent write to the SAME meal — another phone, or a
  // chat amendment applied in the docked pane — shows up in the rows at once.
  // Pinned as intended behaviour, and as the boundary on the header's claim: it is
  // "there is no text to protect", not "nothing ever repaints".
  it('shows a concurrent write to the same meal while the rows are open', async () => {
    const m = meal(['chicken']);
    const { rerender } = show(m, true);
    await openRows();
    expect(rowTitles()).toEqual(['Roast chicken']);

    const moved: Recipe = { ...m, componentRecipeIds: ['chicken', 'gravy'] };
    await rerender(props(moved, true, LIBRARY));

    expect(rowTitles()).toEqual(['Roast chicken', 'Onion gravy']);
  });
});

describe('RecipeMadeFromCard — who gets the card at all', () => {
  it('shows nothing whatever on an ordinary recipe being read', () => {
    show(meal([]), false);

    expect(cardIsThere()).toBe(false);
    expect(screen.queryByTestId('recipe-edit-components')).toBeNull();
  });

  it('offers an ordinary recipe a dashed “+ Dishes” slot in edit mode, and the picker behind it', async () => {
    show(meal([]), true);

    expect(cardIsThere()).toBe(true);
    const slot = screen.getByTestId('recipe-edit-components');
    expect(slot).toHaveTextContent('+ Dishes');
    // Nothing is open until it is pressed — the slot is the door, not the editor.
    expect(screen.queryByTestId('recipe-edit-component-picker')).toBeNull();

    await openRows();

    expect(screen.getByTestId('recipe-edit-component-picker')).toBeInTheDocument();
  });

  it('offers the slot on a cocktail, because that is what the domain says', () => {
    // `takesComponents`, never `kind === 'recipe'` (CLAUDE.md → Data model
    // conventions). A cocktail is the domain's existing answer, so this case goes
    // red the moment the gate becomes a comparison against a kind.
    show(ofKind('cocktail'), true);

    expect(screen.getByTestId('recipe-edit-components')).toHaveTextContent('+ Dishes');
  });

  it('never offers it on an outing or a placeholder, in either mode', () => {
    for (const kind of ['outing', 'placeholder'] as const) {
      for (const editing of [false, true]) {
        show(ofKind(kind), editing);
        expect(cardIsThere()).toBe(false);
        cleanup();
      }
    }
  });

  it('still shows the card for a kind that takes no dishes but already carries some', async () => {
    // The gate's stated boundary rather than an unqualified absolute: presence is
    // the FIRST clause, so a document with dishes on it reads as a meal whatever
    // kind it declares — which is the only way such an entry stays editable at
    // all.
    show(ofKind('outing', ['chicken']), false);
    expect(readTitles()).toEqual(['Roast chicken']);

    cleanup();
    show(ofKind('outing', ['chicken']), true);
    await openRows();
    expect(rowTitles()).toEqual(['Roast chicken']);
  });

  it('keeps the “New” menu off the dashed-slot path, and on a meal', async () => {
    // The card's gate and the page's dialog gate are one predicate in two files;
    // `RecipeViewPage.mealComponents.test.ts` pins them against each other. This
    // is the card's end of it.
    show(meal([]), true);
    expect(screen.queryByTestId('meal-component-new-btn')).toBeNull();
    await openRows();
    expect(screen.queryByTestId('meal-component-new-btn')).toBeNull();

    cleanup();
    show(meal(['chicken']), true);
    expect(screen.getByTestId('meal-component-new-btn')).toBeInTheDocument();
  });
});

describe('RecipeMadeFromCard — a meal emptied while it is being edited', () => {
  it('keeps the card, the rows and the picker when the last dish is taken off', async () => {
    const { rerender } = show(meal(['chicken']), true);
    await openRows();

    await fireEvent.click(screen.getByTestId('recipe-edit-component-remove-chicken'));
    expect(lastEdit().componentRecipeIds).toEqual([]);

    // The page writes it and hands the emptied document back, which is where the
    // old presence gate used to pull the card out from under the gesture.
    await rerender(props(meal([]), true, LIBRARY));

    expect(cardIsThere()).toBe(true);
    expect(screen.getByTestId('recipe-edit-component-rows')).toBeInTheDocument();
    expect(rowTitles()).toEqual([]);
    expect(screen.getByTestId('recipe-edit-component-picker')).toBeInTheDocument();
  });

  it('comes back as the dashed slot when the zone is closed, not as an empty list', async () => {
    const { rerender } = show(meal(['chicken']), true);
    await openRows();
    await rerender(props(meal([]), true, LIBRARY));

    await fireEvent.click(screen.getByTestId('recipe-edit-components-done'));

    expect(cardIsThere()).toBe(true);
    expect(screen.getByTestId('recipe-edit-components')).toHaveTextContent('+ Dishes');
    expect(readTitles()).toEqual([]);
  });

  it('lets go of the card when edit mode ends, which is where the demotion lands', async () => {
    const { rerender } = show(meal(['chicken']), true);
    await openRows();
    await rerender(props(meal([]), true, LIBRARY));

    // Done on the page, not on the zone: `editing` goes false and the gate is back
    // to presence alone.
    await rerender(props(meal([]), false, LIBRARY));

    expect(cardIsThere()).toBe(false);
  });
});
