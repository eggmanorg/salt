import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/svelte';
import { emptyRecipe, newIngredient } from '@salt/domain';
import type { Ingredient, Recipe, Step } from '@salt/domain';

// The method rail, read and written in the same place (issue #1319, Phase 4).
//
// What this suite is built to catch, rather than what the component happens to do:
//
//   READ MODE IS UNTOUCHED. The rail draws exactly as it drew on the page — the
//   discs, the chips and the note box are pinned there by `RecipeViewPage.kit`,
//   `.phases` and friends, which still drive this component. What is asserted
//   HERE is the absence: no pencil, no dashed slot and no Add step on a page
//   nobody has told to be editable.
//
//   THE TWO DASHED SLOTS ARE THE POINT. The retired editor put an empty note box
//   and a dead timer toggle on every step; a step with neither now shows two
//   slots while editing and nothing at all when not.
//
//   A BLANK STEP SURVIVES THE KEYSTROKE THAT FOLLOWS IT. Pruning belongs to every
//   exit from edit mode and to `blankRows.ts`, and `RecipeViewPage.reviewFlag.test.ts`
//   drives that through the page; what this file pins is that nothing here prunes,
//   which is the half a component test can actually see.
//
//   NO BOX IS REPAINTED BY A CONCURRENT WRITE (#1332 review, blocking 1), and no
//   editing state outlives its recipe (#1326/#1331's recurring finding). The last
//   two cases are those two halves: the SAME recipe moving under an open box, and
//   a DIFFERENT recipe arriving in the same component instance.

vi.mock('../src/lib/kitIcons.js', () => ({
  kitIcons: {
    subscribe(fn: (v: { kitIconFor: () => null; kitIconVersionFor: () => undefined }) => void) {
      fn({ kitIconFor: () => null, kitIconVersionFor: () => undefined });
      return () => {};
    },
  },
}));

import RecipeMethodRail from '../src/routes/recipes/RecipeMethodRail.svelte';

const NOW = '2026-01-01T00:00:00.000Z';

function step(id: string, text: string, over: Partial<Step> = {}): Step {
  return { id, text, note: null, timer: null, ...over };
}

function recipeWith(steps: Step[]): Recipe {
  return { ...emptyRecipe('entry-1', NOW), title: 'Sourdough', steps };
}

let onEdit: ReturnType<typeof vi.fn>;

function props(recipe: Recipe, editing: boolean) {
  return {
    recipe,
    editing,
    onEdit,
    firstUseByStep: new Map<string, readonly Ingredient[]>(),
    kitByStep: new Map<string, readonly Recipe['kit'][number][]>(),
    thumbnailFor: () => null,
    iconVersionFor: () => undefined,
    ingredientLabel: (ing: Ingredient) => ing.rawText,
    liveCanonIds: new Set<string>(),
  };
}

function show(recipe: Recipe, editing: boolean) {
  onEdit = vi.fn();
  return render(RecipeMethodRail, { props: props(recipe, editing) });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

function lastSteps(): readonly Step[] {
  return lastEdit().steps;
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('recipe-view-step');
}

/** Each step's WORDS — not the row's textContent, which in edit mode also carries
 * the dashed slots and the row number. */
function rowTexts(): string[] {
  return screen.queryAllByTestId('recipe-view-step-text').map((el) => el.textContent?.trim() ?? '');
}

/** Open one step's editor the way a cook does: press its pencil, or its slot. */
async function open(testId: string, index = 0): Promise<void> {
  await fireEvent.click(screen.getAllByTestId(testId)[index]!);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('RecipeMethodRail — reading the method', () => {
  it('draws the steps and offers nothing to press until the page is in edit mode', () => {
    show(recipeWith([step('s1', 'Mix the dough'), step('s2', 'Bake')]), false);

    expect(rowTexts()).toEqual(['Mix the dough', 'Bake']);
    expect(screen.queryByTestId('recipe-edit-step')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-step-timer')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-step-note')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-step-add')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-step-tools')).toBeNull();
  });

  it('says there are no steps when there are none', () => {
    show(recipeWith([]), false);

    expect(screen.getByText('No steps.')).toBeInTheDocument();
    expect(rows()).toEqual([]);
  });

  it('draws a timer chip as a length and its label, never as raw minutes', () => {
    show(
      recipeWith([
        step('s1', 'Prove', { timer: { durationMinutes: 720, description: 'overnight' } }),
      ]),
      false,
    );

    expect(screen.getByTestId('recipe-view-step-timer').textContent).toContain('12 hr — overnight');
  });

  it('names what a step is the first to call for, picture and word', () => {
    // The tile is decorative — the NAME beside it is the accessible content — so
    // this asserts the words, which is what a screen reader and a cook with no
    // drawn icon both get. The grouping itself is the domain's (`firstUseByStep`)
    // and is pinned there; what is pinned here is that the rail calls it and
    // renders what comes back.
    onEdit = vi.fn();
    const flour: Ingredient = {
      ...newIngredient('ing-1', '500g strong flour'),
      firstUsedInStepId: 's1',
    };
    render(RecipeMethodRail, {
      props: {
        ...props(recipeWith([step('s1', 'Mix'), step('s2', 'Bake')]), false),
        firstUseByStep: new Map([['s1', [flour]]]),
      },
    });

    const row = within(rows()[0]!).getByTestId('recipe-view-step-firstuse');
    expect(row.textContent).toContain('500g strong flour');
    expect(within(rows()[1]!).queryByTestId('recipe-view-step-firstuse')).toBeNull();
  });

  it('calls an hour or more hands-off, and less than an hour not', () => {
    // The threshold moved out of `RecipeViewPage.svelte` with this rail, so it is
    // pinned here: 60 is the line `formatMinutes` switches on too, which is what
    // keeps "12 hr" and "Hands-off" from ever disagreeing.
    show(
      recipeWith([
        step('s1', 'Prove', { timer: { durationMinutes: 60, description: null } }),
        step('s2', 'Rest', { timer: { durationMinutes: 59, description: null } }),
      ]),
      false,
    );

    expect(within(rows()[0]!).getByTestId('recipe-view-step-handsoff')).toBeInTheDocument();
    expect(within(rows()[1]!).queryByTestId('recipe-view-step-handsoff')).toBeNull();
  });
});

