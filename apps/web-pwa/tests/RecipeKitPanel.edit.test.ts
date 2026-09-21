import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { emptyRecipe, groupKitByEquipment } from '@salt/domain';
import type { EquipmentItem, Recipe } from '@salt/domain';
import type { KitchenToolDoc, RecipeKitEntryDoc } from '@salt/domain/schemas';

import RecipeKitPanel from '../src/routes/recipes/RecipeKitPanel.svelte';

// The Equipment list, edited where it is read (issue #1496).
//
// What this suite is built to catch, rather than what the component happens to do:
//
//   NO `kitchenTools` ID EVER REACHES A RECIPE. The combobox OFFERS the drawn
//   vocabulary, because those are the words a picture already exists for — but
//   choosing one may only write its LABEL. This is the Rule 12 pin on the schema
//   header's claim at `recipe.ts`, and it was verified RED by having the panel
//   write `{ itemId: tool.id, accessoryId: null }` for a tool choice: the
//   `equipment` assertion below goes red, the label assertion stays green, which
//   is exactly the silent failure the pin exists to catch.
//
//   `stepIds` SURVIVES A RENAME. It drives `kitByStep`, which the method rail,
//   cook mode and the guided step screen all read, so losing it silently strips
//   the per-step tool pictures with nothing on screen to say so.
//
//   REMOVE ACTS ON ONE STORED ENTRY. Read mode folds an accessory into its
//   appliance's row, so a rendered row can be several stored entries; the edit
//   list is the flat stored one precisely so Remove has a single entry to drop.
//
//   READ MODE IS UNTOUCHED. The grouped rows, the no-tile-on-a-miss gutter, the
//   "with the …" continuation and the pictureless-row button all still behave as
//   `RecipeViewPage.kit.test.ts` pins them — asserted here too, from the
//   component's own side, because the extraction is what could have moved them.
//
//   NOTHING HERE PRUNES. A labelless row survives every gesture in this file;
//   dropping it belongs to `blankRows.ts` and to the page's three exits from edit
//   mode, pinned in `blankRows.test.ts` and `RecipeViewPage.reviewFlag.test.ts`.

const NOW = '2026-01-01T00:00:00.000Z';

function entry(over: Partial<RecipeKitEntryDoc> = {}): RecipeKitEntryDoc {
  return { label: 'frying pan', stepIds: [], equipment: null, ...over };
}

function recipeWith(kit: RecipeKitEntryDoc[]): Recipe {
  return { ...emptyRecipe('entry-1', NOW), title: 'Champ', kit };
}

function item(over: Partial<EquipmentItem> & { id: string; name: string }): EquipmentItem {
  return {
    schemaVersion: 1,
    kind: 'equipment',
    accessories: [],
    rules: [],
    note: '',
    environment: null,
    borrowedPicture: null,
    updatedAt: NOW,
    ...over,
  } as EquipmentItem;
}

function tool(id: string, label: string): KitchenToolDoc {
  return {
    id,
    label,
    schemaVersion: 1,
    matchers: [],
    thumbnail: 'https://example.com/kit/pan.webp',
    createdAt: NOW,
    updatedAt: NOW,
  } as KitchenToolDoc;
}

// The Cosori and its two accessories — the fixture `groupKitByEquipment`'s own
// folding rule is written against, so "one rendered row, three stored entries" is
// a real state here rather than a contrived one.
const COSORI = item({
  id: 'eq-cosori',
  name: 'Cosori 5L Rice Cooker',
  accessories: [
    { id: 'acc-basket', name: 'Steam Basket', owned: true, included: true },
    { id: 'acc-spoon', name: 'Rice Spoon', owned: true, included: true },
  ] as EquipmentItem['accessories'],
});

const PANS = item({
  id: 'eq-pans',
  name: 'Frying Pans',
  kind: 'family',
  accessories: [
    { id: 'fam-tefal', name: 'Tefal non-stick 28cm', owned: true, included: false },
  ] as EquipmentItem['accessories'],
});

let onEdit: ReturnType<typeof vi.fn>;
let onPicture: ReturnType<typeof vi.fn>;

interface Extras {
  items?: readonly EquipmentItem[];
  tools?: readonly KitchenToolDoc[];
  /** Which labels have a picture. Everything else renders words with no tile. */
  drawn?: readonly string[];
}

