import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type { Recipe, RecipePhase } from '@salt/domain';
import RecipePhaseEditor from '../src/routes/recipes/RecipePhaseEditor.svelte';

// The timing strip, read and written in the same place (issue #1319, Phase 2).
//
// What the suite is built to catch, rather than what the component happens to do:
//
//   READ MODE IS UNTOUCHED. The strip draws exactly as it drew before, and there
//   is no pencil and no dashed slot on a page nobody has told to be editable.
//
//   THE STRIP IS ON SCREEN WHILE THE BOXES ARE. "An empty minutes box means zero"
//   is only a user-testable outcome if the totals restate themselves as you type,
//   so the zero case below clears a real box and then reads the real totals line
//   rather than asserting the number that went to `onEdit`.
//
//   THE CAP IS INBOUND ONLY (#1123). A stored seven-phase strip is a strip to
//   edit, not one to truncate, and the cap withholds the Add button and nothing
//   else.
//
//   NO EDITING STATE OUTLIVES ITS RECIPE. `/recipes/:id` is one route, so a "Made
//   from" tap reuses this component instance with a different document — the last
//   case swaps the recipe under an OPEN editor and asserts the boxes are the new
//   recipe's.
//
//   A CONCURRENT WRITE TO THE SAME RECIPE NEVER REPAINTS AN OPEN BOX (#1332
//   review, blocking 1). The id-swap case above is a DIFFERENT recipe arriving;
//   this is the SAME recipe's `phases` moving under an editor that is still
//   open on it — another phone, or a chat amendment applied in the docked pane —
//   which is the concurrent-change case issue #1319 actually settled and the one
//   case an earlier version of this suite never exercised.
//
//   A HAND EDIT DROPS THE MODEL'S TIMING SENTENCE (#1332 review, should-fix 2).
//   `timingSummary` is prose paired with `phases` by `reconcileRecipePhases` and
//   nothing here is that funnel, so a hand edit that changes the list clears the
//   sentence rather than leaving it to contradict the totals line underneath it.

const NOW = '2026-01-01T00:00:00.000Z';

const MIX: RecipePhase = { label: 'Mix & knead', handsOnMinutes: 20, handsOffMinutes: 0 };
const PROVE: RecipePhase = { label: 'First rise', handsOnMinutes: 0, handsOffMinutes: 90 };
const BAKE: RecipePhase = { label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 40 };

function loaf(phases: RecipePhase[], overrides: Partial<Recipe> = {}): Recipe {
  const base = emptyRecipe('entry-1', NOW);
  return {
    ...base,
    title: 'Sourdough',
    ...overrides,
    metadata: { ...base.metadata, phases, ...(overrides.metadata ?? {}) },
  };
}

let onEdit: ReturnType<typeof vi.fn>;

function show(recipe: Recipe, editing: boolean) {
  onEdit = vi.fn();
  return render(RecipePhaseEditor, { props: { recipe, editing, onEdit } });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

function lastPhases(): readonly RecipePhase[] {
  return lastEdit().metadata.phases!;
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('recipe-phase-row');
}

function labelValues(): string[] {
  return screen
    .queryAllByTestId('recipe-phase-label-field')
    .map((el) => (el as HTMLInputElement).value);
}

/** Open the rows the way a cook does: press the pencil, or the dashed slot. */
async function openRows(): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-edit-phases'));
}

