import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import MinutesField from '../src/routes/recipes/MinutesField.svelte';

// A minute box over a REQUIRED number (issue #1221) — the phase strip's two
// figures and a step timer's duration.
//
// THIS SUITE IS THE RELOCATED `RecipeEditPage.minuteBoxes.test.ts`. That suite
// drove the same component through the retired editor, which #1319 Phase 8
// deleted; the box itself moved to `MinutesField.svelte` and now serves
// `RecipePhaseEditor` and `RecipeMethodRail`. Testing it directly is the point
// rather than an accident of the deletion: the defect is a property of the box,
// and asserting it at the box is what stops a THIRD caller from inheriting the
// bug through a surface nobody thought to re-test.
//
// What the model cannot say is "empty". The stored value is a plain number, so
// echoing it straight back through the controlled `TextField` repainted `0`
// under the caret the instant the box was cleared, and the next keystroke read
// `045`.
//
// ASSERTING THE COMMITTED NUMBER CANNOT SEE THIS, which is why two green suites
// ran straight past it, and why `RecipePhaseEditor.test.ts` and
// `RecipeMethodRail.test.ts` — both of which read only what reached `onEdit` —
// do not cover it either. Every assertion below is on what the box DISPLAYS.
//
// THE BOUNDARY THESE PINS CLAIM, stated so it can be checked: while the box has
// focus its text is the cook's, uninterpreted — a cleared box stays cleared and
// nonsense stays visible. On blur it snaps to the stored number. Nothing here
// claims the box FILTERS keystrokes: `inputmode="numeric"` is a soft-keyboard
// hint, and a letter typed on a hardware keyboard is still accepted and still
// reports whatever the caller's `parse` makes of it.
//
// WHICH CASES WERE ACTUALLY RED BEFORE THE FIX, since a suite that implies more
// than that is the defect class this repo keeps shipping: the "stays empty"
// case, and the re-seed case at the bottom (verified red by deleting the
// `$effect` in `MinutesField.svelte`). The two "takes a retype" cases passed
// before the fix as well — a stray leading `0` is re-parsed away by the end of
// the interaction, so they pin the end state and nothing about the caret. They
// are kept as regression cover, not offered as evidence of the bug.

const TEST_ID = 'minutes-box';

/** The phase boxes' rule: floor, and never below zero. */
function phaseMinutes(text: string): number {
  const n = Number(text.trim());
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

let onValueChange: ReturnType<typeof vi.fn>;

function show(value: number) {
  onValueChange = vi.fn();
  const result = render(MinutesField, {
    props: {
      label: 'Hands-on (min)',
      value,
      parse: phaseMinutes,
      onValueChange,
      'data-testid': TEST_ID,
    },
  });
  return { ...result, input: screen.getByTestId(TEST_ID) as HTMLInputElement };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MinutesField — what the box shows while it is being edited', () => {
  it('shows the stored figure to begin with', () => {
    expect(show(20).input.value).toBe('20');
  });

  it('stays empty when it is cleared, instead of repainting 0 under the caret', async () => {
    const { input } = show(20);

    await userEvent.clear(input);

    expect(input.value).toBe('');
  });

  it('takes a retype after a clear without a leading 0', async () => {
    const { input } = show(20);

    await userEvent.clear(input);
    await userEvent.type(input, '45');

    expect(input.value).toBe('45');
  });

  // The interaction the defect was actually reported through: backspace the old
  // figure away one keystroke at a time, then type the new one. `userEvent.clear`
  // is a select-all-and-delete and does NOT exercise the same path.
  it('takes a retype after backspacing the old figure away, one keystroke at a time', async () => {
    const { input } = show(20);

    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}{Backspace}');
    await userEvent.type(input, '45');

    expect(input.value).toBe('45');
  });

  it('keeps text the parse rule does not accept on screen until the box is left', async () => {
    const { input } = show(20);

    await userEvent.clear(input);
    await userEvent.type(input, 'abc');

    expect(input.value).toBe('abc');
    // …and reports what the caller's rule makes of it, which is not the box's
    // business to second-guess.
    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });

  // Blur reads THE PROP, not the box's own last parse — "snaps back to the
  // stored figure" is the claim, and stored means what the parent is holding.
  // With the parent doing its job the two agree, so a cleared box reads back as
  // the real 0 it stored rather than as a hole.
  it('snaps back to the stored figure on blur', async () => {
    const { input, rerender } = show(20);

    await userEvent.clear(input);
    await rerender({ value: 0 });
    await userEvent.tab();

    expect(input.value).toBe('0');
  });

  // The same sentence read as an adversary: the box is CONTROLLED, so if a
  // parent declines the figure the box reported, blur puts the parent's answer
  // back on screen and not the cook's. No caller does that today — both pass
  // `onValueChange` straight into their draft — but the box's behaviour is
  // defined for it, and stating it is what keeps "snaps back to the stored
  // figure" from quietly meaning "snaps back to what you typed".
  it('shows the parent’s figure on blur when the parent did not take the edit', async () => {
    const { input } = show(20);

    await userEvent.clear(input);
    await userEvent.tab();

    expect(input.value).toBe('20');
  });
});

describe('MinutesField — what the box reports', () => {
  it('reports the parsed figure on every keystroke, not only on blur', async () => {
    const { input } = show(20);

    await userEvent.clear(input);
    await userEvent.type(input, '45');

    expect(onValueChange.mock.calls.map(([m]) => m)).toEqual([0, 4, 45]);
  });

  it('reports a cleared box as zero', async () => {
    const { input } = show(20);

    await userEvent.clear(input);

    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });
});

// The other half of the contract, and the reason the box cannot simply STOP
// listening to the stored figure. `RecipePhaseEditor`'s `{#each}` is keyed BY
// POSITION, so reordering or deleting a row hands a surviving box a different
// phase's minutes through the same component instance. A box that only ever
// seeded itself once would then show the wrong phase's time — a worse defect
// than the one #1221 reports, and the neighbour this fix had to not create.
describe('MinutesField — when the stored figure changes underneath it', () => {
  it('re-seeds from a figure it did not author', async () => {
    const { input, rerender } = show(20);

    await rerender({ value: 90 });

    expect(input.value).toBe('90');
  });

  // Re-seeding is on DISAGREEMENT, not on every change — so an edit the box made
  // itself must not bounce back through it. Without this the fix above puts the
  // original defect straight back: clearing a box stores 0, and 0 is a change.
  it('does not re-seed from the figure its own edit just produced', async () => {
    const { input, rerender } = show(20);

    await userEvent.clear(input);
    // The parent doing exactly what a real one does — handing back the number
    // this box just reported.
    await rerender({ value: 0 });

    expect(input.value).toBe('');
  });
});