function show(recipe: Recipe, editing: boolean, extras: Extras = {}) {
  onEdit = vi.fn();
  onPicture = vi.fn();
  const items = extras.items ?? [];
  const drawn = new Set(extras.drawn ?? []);
  return render(RecipeKitPanel, {
    props: {
      recipe,
      editing,
      onEdit,
      kitGroups: groupKitByEquipment(recipe.kit, items),
      equipmentItems: items,
      kitchenTools: extras.tools ?? [],
      kitIconFor: (e: RecipeKitEntryDoc) =>
        drawn.has(e.label) ? 'https://example.com/kit/pan.webp' : null,
      kitIconVersionFor: () => undefined,
      onPicture,
    },
  });
}

/** The recipe as the last `onEdit` call composed it. */
function lastEdit(): Recipe {
  const calls = onEdit.mock.calls;
  return calls[calls.length - 1]![0] as Recipe;
}

function lastKit(): readonly RecipeKitEntryDoc[] {
  return lastEdit().kit;
}

/** The editable rows' comboboxes, in stored order. */
function fields(): HTMLElement[] {
  return screen.queryAllByTestId('recipe-edit-kit-field');
}

/**
 * Open row `index`'s combobox and choose the option reading `label`.
 *
 * Typing rather than clicking the trigger: the popup filters on what is typed,
 * and a manifest of any size renders more options than a click-and-scan can
 * reach. `findByRole` waits for the portalled listbox.
 */
