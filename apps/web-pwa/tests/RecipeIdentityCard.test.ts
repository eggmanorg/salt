import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe } from '@salt/domain';
import type { Member, Recipe } from '@salt/domain';

// The recipe page's identity card, in both of its modes (issue #1319).
//
// Two properties carry the whole feature and each is asserted from the outside,
// on rendered markup rather than on a flag:
//
//   READ MODE IS UNCHANGED. No pencil, no dashed slot, and no control where
//   there used to be text — "nothing is tappable by accident" is the promise the
//   mode exists to keep, and it is only checkable by looking.
//
//   EDIT MODE REVEALS WHAT IS ABSENT. A recipe with no servings and no source
//   shows those as dashed slots while editing and nothing at all otherwise,
//   which is the reason a mode was chosen over always-live fields.
//
// Each field is then driven the way a person drives it — open it, type into it —
// and the whole next recipe handed to `onEdit` is asserted, because that is the
// document that gets written.

const { mockCanonItems, mockPeople, mockRecipes } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCanonItems: makeStore<readonly { id: string; name: string; synonyms: string[] }[]>([]),
    mockPeople: makeStore<readonly Pick<Member, 'name'>[]>([]),
    mockRecipes: makeStore<readonly Recipe[]>([]),
  };
});

vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/membersService.js', () => ({ people: mockPeople }));
vi.mock('../src/lib/recipeService.js', () => ({ recipes: mockRecipes }));

const NOW = '2026-01-01T00:00:00.000Z';

import RecipeIdentityCard from '../src/routes/recipes/RecipeIdentityCard.svelte';

function entry(overrides: Partial<Recipe> = {}): Recipe {
  return { ...emptyRecipe('r1', NOW), title: 'Carbonara', ...overrides };
}

let onEdit: ReturnType<typeof vi.fn>;

