import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { Ingredient } from '@salt/domain';
import type { GuidedCheckInDoc, GuidedStepNoteDoc } from '@salt/domain/schemas';
import GuidedStepNotes from '../src/routes/recipes/GuidedStepNotes.svelte';
import GuidedStepLookahead from '../src/routes/recipes/GuidedStepLookahead.svelte';

// THE TWO COMPONENTS BOTH GUIDED SCREENS DRAW (issue #1453), tested where they
// live rather than through either page.
//
// Every row here is rendered twice in production — once by the cook deck with no
// handlers, once by the review screen with them — so the thing worth pinning is
// that the PRESENCE OF THE HANDLERS is the only difference. There is no mode flag
// to get wrong, and a row that is text for the cook is the same row, in the same
// place, for the reader.
//
// The editing rules under that, each of which is a decision rather than an
// implementation detail:
//
//   • a line writes when it CHANGES — Enter, or tapping away. Escape leaves it;
//   • an abandoned "+" writes nothing, so the document never gains an empty field;
//   • a reminder is composed locally until it has words, and its minutes are the
//     one guess the screen can make that is always inside the timer (halfway);
//   • minutes that are not a positive number are ignored rather than refused:
//     there is no save to block, so the line simply stays as it was;
//   • the bowl is the one row that is never a box you type into — it is picked from
//     the bowls the plan has, plus "none", and a name the document already holds
//     that matches no bowl is still SHOWN, with the page's fix beside it.

function makeIngredient(id: string, rawText: string): Ingredient {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function makeNote(overrides: Partial<GuidedStepNoteDoc> = {}): GuidedStepNoteDoc {
  return {
    stepId: 'step-1',
    container: 'onion bowl',
    setup: 'small hob burner, medium-low',
    cue: 'a very gentle sizzle',
    checkIns: [],
    lookahead: null,
    getAhead: null,
    ...overrides,
  };
}

function makeEdit(
  timerMinutes: number | null = 10,
  bowls: readonly string[] = ['onion bowl', 'carrot bowl'],
) {
  return {
    timerMinutes,
    bowls,
    onSetContainer: vi.fn(),
    onSetSetup: vi.fn(),
    onSetCue: vi.fn(),
    onSetCheckIn: vi.fn(),
    onAddCheckIn: vi.fn(),
    onRemoveCheckIn: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GuidedStepNotes — what the cook sees', () => {
  it("draws the bowl, its contents, the loose ingredients, the setup, the cue and the step's reminders", () => {
    const { getByTestId, getAllByTestId, queryByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ checkIns: [{ atMinutes: 5, text: 'give it a stir' }] }),
        containerContents: [makeIngredient('ing-1', '1 onion')],
        loose: [makeIngredient('ing-2', '100ml red wine')],
        checkIns: [{ atMinutes: 5, text: 'give it a stir' }],
      },
    });

    expect(getByTestId('guided-step-note-container').textContent).toContain('onion bowl');
    expect(getAllByTestId('guided-step-container-contents')).toHaveLength(1);
    expect(getAllByTestId('guided-step-loose')).toHaveLength(1);
    expect(getByTestId('guided-step-note-setup').textContent).toContain('small hob burner');
    expect(getByTestId('guided-step-note-cue').textContent).toContain('a very gentle sizzle');
    expect(getByTestId('guided-step-check-in').textContent).toContain('5 min in');
    // Nothing is tappable and nothing is offered: this is the cook.
    expect(queryByTestId('guided-plan-add-cue')).toBeNull();
    expect(queryByTestId('guided-plan-line')).toBeNull();
  });

  it('draws nothing at all for a step the plan said nothing about', () => {
    const { queryByTestId } = render(GuidedStepNotes, {
      props: { note: null, containerContents: [], loose: [], checkIns: [] },
    });
    expect(queryByTestId('guided-step-notes')).toBeNull();
  });
});