async function choose(index: number, typed: string, optionLabel: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(fields()[index]!);
  // Cleared first: the box opens holding the row's CURRENT words, and the popup
  // filters on everything in it — so typing straight on the end searches for
  // "panCosori" and finds nothing, which is what a cook replacing a row does too.
  await user.clear(fields()[index]!);
  await user.type(fields()[index]!, typed);
  const option = await screen.findByRole('option', { name: optionLabel });
  await user.click(option);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('RecipeKitPanel — read mode is what it always was', () => {
  it('renders the grouped list, folding an accessory into its appliance', () => {
    show(
      recipeWith([
        entry({ label: 'rice cooker', equipment: { itemId: 'eq-cosori', accessoryId: null } }),
        entry({
          label: 'steam basket',
          equipment: { itemId: 'eq-cosori', accessoryId: 'acc-basket' },
        }),
      ]),
      false,
      { items: [COSORI] },
    );

    const rows = screen.getAllByTestId('recipe-kit-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByTestId('recipe-kit-accessories').textContent).toContain(
      'with the steam basket',
    );
    // The label opens with a capital and nothing else is re-cased.
    expect(rows[0]!.textContent).toContain('Rice cooker');
    expect(screen.queryByTestId('recipe-kit-edit-list')).toBeNull();
  });

  it('draws no tile on a picture miss, and makes that row the button', async () => {
    show(recipeWith([entry({ label: 'box grater' })]), false);

    expect(screen.queryByRole('img')).toBeNull();
    await fireEvent.click(screen.getByTestId('recipe-kit-picture-btn'));
    expect(onPicture).toHaveBeenCalledWith('box grater');
  });

  it('leaves a row that already has a picture unclickable', () => {
    show(recipeWith([entry({ label: 'frying pan' })]), false, { drawn: ['frying pan'] });

    expect(screen.queryByTestId('recipe-kit-picture-btn')).toBeNull();
    expect(screen.getAllByTestId('recipe-kit-row')).toHaveLength(1);
  });
});

describe('RecipeKitPanel — the list becomes editable', () => {
  it('draws the FLAT stored list, one row per entry, not the grouped one', () => {
    show(
      recipeWith([
        entry({ label: 'rice cooker', equipment: { itemId: 'eq-cosori', accessoryId: null } }),
        entry({
          label: 'steam basket',
          equipment: { itemId: 'eq-cosori', accessoryId: 'acc-basket' },
        }),
      ]),
      true,
      { items: [COSORI] },
    );

    expect(screen.getAllByTestId('recipe-kit-edit-row')).toHaveLength(2);
    // The read list — and with it the folded row, the picture button and the
    // accessory continuation — is gone entirely.
    expect(screen.queryByTestId('recipe-kit-list')).toBeNull();
    expect(screen.queryByTestId('recipe-kit-picture-btn')).toBeNull();
    expect(screen.queryByTestId('recipe-kit-accessories')).toBeNull();
  });

  it('shows each row s current words in its own box', () => {
    show(recipeWith([entry({ label: 'frying pan' }), entry({ label: 'box grater' })]), true);

    expect(fields().map((f) => (f as HTMLInputElement).value)).toEqual([
      'frying pan',
      'box grater',
    ]);
  });

  it('renames a row by free text, keeping its stepIds and writing no link', async () => {
    const user = userEvent.setup();
    show(recipeWith([entry({ label: 'pan', stepIds: ['step-3', 'step-9'] })]), true, {
      items: [COSORI],
    });

    await user.clear(fields()[0]!);
    await user.type(fields()[0]!, 'large frying pan');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([
      { label: 'large frying pan', stepIds: ['step-3', 'step-9'], equipment: null },
    ]);
  });

  it('records WHICH of your things when one is chosen, and takes its manifest name', async () => {
    show(recipeWith([entry({ label: 'pan', stepIds: ['step-1'] })]), true, { items: [COSORI] });

    await choose(0, 'Cosori', 'Cosori 5L Rice Cooker');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([
      {
        label: 'Cosori 5L Rice Cooker',
        stepIds: ['step-1'],
        equipment: { itemId: 'eq-cosori', accessoryId: null },
      },
    ]);
  });

  it('records an accessory as item + accessory, labelled with the accessory alone', async () => {
    show(recipeWith([entry({ label: 'basket' })]), true, { items: [COSORI] });

    // The OPTION reads "Steam Basket — Cosori 5L Rice Cooker" so two identically
    // named entries under different machines are tellable apart; the ROW says what
    // the thing is called.
    await choose(0, 'Steam', 'Steam Basket — Cosori 5L Rice Cooker');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([
      {
        label: 'Steam Basket',
        stepIds: [],
        equipment: { itemId: 'eq-cosori', accessoryId: 'acc-basket' },
      },
    ]);
  });

  it('records a FAMILY member the same way — the case words alone can never reach', async () => {
    show(recipeWith([entry({ label: 'frying pan' })]), true, { items: [PANS] });

    await choose(0, 'Tefal', 'Tefal non-stick 28cm — Frying Pans');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([
      {
        label: 'Tefal non-stick 28cm',
        stepIds: [],
        equipment: { itemId: 'eq-pans', accessoryId: 'fam-tefal' },
      },
    ]);
  });

  it('writes a kitchen tool as WORDS with no link — no kitchenTools id reaches the recipe', async () => {
    // The Rule 12 pin on `RecipeKitEntrySchema`'s "NO `kitchenTools` ID IS EVER
    // WRITTEN HERE". The vocabulary grows and shrinks and every recipe that
    // already says the word gains a picture for free; an id would freeze that.
    show(recipeWith([entry({ label: 'bowl', stepIds: ['step-2'] })]), true, {
      items: [COSORI],
      tools: [tool('kt-mixing-bowl', 'mixing bowl')],
    });

    await choose(0, 'mixing', 'mixing bowl');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([{ label: 'mixing bowl', stepIds: ['step-2'], equipment: null }]);
    // Said twice on purpose: the label assertion above stays green when an id is
    // written, so it is this one that goes red.
    expect(JSON.stringify(lastEdit())).not.toContain('kt-mixing-bowl');
  });

  it('removes exactly ONE stored entry from a folded appliance-and-accessory group', async () => {
    const stored = [
      entry({ label: 'rice cooker', equipment: { itemId: 'eq-cosori', accessoryId: null } }),
      entry({
        label: 'steam basket',
        equipment: { itemId: 'eq-cosori', accessoryId: 'acc-basket' },
      }),
      entry({ label: 'rice spoon', equipment: { itemId: 'eq-cosori', accessoryId: 'acc-spoon' } }),
    ];
    // Read mode draws these three as ONE row, which is why Remove could not live
    // there: the rendered row has no single stored entry to delete.
    expect(groupKitByEquipment(stored, [COSORI])).toHaveLength(1);
    show(recipeWith(stored), true, { items: [COSORI] });

    await fireEvent.click(screen.getAllByTestId('recipe-edit-kit-remove')[1]!);

    expect(lastKit().map((e) => e.label)).toEqual(['rice cooker', 'rice spoon']);
  });

  it('reorders through ReorderControl, and guards both ends', async () => {
    show(recipeWith([entry({ label: 'a' }), entry({ label: 'b' }), entry({ label: 'c' })]), true);

    expect(screen.getAllByLabelText('Move equipment up')[0]).toBeDisabled();
    expect(screen.getAllByLabelText('Move equipment down')[2]).toBeDisabled();

    await fireEvent.click(screen.getAllByLabelText('Move equipment down')[0]!);
    expect(lastKit().map((e) => e.label)).toEqual(['b', 'a', 'c']);
  });

  it('adds a row the slot promises — blank, stepless and unlinked', async () => {
    show(recipeWith([entry({ label: 'frying pan' })]), true);

    await fireEvent.click(screen.getByTestId('recipe-edit-kit-add'));

    expect(lastKit()).toEqual([
      { label: 'frying pan', stepIds: [], equipment: null },
      { label: '', stepIds: [], equipment: null },
    ]);
  });

  it('offers + Add equipment on a recipe with no kit at all — the #1418 case', () => {
    show(recipeWith([]), true);

    expect(screen.getByTestId('recipe-edit-kit-add')).toBeTruthy();
    expect(screen.queryAllByTestId('recipe-edit-kit-edit-row')).toHaveLength(0);
  });

  it('keeps a labelless row on screen — pruning is the page s, at every exit', async () => {
    const { rerender } = show(recipeWith([entry({ label: '' })]), true);

    expect(fields()).toHaveLength(1);
    await rerender({ recipe: recipeWith([entry({ label: '' })]) } as never);
    expect(fields()).toHaveLength(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('drops every open box the moment editing ends', async () => {
    // #1319's standing requirement 1, and here it holds by construction rather
    // than by an effect: the boxes live inside the edit arm, so `editing` going
    // false unmounts them along with whatever each was holding.
    const recipe = recipeWith([entry({ label: 'frying pan' })]);
    const { rerender } = show(recipe, true);
    await userEvent.setup().type(fields()[0]!, ' xyz');

    await rerender({ editing: false } as never);

    expect(fields()).toHaveLength(0);
    expect(screen.getAllByTestId('recipe-kit-row')).toHaveLength(1);
    // And nothing typed but never committed reached the document.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('leaves every OTHER row exactly as it was when one is changed', async () => {
    const user = userEvent.setup();
    show(
      recipeWith([
        entry({ label: 'frying pan', stepIds: ['step-1'] }),
        entry({ label: 'pan', stepIds: ['step-2'] }),
      ]),
      true,
    );

    await user.clear(fields()[1]!);
    await user.type(fields()[1]!, 'box grater');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(lastKit()).toEqual([
      { label: 'frying pan', stepIds: ['step-1'], equipment: null },
      { label: 'box grater', stepIds: ['step-2'], equipment: null },
    ]);
  });

  it('says so when a blank row has nothing to offer and nothing typed', async () => {
    // Nothing owned, nothing drawn, nothing typed — the one state with neither an
    // option to pick nor words to keep, so the popup has to say something.
    show(recipeWith([entry({ label: '' })]), true);

    await userEvent.setup().click(fields()[0]!);

    expect(await screen.findByText('Nothing matches.')).toBeTruthy();
  });

  it('keeps the picture in the gutter while editing, and draws none on a miss', () => {
    // The tile is what tells you at a glance which row you are about to change, so
    // it stays; #882's no-tile-on-a-miss rule stays with it, in both modes.
    show(recipeWith([entry({ label: 'frying pan' }), entry({ label: 'box grater' })]), true, {
      drawn: ['frying pan'],
    });

    const rows = screen.getAllByTestId('recipe-kit-edit-row');
    expect(within(rows[0]!).getByTestId('canon-icon-img')).toBeTruthy();
    expect(within(rows[1]!).queryByTestId('canon-icon')).toBeNull();
  });

  it('offers an item with no accessories array at all, rather than throwing', () => {
    // `EquipmentItem` types `accessories` as present and the schema defaults it,
    // so a PARSED manifest always carries the array — but a projection or a page
    // fixture need not, and a render is the wrong place to find that out.
    // `resolveKitEntryEquipment` takes the same stance for the same reason.
    const partial = { id: 'eq-bare', name: 'Sage Pizzaiolo' } as unknown as EquipmentItem;
    show(recipeWith([entry({ label: 'oven' })]), true, { items: [partial] });

    expect(fields()).toHaveLength(1);
    expect((fields()[0] as HTMLInputElement).value).toBe('oven');
  });

  it('reads a dangling link as the row s own words rather than a phantom choice', () => {
    // The manifest no longer holds `eq-gone`. `resolveKitEntryEquipment` reads
    // that as a miss everywhere else, and so does the box.
    show(
      recipeWith([
        entry({ label: 'rice cooker', equipment: { itemId: 'eq-gone', accessoryId: null } }),
      ]),
      true,
      { items: [COSORI] },
    );

    expect((fields()[0] as HTMLInputElement).value).toBe('rice cooker');
  });
});