function show(recipe: Recipe, editing: boolean) {
  onEdit = vi.fn();
  return render(RecipeIdentityCard, { props: { recipe, editing, onEdit } });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
  mockPeople._set([]);
  mockRecipes._set([]);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipeIdentityCard — read mode', () => {
  it('offers nothing to tap: no pencils, no dashed slots', () => {
    show(entry({ description: 'Silky', metadata: { servings: 4, tags: ['weeknight'] } }), false);

    expect(screen.getByText('Silky')).toBeTruthy();
    expect(screen.getByText('Serves 4')).toBeTruthy();
    for (const id of [
      'recipe-edit-description',
      'recipe-edit-servings',
      'recipe-edit-tags',
      'recipe-edit-source',
      'recipe-edit-produces',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it.each([
    { shape: 'an empty url', source: { type: 'url' as const, url: '' } },
    { shape: 'no url at all', source: { type: 'url' as const } },
  ])('shows no link for a url source with $shape', ({ source }) => {
    show(entry({ source }), false);

    expect(screen.queryByTestId('recipe-source-link')).toBeNull();
  });

  it('shows no "Makes" chip once the grocery item it pointed at is gone', () => {
    mockCanonItems._set([]);
    show(entry({ producesCanonId: 'deleted' }), false);

    expect(screen.queryByTestId('recipe-produces-chip')).toBeNull();
  });

  it('says nothing at all about fields the recipe has never filled in', () => {
    show(entry({ description: 'Silky' }), false);

    expect(screen.queryByText(/Serves/)).toBeNull();
    expect(screen.queryByTestId('recipe-source-link')).toBeNull();
  });

  it('earns the card on timing alone — a recipe whose only stated fact is its phases', () => {
    show(
      entry({
        metadata: {
          servings: null,
          tags: [],
          phases: [{ label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 40 }],
        },
      }),
      false,
    );

    expect(screen.getByTestId('recipe-phases')).toBeTruthy();
  });

  it('keeps a fact chip a span, never a control (ui-spec-v09 §8.23.8)', () => {
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(entry({ producesCanonId: 'c1' }), false);

    const chip = screen.getByTestId('recipe-produces-chip');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('role')).toBeNull();
  });
});

describe('RecipeIdentityCard — edit mode', () => {
  it('reveals an absent field as a dashed slot offering to add it', () => {
    show(entry({ description: 'Silky' }), true);

    expect(screen.getByTestId('recipe-edit-servings').textContent).toContain('Servings');
    expect(screen.getByTestId('recipe-edit-source').textContent).toContain('Source link');
  });

  it('writes the description as it is typed, with no save', async () => {
    show(entry({ description: 'Silky' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-description'));
    await fireEvent.input(screen.getByTestId('recipe-description-input'), {
      target: { value: 'Silky and quick' },
    });

    expect(lastEdit().description).toBe('Silky and quick');
  });

  it('reads an emptied description as absent rather than as an empty string', async () => {
    show(entry({ description: 'Silky' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-description'));
    await fireEvent.input(screen.getByTestId('recipe-description-input'), {
      target: { value: '   ' },
    });

    expect(lastEdit().description).toBeNull();
  });

  it('starts an absent description from an empty box, not from the word null', async () => {
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-description'));

    expect((screen.getByTestId('recipe-description-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('prompts an empty tag box and stops prompting once there is a tag', async () => {
    show(entry(), true);
    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    expect(screen.getByTestId('recipe-tags-input').getAttribute('placeholder')).toBe('Add tags…');

    cleanup();
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);
    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    expect(screen.getByTestId('recipe-tags-input').getAttribute('placeholder')).toBe('');
  });

  it('takes a serving count from the dashed slot', async () => {
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-servings'));
    await fireEvent.input(screen.getByTestId('recipe-servings-input'), { target: { value: '6' } });

    expect(lastEdit().metadata.servings).toBe(6);
  });

  it('reads an emptied serving box as "not stated", not as zero', async () => {
    show(entry({ metadata: { servings: 4, tags: [] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-servings'));
    await fireEvent.input(screen.getByTestId('recipe-servings-input'), { target: { value: '' } });

    expect(lastEdit().metadata.servings).toBeNull();
  });

  it('adds a tag on Enter and normalises it', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    const input = screen.getByTestId('recipe-tags-input');
    await fireEvent.input(input, { target: { value: 'Summer' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEdit().metadata.tags).toEqual(['weeknight', 'summer']);
  });

  it('removes a tag from the row that holds it', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight', 'summer'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.click(screen.getByLabelText('Remove summer'));

    expect(lastEdit().metadata.tags).toEqual(['weeknight']);
  });

  it('marks the recipe url-sourced when a source link is typed in', async () => {
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-source'));
    await fireEvent.input(screen.getByTestId('recipe-source-input'), {
      target: { value: 'https://example.com/carbonara' },
    });

    expect(lastEdit().source).toEqual({ type: 'url', url: 'https://example.com/carbonara' });
  });

  it('clears the source entirely when the link is emptied', async () => {
    show(entry({ source: { type: 'url', url: 'https://example.com/carbonara' } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-source'));
    await fireEvent.input(screen.getByTestId('recipe-source-input'), { target: { value: '' } });

    expect(lastEdit().source).toBeNull();
  });

  // Nothing to pick from is not a control: an empty roster — still loading, or a
  // permission-denied stream — would otherwise offer a slot that opens on
  // nothing. A name already ON the recipe is itself something to pick from, so
  // the slot is offered for that alone.
  it('offers no "Added by" slot when there is nothing at all to pick from', () => {
    show(entry(), true);

    expect(screen.queryByTestId('recipe-edit-added-by')).toBeNull();
  });

  it('offers "Added by" once there is a roster, or a name already on the record', () => {
    show(entry({ createdBy: 'Sam Vale' }), true);
    expect(screen.getByTestId('recipe-edit-added-by')).toBeTruthy();

    cleanup();
    mockPeople._set([{ name: 'Sam Vale' }]);
    show(entry(), true);
    expect(screen.getByTestId('recipe-edit-added-by')).toBeTruthy();
  });

  it('takes a tag straight from the suggestions the library already uses', async () => {
    mockRecipes._set([entry({ id: 'other', metadata: { servings: null, tags: ['summer'] } })]);
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.click(screen.getByText('+ summer'));

    expect(lastEdit().metadata.tags).toEqual(['weeknight', 'summer']);
  });

  it('suggests only tags this recipe does not already carry', async () => {
    mockRecipes._set([entry({ id: 'other', metadata: { servings: null, tags: ['weeknight'] } })]);
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));

    expect(screen.queryByText('+ weeknight')).toBeNull();
  });

  it('drops the last tag on Backspace in an empty box', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight', 'summer'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.keyDown(screen.getByTestId('recipe-tags-input'), { key: 'Backspace' });

    expect(lastEdit().metadata.tags).toEqual(['weeknight']);
  });

  // Escape closes the field and keeps what is typed. There is nothing held back
  // to discard — the write already happened — so a reverting Escape would need an
  // undo buffer this design does not have.
  it('closes the tag box on Escape without discarding anything', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.keyDown(screen.getByTestId('recipe-tags-input'), { key: 'Escape' });

    expect(screen.queryByTestId('recipe-tags-input')).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('ignores a keystroke that is neither a separator nor an edit', async () => {
    show(entry({ metadata: { servings: null, tags: [] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.keyDown(screen.getByTestId('recipe-tags-input'), { key: 'a' });

    expect(onEdit).not.toHaveBeenCalled();
  });

  /** The grocery suggestions the picker is currently offering. */
  function offeredGroceries(): string[] {
    return [...document.querySelectorAll('[role="option"]')].map((el) =>
      (el.textContent ?? '').trim(),
    );
  }

  it('finds a grocery item by its name or by one of its synonyms', async () => {
    const user = userEvent.setup();
    mockCanonItems._set([
      { id: 'c1', name: 'Mayonnaise', synonyms: ['mayo'] },
      { id: 'c2', name: 'Garlic', synonyms: [] },
    ]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));
    const input = screen.getByPlaceholderText('Search grocery items…');
    await user.click(input);
    await user.type(input, 'mayo');

    expect(offeredGroceries()).toEqual(['Mayonnaise']);
  });

  it('says so plainly when nothing in the groceries matches', async () => {
    const user = userEvent.setup();
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));
    const input = screen.getByPlaceholderText('Search grocery items…');
    await user.click(input);
    await user.type(input, 'quinoa');

    expect(offeredGroceries()).toEqual([]);
    expect(screen.getByText('No grocery items found')).toBeTruthy();
  });

  it('links the recipe to the grocery item picked', async () => {
    const user = userEvent.setup();
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));
    const input = screen.getByPlaceholderText('Search grocery items…');
    await user.click(input);
    await user.type(input, 'mayo');
    await user.click(document.querySelector('[role="option"]')!);

    expect(lastEdit().producesCanonId).toBe('c1');
  });

  it('closes the tag box when it is finished with', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.click(screen.getByText('Done'));

    expect(screen.queryByTestId('recipe-tags-input')).toBeNull();
  });

  it('unlinks what the recipe makes without leaving the page', async () => {
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: ['mayo'] }]);
    show(entry({ producesCanonId: 'c1' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));
    await fireEvent.click(screen.getByTestId('recipe-produces-clear'));

    expect(lastEdit().producesCanonId).toBeNull();
  });

  it('offers no Clear when nothing is linked yet', async () => {
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));

    expect(screen.getByTestId('recipe-produces')).toBeTruthy();
    expect(screen.queryByTestId('recipe-produces-clear')).toBeNull();
  });

  it('opens the "Added by" picker on the name already recorded', async () => {
    mockPeople._set([{ name: 'Sam Vale' }, { name: 'Ada Vale' }]);
    show(entry({ createdBy: 'Sam Vale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-added-by'));

    expect(screen.getByTestId('recipe-added-by-select').textContent).toContain('Sam');
  });

  it('says "Not recorded" rather than a placeholder person when nobody is on record', async () => {
    mockPeople._set([{ name: 'Sam Vale' }]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-added-by'));

    expect(screen.getByTestId('recipe-added-by-select').textContent).toContain('Not recorded');
  });

  // Attribution is a record that can be WRONG — every recipe predating the field
  // got its name from a backfill that could only guess — so putting it right is
  // the point of the picker. The stored value stays the verbatim `Member.name`;
  // only the label is shortened to a first name.
  it('puts a wrong "Added by" right, storing the full name', async () => {
    const user = userEvent.setup();
    mockPeople._set([{ name: 'Sam Vale' }, { name: 'Ada Vale' }]);
    show(entry({ createdBy: 'Sam Vale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-added-by'));
    await user.click(screen.getByTestId('recipe-added-by-select'));
    await user.click(screen.getByRole('option', { name: 'Ada' }));

    expect(lastEdit().createdBy).toBe('Ada Vale');
  });

  it('closes the grocery picker when it is finished with', async () => {
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-produces'));
    await fireEvent.click(screen.getByText('Done'));

    expect(screen.queryByTestId('recipe-produces')).toBeNull();
  });

  it('closes a field again once it is finished with', async () => {
    mockPeople._set([{ name: 'Sam Vale' }]);
    show(entry({ createdBy: 'Sam Vale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-added-by'));
    await fireEvent.click(screen.getByText('Done'));

    expect(screen.queryByTestId('recipe-added-by-select')).toBeNull();
  });

  it('offers no servings slot on an entry that is not cooked', () => {
    show(entry({ kind: 'outing' }), true);

    expect(screen.queryByTestId('recipe-edit-servings')).toBeNull();
  });
});
