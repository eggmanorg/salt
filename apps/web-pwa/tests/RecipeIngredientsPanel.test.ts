import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe, newIngredient } from '@salt/domain';
import type { Ingredient, IngredientGroup, Recipe } from '@salt/domain';

import RecipeIngredientsPanel from '../src/routes/recipes/RecipeIngredientsPanel.svelte';

// The ingredients panel, read and written in the same place (issue #1319, Phase 5).
//
// What this suite is built to catch, rather than what the component happens to do:
//
//   THE GESTURE COLLISION. This is the only panel whose row was already a tap
//   target. Read mode must keep the inspect `<button>` and all three match markers
//   doing exactly what they did; edit mode must take the line's own tap away
//   entirely rather than overloading it, markers included. Both halves are
//   asserted, in both modes, because the interesting failure is one mode quietly
//   borrowing the other's behaviour.
//
//   REWORDING A LINE DROPS ITS MATCH. The canon item the old words bought is not
//   what the new words buy. The no-op guard beside it matters just as much: a
//   change event carrying the same text must not throw a good match away.
//
//   NO BOX IS REPAINTED BY A CONCURRENT WRITE, and no editing state outlives its
//   recipe — the two findings that recurred across #1326, #1331 and #1336. The last
//   two cases are those halves: the SAME recipe moving under an open box, and a
//   DIFFERENT recipe arriving in the same component instance.
//
//   NOTHING HERE PRUNES. A blank row survives every gesture in this file; dropping
//   it belongs to `blankRows.ts` and to the page's three exits from edit mode,
//   pinned in `blankRows.test.ts` and `RecipeViewPage.reviewFlag.test.ts`.

const NOW = '2026-01-01T00:00:00.000Z';

function matched(id: string, rawText: string, canonId = 'canon-1'): Ingredient {
  return {
    ...newIngredient(id, rawText),
    canonId,
    matchState: 'matched',
    parsed: {
      quantity: { type: 'single', value: 300 },
      unit: 'g',
      item: rawText,
      preparation: [],
      notes: null,
      displayText: null,
    },
  };
}

function group(id: string, name: string | null, items: Ingredient[]): IngredientGroup {
  return { id, name, items };
}

function recipeWith(groups: IngredientGroup[]): Recipe {
  return { ...emptyRecipe('entry-1', NOW), title: 'Sourdough', ingredients: groups };
}

let onEdit: ReturnType<typeof vi.fn>;
let handleRematch: ReturnType<typeof vi.fn>;
let inspectMatch: ReturnType<typeof vi.fn>;
let handleCanonicalise: ReturnType<typeof vi.fn>;
let setServings: ReturnType<typeof vi.fn>;

type Marker = 'unmatched' | 'no-amount' | 'mismatched' | null;

interface Extras {
  editing?: boolean;
  marker?: (ing: Ingredient) => Marker;
  matchingIds?: Record<string, boolean>;
  scaling?: { base: number; active: number } | null;
  ingredientScale?: number;
  hasParsedPending?: boolean;
  canonalising?: boolean;
  liveCanonIds?: ReadonlySet<string>;
}

function props(recipe: Recipe, editing: boolean, extras: Extras = {}) {
  const scaling = extras.scaling ?? null;
  const ingredientScale = extras.ingredientScale ?? 1;
  return {
    recipe,
    editing,
    onEdit,
    ingredientScale,
    scaling,
    isScaled: ingredientScale !== 1,
    setServings,
    thumbnailFor: () => null,
    iconVersionFor: () => undefined,
    ingredientLabel: (ing: Ingredient) => ing.parsed?.item ?? ing.rawText,
    rowMarker: extras.marker ?? ((): Marker => null),
    liveCanonIds: extras.liveCanonIds ?? new Set<string>(['canon-1']),
    matchingIds: extras.matchingIds ?? {},
    handleRematch,
    inspectMatch,
    hasParsedPending: extras.hasParsedPending ?? false,
    canonalising: extras.canonalising ?? false,
    handleCanonicalise,
  };
}

