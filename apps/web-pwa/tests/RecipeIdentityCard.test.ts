import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// The recipe page's identity card, in both of its modes (issue #1324, Phase 3).
//
// Two properties carry the whole feature and each is asserted from the outside,
// on rendered markup rather than on a flag:
//
//   READ MODE IS UNCHANGED. No pencil, no dashed slot, and no control where
//   there used to be text — "nothing is tappable by accident" is the promise the
//   mode exists to keep, and it is only checkable by looking.
//
//   EDIT MODE REVEALS WHAT IS ABSENT. A recipe with no description and no source
//   shows those as dashed slots while editing and nothing at all otherwise,
//   which is the reason a mode was chosen over always-live fields.
//
// Each editable field is then driven the way a person drives it — open it, type
// into it — and the whole next recipe handed to `onEdit` is asserted, because
// that is the document that gets written.
//
// The three FACT pills are read-only in BOTH modes in this phase. What is pinned
// here is that they do not change when the mode does; making them editable is
// Phase 4's job and these assertions are what will have to be rewritten then.

const { mockCanonItems, mockRecipes } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCanonItems: makeStore<readonly { id: string; name: string; synonyms: string[] }[]>([]),
    mockRecipes: makeStore<readonly Recipe[]>([]),
  };
});

vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/recipeService.js', () => ({ recipes: mockRecipes }));

const NOW = '2026-01-01T00:00:00.000Z';

import RecipeIdentityCard from '../src/routes/recipes/RecipeIdentityCard.svelte';

function entry(overrides: Partial<Recipe> = {}): Recipe {
  return { ...emptyRecipe('r1', NOW), title: 'Carbonara', ...overrides };
}

let onEdit: ReturnType<typeof vi.fn>;
let setServings: ReturnType<typeof vi.fn>;

/**
 * The page's own scaling state, which this card renders and does not own. The
 * suite passes it explicitly so the read-mode pill is exercised at a number that
 * is NOT the stored one — the case where the two could disagree.
 */
