import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe } from '@salt/domain';

// The notes card, in place (issue #1319).
//
// The retired editor had an Edit/Preview pair. There is none here and there is
// nothing to switch between: the card renders the note as Markdown whenever it
// is not being typed into, so the preview IS the read state, through the same
// `<Markdown … breaks />` either way.
//
// The one field-level decision worth pinning is that this textarea does NOT
// close on blur. Every formatting button is a press that takes focus off it, so
// blur-to-close would shut the editor the moment you reached for Bold.

const NOW = '2026-01-01T00:00:00.000Z';

import RecipeNotesCard from '../src/routes/recipes/RecipeNotesCard.svelte';

function entry(overrides: Partial<Recipe> = {}): Recipe {
  return { ...emptyRecipe('r1', NOW), title: 'Carbonara', ...overrides };
}

let onEdit: ReturnType<typeof vi.fn>;

function show(recipe: Recipe, editing: boolean) {
  onEdit = vi.fn();
  return render(RecipeNotesCard, { props: { recipe, editing, onEdit } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipeNotesCard', () => {
  it('says nothing at all about a recipe with no note', () => {
    show(entry(), false);

    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('renders an existing note as Markdown, with nothing to tap', () => {
    show(entry({ notes: 'Use **guanciale**' }), false);

    expect(screen.getByText('guanciale').tagName).toBe('STRONG');
    expect(screen.queryByTestId('recipe-edit-notes')).toBeNull();
  });

  it('offers a dashed slot while editing a recipe that has no note', () => {
    show(entry(), true);

    expect(screen.getByTestId('recipe-edit-notes').textContent).toContain('Note');
  });

  it('starts a first note from an empty box', async () => {
    show(entry(), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-notes'));

    expect((screen.getByTestId('recipe-notes-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('writes the note as it is typed', async () => {
    show(entry({ notes: 'Use guanciale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-notes'));
    await fireEvent.input(screen.getByTestId('recipe-notes-input'), {
      target: { value: 'Use guanciale, not bacon' },
    });

    expect(onEdit).toHaveBeenCalled();
    expect((onEdit.mock.calls.at(-1)![0] as Recipe).notes).toBe('Use guanciale, not bacon');
  });

  it('reads an emptied note as absent rather than as an empty string', async () => {
    show(entry({ notes: 'Use guanciale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-notes'));
    await fireEvent.input(screen.getByTestId('recipe-notes-input'), { target: { value: '  ' } });

    expect((onEdit.mock.calls.at(-1)![0] as Recipe).notes).toBeNull();
  });

  it('stays open when the textarea loses focus — the toolbar takes it', async () => {
    show(entry({ notes: 'Use guanciale' }), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-notes'));
    await fireEvent.blur(screen.getByTestId('recipe-notes-input'));

    expect(screen.getByTestId('recipe-notes-input')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('recipe-notes-done'));
    expect(screen.queryByTestId('recipe-notes-input')).toBeNull();
  });
});