function show(recipe: Recipe, editing: boolean, extras: Extras = {}) {
  onEdit = vi.fn();
  handleRematch = vi.fn();
  inspectMatch = vi.fn();
  handleCanonicalise = vi.fn();
  setServings = vi.fn();
  return render(RecipeIngredientsPanel, { props: props(recipe, editing, extras) });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

function lastGroups(): readonly IngredientGroup[] {
  return lastEdit().ingredients;
}

function rowTexts(): string[] {
  return screen
    .queryAllByTestId('recipe-view-ingredient')
    .map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

/** Open the nth zone carrying `testId` — the pencil, or the dashed slot. */
async function open(testId: string, nth = 0): Promise<void> {
  await fireEvent.click(screen.getAllByTestId(testId)[nth]!);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

// ─── Read mode ────────────────────────────────────────────────────────────────

describe('RecipeIngredientsPanel — read mode is exactly what it always was', () => {
  const TWO_GROUPS = [
    group('g1', null, [matched('i1', 'strong white flour')]),
    group('g2', 'For the glaze', [matched('i2', 'honey')]),
  ];

  it('offers nothing to edit: no pencil, no dashed slot, no add and no tools', () => {
    show(recipeWith(TWO_GROUPS), false);

    expect(screen.queryByTestId('recipe-edit-ingredient')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-group-name')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-ingredient-add')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-group-add')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-ingredient-tools')).toBeNull();
    expect(screen.queryByTestId('recipe-edit-group-tools')).toBeNull();
  });

  it('keeps the line a button that opens the match inspector', async () => {
    show(recipeWith(TWO_GROUPS), false);

    const line = screen.getAllByTestId('recipe-view-ingredient-inspect')[0]!;
    expect(line.tagName).toBe('BUTTON');
    await fireEvent.click(line);

    expect(inspectMatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }));
  });

  it('draws a named group’s heading and nothing at all for an unnamed one', () => {
    show(recipeWith(TWO_GROUPS), false);

    const headings = screen.getAllByTestId('recipe-view-group-name');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent?.trim()).toBe('For the glaze');
    expect(screen.getAllByTestId('recipe-view-group')).toHaveLength(2);
  });

  // #1339 review, should-fix 3: the heading row's own wrapper `<div>` used to
  // render unconditionally, so an unnamed group's `flex flex-col gap-1.5`
  // container opened 6px of dead space above the `<ul>` even though
  // `EditableZone` drew nothing inside it. Fixed by gating the wrapper itself
  // rather than relying on `EditableZone` to look empty.
  it('renders no heading row at all above an unnamed group’s list', () => {
    show(recipeWith(TWO_GROUPS), false);

    const containers = screen.getAllByTestId('recipe-view-group');
    // g1 (unnamed): only the `<ul>` — no heading row above it.
    expect(containers[0]!.children).toHaveLength(1);
    expect(containers[0]!.children[0]!.tagName).toBe('UL');
    // g2 (named, "For the glaze"): the heading row, then the `<ul>`.
    expect(containers[1]!.children).toHaveLength(2);
    expect(containers[1]!.children[1]!.tagName).toBe('UL');
  });

  it('says so when there are no ingredients at all', () => {
    show(recipeWith([]), false);

    expect(screen.getByText('No ingredients.')).toBeTruthy();
    expect(screen.queryAllByTestId('recipe-view-ingredient')).toHaveLength(0);
  });

  // The stated boundary on "read mode is unchanged", pinned rather than left as a
  // sentence: a row with no words at all draws its tile and nothing else, where the
  // page used to draw an empty inspect button. Such a row exists only between
  // `+ Add an ingredient` and the next exit from edit mode.
  it('draws a wordless row as its tile alone, with no line to tap', () => {
    show(recipeWith([group('g1', null, [newIngredient('i1', '')])]), false);

    expect(screen.getAllByTestId('recipe-view-ingredient')).toHaveLength(1);
    expect(screen.queryByTestId('recipe-view-ingredient-inspect')).toBeNull();
    expect(screen.queryByTestId('recipe-view-ingredient-text')).toBeNull();
  });

  it('runs the unmatched ✗ and the no-amount ? through the page’s re-match', async () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      marker: () => 'unmatched',
    });
    await fireEvent.click(screen.getByTestId('match-state-unmatched'));
    expect(handleRematch).toHaveBeenCalledTimes(1);

    cleanup();
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      marker: () => 'no-amount',
    });
    await fireEvent.click(screen.getByTestId('match-state-no-amount'));
    expect(handleRematch).toHaveBeenCalledTimes(1);
  });

  it('opens the sheet from the mis-bought ⚠ rather than re-matching', async () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      marker: () => 'mismatched',
    });

    await fireEvent.click(screen.getByTestId('match-state-mismatched'));

    expect(inspectMatch).toHaveBeenCalledTimes(1);
    expect(handleRematch).not.toHaveBeenCalled();
  });

  it('shows a match in flight as an inert ellipsis', () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      marker: () => 'unmatched',
      matchingIds: { i1: true },
    });

    const marker = screen.getByTestId('match-state-unmatched') as HTMLButtonElement;
    expect(marker.textContent).toBe('…');
    expect(marker.disabled).toBe(true);
  });

  it('carries the scaled line and its way back', async () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      scaling: { base: 4, active: 6 },
      ingredientScale: 1.5,
    });

    expect(screen.getByTestId('recipe-scaled-notice').textContent).toContain('written for 4');
    await fireEvent.click(screen.getByTestId('recipe-scaled-reset'));

    expect(setServings).toHaveBeenCalledWith(4, 4);
  });

  it('shows Canonicalise only when something is parsed but unmatched', async () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false);
    expect(screen.queryByTestId('recipe-canonicalise-button')).toBeNull();

    cleanup();
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      hasParsedPending: true,
    });
    await fireEvent.click(screen.getByTestId('recipe-canonicalise-button'));

    expect(handleCanonicalise).toHaveBeenCalledTimes(1);
  });

  it('disables Canonicalise while it is running', () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), false, {
      hasParsedPending: true,
      canonalising: true,
    });

    expect((screen.getByTestId('recipe-canonicalise-button') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // #1339 review, should-fix 5: Canonicalise composes its write from a snapshot
  // of `recipe.ingredients` taken before the round trip, exactly like the
  // per-row markers it stands beside — so it carries the identical risk a
  // keystroke lands in some row before the Cloud Function returns, and the
  // toast then claims a match that never reached the document. Gated on
  // `!editing` for the same reason the markers already are.
  it('hides Canonicalise while editing, for the same reason as the per-row markers', () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), true, {
      hasParsedPending: true,
    });

    expect(screen.queryByTestId('recipe-canonicalise-button')).toBeNull();
  });
});

