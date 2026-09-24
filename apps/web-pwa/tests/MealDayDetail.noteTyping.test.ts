import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { emptyDay, setDayNote, type Day, type Member } from '@salt/domain';

import MealDayDetail from '../src/routes/mealplan/MealDayDetail.svelte';

// Issue #1513. `setDayNote` tidies the note it stores, and it runs on EVERY
// keystroke of the Dinner textarea — whose `value` is driven one-way from the
// stored note. So whatever the tidy strips mid-edit is stripped out of the field
// the user is typing in. Tidying both ends made "Pa b", backspace, read "Pa"
// instead of "Pa ", and the next word ran on. This harness loops each keystroke
// through the REAL `setDayNote` and back into the prop, as the store does.

vi.mock('../src/lib/mealPlanService.js', () => ({
  flushMealPlanWrites: vi.fn().mockResolvedValue(undefined),
}));

const alex: Member = { id: 'm1', name: 'Alex' } as Member;
const noop = () => {};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function mountTyping() {
  let day: Day = emptyDay();
  const view = render(MealDayDetail, {
    props: {
      day,
      members: [alex],
      testid: 'detail',
      recipes: [],
      onNoteChange: (note: string) => {
        day = setDayNote({ days: { d: day } }, 'd', note).days.d!;
        void view.rerender({ day });
      },
      onChefToggle: noop,
      onAttendeeToggle: noop,
      onAttendeeHomeTime: noop,
      onAttendeeNote: noop,
      onGuestsChange: noop,
    },
  });
  const field = view.getByTestId('detail-note') as HTMLTextAreaElement;
  return {
    field,
    async type(...states: string[]) {
      for (const value of states) {
        field.value = value;
        await fireEvent.input(field);
        flushSync();
      }
    },
  };
}

describe('MealDayDetail — typing a note through the tidy (issue #1513)', () => {
  it('keeps a trailing space left by a backspace, so the next word does not run on', async () => {
    const { field, type } = mountTyping();

    await type('P', 'Pa', 'Pa ', 'Pa b', 'Pa ');
    expect(field.value).toBe('Pa ');

    await type('Pa c');
    expect(field.value).toBe('Pa c');
  });

  it('keeps a trailing newline, so a second line can be started', async () => {
    const { field, type } = mountTyping();

    await type('Pie', 'Pie\n', 'Pie\nx', 'Pie\n');
    expect(field.value).toBe('Pie\n');
  });

  it("keeps a leading space left by deleting a note's first word", async () => {
    const { field, type } = mountTyping();

    // "Pie and mash", first word deleted, leaves " and mash" — a leading space
    // on real content, not a blank line, so it must not be trimmed away.
    await type('Pie and mash', ' and mash');
    expect(field.value).toBe(' and mash');
  });
});
