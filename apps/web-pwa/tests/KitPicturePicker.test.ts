import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';
import type { EquipmentIconDoc, KitchenToolDoc, RecipeKitEntryDoc } from '@salt/domain/schemas';

// Giving a pictureless kit row a picture, from the recipe you noticed it on
// (issue #1465, Phase 3).
//
// THE ONE THING WORTH PINNING is which of two different acts a row gets, because
// they are indistinguishable on screen and opposite underneath:
//
//   • a row that LINKS one of your things writes a BORROWED PICTURE onto the
//     manifest — a fact about that object;
//   • a row that links nothing writes a MATCHER onto a curated tool — a fact
//     about those words, which lights up every recipe that already said them.
//
// Getting that the wrong way round would either teach the vocabulary a brand name
// nobody else will ever type, or silently do nothing to the thing you were
// looking at.

const { mockEquipment, mockEquipmentIcons, mockKitchenTools } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockEquipment: makeStore<EquipmentManifest | null>(null),
    mockEquipmentIcons: makeStore<Map<string, EquipmentIconDoc>>(new Map()),
    mockKitchenTools: makeStore<readonly KitchenToolDoc[]>([]),
  };
});

const mockPush = vi.fn();
vi.mock('svelte-spa-router', () => ({ push: (...args: unknown[]) => mockPush(...args) }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  equipmentIcons: mockEquipmentIcons,
  setBorrowedPictureFor: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
// Only the vocabulary store and the two write commands stand in; `toolPicture` —
// the tri-state fold and the cache-bust rule — stays the real one.
vi.mock('../src/lib/kitchenToolService.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/kitchenToolService.js')>()),
  kitchenTools: mockKitchenTools,
  addKitchenTool: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addKitchenToolMatcher: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import KitPicturePicker from '../src/routes/recipes/KitPicturePicker.svelte';
import { setBorrowedPictureFor } from '../src/lib/equipmentService.js';
import { addKitchenTool, addKitchenToolMatcher } from '../src/lib/kitchenToolService.js';
import { addToast } from '../src/lib/toastStore.js';

const tool = (id: string, label: string, matchers: string[] = []): KitchenToolDoc =>
  ({
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail: `https://example.test/${id}.webp`,
    createdAt: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as KitchenToolDoc;

const MANIFEST: EquipmentManifest = {
  schemaVersion: 1,
  updatedAt: '',
  items: [
    {
      id: 'eq-pans',
      schemaVersion: 1,
      name: 'Frying Pans',
      kind: 'family',
      accessories: [
        {
          id: 'acc-tefal',
          name: 'Tefal non-stick 28cm',
          owned: true,
          included: false,
          note: '',
          borrowedPicture: null,
        },
      ],
      rules: [],
      note: '',
      environment: null,
      borrowedPicture: null,
      updatedAt: '',
    },
  ],
};

const entry = (label: string, equipment: RecipeKitEntryDoc['equipment'] = null) =>
  ({ label, stepIds: [], equipment }) as RecipeKitEntryDoc;

function open(e: RecipeKitEntryDoc, onClose: () => void = vi.fn()): void {
  render(KitPicturePicker, { props: { open: true, onClose, entry: e } });
}

/**
 * Pick one row out of the searchable list.
 *
 * `fireEvent`, not `userEvent`: the list lives inside a Dialog, and bits-ui puts
 * `pointer-events: none` on the body while one is open — which `userEvent`
 * honours and which makes this the standing web-pwa suite flake (it passes
 * alone and drops the click under load).
 */
async function chooseFromList(label: string): Promise<void> {
  await fireEvent.click(screen.getByRole('combobox'));
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  await fireEvent.click(screen.getByText(label));
  // The button unlocks only once a choice has actually landed, so waiting for it
  // is what makes a dropped click fail here rather than silently assert nothing.
  await waitFor(() =>
    expect(screen.getByTestId('kit-picture-use-chosen').getAttribute('data-disabled')).toBe(null),
  );
  await fireEvent.click(screen.getByTestId('kit-picture-use-chosen'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEquipment.set(MANIFEST);
  mockEquipmentIcons.set(new Map());
  mockKitchenTools.set([tool('frying-pan', 'Frying pan'), tool('mixing-bowl', 'Mixing bowl')]);
});

afterEach(cleanup);

describe('KitPicturePicker — one of your things', () => {
  // A label the vocabulary cannot already name, so Salt has a suggestion to lead
  // with — `suggestKitchenToolParent` answers null for anything that resolves.
  const LINKED = entry('non-stick pan', { itemId: 'eq-pans', accessoryId: 'acc-tefal' });

  it('writes the chosen picture onto the THING, so every recipe naming it gains one', async () => {
    open(LINKED);
    await userEvent.click(screen.getByTestId('kit-picture-suggestion'));
    await waitFor(() =>
      expect(setBorrowedPictureFor).toHaveBeenCalledWith('eq-pans', 'acc-tefal', {
        family: 'kitchenTool',
        id: 'frying-pan',
      }),
    );
    // Never a matcher: the row names a specific pan, and what the person meant is
    // "that pan looks like this drawing" — a fact about the pan, not about the
    // words. Teaching the vocabulary a phrase per pan is exactly #956's bloat.
    expect(addKitchenToolMatcher).not.toHaveBeenCalled();
  });

  it('hands "draw one" to the equipment record, where the read-the-description gate lives', async () => {
    open(LINKED);
    await userEvent.click(screen.getByTestId('kit-picture-draw-new'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/equipment/eq-pans'));
    expect(addKitchenTool).not.toHaveBeenCalled();
  });
});

describe('KitPicturePicker — resolved by words alone (review of #1482)', () => {
  // A row with NO recorded link whose label already names one of your things by
  // WORDS — every unlinked stored recipe reaches this dialog exactly this way
  // until Phase 4 re-runs them (`resolveEquipmentItem` is asked before tools in
  // `kitIcons.ts`, so the strip already draws this row as "one of your things").
  // Before the fix the picker asked "is there a *recorded* link?" and answered
  // no, so choosing wrote a matcher `kitIcons.ts` could never reach, and "draw
  // new" minted a duplicate, instance-named `kitchenTools` document — the exact
  // #956 row the issue's own pointer forbids.
  it('treats a word-resolved row as one of your things, not ordinary words', async () => {
    open(entry('Frying Pans'));
    expect(screen.getByTestId('kit-picture-picker').textContent).toContain('Frying Pans');
    await chooseFromList('Frying pan');
    await waitFor(() =>
      expect(setBorrowedPictureFor).toHaveBeenCalledWith('eq-pans', null, {
        family: 'kitchenTool',
        id: 'frying-pan',
      }),
    );
    // Never a matcher, and never onto a name the renderer's link-then-words
    // order would skip straight past.
    expect(addKitchenToolMatcher).not.toHaveBeenCalled();
  });

  it('hands "draw one" to the equipment record for a word-resolved row too', async () => {
    open(entry('Frying Pans'));
    await userEvent.click(screen.getByTestId('kit-picture-draw-new'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/equipment/eq-pans'));
    // Never a second, instance-named tool.
    expect(addKitchenTool).not.toHaveBeenCalled();
  });
});

describe('KitPicturePicker — ordinary words', () => {
  it("teaches the chosen tool the row's words, and draws nothing", async () => {
    open(entry('heatproof bowl'));
    // Salt's guess leads: "heatproof bowl" shares its head noun with "Mixing
    // bowl" without the vocabulary already naming it, so one tap resolves the gap
    // and no second drawing is minted. That ordering is the whole answer to
    // #1458's objection — minting stays available, it just is not the easy one.
    const suggestion = screen.getByTestId('kit-picture-suggestion');
    expect(suggestion.textContent).toContain('Mixing bowl');
    await userEvent.click(suggestion);
    await waitFor(() =>
      expect(addKitchenToolMatcher).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mixing-bowl' }),
        'heatproof bowl',
      ),
    );
    expect(addKitchenTool).not.toHaveBeenCalled();
    expect(setBorrowedPictureFor).not.toHaveBeenCalled();
  });

  it('mints a tool named after the words when nothing existing fits', async () => {
    open(entry('tagine'));
    // Nothing shares the head noun, so there is no suggestion to lead with and
    // "draw a new one" is the honest answer.
    expect(screen.queryByTestId('kit-picture-suggestion')).toBeNull();
    await userEvent.click(screen.getByTestId('kit-picture-draw-new'));
    await waitFor(() =>
      expect(addKitchenTool).toHaveBeenCalledWith({ label: 'Tagine', matchers: [] }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('never suggests a tool with nothing actually drawn (should-fix, review of #1482)', async () => {
    // `suggestKitchenToolParent` ranks on shared trailing words alone and never
    // reads `thumbnail`, so an UNDRAWN tool can still win the guess. The
    // searchable list beside it is filtered on `toolPicture(t) !== null`; the
    // suggestion must be too, or tapping it writes a borrow that resolves to no
    // picture, with the same "Picture set" toast.
    mockKitchenTools.set([
      tool('frying-pan', 'Frying pan'),
      { ...tool('griddle-plate', 'Griddle plate'), thumbnail: null },
    ]);
    open(entry('square griddle plate'));
    expect(screen.queryByTestId('kit-picture-suggestion')).toBeNull();
  });

  it('offers only TOOL pictures, never equipment, for words that name nothing you own', async () => {
    mockEquipmentIcons.set(
      new Map([['eq-pans', { thumbnail: 'https://example.test/pans.webp' } as EquipmentIconDoc]]),
    );
    open(entry('tagine'));
    await userEvent.click(screen.getByRole('combobox'));
    // An equipment record has no matchers, so there is nothing for a word to be
    // taught to — offering one would be offering an action that cannot happen.
    await waitFor(() => expect(screen.getByText('Frying pan')).toBeTruthy());
    expect(screen.queryByText('Frying Pans')).toBeNull();
  });
});

describe('KitPicturePicker — the searchable list, and what a refusal costs', () => {
  const LINKED = entry('non-stick pan', { itemId: 'eq-pans', accessoryId: 'acc-tefal' });

  it('borrows another piece of EQUIPMENT’s picture when one is chosen', async () => {
    mockEquipmentIcons.set(
      new Map([['eq-pans', { thumbnail: 'https://example.test/pans.webp' } as EquipmentIconDoc]]),
    );
    open(LINKED);
    await chooseFromList('Frying Pans');
    await waitFor(() =>
      expect(setBorrowedPictureFor).toHaveBeenCalledWith('eq-pans', 'acc-tefal', {
        family: 'equipment',
        id: 'eq-pans',
      }),
    );
  });

  it('says so when the write is refused, and stays open', async () => {
    vi.mocked(setBorrowedPictureFor).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    const onClose = vi.fn();
    open(LINKED, onClose);
    await userEvent.click(screen.getByTestId('kit-picture-suggestion'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Couldn't set the picture.", 'destructive'),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  // `createKitchenTool` refuses an identical slug as a `conflict` rather than an
  // `err`: it would otherwise replace a curated tool — matchers, drawing and all —
  // with a blank one. The two refusals want different next moves, so they say
  // different things.
  it('points at the existing drawing when the new name is already taken', async () => {
    const existing = tool('tagine', 'Tagine');
    vi.mocked(addKitchenTool).mockResolvedValueOnce({
      kind: 'conflict',
      local: existing,
      remote: existing,
    });
    open(entry('tagine'));
    await userEvent.click(screen.getByTestId('kit-picture-draw-new'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        'Something with that name is already drawn — choose it above instead.',
        'destructive',
      ),
    );
  });

  // A family is a category nobody will draw a portrait of, so the record itself
  // borrowing the generic drawing is the realistic case — and it is the arm where
  // the write carries a null entry id.
  it('borrows for the RECORD when the row names it rather than one of its entries', async () => {
    open(entry('frying pan', { itemId: 'eq-pans', accessoryId: null }));
    expect(screen.getByTestId('kit-picture-picker').textContent).toContain('Frying Pans');
    await chooseFromList('Frying pan');
    await waitFor(() =>
      expect(setBorrowedPictureFor).toHaveBeenCalledWith('eq-pans', null, {
        family: 'kitchenTool',
        id: 'frying-pan',
      }),
    );
  });

  it('hands the close back to the page, which owns which row is open', async () => {
    const onClose = vi.fn();
    open(entry('tagine'), onClose);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