// ─── The gesture collision ────────────────────────────────────────────────────
//
// The resolution is recorded at the declaration: while editing, the line's words
// render in an inert `<span>` and the marker block is absent, so the tap that used
// to inspect is gone rather than overloaded. Both halves are asserted here, and
// both are what the component's header claims.

describe('RecipeIngredientsPanel — edit mode takes the line’s tap away', () => {
  const ONE = [group('g1', null, [matched('i1', 'strong white flour')])];

  it('replaces the inspect button with inert words', () => {
    show(recipeWith(ONE), true);

    expect(screen.queryByTestId('recipe-view-ingredient-inspect')).toBeNull();
    const words = screen.getByTestId('recipe-view-ingredient-text');
    expect(words.tagName).toBe('SPAN');
    expect(words.textContent).toContain('strong white flour');
  });

  it('takes the match markers with it, so no empty line can be sent to the matcher', () => {
    show(recipeWith([group('g1', null, [newIngredient('i1', '')])]), true, {
      marker: () => 'unmatched',
    });

    expect(screen.queryByTestId('match-state-unmatched')).toBeNull();
    expect(screen.queryByTestId('match-state-no-amount')).toBeNull();
    expect(screen.queryByTestId('match-state-mismatched')).toBeNull();
  });
});

// ─── Editing a line ───────────────────────────────────────────────────────────

