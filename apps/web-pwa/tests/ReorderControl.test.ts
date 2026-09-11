import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import ReorderControl from '../src/routes/recipes/ReorderControl.svelte';

// The one place a list on the recipe page is reordered (issue #1319).
//
// Daniel chose up/down arrows over a drag handle PROVISIONALLY, so the whole
// point of this component is that Phases 3, 4 and 5 render it instead of writing
// their own buttons. Two properties are pinned here because they are what a later
// swap to a drag handle has to keep true:
//
//   THE CONTRACT IS AFFORDANCE-NEUTRAL — a list, a position, and the list handed
//   back in its new order. Nothing below asserts a chevron; a drag version passing
//   these tests would be a drop-in.
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