describe('RecipeMethodRail — editing a step', () => {
  it('rewords a step where it sits', async () => {
    show(recipeWith([step('s1', 'Mix the dough')]), true);

    await open('recipe-edit-step');
    const box = screen.getByTestId('recipe-edit-step-field');
    expect(box).toHaveValue('Mix the dough');

    await fireEvent.input(box, { target: { value: 'Mix the dough well' } });

    expect(lastSteps()[0]!.text).toBe('Mix the dough well');
  });

  it('shows two dashed slots on a step with no timer and no note, and neither when read', async () => {
    const plain = recipeWith([step('s1', 'Mix')]);
    const { rerender } = show(plain, false);
    expect(screen.queryByTestId('recipe-edit-step-timer')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-step-note')).toBeNull();

    await rerender(props(plain, true));

    expect(screen.getByTestId('recipe-edit-step-timer').textContent).toContain('+ Timer');
    expect(screen.getByTestId('recipe-edit-step-note').textContent).toContain('+ Note');
  });

  it('sets a timer on a step that had none, and the chip says so', async () => {
    show(recipeWith([step('s1', 'Prove')]), true);

    await open('recipe-edit-step-timer');
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '90' },
    });
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-label'), {
      target: { value: 'until doubled' },
    });

    expect(lastSteps()[0]!.timer).toEqual({ durationMinutes: 90, description: 'until doubled' });
    await fireEvent.click(screen.getByTestId('recipe-edit-step-timer-done'));
    expect(screen.getByTestId('recipe-view-step-timer').textContent).toContain(
      '1 hr 30 min — until doubled',
    );
  });

  it('reads an emptied minutes box as zero, and clearing both boxes drops the timer entirely', async () => {
    show(
      recipeWith([step('s1', 'Prove', { timer: { durationMinutes: 90, description: 'a while' } })]),
      true,
    );
    await open('recipe-edit-step-timer');

    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '' },
    });
    expect(lastSteps()[0]!.timer).toEqual({ durationMinutes: 0, description: 'a while' });

    // Clearing the label too leaves nothing behind: a 0-minute, unlabelled
    // timer is not a timer at all (#1336 review, should-fix 4).
    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-label'), {
      target: { value: '  ' },
    });
    expect(lastSteps()[0]!.timer).toBeNull();
  });

  it('keeps an unparseable minutes box at zero rather than storing nonsense', async () => {
    // A label is present throughout so the zero-and-unlabelled collapse
    // (should-fix 4, pinned separately below) never fires here — this test is
    // only about `stepTimerMinutes` refusing to store `NaN`.
    show(
      recipeWith([
        step('s1', 'Prove', { timer: { durationMinutes: 5, description: 'while things happen' } }),
      ]),
      true,
    );
    await open('recipe-edit-step-timer');

    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: 'soon' },
    });

    expect(lastSteps()[0]!.timer).toEqual({
      durationMinutes: 0,
      description: 'while things happen',
    });
  });

  it('never lets an abandoned + Timer persist as a phantom 0-minute timer (#1336 review, should-fix 4)', async () => {
    show(recipeWith([step('s1', 'Prove')]), true);
    await open('recipe-edit-step-timer');

    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '5' },
    });
    expect(lastSteps()[0]!.timer).toEqual({ durationMinutes: 5, description: null });

    await fireEvent.input(screen.getByTestId('recipe-edit-step-timer-minutes'), {
      target: { value: '' },
    });

    expect(lastSteps()[0]!.timer).toBeNull();
  });

  it('takes a timer off again', async () => {
    show(
      recipeWith([step('s1', 'Prove', { timer: { durationMinutes: 90, description: null } })]),
      true,
    );
    await open('recipe-edit-step-timer');

    await fireEvent.click(screen.getByTestId('recipe-edit-step-timer-remove'));

    expect(lastSteps()[0]!.timer).toBeNull();
  });

  it('adds a note to a step that had none, and an emptied note is no note', async () => {
    show(recipeWith([step('s1', 'Bake')]), true);

    await open('recipe-edit-step-note');
    await fireEvent.input(screen.getByTestId('recipe-edit-step-note-field'), {
      target: { value: 'Watch the top' },
    });
    expect(lastSteps()[0]!.note).toBe('Watch the top');

    await fireEvent.input(screen.getByTestId('recipe-edit-step-note-field'), {
      target: { value: '   ' },
    });
    expect(lastSteps()[0]!.note).toBeNull();
  });

  it('closes a note editor back to the note it wrote', async () => {
    show(recipeWith([step('s1', 'Bake', { note: 'Watch the top' })]), true);
    await open('recipe-edit-step-note');

    await fireEvent.click(screen.getByTestId('recipe-edit-step-note-done'));

    expect(screen.getByTestId('recipe-step-note-content').textContent).toContain('Watch the top');
  });

  it('closes a step editor back to its words', async () => {
    show(recipeWith([step('s1', 'Mix')]), true);
    await open('recipe-edit-step');

    await fireEvent.click(screen.getByTestId('recipe-edit-step-done'));

    expect(screen.queryByTestId('recipe-edit-step-field')).toBeNull();
    expect(rowTexts()).toEqual(['Mix']);
  });
});