describe('RecipeIngredientsPanel — a line', () => {
  const MATCHED = [group('g1', null, [matched('i1', '300g strong white flour')])];

  it('opens on its pencil holding the stored line, never a derived amount', async () => {
    show(recipeWith(MATCHED), true);

    await open('recipe-edit-ingredient');

    expect(screen.getByTestId('recipe-edit-ingredient-field')).toHaveValue(
      '300g strong white flour',
    );
  });

  it('drops the match when the words change — the old match bought the old words', async () => {
    show(recipeWith(MATCHED), true);
    await open('recipe-edit-ingredient');

    await fireEvent.input(screen.getByTestId('recipe-edit-ingredient-field'), {
      target: { value: '300g rye flour' },
    });

    const written = lastGroups()[0]!.items[0]!;
    expect(written.rawText).toBe('300g rye flour');
    expect(written.canonId).toBeNull();
    expect(written.matchState).toBe('pending');
    expect(written.parsed).toBeNull();
  });

  it('keeps a good match when a change event carries the same words', async () => {
    show(recipeWith(MATCHED), true);
    await open('recipe-edit-ingredient');

    await fireEvent.input(screen.getByTestId('recipe-edit-ingredient-field'), {
      target: { value: '300g strong white flour' },
    });

    expect(lastGroups()[0]!.items[0]!.canonId).toBe('canon-1');
  });

  it('marks itself optional', async () => {
    show(recipeWith(MATCHED), true);
    await open('recipe-edit-ingredient');

    await fireEvent.click(
      screen.getByTestId('recipe-edit-ingredient-optional').querySelector('button')!,
    );

    expect(lastGroups()[0]!.items[0]!.isOptional).toBe(true);
  });

  it('marks only the line it was opened on optional, never its siblings', async () => {
    show(
      recipeWith([group('g1', null, [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')])]),
      true,
    );
    await open('recipe-edit-ingredient', 1);

    await fireEvent.click(
      screen.getByTestId('recipe-edit-ingredient-optional').querySelector('button')!,
    );

    expect(lastGroups()[0]!.items.map((i) => i.isOptional)).toEqual([false, true]);
  });

  it('closes its box on Done without reverting anything', async () => {
    show(recipeWith(MATCHED), true);
    await open('recipe-edit-ingredient');

    await fireEvent.click(screen.getByTestId('recipe-edit-ingredient-done'));

    expect(screen.queryByTestId('recipe-edit-ingredient-field')).toBeNull();
    expect(screen.getByTestId('recipe-view-ingredient-text').textContent).toContain(
      'strong white flour',
    );
  });

  it('appears as a dashed slot when it has no words yet', () => {
    show(recipeWith([group('g1', null, [newIngredient('i1', '')])]), true);

    expect(screen.getByTestId('recipe-edit-ingredient').textContent).toContain('+ Ingredient');
  });
});

// ─── Adding, removing, reordering ─────────────────────────────────────────────

describe('RecipeIngredientsPanel — the shape of the list', () => {
  const TWO_ROWS = [group('g1', null, [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')])];

  it('adds a blank row and prunes nothing', async () => {
    show(recipeWith(TWO_ROWS), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-ingredient-add'));

    expect(lastGroups()[0]!.items).toHaveLength(3);
    expect(lastGroups()[0]!.items[2]!.rawText).toBe('');
    expect(screen.queryAllByTestId('recipe-view-ingredient')).toHaveLength(3);
  });

  it('removes a row', async () => {
    show(recipeWith(TWO_ROWS), true);

    await fireEvent.click(screen.getAllByTestId('recipe-edit-ingredient-remove')[0]!);

    expect(lastGroups()[0]!.items.map((i) => i.id)).toEqual(['i2']);
  });

  it('reorders rows inside a group through ReorderControl, ends guarded', async () => {
    show(recipeWith(TWO_ROWS), true);

    const ups = screen.getAllByLabelText('Move ingredient up') as HTMLButtonElement[];
    expect(ups[0]!.disabled).toBe(true);
    await fireEvent.click(ups[1]!);

    expect(lastGroups()[0]!.items.map((i) => i.id)).toEqual(['i2', 'i1']);
  });

  it('adds an unnamed group, and draws it straight away', async () => {
    show(recipeWith(TWO_ROWS), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-group-add'));

    expect(lastGroups()).toHaveLength(2);
    expect(lastGroups()[1]!.name).toBeNull();
    expect(lastGroups()[1]!.items).toEqual([]);
    expect(screen.getAllByTestId('recipe-view-group')).toHaveLength(2);
  });

  it('names a group, and removes one', async () => {
    show(
      recipeWith([
        group('g1', null, [matched('i1', 'flour')]),
        group('g2', null, [matched('i2', 'honey', 'canon-2')]),
      ]),
      true,
    );

    await open('recipe-edit-group-name', 1);
    await fireEvent.input(screen.getByTestId('recipe-edit-group-name-field'), {
      target: { value: 'For the glaze' },
    });
    expect(lastGroups()[1]!.name).toBe('For the glaze');

    await fireEvent.click(screen.getAllByTestId('recipe-edit-group-remove')[1]!);
    expect(lastGroups().map((g) => g.id)).toEqual(['g1']);
  });

  it('stores an emptied group name as null rather than as an empty string', async () => {
    show(recipeWith([group('g1', 'For the glaze', [matched('i1', 'honey')])]), true);

    await open('recipe-edit-group-name');
    await fireEvent.input(screen.getByTestId('recipe-edit-group-name-field'), {
      target: { value: '   ' },
    });

    expect(lastGroups()[0]!.name).toBeNull();
  });

  it('offers a dashed slot on a group that has never had a heading', () => {
    show(recipeWith(TWO_ROWS), true);

    expect(screen.getByTestId('recipe-edit-group-name').textContent).toContain('+ Group name');
  });

  it('reorders the groups themselves', async () => {
    show(
      recipeWith([
        group('g1', 'Dough', [matched('i1', 'flour')]),
        group('g2', 'Glaze', [matched('i2', 'honey', 'canon-2')]),
      ]),
      true,
    );

    await fireEvent.click((screen.getAllByLabelText('Move group down') as HTMLElement[])[0]!);

    expect(lastGroups().map((g) => g.id)).toEqual(['g2', 'g1']);
  });

  it('closes the box on Done for a group name too', async () => {
    show(recipeWith([group('g1', 'Dough', [matched('i1', 'flour')])]), true);
    await open('recipe-edit-group-name');

    await fireEvent.click(screen.getByTestId('recipe-edit-group-name-done'));

    expect(screen.queryByTestId('recipe-edit-group-name-field')).toBeNull();
  });
});

// ─── Moving a line between groups ─────────────────────────────────────────────
//
// The one behaviour the retired editor never had. It is a `Select` inside the
// line's own open editor, offered only when there is somewhere to move to.

describe('RecipeIngredientsPanel — moving a line to another group', () => {
  function twoGroups(): Recipe {
    return recipeWith([
      group('g1', 'Dough', [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')]),
      group('g2', 'Glaze', [matched('i3', 'honey', 'canon-3')]),
    ]);
  }

  it('is not offered at all when there is only one group', async () => {
    show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), true);
    await open('recipe-edit-ingredient');

    expect(screen.queryByTestId('recipe-edit-ingredient-group')).toBeNull();
  });

  it('drops the line at the end of the group it joins', async () => {
    const user = userEvent.setup();
    show(twoGroups(), true);
    await open('recipe-edit-ingredient');

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));
    await user.click(screen.getByRole('option', { name: 'Glaze' }));

    expect(lastGroups()[0]!.items.map((i) => i.id)).toEqual(['i2']);
    expect(lastGroups()[1]!.items.map((i) => i.id)).toEqual(['i3', 'i1']);
  });

  it('calls an unnamed group the main list, which is what the page calls it', async () => {
    const user = userEvent.setup();
    show(
      recipeWith([
        group('g1', null, [matched('i1', 'flour')]),
        group('g2', 'Glaze', [matched('i3', 'honey', 'canon-3')]),
      ]),
      true,
    );
    await open('recipe-edit-ingredient', 1);

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));

    expect(screen.getByRole('option', { name: 'Main list' })).toBeTruthy();
  });

  it('leaves every group it is not moving between untouched, object for object', async () => {
    const user = userEvent.setup();
    const dough = group('g1', 'Dough', [matched('i1', 'flour')]);
    const glaze = group('g2', 'Glaze', [matched('i3', 'honey', 'canon-3')]);
    const filling = group('g3', 'Filling', [matched('i4', 'ricotta', 'canon-4')]);
    show(recipeWith([dough, glaze, filling]), true);
    await open('recipe-edit-ingredient');

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));
    await user.click(screen.getByRole('option', { name: 'Glaze' }));

    expect(lastGroups()[2]).toBe(filling);
  });

  // A concurrent delete — another phone, or a chat amendment — takes the line out
  // from under the open picker. The move is composed off the STORED groups, so
  // there is nothing to move and nothing is written: the alternative would be to
  // resurrect a line somebody else deleted, in a group they never chose.
  it('writes nothing when the line has been deleted from under the open picker', async () => {
    const user = userEvent.setup();
    const { rerender } = show(twoGroups(), true);
    await open('recipe-edit-ingredient');

    await rerender(
      props(
        recipeWith([
          group('g1', 'Dough', [matched('i2', 'water', 'canon-2')]),
          group('g2', 'Glaze', [matched('i3', 'honey', 'canon-3')]),
        ]),
        true,
      ),
    );

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));
    await user.click(screen.getByRole('option', { name: 'Glaze' }));

    expect(onEdit).not.toHaveBeenCalled();
  });

  // #1339 review, blocking 2: the mirror of the test above, on the DESTINATION
  // side. Before the fix, `moveRowToGroup` checked only that the source row still
  // existed; a target group removed from under the open picker (another device,
  // between the box opening and this Select firing) filtered the row out of its
  // source and appended it nowhere, deleting the line from the document while the
  // draft — which still had the ghost group — drew the move as a success.
  it('writes nothing when the target group has been removed from under the open picker', async () => {
    const user = userEvent.setup();
    const { rerender } = show(twoGroups(), true);
    await open('recipe-edit-ingredient');

    await rerender(
      props(
        recipeWith([
          group('g1', 'Dough', [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')]),
        ]),
        true,
      ),
    );

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));
    await user.click(screen.getByRole('option', { name: 'Glaze' }));

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('writes nothing when the group chosen is the one it is already in', async () => {
    const user = userEvent.setup();
    show(twoGroups(), true);
    await open('recipe-edit-ingredient');

    await user.click(screen.getByTestId('recipe-edit-ingredient-group'));
    await user.click(screen.getByRole('option', { name: 'Dough' }));

    expect(onEdit).not.toHaveBeenCalled();
  });
});

// ─── The draft ────────────────────────────────────────────────────────────────
//
// `RecipeMethodRail`'s pattern and its reason: there is real typing here, so a
// snapshot arriving from another phone must not repaint a box mid-word — and the
// write must not carry the draft's stale siblings back over that write either.
//
// THE TEST BELOW HOLDS GROUP ID 'g1' CONSTANT ON PURPOSE, and that is exactly
// what makes it a test of an ORDINARY concurrent write (another phone rewording
// a line, adding a row) rather than of a chat amendment — a real amendment does
// not merely reword rows, it re-mints every ingredient GROUP id at once
// (`assembleRecipeDraft.ts`), which is a different failure this fixture cannot
// reach no matter what its items do. `#1339 review, blocking 1` is exactly this:
// the PR that first wrote this test cited it as the pin for the amendment case,
// and it pins only the ordinary one. The amendment case — group ids CHANGING,
// not held constant — is `recovers when a chat amendment re-mints every group
// and item id at once`, below.
describe('RecipeIngredientsPanel — the draft', () => {
  it('ignores a concurrent write while a box is open, and a later gesture does not revert it', async () => {
    const mine = recipeWith([
      group('g1', null, [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')]),
    ]);
    const { rerender } = show(mine, true);
    await open('recipe-edit-ingredient');

    // Another device rewords the very line this box has open, reword its
    // sibling, and adds a third — all inside the SAME group id.
    await rerender(
      props(
        recipeWith([
          group('g1', null, [
            matched('i1', '500g strong white flour'),
            matched('i2', '350g water', 'canon-2'),
            matched('i3', '10g salt', 'canon-3'),
          ]),
        ]),
        true,
      ),
    );

    expect(screen.getByTestId('recipe-edit-ingredient-field')).toHaveValue('flour');

    // A gesture that is not a keystroke in this line's own box must not carry the
    // concurrent write's words into the open box, and must not carry the stale,
    // pre-write draft back over that write either.
    await fireEvent.click((screen.getAllByLabelText('Move ingredient down') as HTMLElement[])[0]!);

    const items = lastGroups()[0]!.items;
    expect(items.find((i) => i.id === 'i2')!.rawText).toBe('350g water');
    expect(items.map((i) => i.id)).toContain('i3');
    expect(screen.getByTestId('recipe-edit-ingredient-field')).toHaveValue('flour');
  });

  // #1339 review, blocking 1: the case the test above cannot reach. A chat
  // amendment does not reword rows inside stable groups — `assembleRecipeDraft.ts`
  // mints a fresh `crypto.randomUUID()` for every ingredient GROUP on every
  // amend, unconditionally, so `recipe.ingredients` arrives sharing not one id
  // with whatever `groupsDraft` held. Before the fix, that meant the panel wrote
  // nothing ever again until edit mode was re-entered: `setRowText` patched a
  // group id gone from the store, `addRow` appeared on screen and nowhere in the
  // document. This is the fixture the PR body wrongly claimed was already
  // covered — group ids CHANGING, not held constant.
  // TWO groups, deliberately (#1341). This fixture was written with one, and a
  // one-group fixture cannot tell the threshold the panel actually keys on —
  // `draftSurvivesInStore()` is a `.some`, so it re-seeds only when NONE of the
  // draft's group ids survive — apart from the much weaker "any group id
  // changed". With one group the two are the same sentence. With two, "none
  // survive" means neither, and the paired test below pins the other side: one
  // surviving group must NOT re-seed.
  it('recovers when a chat amendment re-mints every group and item id at once', async () => {
    const { rerender } = show(
      recipeWith([
        group('g1', null, [matched('i1', 'flour'), matched('i2', 'water', 'canon-2')]),
        group('g2', 'For the glaze', [matched('i3', 'honey', 'canon-3')]),
      ]),
      true,
    );
    await open('recipe-edit-ingredient');

    // The amendment lands: not just new words, entirely new group ids and new
    // item ids — the shape `assembleRecipeDraft.ts` actually produces, which
    // re-mints EVERY group in one unconditional `map`.
    await rerender(
      props(
        recipeWith([
          group('gNEW', null, [
            matched('iNEW1', '500g strong white flour'),
            matched('iNEW2', '350g water', 'canon-2'),
          ]),
          group('gNEW2', 'For the glaze', [matched('iNEW3', '2 tbsp honey', 'canon-3')]),
        ]),
        true,
      ),
    );

    // The box that was open belonged to a group and a row that no longer exist
    // under any id — it closes, honestly, the same way `moveRowToGroup` closes a
    // box that moves group.
    expect(screen.queryByTestId('recipe-edit-ingredient-field')).toBeNull();

    // The panel is not dead to the document: a fresh gesture against the NEW ids
    // writes, rather than silently patching a group id the store no longer has.
    await fireEvent.click(screen.getAllByTestId('recipe-edit-ingredient-add')[0]!);

    expect(lastGroups().map((g) => g.id)).toEqual(['gNEW', 'gNEW2']);
    expect(lastGroups()[0]!.items).toHaveLength(3);
    expect(lastGroups()[0]!.items[2]!.rawText).toBe('');
  });

  // The other side of that threshold, and the reason the fixture above needed a
  // second group (#1341). An ordinary concurrent edit from another phone can
  // replace ONE group — remove it and add another — without touching its
  // sibling. That is not the amendment shape, and it must not re-seed: re-seeding
  // on "any group id changed" would close a box the user is typing in and discard
  // the draft for a change made somewhere else on the page.
  it('does NOT re-seed when one group id changes and a sibling survives', async () => {
    const { rerender } = show(
      recipeWith([
        group('g1', null, [matched('i1', 'flour')]),
        group('g2', 'For the glaze', [matched('i2', 'honey', 'canon-2')]),
      ]),
      true,
    );
    // Open the box in the group that is about to survive, and TYPE — the typed
    // text is what makes a re-seed visible at all. `onEdit` is a spy here, so the
    // `recipe` prop still holds `honey` while the draft holds `set honey`: that
    // divergence is precisely what re-seeding from the store would throw away.
    // (Asserting only that the box is still open would not discriminate — the box
    // survives either way, because its own row `i2` never goes missing. Verified
    // by flipping `.some` to `.every` and watching this test stay green without
    // the keystroke.)
    await open('recipe-edit-ingredient', 1);
    await fireEvent.input(screen.getByTestId('recipe-edit-ingredient-field'), {
      target: { value: 'set honey' },
    });
    expect(screen.getByTestId('recipe-edit-ingredient-field')).toHaveValue('set honey');

    // Only `g1` is replaced. `g2` — and so the draft's identity — is still there.
    await rerender(
      props(
        recipeWith([
          group('gNEW', null, [matched('iNEW', '500g strong white flour')]),
          group('g2', 'For the glaze', [matched('i2', 'honey', 'canon-2')]),
        ]),
        true,
      ),
    );

    // The draft was kept, so the half-typed line is still on screen.
    expect(screen.getByTestId('recipe-edit-ingredient-field')).toHaveValue('set honey');

    // And the next write still composes off the FRESHEST store rather than the
    // draft: it patches the surviving group and carries the replacement group
    // beside it, instead of writing the panel's stale copy of `g1` back over it.
    await fireEvent.input(screen.getByTestId('recipe-edit-ingredient-field'), {
      target: { value: 'set honey, warmed' },
    });

    expect(lastGroups().map((g) => g.id)).toEqual(['gNEW', 'g2']);
    expect(lastGroups()[0]!.items[0]!.rawText).toBe('500g strong white flour');
    expect(lastGroups()[1]!.items[0]!.rawText).toBe('set honey, warmed');
  });

  it('shows the new recipe’s ingredients when the document changes under an open editor', async () => {
    const { rerender } = show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), true);
    await open('recipe-edit-ingredient');

    const other: Recipe = {
      ...recipeWith([group('g9', null, [matched('i9', 'chorizo', 'canon-9')])]),
      id: 'entry-2',
    };
    await rerender(props(other, true));

    expect(rowTexts().join(' ')).toContain('chorizo');
    expect(rowTexts().join(' ')).not.toContain('flour');
  });

  it('leaves read mode drawing the stored list, never the draft', async () => {
    const { rerender } = show(recipeWith([group('g1', null, [matched('i1', 'flour')])]), true);
    await open('recipe-edit-ingredient');
    await fireEvent.input(screen.getByTestId('recipe-edit-ingredient-field'), {
      target: { value: 'rye flour' },
    });

    await rerender(props(recipeWith([group('g1', null, [matched('i1', 'rye flour')])]), false));

    expect(screen.getByTestId('recipe-view-ingredient-inspect').textContent).toContain('rye flour');
  });
});