function totalsLine(): string {
  return (screen.getByTestId('recipe-phase-totals').textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipePhaseEditor — read mode', () => {
  it('draws the stored strip and offers nothing to tap', () => {
    show(loaf([MIX, PROVE]), false);

    expect(screen.getByTestId('recipe-phases')).toBeTruthy();
    expect(screen.queryByTestId('recipe-edit-phases')).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('draws nothing at all for a recipe with no phases', () => {
    show(loaf([]), false);

    expect(screen.queryByTestId('recipe-phases')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-phases')).toBeNull();
  });
});

describe('RecipePhaseEditor — edit mode', () => {
  it('grows a pencil beside the strip, and opens the rows on a tap', async () => {
    show(loaf([MIX, PROVE]), true);

    expect(rows()).toHaveLength(0);
    await openRows();

    expect(rows()).toHaveLength(2);
    expect(labelValues()).toEqual(['Mix & knead', 'First rise']);
  });

  it('gives a row two minute figures and never a third', async () => {
    show(loaf([MIX, PROVE]), true);
    await openRows();

    expect(screen.getAllByTestId('recipe-phase-hands-on-field')).toHaveLength(2);
    expect(screen.getAllByTestId('recipe-phase-hands-off-field')).toHaveLength(2);
    expect(screen.getAllByTestId('recipe-phase-hands-off-field')[1]).toHaveValue('90');
  });

  it('keeps the strip on screen beside the boxes, redrawing from the same list', async () => {
    show(loaf([BAKE]), true);
    await openRows();

    expect(screen.getByTestId('recipe-phases')).toBeTruthy();
    expect(totalsLine()).toContain('45 min');
  });

  it('offers a recipe with no strip the slot that says what it does', () => {
    show(loaf([]), true);

    expect(screen.getByTestId('recipe-edit-phases').textContent).toContain('+ Add a phase');
  });

  it('adds the phase the slot promised, so the cursor lands in a row to name', async () => {
    show(loaf([]), true);

    await openRows();

    expect(lastPhases()).toEqual([{ label: '', handsOnMinutes: 0, handsOffMinutes: 0 }]);
  });

  it('adds nothing extra when the pencil opens a strip that already has rows', async () => {
    show(loaf([BAKE]), true);

    await openRows();

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('offers an entry that is never cooked no timing at all', () => {
    show(loaf([], { kind: 'outing' }), true);

    expect(screen.queryByTestId('recipe-edit-phases')).toBeNull();
  });

  it('still reads a stored strip on an entry that is never cooked', () => {
    show(loaf([BAKE], { kind: 'outing' }), true);

    expect(screen.getByTestId('recipe-phases')).toBeTruthy();
    expect(screen.queryByTestId('recipe-edit-phases')).toBeNull();
  });

  it('renames a phase without touching its minutes, and with no save', async () => {
    show(loaf([PROVE]), true);
    await openRows();

    await fireEvent.input(screen.getByTestId('recipe-phase-label-field'), {
      target: { value: 'Bulk ferment' },
    });

    expect(lastPhases()).toEqual([{ ...PROVE, label: 'Bulk ferment' }]);
  });

  it('leaves the rows it was not asked about alone', async () => {
    show(loaf([MIX, PROVE, BAKE]), true);
    await openRows();

    await fireEvent.input(screen.getAllByTestId('recipe-phase-label-field')[1]!, {
      target: { value: 'Bulk ferment' },
    });

    expect(lastPhases()).toEqual([MIX, { ...PROVE, label: 'Bulk ferment' }, BAKE]);
  });

  it('retimes a phase to the figure that is on screen', async () => {
    show(loaf([PROVE]), true);
    await openRows();

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-on-field'), {
      target: { value: '12' },
    });

    expect(lastPhases()).toEqual([{ ...PROVE, handsOnMinutes: 12 }]);
  });

  it('reads an emptied minutes box as zero, and the strip totals it as zero', async () => {
    const { rerender } = show(loaf([BAKE]), true);
    await openRows();
    expect(totalsLine()).toContain('45 min');

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-off-field'), {
      target: { value: '' },
    });
    // The written document fed back, which is what the page does — the strip above
    // the boxes is then drawn from the same list they just changed.
    await rerender({ recipe: lastEdit(), editing: true, onEdit });

    expect(lastPhases()).toEqual([{ ...BAKE, handsOffMinutes: 0 }]);
    expect(totalsLine()).toContain('5 min start to finish');
  });

  it('refuses to store a negative, keeping 0 as the real answer', async () => {
    show(loaf([BAKE]), true);
    await openRows();

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-on-field'), {
      target: { value: '-5' },
    });

    expect(lastPhases()).toEqual([{ ...BAKE, handsOnMinutes: 0 }]);
  });

  it('floors a fractional minute rather than storing it', async () => {
    show(loaf([BAKE]), true);
    await openRows();

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-on-field'), {
      target: { value: '7.8' },
    });

    expect(lastPhases()).toEqual([{ ...BAKE, handsOnMinutes: 7 }]);
  });

  it('reads an unparseable box as zero rather than as nothing', async () => {
    show(loaf([BAKE]), true);
    await openRows();

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-off-field'), {
      target: { value: 'soon' },
    });

    expect(lastPhases()).toEqual([{ ...BAKE, handsOffMinutes: 0 }]);
  });

  it('appends a blank row on Add phase', async () => {
    show(loaf([MIX]), true);
    await openRows();

    await fireEvent.click(screen.getByTestId('recipe-phase-add'));

    expect(lastPhases()).toEqual([MIX, { label: '', handsOnMinutes: 0, handsOffMinutes: 0 }]);
  });

  it('removes the row whose bin was pressed', async () => {
    show(loaf([MIX, PROVE]), true);
    await openRows();

    await fireEvent.click(screen.getAllByLabelText('Remove phase')[0]!);

    expect(lastPhases()).toEqual([PROVE]);
  });

  // The draft can be emptied without closing the zone — nothing here re-adds
  // the seed phase except OPENING onto an empty strip. That makes the strip's
  // own `hasPhases` gate reachable while editing is still open, which is what
  // this pins: removing the last row drops the strip from above the boxes, the
  // same way an emptied recipe reads with none at all.
  it('drops the strip from above the boxes when the last row is removed, without closing the zone', async () => {
    show(loaf([BAKE]), true);
    await openRows();
    expect(screen.getByTestId('recipe-phases')).toBeTruthy();

    await fireEvent.click(screen.getByLabelText('Remove phase'));

    expect(lastPhases()).toEqual([]);
    expect(screen.queryByTestId('recipe-phases')).toBeNull();
    expect(rows()).toHaveLength(0);
    // Still open, not closed — Remove is not Done.
    expect(screen.getByTestId('recipe-phase-done')).toBeTruthy();
  });

  it('moves a phase, because the order is the plan', async () => {
    show(loaf([MIX, PROVE, BAKE]), true);
    await openRows();

    await fireEvent.click(screen.getAllByLabelText('Move phase down')[0]!);

    expect(lastPhases()).toEqual([PROVE, MIX, BAKE]);
  });

  it('renders and edits an over-cap strip, withholding only the Add button', async () => {
    const seven: RecipePhase[] = Array.from({ length: 7 }, (_, i) => ({
      label: `Phase ${i + 1}`,
      handsOnMinutes: i,
      handsOffMinutes: 0,
    }));
    show(loaf(seven), true);
    await openRows();

    expect(rows()).toHaveLength(7);
    expect(screen.queryByTestId('recipe-phase-add')).toBeNull();

    await fireEvent.click(screen.getAllByLabelText('Remove phase')[6]!);
    expect(lastPhases()).toHaveLength(6);
  });

  // Driven by a REMOVE the cook presses, not by a rerender standing in for a
  // second device: the cap now reads the draft this editing session is
  // building (#1332 review, blocking 1), not whatever the store happens to say,
  // so a store snapshot arriving from elsewhere must NOT move this boundary —
  // see 'ignores a concurrent write…' below, which pins that half directly. This
  // test's job is only the boundary itself: six withholds Add, five offers it.
  it('withholds Add at exactly six and offers it at five', async () => {
    const six: RecipePhase[] = Array.from({ length: 6 }, (_, i) => ({
      label: `Phase ${i + 1}`,
      handsOnMinutes: 0,
      handsOffMinutes: 0,
    }));
    show(loaf(six), true);
    await openRows();
    expect(screen.queryByTestId('recipe-phase-add')).toBeNull();

    await fireEvent.click(screen.getAllByLabelText('Remove phase')[0]!);

    expect(screen.getByTestId('recipe-phase-add')).toBeInTheDocument();
  });

  it('puts the rows away on Done, leaving the strip and its pencil', async () => {
    show(loaf([BAKE]), true);
    await openRows();

    await fireEvent.click(screen.getByTestId('recipe-phase-done'));

    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('recipe-phases')).toBeTruthy();
    expect(screen.getByTestId('recipe-edit-phases')).toBeTruthy();
  });

  // Standing requirement 1 (#1326/#1331's recurring finding), belt-and-suspenders
  // half. `/recipes/:id` is one route, so a "Made from" tap moves `params.id` and
  // reuses this instance — in the real app the page's own id-keyed `$effect`
  // closes `editing` before that can happen, but this holds `editing: true`
  // across the swap to pin that the DRAFT itself reseeds on an `id` change too,
  // and does not merely rely on the page to have closed the zone first.
  it('shows the new recipe’s phases when the document changes under an open editor', async () => {
    const { rerender } = show(loaf([MIX]), true);
    await openRows();
    expect(labelValues()).toEqual(['Mix & knead']);

    await rerender({ recipe: { ...loaf([BAKE]), id: 'entry-2' }, editing: true, onEdit });

    expect(labelValues()).toEqual(['Bake']);
    expect(screen.getByTestId('recipe-phase-hands-off-field')).toHaveValue('40');
  });

  // The other half, and the one the earlier suite never pinned (#1332 review,
  // blocking 1): the SAME recipe's `phases` moving under an editor that is still
  // open on it — another phone, or a chat amendment applied in the docked pane —
  // must not repaint a box the cook is mid-word in. `id` stays 'entry-1'
  // throughout, which is what makes this the concurrent-write case rather than
  // the id-change case above.
  it('ignores a concurrent write to the same recipe while a box is open', async () => {
    const { rerender } = show(loaf([PROVE]), true);
    await openRows();
    expect(labelValues()).toEqual(['First rise']);
    expect(totalsLine()).toContain('1 hr 30 min');

    await rerender({
      recipe: loaf([{ ...PROVE, label: 'Someone else’s edit', handsOffMinutes: 5 }]),
      editing: true,
      onEdit,
    });

    expect(labelValues()).toEqual(['First rise']);
    expect(totalsLine()).toContain('1 hr 30 min');
  });

  // #1332 review, should-fix 2: the strip drew a stale prose sentence beside
  // boxes whose totals had already moved. Clearing `timingSummary` on the same
  // write that changes `phases` is what stops the two lines from disagreeing —
  // pinned here by actually reading the summary line before and after.
  it('drops the model’s timing sentence the moment a hand edit changes the list', async () => {
    show(
      loaf([BAKE], {
        metadata: {
          servings: null,
          tags: [],
          timingSummary: 'About 40 minutes of you, over 2 hours.',
        },
      }),
      true,
    );
    await openRows();
    expect(screen.getByTestId('recipe-timing-summary')).toHaveTextContent('2 hours');

    await fireEvent.input(screen.getByTestId('recipe-phase-hands-off-field'), {
      target: { value: '' },
    });

    expect(screen.queryByTestId('recipe-timing-summary')).toBeNull();
    expect(lastEdit().metadata.timingSummary).toBeNull();
  });
});
