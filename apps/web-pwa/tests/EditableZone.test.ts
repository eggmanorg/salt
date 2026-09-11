import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import EditableZoneHarness from './fixtures/EditableZoneHarness.svelte';

// The page-local primitive every editable region of the recipe page goes through
// (issue #1319). Phase 2 proves it against the title and the notes card; every
// later field is built on the contract pinned here, so the properties below are
// the ones a later phase must not quietly change:
//
//   1. OUTSIDE edit mode the region renders exactly what the read page rendered
//      and offers nothing to tap — that is the whole "a tap can only mean 'change
//      this' once the page has been told" principle, at component scale;
//   2. a FILLED region grows a pencil BESIDE the value, never around it, so a
//      link or a row of chips inside the view is never nested in a `<button>`;
//   3. an EMPTY region is invisible when reading and a dashed `+ Label` slot when
//      editing — the reason the mode exists at all;
//   4. `onOpen` fires before the editor is mounted, which is where every caller
//      seeds its draft;
//   5. `close` finishes the field and KEEPS what was typed — there is no Cancel
//      anywhere in this feature;
//   6. leaving edit mode closes an editor left open, or the page would still be a
//      text box after it had said it was being read.

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('EditableZone — read mode', () => {
  it('renders the value and offers nothing to tap', () => {
    render(EditableZoneHarness, { props: { editing: false, filled: true } });

    expect(screen.getByTestId('zone-view').textContent).toBe('a note');
    expect(screen.queryByTestId('zone-affordance')).toBeNull();
  });

  it('renders nothing at all for a field the recipe has never filled in', () => {
    render(EditableZoneHarness, { props: { editing: false, filled: false } });

    expect(screen.queryByTestId('zone-view')).toBeNull();
    expect(screen.queryByTestId('zone-affordance')).toBeNull();
  });
});

describe('EditableZone — edit mode', () => {
  it('keeps the value visible and puts the pencil beside it, not around it', () => {
    render(EditableZoneHarness, { props: { editing: true, filled: true } });

    const view = screen.getByTestId('zone-view');
    const pencil = screen.getByTestId('zone-affordance');
    expect(view.textContent).toBe('a note');
    expect(pencil.tagName).toBe('BUTTON');
    // Sibling, not ancestor. A wrapper would swallow the taps a link or a chip
    // row inside the view still needs, and nests interactive content illegally.
    expect(pencil.contains(view)).toBe(false);
    expect(view.closest('button')).toBeNull();
  });

  it('shows an empty field as a dashed slot naming what is missing', () => {
    render(EditableZoneHarness, { props: { editing: true, filled: false, slotLabel: 'Servings' } });

    expect(screen.getByTestId('zone-affordance').textContent).toContain('+ Servings');
  });

  it('tells the caller to seed its draft as the editor opens', async () => {
    render(EditableZoneHarness, { props: { editing: true, filled: true } });

    expect(screen.getByTestId('zone-opens').textContent).toBe('0');
    await fireEvent.click(screen.getByTestId('zone-affordance'));

    expect(screen.getByTestId('zone-opens').textContent).toBe('1');
  });

  it('swaps the value for the editor, and focuses its first text control', async () => {
    render(EditableZoneHarness, { props: { editing: true, filled: true } });

    await fireEvent.click(screen.getByTestId('zone-affordance'));

    const input = screen.getByTestId('zone-input');
    expect(screen.queryByTestId('zone-view')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('keeps what was typed when the field is closed — there is no Cancel', async () => {
    render(EditableZoneHarness, { props: { editing: true, filled: true } });

    await fireEvent.click(screen.getByTestId('zone-affordance'));
    await fireEvent.input(screen.getByTestId('zone-input'), { target: { value: 'rewritten' } });
    await fireEvent.click(screen.getByTestId('zone-close'));

    expect(screen.queryByTestId('zone-input')).toBeNull();
    expect(screen.getByTestId('zone-view').textContent).toBe('rewritten');
  });

  it('closes an open editor when the page leaves edit mode', async () => {
    const { rerender } = render(EditableZoneHarness, { props: { editing: true, filled: true } });

    await fireEvent.click(screen.getByTestId('zone-affordance'));
    expect(screen.getByTestId('zone-input')).toBeTruthy();

    await rerender({ editing: false, filled: true });

    expect(screen.queryByTestId('zone-input')).toBeNull();
    expect(screen.getByTestId('zone-view')).toBeTruthy();
  });
});