describe('GuidedStepNotes — the lines you can change', () => {
  it('writes a cue when it changes, and leaves it alone on Escape', async () => {
    const edit = makeEdit();
    const { getByLabelText } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getByLabelText('Change what to listen or look for'));
    const field = await waitFor(() => getByLabelText('what to listen or look for'));
    await fireEvent.input(field, { target: { value: 'a lazy bubble' } });
    await fireEvent.keyDown(field, { key: 'Escape' });

    expect(edit.onSetCue).not.toHaveBeenCalled();
  });

  it('writes a cue on Enter', async () => {
    const edit = makeEdit();
    const { getByLabelText } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getByLabelText('Change what to listen or look for'));
    const field = await waitFor(() => getByLabelText('what to listen or look for'));
    await fireEvent.input(field, { target: { value: 'a lazy bubble' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(edit.onSetCue).toHaveBeenCalledWith('a lazy bubble');
  });

  it('clears a line to null rather than to an empty string', async () => {
    const edit = makeEdit();
    const { getByLabelText } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getByLabelText('Change how the station is set'));
    const field = await waitFor(() => getByLabelText('how the station is set'));
    await fireEvent.input(field, { target: { value: '  ' } });
    await fireEvent.blur(field);

    expect(edit.onSetSetup).toHaveBeenCalledWith(null);
  });

  it('offers a "+" only for the lines the plan left unsaid, and writes nothing if abandoned', async () => {
    const edit = makeEdit();
    const { getByTestId, queryByTestId, getByLabelText } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: null, setup: null }),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit,
      },
    });

    // The cue is already said, so it is not offered again.
    expect(queryByTestId('guided-plan-add-cue')).toBeNull();

    await fireEvent.click(getByTestId('guided-plan-add-setup'));
    const field = await waitFor(() => getByLabelText('how the station is set'));
    await fireEvent.input(field, { target: { value: 'oven, 200°C fan' } });
    await fireEvent.blur(field);
    expect(edit.onSetSetup).toHaveBeenCalledWith('oven, 200°C fan');
  });
});