describe('RecipeMethodRail — the shape of the method', () => {
  it('adds a step, and keeps it while you are still editing', async () => {
    show(recipeWith([step('s1', 'Mix')]), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-step-add'));

    expect(lastSteps()).toHaveLength(2);
    expect(lastSteps()[1]!.text).toBe('');
    // Nothing here prunes: the blank row is the row you are about to type into,
    // and Done is where it goes if you never do (`blankRows.ts`).
    expect(rows()).toHaveLength(2);
    expect(screen.getAllByTestId('recipe-edit-step')[1]!.textContent).toContain('+ Step');
  });

  it('removes a step without touching the others', async () => {
    show(recipeWith([step('s1', 'Mix'), step('s2', 'Bake')]), true);

    await fireEvent.click(screen.getAllByTestId('recipe-edit-step-remove')[0]!);

    expect(lastSteps().map((s) => s.text)).toEqual(['Bake']);
  });

  it('moves a step down, and the two ends are inert', async () => {
    show(recipeWith([step('s1', 'Mix'), step('s2', 'Prove'), step('s3', 'Bake')]), true);

    const down = screen.getAllByLabelText('Move step down');
    expect(down[2]!).toBeDisabled();
    expect(screen.getAllByLabelText('Move step up')[0]!).toBeDisabled();

    await fireEvent.click(down[0]!);

    expect(lastSteps().map((s) => s.text)).toEqual(['Prove', 'Mix', 'Bake']);
  });
});

describe('RecipeMethodRail — what the boxes are fed from', () => {
  // #1332 review, blocking 1: the SAME recipe's steps moving under an open box —
  // another phone, or a chat amendment applied in the docked pane — must not
  // repaint what the cook is mid-word in.
  //
  // #1336 review, blocking 1: nor may a LATER gesture, on a step the cook is
  // NOT typing in, write that stale pre-amendment list back over the
  // concurrent write. Before the fix this test's own second half failed: the
  // reorder wrote `stepsDraft` in full, silently deleting the amendment's
  // reword of s2 and its new s3.
  it('ignores a concurrent write to the same recipe while a box is open, and a later gesture does not revert it', async () => {
    const mine = recipeWith([step('s1', 'Mix the dough'), step('s2', 'Bake')]);
    const { rerender } = show(mine, true);
    await open('recipe-edit-step');

    await rerender(
      props(
        recipeWith([
          step('s1', 'Mix the dough'),
          step('s2', 'Bake until deep gold'),
          step('s3', 'Rest before slicing'),
        ]),
        true,
      ),
    );

    expect(screen.getByTestId('recipe-edit-step-field')).toHaveValue('Mix the dough');

    // A gesture on an unrelated step (move step 1 down) must not carry the
    // stale, pre-amendment draft back over the amendment's reword of s2 and
    // its new s3.
    await fireEvent.click(screen.getAllByLabelText('Move step down')[0]!);

    const steps = lastSteps();
    expect(steps.find((s) => s.id === 's2')!.text).toBe('Bake until deep gold');
    expect(steps.map((s) => s.id)).toContain('s3');
  });

  // Standing requirement 1. `/recipes/:id` is one route, so a "Made from" tap
  // moves `params.id` and reuses this instance; the page's id-keyed `$effect`
  // closes `editing` first, and this holds it TRUE across the swap to pin that
  // the draft reseeds on an id change rather than relying on that.
  it('shows the new recipe’s steps when the document changes under an open editor', async () => {
    const { rerender } = show(recipeWith([step('s1', 'Mix the dough')]), true);
    await open('recipe-edit-step');

    const other: Recipe = { ...recipeWith([step('s9', 'Carve')]), id: 'entry-2' };
    await rerender(props(other, true));

    expect(rowTexts()).toEqual(['Carve']);
  });
});
