import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import ReorderControl from '../src/routes/recipes/ReorderControl.svelte';

// The one place a list on the recipe page is reordered (issue #1319).
//
// Daniel chose up/down arrows over a drag handle PROVISIONALLY, so the whole
// point of this component is that Phases 3, 4 and 5 render it instead of writing
// their own buttons. One property below is genuinely a later-swap guarantee; the
// other is this component's own contract and is NOT a stand-in for "a drag
// version would pass these tests unchanged" — it would not: `SortableList` is
// list-level and keys rows by id, this component is row-level and does not, and
// `ReorderControl.svelte`'s header states the real cost of that gap (#1332
// review, should-fix 1).
//
//   NOTHING BELOW ASSERTS A CHEVRON — the assertions are on `aria-label`s and on
//   what `onReorder` is called with, not on an icon, so a later affordance swap
//   at THIS row-level contract would not have to rewrite these particular
//   assertions. That is narrower than "affordance-neutral"; it says nothing
//   about `SortableList`'s incompatible shape.
//
//   THE ENDS ARE GUARDED BY `disabled` AND BY NOTHING ELSE. `move` carries no
//   bounds check, so if the first row's up arrow or the last row's down arrow ever
//   stopped being inert, the guard would be gone rather than duplicated. That is
//   the claim the component's header states with its boundary, and this is where
//   it goes red.

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function show(items: readonly string[], index: number, noun = 'phase') {
  const onReorder = vi.fn();
  render(ReorderControl, { props: { items, index, noun, onReorder } });
  return onReorder;
}

describe('ReorderControl', () => {
  it('names its controls after the thing being moved, not after the page', () => {
    show(['a', 'b', 'c'], 1, 'ingredient');

    expect(screen.getByLabelText('Move ingredient up')).toBeTruthy();
    expect(screen.getByLabelText('Move ingredient down')).toBeTruthy();
  });

  it('hands back the whole list with this row one place earlier', async () => {
    const onReorder = show(['a', 'b', 'c'], 1);

    await fireEvent.click(screen.getByLabelText('Move phase up'));

    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('hands back the whole list with this row one place later', async () => {
    const onReorder = show(['a', 'b', 'c'], 1);

    await fireEvent.click(screen.getByLabelText('Move phase down'));

    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('makes the top row’s up arrow inert — the only guard there is', () => {
    show(['a', 'b', 'c'], 0);

    expect(screen.getByLabelText('Move phase up')).toBeDisabled();
    expect(screen.getByLabelText('Move phase down')).not.toBeDisabled();
  });

  it('makes the bottom row’s down arrow inert — the only guard there is', () => {
    show(['a', 'b', 'c'], 2);

    expect(screen.getByLabelText('Move phase down')).toBeDisabled();
    expect(screen.getByLabelText('Move phase up')).not.toBeDisabled();
  });

  it('offers nothing at all on a list of one', () => {
    show(['a'], 0);

    expect(screen.getByLabelText('Move phase up')).toBeDisabled();
    expect(screen.getByLabelText('Move phase down')).toBeDisabled();
  });
});