describe('GuidedStepNotes — the bowl is picked, never spelled', () => {
  // The two ways a plan breaks are both consequences of one free-text box. A row
  // of the bowls that EXIST removes the first of them at the source: there is no
  // field here to type a name no job fills into.

  it('offers the plan\'s bowls and "none", with the step\'s own bowl pressed', () => {
    const { getAllByTestId } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit: makeEdit() },
    });

    const chips = getAllByTestId('guided-plan-bowl-chip');
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['onion bowl', 'carrot bowl', 'none']);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('has no way to type a name at all — the bowl is only ever a chip', async () => {
    // The pin under "a name that is not a bowl cannot be entered": there is no
    // editable `GuidedPlanLine` inside the container row, on a step that already
    // has one or on one that just opened it from "+ bowl". `GuidedPlanLine` is
    // the component every OTHER row on this screen (setup, cue, a reminder's
    // words) uses to become a text box — read mode is
    // `data-testid="guided-plan-line"`, open is `"guided-plan-line-input"` — so
    // its absence from this subtree is exactly the claim "there is no way to
    // type a bowl name". Checked by aria-label before, against two labels this
    // row has never carried (`GuidedStepNotes.svelte` names the chip row
    // "which bowl this step wants"), which held even with a text box present
    // and pinned nothing. A regression that put a free-text line back under the
    // bowl fails here.
    const edit = makeEdit();
    const withContainer = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });
    const setRow = withContainer.getByTestId('guided-step-note-container');
    expect(setRow.querySelector('[data-testid="guided-plan-line"]')).toBeNull();
    expect(setRow.querySelector('[data-testid="guided-plan-line-input"]')).toBeNull();
    withContainer.unmount();

    // Same claim on a step that asks for none yet, once "+ bowl" has opened the
    // picker — the only other way this row ever appears.
    const empty = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: null }),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit,
      },
    });
    await fireEvent.click(empty.getByTestId('guided-plan-add-container'));
    const openedRow = await waitFor(() => empty.getByTestId('guided-step-note-container'));
    expect(openedRow.querySelector('[data-testid="guided-plan-line"]')).toBeNull();
    expect(openedRow.querySelector('[data-testid="guided-plan-line-input"]')).toBeNull();
  });

  it('writes the bowl the chip names, and clears it on "none"', async () => {
    const edit = makeEdit();
    const { getAllByTestId } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getAllByTestId('guided-plan-bowl-chip')[1]!);
    expect(edit.onSetContainer).toHaveBeenCalledWith('carrot bowl');

    await fireEvent.click(getAllByTestId('guided-plan-bowl-chip')[2]!);
    expect(edit.onSetContainer).toHaveBeenCalledWith(null);
  });

  it('opens the row from "+ bowl" on a step that asks for none', async () => {
    const edit = makeEdit();
    const { getByTestId, getAllByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: null }),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit,
      },
    });

    await fireEvent.click(getByTestId('guided-plan-add-container'));
    const chips = await waitFor(() => getAllByTestId('guided-plan-bowl-chip'));
    // Nothing is chosen, and "none" reads as the truth rather than as blank.
    expect(chips.at(-1)!.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(chips[0]!);
    expect(edit.onSetContainer).toHaveBeenCalledWith('onion bowl');
  });

  it('says where a bowl comes from when the plan has none', async () => {
    // A bowl is added on the bench, where adding it also says who FILLS it. A
    // "+ new bowl" here would mint a prep job from the wrong screen.
    const { getByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: null }),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit: makeEdit(10, []),
      },
    });

    await fireEvent.click(getByTestId('guided-plan-add-container'));
    expect((await waitFor(() => getByTestId('guided-plan-no-bowls'))).textContent).toContain(
      'add a job on the bench',
    );
  });

  it('still shows a dangling name the document already holds', () => {
    // The picker stops the fault being CREATED here; it does not retro-fix a
    // document. The name is shown as it stands, and the page puts the fix on it.
    const { getByTestId, getAllByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: 'the onion bowl' }),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit: makeEdit(),
        problems: [{ message: 'This step asks for "the onion bowl" but no bowl has that name.' }],
      },
    });

    expect(getByTestId('guided-step-note-container').textContent).toContain('the onion bowl');
    expect(
      getAllByTestId('guided-plan-bowl-chip').map((c) => c.getAttribute('aria-pressed')),
    ).toEqual(['false', 'false', 'false']);
    expect(getByTestId('guided-plan-problem').textContent).toContain('no bowl has that name');
  });

  it('says nothing to the cook — no chips, no problems, whatever it is handed', () => {
    const { queryByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ container: 'the onion bowl' }),
        containerContents: [],
        loose: [],
        checkIns: [],
        problems: [{ message: 'never shown' }],
      },
    });

    expect(queryByTestId('guided-plan-bowl-chip')).toBeNull();
    // Gated on `edit`, not merely never passed without it. A warning at the hob is
    // one nobody can act on, and "we never pass that prop" is a sentence rather
    // than a guarantee.
    expect(queryByTestId('guided-plan-problem')).toBeNull();
  });
});