function show(
  recipe: Recipe,
  editing: boolean,
  scaling: { base: number; active: number } | null = null,
) {
  onEdit = vi.fn();
  setServings = vi.fn();
  return render(RecipeIdentityCard, {
    props: {
      recipe,
      editing,
      onEdit,
      scaling,
      servingsOptions: (base: number, active: number) => [...new Set([base, active, 6])],
      setServings,
    },
  });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanonItems._set([]);
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
    for (const id of ['recipe-edit-description', 'recipe-edit-tags', 'recipe-edit-source']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('says nothing at all about a recipe with nothing to say', () => {
    show(entry(), false);

    expect(screen.queryByTestId('recipe-source-link')).toBeNull();
    expect(screen.queryByText(/Serves/)).toBeNull();
  });

  it.each([
    { shape: 'an empty url', source: { type: 'url' as const, url: '' } },
    { shape: 'no url at all', source: { type: 'url' as const } },
  ])('shows no link for a url source with $shape', ({ source }) => {
    show(entry({ source }), false);

    expect(screen.queryByTestId('recipe-source-link')).toBeNull();
  });

  it('links out to the original recipe when there is one', () => {
    show(entry({ source: { type: 'url', url: 'https://example.com/carbonara' } }), false);

    expect(screen.getByTestId('recipe-source-link').getAttribute('href')).toBe(
      'https://example.com/carbonara',
    );
  });

  it('shows no "Makes" chip once the grocery item it pointed at is gone', () => {
    mockCanonItems._set([]);
    show(entry({ producesCanonId: 'deleted' }), false);

    expect(screen.queryByTestId('recipe-produces-chip')).toBeNull();
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
    show(entry({ producesCanonId: 'c1', createdBy: 'Ada Lovelace' }), false);

    for (const id of ['recipe-produces-chip', 'recipe-attribution-chip']) {
      const chip = screen.getByTestId(id);
      expect(chip.tagName).toBe('SPAN');
      expect(chip.getAttribute('role')).toBeNull();
    }
  });

  it('names both people only when the last editor is somebody else', () => {
    show(entry({ createdBy: 'Ada Lovelace', lastEditedBy: 'Ada Lovelace' }), false);
    expect(screen.getByTestId('recipe-attribution-chip').textContent).toBe('Added by Ada');

    cleanup();
    show(entry({ createdBy: 'Ada Lovelace', lastEditedBy: 'Sam Vale' }), false);
    expect(screen.getByTestId('recipe-attribution-chip').textContent).toContain('edited by Sam');
  });

  it('shows the number being read, which is the page’s and not the stored one', () => {
    show(entry({ metadata: { servings: 4, tags: [] } }), false, { base: 4, active: 6 });

    expect(screen.getByTestId('recipe-servings-chip').textContent).toContain('Serves 6');
  });

  it('hands a chosen number back to the page rather than writing anything', async () => {
    show(entry({ metadata: { servings: 4, tags: [] } }), false, { base: 4, active: 4 });

    await fireEvent.click(screen.getByTestId('recipe-servings-chip'));
    await fireEvent.click(await screen.findByRole('option', { name: '6' }));

    expect(setServings).toHaveBeenCalledWith(6, 4);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('renders an inert pill, not a picker, for a recipe that cannot be scaled', () => {
    // `scaling` is `null` whenever `usableServings` refuses the stored count
    // (issue #1123). The fact is still stated; it just is not a control.
    show(entry({ metadata: { servings: 4, tags: [] } }), false, null);

    expect(screen.queryByTestId('recipe-servings-chip')).toBeNull();
    expect(screen.getByText('Serves 4')).toBeTruthy();
  });

  it('states no servings at all for an entry that is not cooked', () => {
    show(entry({ kind: 'outing', metadata: { servings: 4, tags: [] } }), false, {
      base: 4,
      active: 4,
    });

    expect(screen.queryByTestId('recipe-servings-chip')).toBeNull();
    expect(screen.queryByText(/Serves/)).toBeNull();
  });
});

describe('RecipeIdentityCard — edit mode', () => {
  it('reveals an absent field as a dashed slot offering to add it', () => {
    show(entry({ description: 'Silky' }), true);

    expect(screen.getByTestId('recipe-edit-source').textContent).toContain('Source link');
    expect(screen.getByTestId('recipe-edit-tags').textContent).toContain('Tags');
  });

  it('shows an empty card full of slots for a recipe that states nothing', () => {
    show(entry(), true);

    expect(screen.getByTestId('recipe-edit-description')).toBeTruthy();
    expect(screen.getByTestId('recipe-edit-tags')).toBeTruthy();
    expect(screen.getByTestId('recipe-edit-source')).toBeTruthy();
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

  it('closes the description when it loses focus', async () => {
    show(entry({ description: 'Silky' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-description'));
    await fireEvent.blur(screen.getByTestId('recipe-description-input'));

    expect(screen.queryByTestId('recipe-description-input')).toBeNull();
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

  it('adds a tag on Enter and normalises it', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    const input = screen.getByTestId('recipe-tags-input');
    await fireEvent.input(input, { target: { value: 'Summer' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEdit().metadata.tags).toEqual(['weeknight', 'summer']);
  });

  it('splits one typed run on a comma, because the domain rule does', async () => {
    show(entry({ metadata: { servings: null, tags: [] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    const input = screen.getByTestId('recipe-tags-input');
    await fireEvent.input(input, { target: { value: 'summer, quick' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastEdit().metadata.tags).toEqual(['summer', 'quick']);
  });

  it('adds nothing for a tag the recipe already carries', async () => {
    show(entry({ metadata: { servings: null, tags: ['summer'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    const input = screen.getByTestId('recipe-tags-input');
    await fireEvent.input(input, { target: { value: 'Summer' } });
    await fireEvent.keyDown(input, { key: ',' });

    expect(onEdit).not.toHaveBeenCalled();
    expect((screen.getByTestId('recipe-tags-input') as HTMLInputElement).value).toBe('');
  });

  it('removes a tag from the row that holds it', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight', 'summer'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.click(screen.getByLabelText('Remove summer'));

    expect(lastEdit().metadata.tags).toEqual(['weeknight']);
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

  it('leaves an empty tag row alone on Backspace', async () => {
    show(entry({ metadata: { servings: null, tags: [] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.keyDown(screen.getByTestId('recipe-tags-input'), { key: 'Backspace' });

    expect(onEdit).not.toHaveBeenCalled();
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

  it('closes the tag box when it is finished with', async () => {
    show(entry({ metadata: { servings: null, tags: ['weeknight'] } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-tags'));
    await fireEvent.click(screen.getByTestId('recipe-tags-done'));

    expect(screen.queryByTestId('recipe-tags-input')).toBeNull();
  });

  it('marks the recipe url-sourced when a source link is typed in', async () => {
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-source'));
    await fireEvent.input(screen.getByTestId('recipe-source-input'), {
      target: { value: 'https://example.com/carbonara' },
    });

    expect(lastEdit().source).toEqual({ type: 'url', url: 'https://example.com/carbonara' });
  });

  it('opens the source box on the link already recorded', async () => {
    show(entry({ source: { type: 'url', url: 'https://example.com/carbonara' } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-source'));

    expect((screen.getByTestId('recipe-source-input') as HTMLInputElement).value).toBe(
      'https://example.com/carbonara',
    );
  });

  it('clears the source entirely when the link is emptied', async () => {
    show(entry({ source: { type: 'url', url: 'https://example.com/carbonara' } }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-source'));
    await fireEvent.input(screen.getByTestId('recipe-source-input'), { target: { value: '' } });

    expect(lastEdit().source).toBeNull();
  });

  // Phase 3's boundary, stated as a test rather than only in prose: the fact row
  // does not notice the mode. Phase 4 is what changes these.
  it('leaves the three fact pills exactly as they read, mode or no mode', () => {
    mockCanonItems._set([{ id: 'c1', name: 'Mayonnaise', synonyms: [] }]);
    show(
      entry({
        producesCanonId: 'c1',
        createdBy: 'Ada Lovelace',
        metadata: { servings: 4, tags: [] },
      }),
      true,
      { base: 4, active: 4 },
    );

    expect(screen.getByTestId('recipe-produces-chip').tagName).toBe('SPAN');
    expect(screen.getByTestId('recipe-attribution-chip').tagName).toBe('SPAN');
    expect(screen.getByTestId('recipe-servings-chip').textContent).toContain('Serves 4');
    for (const id of ['recipe-edit-produces', 'recipe-edit-servings', 'recipe-edit-added-by']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });
});