describe('GuidedStepNotes — reminders', () => {
  const REMINDER: GuidedCheckInDoc = { atMinutes: 5, text: 'give it a stir' };

  it('composes a new reminder locally, halfway through the timer, and writes it once it says something', async () => {
    const edit = makeEdit(10);
    const { getByTestId, getByLabelText } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getByTestId('guided-plan-add-check-in'));
    const pending = await waitFor(() => getByTestId('guided-step-check-in-pending'));
    // Halfway through the ten-minute timer — the one guess that is always inside
    // it. The minutes are text until the reminder exists; moving them is done on
    // the row it becomes.
    expect(pending.textContent).toContain('5 min in');

    const words = await waitFor(() => getByLabelText('what the reminder says'));
    await fireEvent.input(words, { target: { value: 'give it a stir' } });
    await fireEvent.blur(words);

    expect(edit.onAddCheckIn).toHaveBeenCalledWith({ atMinutes: 5, text: 'give it a stir' });
  });

  it('writes nothing when a new reminder is abandoned', async () => {
    const edit = makeEdit(10);
    const { getByTestId, getByLabelText, queryByTestId } = render(GuidedStepNotes, {
      props: { note: makeNote(), containerContents: [], loose: [], checkIns: [], edit },
    });

    await fireEvent.click(getByTestId('guided-plan-add-check-in'));
    await fireEvent.blur(await waitFor(() => getByLabelText('what the reminder says')));

    expect(edit.onAddCheckIn).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId('guided-step-check-in-pending')).toBeNull());
  });

  it('never offers a reminder on a step with no timer', () => {
    const { queryByTestId } = render(GuidedStepNotes, {
      props: {
        note: makeNote(),
        containerContents: [],
        loose: [],
        checkIns: [],
        edit: makeEdit(null),
      },
    });
    expect(queryByTestId('guided-plan-add-check-in')).toBeNull();
  });

  it('moves a reminder, ignores minutes that are not a number, and removes one', async () => {
    const edit = makeEdit(10);
    const { getByTestId, getByLabelText } = render(GuidedStepNotes, {
      props: {
        note: makeNote({ checkIns: [REMINDER] }),
        containerContents: [],
        loose: [],
        checkIns: [REMINDER],
        edit,
      },
    });

    await fireEvent.click(getByLabelText('Change when this reminder fires'));
    let minutes = await waitFor(() => getByLabelText('when this reminder fires'));
    await fireEvent.input(minutes, { target: { value: 'soon' } });
    await fireEvent.blur(minutes);
    expect(edit.onSetCheckIn).not.toHaveBeenCalled();

    await fireEvent.click(getByLabelText('Change when this reminder fires'));
    minutes = await waitFor(() => getByLabelText('when this reminder fires'));
    await fireEvent.input(minutes, { target: { value: '8' } });
    await fireEvent.blur(minutes);
    expect(edit.onSetCheckIn).toHaveBeenCalledWith(0, { atMinutes: 8, text: 'give it a stir' });

    await fireEvent.click(getByTestId('guided-plan-check-in-delete'));
    expect(edit.onRemoveCheckIn).toHaveBeenCalledWith(0);
  });
});

describe('GuidedStepLookahead', () => {
  it('says nothing on a step with nothing after it', () => {
    const { container } = render(GuidedStepLookahead, {
      props: { lookahead: 'the sauce reduces', getAhead: 'preheat the oven', nextNumber: null },
    });
    expect(container.textContent?.trim()).toBe('');
  });

  it('draws the get-ahead and the numbered next line for the cook', () => {
    const { getByTestId, container } = render(GuidedStepLookahead, {
      props: {
        lookahead: 'the sauce reduces by half',
        getAhead: 'preheat the oven',
        nextNumber: 5,
      },
    });
    expect(getByTestId('guided-step-get-ahead').textContent).toContain('preheat the oven');
    expect(container.textContent).toContain('Next · 5');
    expect(container.textContent).toContain('the sauce reduces by half');
  });

  it('adds and clears both lines when it can be edited', async () => {
    const edit = { onSetLookahead: vi.fn(), onSetGetAhead: vi.fn() };
    const { getByTestId, getByLabelText } = render(GuidedStepLookahead, {
      props: { lookahead: '', getAhead: '', nextNumber: 2, edit },
    });

    await fireEvent.click(getByTestId('guided-plan-add-get-ahead'));
    const ahead = await waitFor(() => getByLabelText('what to start during this step'));
    await fireEvent.input(ahead, { target: { value: 'preheat the oven to 200°C' } });
    await fireEvent.blur(ahead);
    expect(edit.onSetGetAhead).toHaveBeenCalledWith('preheat the oven to 200°C');

    await fireEvent.click(getByTestId('guided-plan-add-lookahead'));
    const next = await waitFor(() => getByLabelText('what the next step does'));
    await fireEvent.input(next, { target: { value: 'the sauce reduces' } });
    await fireEvent.blur(next);
    expect(edit.onSetLookahead).toHaveBeenCalledWith('the sauce reduces');
  });

  it('clears an authored line to null', async () => {
    const edit = { onSetLookahead: vi.fn(), onSetGetAhead: vi.fn() };
    const { getByLabelText } = render(GuidedStepLookahead, {
      props: { lookahead: 'the sauce reduces', getAhead: '', nextNumber: 2, edit },
    });

    await fireEvent.click(getByLabelText('Change what the next step does'));
    const field = await waitFor(() => getByLabelText('what the next step does'));
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.blur(field);

    expect(edit.onSetLookahead).toHaveBeenCalledWith(null);
  });
});
