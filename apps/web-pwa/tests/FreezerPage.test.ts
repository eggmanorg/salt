import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { ErrorCode, failure, success } from '@salt/shared-types';
import {
  emptyRecipe,
  type CanonItem,
  type FreezerConfig,
  type FreezerItem,
  type Recipe,
} from '@salt/domain';
import type { FreezerConfigState, FreezerItemsState } from '../src/lib/freezerService.js';

// The freezer page, its setup sheet (issue #1682) and its item sheet (issue
// #1684) — `/freezer`.
//
// The page shows each freezer and its shelves with what is on them. The sheets
// are where the places are set up and the items added, changed and removed, and
// every refusal they show comes from the service's result — so these cases drive
// the sheets and assert which command was called with what, and what is said
// when it is refused.

const {
  mockState,
  mockItems,
  mockInit,
  mockAdd,
  mockRename,
  mockSetShelves,
  mockRemove,
  mockAddItem,
  mockUpdateItem,
  mockRemoveItem,
  mockTake,
  mockShelve,
  mockForget,
  mockCanon,
  mockRecipes,
  mockGate,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockState: makeStore<FreezerConfigState>({ status: 'loading' }),
    mockItems: makeStore<FreezerItemsState>({ status: 'loaded', items: [] }),
    mockInit: vi.fn(() => () => {}),
    mockAdd: vi.fn(),
    mockRename: vi.fn(),
    mockSetShelves: vi.fn(),
    mockRemove: vi.fn(),
    mockAddItem: vi.fn(),
    mockUpdateItem: vi.fn(),
    mockRemoveItem: vi.fn(),
    mockTake: vi.fn(),
    mockShelve: vi.fn(),
    mockForget: vi.fn(),
    mockCanon: makeStore<readonly CanonItem[]>([]),
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockGate: makeStore<{ enabled: boolean; settled: boolean }>({
      enabled: true,
      settled: true,
    }),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/freezerService.js', () => ({
  freezerConfigState: mockState,
  freezerItemsState: mockItems,
  initFreezerSync: mockInit,
  addFreezerItem: mockAddItem,
  updateFreezerItem: mockUpdateItem,
  removeFreezerItem: mockRemoveItem,
  takeOneFreezerPack: mockTake,
  shelveFreezerItem: mockShelve,
  forgetSupplier: mockForget,
  addFreezer: mockAdd,
  renameFreezer: mockRename,
  setFreezerShelves: mockSetShelves,
  removeFreezer: mockRemove,
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanon }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  // The id index, derived from the same stub so one seed serves both.
  recipesById: {
    subscribe: (run: (m: ReadonlyMap<string, Recipe>) => void) =>
      mockRecipes.subscribe((list) => run(new Map(list.map((r) => [r.id, r])))),
  },
}));
vi.mock('../src/lib/featureGate.js', () => ({
  freezerGate: mockGate,
  featureGate: () => mockGate,
  isFeatureEnabled: () => true,
}));

import { push } from 'svelte-spa-router';
import FreezerPage from '../src/routes/freezer/FreezerPage.svelte';
import FreezerItemSheet from '../src/routes/freezer/FreezerItemSheet.svelte';
import ManageFreezersSheet from '../src/routes/freezer/ManageFreezersSheet.svelte';

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B', 'C', 'D'] };
const KITCHEN = { id: 'fz-kitchen', name: 'Kitchen', shelves: [] };

function loaded(
  freezers: FreezerConfig['freezers'],
  suppliers: string[] = [],
  highestNumber = 0,
): FreezerConfigState {
  return {
    status: 'loaded',
    config: {
      schemaVersion: 1,
      updatedAt: '2026-10-12T09:00:00.000Z',
      freezers,
      suppliers,
      highestNumber,
    },
  };
}

const OK = success(loaded([]));

function item(number: number, over: Partial<FreezerItem> = {}): FreezerItem {
  return {
    schemaVersion: 1,
    number,
    name: `Item ${number}`,
    freezerId: GARAGE.id,
    shelf: 'A',
    amount: 1,
    canonId: null,
    recipeId: null,
    purchasedFrom: null,
    packWeight: null,
    notes: null,
    addedAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    ...over,
  };
}

function stocked(items: FreezerItem[]): void {
  mockItems.set({ status: 'loaded', items });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockState.set({ status: 'loading' });
  mockItems.set({ status: 'loaded', items: [] });
  mockGate.set({ enabled: true, settled: true });
  mockCanon.set([]);
  mockRecipes.set([]);
  for (const fn of [mockAdd, mockRename, mockSetShelves, mockRemove, mockForget]) {
    fn.mockResolvedValue(OK);
  }
  for (const fn of [mockAddItem, mockUpdateItem, mockRemoveItem, mockShelve]) {
    fn.mockResolvedValue(success(item(1)));
  }
});

async function openSheet(testId: string): Promise<HTMLElement> {
  await fireEvent.click(await screen.findByTestId(testId));
  return screen.findByRole('dialog');
}

describe('FreezerPage', () => {
  it('owns the subscription', () => {
    render(FreezerPage);
    expect(mockInit).toHaveBeenCalledOnce();
  });

  it('says nothing is set up when the document is absent, and offers setup', async () => {
    mockState.set({ status: 'loaded', config: null });
    render(FreezerPage);

    expect(await screen.findByTestId('freezer-empty')).toHaveTextContent('No freezers set up yet.');
    const sheet = await openSheet('freezer-setup');
    expect(within(sheet).getByText('Manage freezers')).toBeInTheDocument();
  });

  it('treats a config with no freezers the same as no config', async () => {
    mockState.set(loaded([]));
    render(FreezerPage);
    expect(await screen.findByTestId('freezer-empty')).toBeInTheDocument();
  });

  it('shows each freezer with its shelves, all empty, and says the freezer is empty', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    render(FreezerPage);

    const cards = await screen.findAllByTestId('freezer-card');
    expect(cards.map((c) => within(c).getByTestId('freezer-card-name').textContent)).toEqual([
      'Garage',
      'Kitchen',
    ]);
    const shelves = within(cards[0] as HTMLElement).getAllByTestId('freezer-shelf');
    expect(shelves.map((s) => s.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Shelf A Empty',
      'Shelf B Empty',
      'Shelf C Empty',
      'Shelf D Empty',
    ]);
    // A freezer with no shelves holds its items in one unlabelled group.
    expect(
      within(cards[1] as HTMLElement)
        .getAllByTestId('freezer-shelf')
        .map((s) => s.textContent?.trim()),
    ).toEqual(['Empty']);
    expect(screen.getByTestId('freezer-contents-empty')).toHaveTextContent(
      'Nothing in the freezer yet.',
    );
  });

  it('says so when the freezers could not be loaded', async () => {
    mockState.set({ status: 'failed' });
    render(FreezerPage);
    expect(await screen.findByTestId('freezer-error')).toBeInTheDocument();
    expect(screen.queryByTestId('freezer-empty')).not.toBeInTheDocument();
  });

  it('renders nothing and goes home when the freezer flag is off', async () => {
    mockGate.set({ enabled: false, settled: true });
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(screen.queryByTestId('freezer-page')).not.toBeInTheDocument();
  });
});

describe('ManageFreezersSheet', () => {
  it('adds a freezer by name', async () => {
    mockState.set({ status: 'loaded', config: null });
    render(FreezerPage);
    const sheet = await openSheet('freezer-setup');

    const input = within(sheet).getByTestId('manage-new-freezer-name');
    await fireEvent.input(input, { target: { value: 'Garage' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('Garage'));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('shows the refusal for a blank or duplicate name, and keeps what was typed', async () => {
    mockState.set(loaded([GARAGE]));
    mockAdd.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_FREEZER_NAME }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    const input = within(sheet).getByTestId('manage-new-freezer-name');
    await fireEvent.input(input, { target: { value: 'garage' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));

    expect(await within(sheet).findByTestId('manage-new-freezer-error')).toHaveTextContent(
      'There is already a freezer with that name.',
    );
    expect((input as HTMLInputElement).value).toBe('garage');

    mockAdd.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_NAME }),
    );
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.click(within(sheet).getByTestId('manage-new-freezer-add'));
    await waitFor(() =>
      expect(within(sheet).getByTestId('manage-new-freezer-error')).toHaveTextContent(
        'Give the freezer a name.',
      ),
    );
  });

  it('renames a freezer by its id once the name is changed', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    expect(within(sheet).queryByTestId('manage-freezer-rename')).not.toBeInTheDocument();
    await fireEvent.input(within(sheet).getByTestId('manage-freezer-name'), {
      target: { value: 'Shed' },
    });
    await fireEvent.click(await within(sheet).findByTestId('manage-freezer-rename'));

    await waitFor(() => expect(mockRename).toHaveBeenCalledWith('fz-garage', 'Shed'));
  });

  it('adds a shelf to the end of the freezer’s list', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.input(within(sheet).getByTestId('manage-shelf-input'), {
      target: { value: 'E' },
    });
    await fireEvent.click(within(sheet).getByTestId('manage-shelf-add'));

    await waitFor(() =>
      expect(mockSetShelves).toHaveBeenCalledWith('fz-garage', ['A', 'B', 'C', 'D', 'E']),
    );
  });

  it('shows the refusal for a repeated shelf label', async () => {
    mockState.set(loaded([GARAGE]));
    mockSetShelves.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_SHELF_LABEL }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.input(within(sheet).getByTestId('manage-shelf-input'), {
      target: { value: 'a' },
    });
    await fireEvent.click(within(sheet).getByTestId('manage-shelf-add'));

    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      'This freezer already has a shelf with that label.',
    );
  });

  it('removes a shelf, leaving the rest in order', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove shelf B' }));

    await waitFor(() => expect(mockSetShelves).toHaveBeenCalledWith('fz-garage', ['A', 'C', 'D']));
  });

  it('removes a freezer', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Garage' }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('fz-garage'));
  });

  it('says a renamed freezer has just been removed when the rename finds it gone', async () => {
    mockState.set(loaded([GARAGE]));
    mockRename.mockResolvedValue(failure({ kind: 'NotFound', resource: 'freezer', id: 'x' }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.input(within(sheet).getByTestId('manage-freezer-name'), {
      target: { value: 'Shed' },
    });
    await fireEvent.click(await within(sheet).findByTestId('manage-freezer-rename'));

    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      'That freezer has just been removed.',
    );
    // The draft is kept: the field still shows what was typed, not the stored name.
    expect((within(sheet).getByTestId('manage-freezer-name') as HTMLInputElement).value).toBe(
      'Shed',
    );
  });

  it('submitting the name with nothing typed renames nothing', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    const form = within(sheet).getByTestId('manage-freezer-name').closest('form');
    await fireEvent.submit(form as HTMLFormElement);

    expect(mockRename).not.toHaveBeenCalled();
  });

  it('adding a shelf with nothing typed sends a blank label, and shows its refusal', async () => {
    mockState.set(loaded([KITCHEN]));
    mockSetShelves.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_SHELF_LABEL }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByTestId('manage-shelf-add'));

    await waitFor(() => expect(mockSetShelves).toHaveBeenCalledWith('fz-kitchen', ['']));
    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      'Give the shelf a label.',
    );
  });

  it('says so when the freezer has just been removed', async () => {
    mockState.set(loaded([GARAGE]));
    mockRemove.mockResolvedValue(
      failure({ kind: 'NotFound', resource: 'freezer', id: 'fz-garage' }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Garage' }));

    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      'That freezer has just been removed.',
    );
  });
});

describe('freezer stock — the list (issue #1684)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists items under their freezer and shelf with number, name, packs and age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-07T09:00:00.000Z'));
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([
      item(47, { name: 'Pork loin', shelf: 'B', amount: 1, addedAt: '2026-06-12T09:00:00.000Z' }),
      item(3, { name: 'Prawns', shelf: 'B', amount: 5, addedAt: '2026-08-05T09:00:00.000Z' }),
      item(9, {
        name: 'Stock',
        freezerId: KITCHEN.id,
        shelf: null,
        addedAt: '2026-08-07T08:00:00.000Z',
      }),
      item(5, { addedAt: '2026-07-31T09:00:00.000Z' }),
      item(6, { addedAt: '2026-08-06T09:00:00.000Z' }),
    ]);
    render(FreezerPage);

    const cards = await screen.findAllByTestId('freezer-card');
    const shelfB = within(cards[0] as HTMLElement).getAllByTestId(
      'freezer-shelf',
    )[1] as HTMLElement;
    const rows = within(shelfB).getAllByTestId('freezer-item');
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '#0003 Prawns — 5 packs in since 5 Aug · 2 days',
      '#0047 Pork loin — 1 pack in since 12 Jun · 8 weeks',
    ]);
    expect(within(cards[1] as HTMLElement).getByTestId('freezer-item')).toHaveTextContent(
      'in since 7 Aug · today',
    );
    const shelfA = within(cards[0] as HTMLElement).getAllByTestId(
      'freezer-shelf',
    )[0] as HTMLElement;
    expect(
      within(shelfA)
        .getAllByTestId('freezer-item-meta')
        .map((m) => m.textContent?.trim()),
    ).toEqual(['in since 31 Jul · 1 week', 'in since 6 Aug · 1 day']);
    expect(screen.queryByTestId('freezer-contents-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('freezer-not-placed')).not.toBeInTheDocument();
  });

  it('puts items whose freezer or shelf is gone under Not placed, at the top', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(1), item(2, { freezerId: 'fz-removed' }), item(3, { shelf: 'Z' })]);
    render(FreezerPage);

    const group = await screen.findByTestId('freezer-not-placed');
    expect(
      within(group)
        .getAllByTestId('freezer-item')
        .map((r) => r.dataset['number']),
    ).toEqual(['2', '3']);
    const list = screen.getByTestId('freezer-list');
    expect(list.firstElementChild).toBe(group);
  });

  it('heads a freezer with its packs that have no shelf yet, and shelves one in a tap', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(1), item(12, { name: 'Lamb mince', shelf: null })]);
    render(FreezerPage);

    const group = await screen.findByTestId('freezer-unshelved');
    const card = screen.getByTestId('freezer-card');
    expect(group.parentElement?.firstElementChild).toBe(group);
    expect(card.contains(group)).toBe(true);
    expect(within(group).getByTestId('freezer-item')).toHaveAttribute('data-number', '12');
    expect(screen.queryByTestId('freezer-not-placed')).not.toBeInTheDocument();

    const shelves = within(group).getByRole('group', { name: 'Shelf for #12 Lamb mince' });
    expect(
      within(shelves)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['A', 'B', 'C', 'D']);
    await fireEvent.click(within(shelves).getByRole('button', { name: 'C' }));
    expect(mockShelve).toHaveBeenCalledWith(12, GARAGE.id, 'C');
  });

  it('says so when shelving a pack finds it gone', async () => {
    mockShelve.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezerItem', id: '12' },
    });
    mockState.set(loaded([GARAGE]));
    stocked([item(12, { shelf: null })]);
    render(FreezerPage);

    const group = await screen.findByTestId('freezer-unshelved');
    await fireEvent.click(within(group).getByRole('button', { name: 'A' }));
    expect(await screen.findByTestId('freezer-take-error')).toHaveTextContent(
      'That has just been taken out on another phone.',
    );
  });

  it('says a shelving failed for any other reason, and clears it once one succeeds', async () => {
    mockShelve.mockResolvedValueOnce(failure({ kind: 'NetworkError', reason: 'transient' }));
    mockState.set(loaded([GARAGE]));
    stocked([item(12, { shelf: null })]);
    render(FreezerPage);

    const group = await screen.findByTestId('freezer-unshelved');
    await fireEvent.click(within(group).getByRole('button', { name: 'A' }));
    expect(await screen.findByTestId('freezer-take-error')).toHaveTextContent(
      "Couldn't move that yet. Try again.",
    );
    await fireEvent.click(within(group).getByRole('button', { name: 'B' }));
    await waitFor(() => expect(screen.queryByTestId('freezer-take-error')).not.toBeInTheDocument());
  });

  it('shows the stock even when every freezer has been removed', async () => {
    mockState.set(loaded([]));
    stocked([item(4, { freezerId: 'fz-removed' })]);
    render(FreezerPage);

    expect(await screen.findByTestId('freezer-not-placed')).toBeInTheDocument();
    expect(screen.queryByTestId('freezer-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('freezer-add')).not.toBeInTheDocument();
    // A freezer can still be set up again, or the household is stuck.
    await openSheet('freezer-manage');
  });

  it('shows stock under Not placed when the setup document is absent', async () => {
    mockState.set({ status: 'loaded', config: null });
    stocked([item(4)]);
    render(FreezerPage);

    expect(await screen.findByTestId('freezer-not-placed')).toBeInTheDocument();
    expect(screen.queryByTestId('freezer-add')).not.toBeInTheDocument();
  });

  it('waits for the stock before deciding there is nothing set up', () => {
    mockState.set({ status: 'loaded', config: null });
    mockItems.set({ status: 'loading' });
    render(FreezerPage);
    expect(screen.queryByTestId('freezer-empty')).not.toBeInTheDocument();
  });

  it('switches to oldest first across every freezer, saying where each is', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([
      item(1, { addedAt: '2026-09-01T00:00:00.000Z' }),
      item(2, { freezerId: KITCHEN.id, shelf: null, addedAt: '2026-06-01T00:00:00.000Z' }),
      item(3, { freezerId: 'fz-removed', addedAt: '2026-07-01T00:00:00.000Z' }),
      item(4, { shelf: null, addedAt: '2026-10-01T00:00:00.000Z' }),
    ]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-view-oldest'));

    const rows = within(screen.getByTestId('freezer-oldest')).getAllByTestId('freezer-item');
    expect(rows.map((r) => r.dataset['number'])).toEqual(['2', '3', '1', '4']);
    expect(
      rows.map((r) => within(r).getByTestId('freezer-item-meta').textContent?.split(' · ').pop()),
    ).toEqual(['Kitchen', 'Not placed', 'Garage, shelf A', 'Garage, no shelf yet']);
    expect(screen.queryByTestId('freezer-list')).not.toBeInTheDocument();

    await fireEvent.click(screen.getByTestId('freezer-view-shelf'));
    expect(screen.getByTestId('freezer-list')).toBeInTheDocument();
    expect(screen.queryByTestId('freezer-oldest')).not.toBeInTheDocument();
  });

  it('is loading until the stock has arrived too', () => {
    mockState.set(loaded([GARAGE]));
    mockItems.set({ status: 'loading' });
    render(FreezerPage);
    expect(screen.queryByTestId('freezer-card')).not.toBeInTheDocument();
  });

  it('says so when the stock could not be loaded', async () => {
    mockState.set(loaded([GARAGE]));
    mockItems.set({ status: 'failed' });
    render(FreezerPage);
    expect(await screen.findByTestId('freezer-error')).toBeInTheDocument();
  });
});

describe('freezer stock — the item sheet (issue #1684)', () => {
  it('adds with the next number up pre-filled — a gap is not reused — at the first freezer and shelf', async () => {
    // No mark stored yet (a household from before it existed): the items set it.
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([item(1), item(2), item(4)]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    expect((within(sheet).getByTestId('freezer-item-number') as HTMLInputElement).value).toBe(
      '0005',
    );
    await fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value: 'Pork loin' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-packs'), {
      target: { value: '5' },
    });
    expect(within(sheet).getByRole('button', { name: 'g' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fireEvent.input(within(sheet).getByTestId('freezer-item-weight'), {
      target: { value: '500' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-supplier'), {
      target: { value: 'Swaledale' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-notes'), {
      target: { value: 'For Sunday' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith({
        number: 5,
        name: 'Pork loin',
        freezerId: GARAGE.id,
        shelf: 'A',
        amount: 5,
        packWeight: { amount: 500, unit: 'g' },
        purchasedFrom: 'Swaledale',
        notes: 'For Sunday',
        canonId: null,
        recipeId: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('counts on past a removed top bag: the mark, not the items, sets the number', async () => {
    mockState.set(loaded([GARAGE], [], 6));
    stocked([item(1), item(2), item(3), item(4), item(5)]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    expect((within(sheet).getByTestId('freezer-item-number') as HTMLInputElement).value).toBe(
      '0007',
    );
  });

  it('takes a typed-over number and another place', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.input(within(sheet).getByTestId('freezer-item-number'), {
      target: { value: '47' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value: 'Stock' },
    });
    await fireEvent.click(within(sheet).getByRole('button', { name: 'Kitchen' }));
    expect(within(sheet).queryByTestId('freezer-item-shelves')).not.toBeInTheDocument();
    await fireEvent.click(within(sheet).getByRole('button', { name: 'Garage' }));
    await fireEvent.click(within(sheet).getByRole('button', { name: 'C' }));
    await fireEvent.input(within(sheet).getByTestId('freezer-item-weight'), {
      target: { value: '1.5' },
    });
    await fireEvent.click(within(sheet).getByRole('button', { name: 'ml' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          number: 47,
          freezerId: GARAGE.id,
          shelf: 'C',
          amount: 1,
          packWeight: { amount: 1.5, unit: 'ml' },
        }),
      ),
    );
  });

  it('adds with no shelf yet when Not yet is picked', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value: 'Lamb mince' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-shelf-none'));
    await fireEvent.input(within(sheet).getByTestId('freezer-item-weight'), {
      target: { value: '500' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({ freezerId: GARAGE.id, shelf: null }),
      ),
    );
  });

  it('opens with the description focused, not the number — adding and editing', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(12)]);
    render(FreezerPage);

    let sheet = await openSheet('freezer-add');
    await waitFor(() => expect(within(sheet).getByTestId('freezer-item-name')).toHaveFocus());
    expect(within(sheet).getByText('Description')).toBeInTheDocument();
    await fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    sheet = await screen.findByRole('dialog');
    await waitFor(() => expect(within(sheet).getByTestId('freezer-item-name')).toHaveFocus());
  });

  it('takes a pack size as a count', async () => {
    mockState.set(loaded([GARAGE]));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value: 'Sausages' },
    });
    await fireEvent.click(within(sheet).getByRole('button', { name: 'count' }));
    await fireEvent.input(within(sheet).getByTestId('freezer-item-weight'), {
      target: { value: '6' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({ packWeight: { amount: 6, unit: 'count' } }),
      ),
    );
  });

  it('says what a count must be when one is refused', async () => {
    mockState.set(loaded([GARAGE]));
    mockAddItem.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_PACK_WEIGHT }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'count' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      'Say how many are in one pack — a whole number.',
    );
  });

  it('opens an item with its notes, and sends them changed', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(12, { notes: 'Spicy', packWeight: { amount: 500, unit: 'g' } })]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    const field = within(sheet).getByTestId('freezer-item-notes') as HTMLTextAreaElement;
    expect(field.value).toBe('Spicy');
    await fireEvent.input(field, { target: { value: 'Mild' } });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(12, expect.objectContaining({ notes: 'Mild' })),
    );
  });

  it('opens an item with no shelf yet at its freezer, with Not yet picked', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(12, { shelf: null, packWeight: { amount: 500, unit: 'g' } })]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByTestId('freezer-item-shelf-none')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fireEvent.click(within(sheet).getByRole('button', { name: 'B' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ place: { freezerId: GARAGE.id, shelf: 'B' } }),
      ),
    );
  });

  it('sends a blank number as not-a-number, for the domain to refuse', async () => {
    mockState.set(loaded([GARAGE]));
    mockAddItem.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_NUMBER }),
    );
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.input(within(sheet).getByTestId('freezer-item-number'), {
      target: { value: '' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(expect.objectContaining({ number: Number.NaN })),
    );
    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      'The number must be a whole number, 1 or more.',
    );
  });

  it.each([
    [ErrorCode.FREEZER_NUMBER_IN_USE, 'Something in the freezer already has that number.'],
    [ErrorCode.INVALID_FREEZER_ITEM_NAME, 'Give it a description.'],
    [ErrorCode.INVALID_FREEZER_AMOUNT, 'Say how many packs — a whole number, 1 or more.'],
    [ErrorCode.UNKNOWN_FREEZER_PLACE, 'Pick a freezer.'],
    [ErrorCode.INVALID_FREEZER_PACK_WEIGHT, 'Say how much one pack weighs.'],
  ])('shows the refusal for %s and stays open', async (code, message) => {
    mockState.set(loaded([GARAGE]));
    mockAddItem.mockResolvedValue(failure({ kind: 'ValidationError', code }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(message);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('edits with the number fixed, and moves it when another shelf is picked', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([
      item(47, {
        name: 'Pork loin',
        shelf: 'B',
        purchasedFrom: 'Swaledale',
        packWeight: { amount: 750, unit: 'ml' },
      }),
    ]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    const number = within(sheet).getByTestId('freezer-item-number') as HTMLInputElement;
    expect(number.value).toBe('0047');
    expect(number.readOnly).toBe(true);
    expect((within(sheet).getByTestId('freezer-item-name') as HTMLInputElement).value).toBe(
      'Pork loin',
    );
    expect((within(sheet).getByTestId('freezer-item-packs') as HTMLInputElement).value).toBe('1');
    expect((within(sheet).getByTestId('freezer-item-weight') as HTMLInputElement).value).toBe(
      '750',
    );
    expect(within(sheet).getByRole('button', { name: 'ml' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await fireEvent.click(within(sheet).getByRole('button', { name: 'D' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(47, {
        name: 'Pork loin',
        purchasedFrom: 'Swaledale',
        packWeight: { amount: 750, unit: 'ml' },
        notes: '',
        place: { freezerId: GARAGE.id, shelf: 'D' },
        canonId: null,
        recipeId: null,
      }),
    );
  });

  it('edits a Not placed item without filing it unless a place is picked', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(8, { freezerId: 'fz-removed' })]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Garage' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(8, {
        name: 'Item 8',
        purchasedFrom: '',
        packWeight: { amount: Number.NaN, unit: 'g' },
        notes: '',
        place: null,
        canonId: null,
        recipeId: null,
      }),
    );
  });

  it('also leaves a Not placed item unfiled when only its shelf is gone', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(9, { freezerId: GARAGE.id, shelf: 'Z' })]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Garage' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(9, {
        name: 'Item 9',
        purchasedFrom: '',
        packWeight: { amount: Number.NaN, unit: 'g' },
        notes: '',
        place: null,
        canonId: null,
        recipeId: null,
      }),
    );
  });

  it('removes an item, and says so when another phone already has', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(47)]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    let sheet = await screen.findByRole('dialog');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-remove'));
    await waitFor(() => expect(mockRemoveItem).toHaveBeenCalledWith(47));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    mockRemoveItem.mockResolvedValue(
      failure({ kind: 'NotFound', resource: 'freezerItem', id: '47' }),
    );
    await fireEvent.click(screen.getByTestId('freezer-item'));
    sheet = await screen.findByRole('dialog');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-remove'));
    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      'This has just been taken out on another phone.',
    );
  });

  it('says a save failed for any other reason', async () => {
    mockState.set(loaded([GARAGE]));
    mockAddItem.mockResolvedValue(failure({ kind: 'NetworkError', reason: 'transient' }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      "Couldn't save that. Try again.",
    );
  });
});

describe('FreezerItemSheet on its own', () => {
  it('with no freezer to pick, sends no place for the domain to refuse', async () => {
    render(FreezerItemSheet, { open: true, item: null, freezers: [], suggestedNumber: 1 });
    mockAddItem.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.UNKNOWN_FREEZER_PLACE }),
    );
    const sheet = await screen.findByRole('dialog');

    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({ freezerId: '', shelf: null }),
      ),
    );
    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      'Pick a freezer.',
    );
  });

  it('re-picking the chosen freezer keeps the chosen shelf', async () => {
    render(FreezerItemSheet, { open: true, item: null, freezers: [GARAGE], suggestedNumber: 1 });
    const sheet = await screen.findByRole('dialog');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'C' }));
    await fireEvent.click(within(sheet).getByRole('button', { name: 'Garage' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(expect.objectContaining({ shelf: 'C' })),
    );
  });
});

describe('ManageFreezersSheet — stock counts (issue #1684)', () => {
  it('says a change could not be saved when it failed for any other reason', async () => {
    mockState.set(loaded([GARAGE]));
    mockRemove.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Garage' }));

    expect(await within(sheet).findByTestId('manage-freezer-error')).toHaveTextContent(
      "Couldn't save that. Try again.",
    );
  });

  it('shows how many items are on each freezer and shelf, and removes without asking', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(1, { shelf: 'B' }), item(2, { shelf: 'B' }), item(3, { shelf: 'D' })]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    expect(within(sheet).getByTestId('manage-freezer-count')).toHaveTextContent(
      '3 items in this freezer',
    );
    expect(
      within(sheet)
        .getAllByTestId('manage-shelf-count')
        .map((c) => c.textContent?.trim()),
    ).toEqual(['· 2 items', '· 1 item']);

    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove shelf B' }));
    await waitFor(() => expect(mockSetShelves).toHaveBeenCalledWith('fz-garage', ['A', 'C', 'D']));
    await fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Garage' }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('fz-garage'));
  });
});

// ─── Taking packs out, and the links (issue #1684 Phase 2) ───────────────────

function canon(id: string, name: string, synonyms: string[] = []): CanonItem {
  return {
    id,
    name,
    synonyms,
    schemaVersion: 5,
    aisleId: 'a-meat',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
  };
}

function recipe(id: string, title: string, imageUrl: string | null = null): Recipe {
  return {
    ...emptyRecipe(id, '2026-10-12T09:00:00.000Z'),
    title,
    image: imageUrl === null ? null : { url: imageUrl, source: 'ai' },
  };
}

function taken(of: FreezerItem, amount: number, delta: number) {
  return success({ delta, item: { ...of, amount }, last: amount <= 0 });
}

describe('freezer stock — taking one out', () => {
  it('−1 takes one pack of that item, and asks nothing while some are left', async () => {
    const pork = item(47, { name: 'Pork loin', amount: 5 });
    mockState.set(loaded([GARAGE]));
    stocked([pork]);
    mockTake.mockResolvedValue(taken(pork, 4, -1));
    render(FreezerPage);

    await fireEvent.click(
      await screen.findByRole('button', { name: 'Take one pack of Pork loin' }),
    );

    await waitFor(() => expect(mockTake).toHaveBeenCalledWith(47));
    expect(screen.queryByTestId('freezer-last-one')).not.toBeInTheDocument();
    expect(screen.queryByTestId('freezer-take-error')).not.toBeInTheDocument();
  });

  it('taking the last one asks whether to remove it, and Remove removes it', async () => {
    const pork = item(47, { name: 'Pork loin', amount: 1 });
    mockState.set(loaded([GARAGE]));
    stocked([pork]);
    mockTake.mockResolvedValue(taken(pork, 0, -1));
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item-take'));

    const ask = await screen.findByTestId('freezer-last-one');
    expect(ask).toHaveTextContent('That was the last one');
    expect(ask).toHaveTextContent('Take #0047 Pork loin off the list?');
    // The number does not come back to the count (issue #1693), so nothing says it is free.
    expect(ask).not.toHaveTextContent(/free/i);
    await fireEvent.click(within(ask).getByTestId('freezer-last-one-remove'));

    await waitFor(() => expect(mockRemoveItem).toHaveBeenCalledWith(47));
    await waitFor(() => expect(screen.queryByTestId('freezer-last-one')).not.toBeInTheDocument());
  });

  it('Keep it closes the question and removes nothing', async () => {
    const pork = item(47, { name: 'Pork loin', amount: 0 });
    mockState.set(loaded([GARAGE]));
    stocked([pork]);
    mockTake.mockResolvedValue(taken(pork, 0, 0));
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item-take'));
    await fireEvent.click(await screen.findByTestId('freezer-last-one-keep'));

    await waitFor(() => expect(screen.queryByTestId('freezer-last-one')).not.toBeInTheDocument());
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('Escape closes the question too, removing nothing', async () => {
    const pork = item(47, { name: 'Pork loin', amount: 1 });
    mockState.set(loaded([GARAGE]));
    stocked([pork]);
    mockTake.mockResolvedValue(taken(pork, 0, -1));
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item-take'));
    const ask = await screen.findByTestId('freezer-last-one');
    await fireEvent.keyDown(ask, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByTestId('freezer-last-one')).not.toBeInTheDocument());
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('says so when another phone took it out, or the take failed, and clears it on the next', async () => {
    const pork = item(47, { name: 'Pork loin', amount: 5 });
    mockState.set(loaded([GARAGE]));
    stocked([pork]);
    mockTake.mockResolvedValueOnce(
      failure({ kind: 'NotFound', resource: 'freezerItem', id: '47' }),
    );
    render(FreezerPage);
    const take = await screen.findByTestId('freezer-item-take');

    await fireEvent.click(take);
    expect(await screen.findByTestId('freezer-take-error')).toHaveTextContent(
      'That has just been taken out on another phone.',
    );

    mockTake.mockResolvedValueOnce(failure({ kind: 'NetworkError', reason: 'transient' }));
    await fireEvent.click(take);
    await waitFor(() =>
      expect(screen.getByTestId('freezer-take-error')).toHaveTextContent(
        "Couldn't take that out yet. Try again.",
      ),
    );

    mockTake.mockResolvedValueOnce(taken(pork, 4, -1));
    await fireEvent.click(take);
    await waitFor(() => expect(screen.queryByTestId('freezer-take-error')).not.toBeInTheDocument());
  });

  // Issue #1712: the count with the weight of one pack, in kilos or litres from
  // 1000 up; a bag from before weights, or one with none left, reads as before.
  it('shows the weight per pack beside the count', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([
      item(12, { name: 'Beef mince', amount: 4, packWeight: { amount: 500, unit: 'g' } }),
      item(13, { name: 'Lamb', amount: 1, packWeight: { amount: 1500, unit: 'g' } }),
      item(31, { name: 'Chicken stock', amount: 2, packWeight: { amount: 1000, unit: 'ml' } }),
      item(32, { name: 'Soup', amount: 3, packWeight: { amount: 750, unit: 'ml' } }),
      item(33, { name: 'Sausages', amount: 2, packWeight: { amount: 6, unit: 'count' } }),
      item(34, { name: 'Bun', amount: 5, packWeight: { amount: 1, unit: 'count' } }),
      item(40, { name: 'Old bag', amount: 4, packWeight: null }),
      item(41, { name: 'Gone', amount: 0, packWeight: { amount: 500, unit: 'g' } }),
    ]);
    render(FreezerPage);

    const rows = await screen.findAllByTestId('freezer-item');
    expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual([
      '#0012 Beef mince — 4 × 500 g',
      '#0013 Lamb — 1 × 1.5 kg',
      '#0031 Chicken stock — 2 × 1 l',
      '#0032 Soup — 3 × 750 ml',
      '#0033 Sausages — 2 × 6 pieces',
      '#0034 Bun — 5 × 1 piece',
      '#0040 Old bag — 4 packs',
      '#0041 Gone — none left',
    ]);
  });

  it('shows the notes under an item, and nothing for one with none', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(12, { notes: 'Mild — for the children' }), item(13)]);
    render(FreezerPage);

    const rows = await screen.findAllByTestId('freezer-item');
    expect(within(rows[0] as HTMLElement).getByTestId('freezer-item-notes')).toHaveTextContent(
      'Mild — for the children',
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('freezer-item-notes')).toBeNull();
  });

  it('shows a count of zero, or below it, as none left', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(1, { amount: 0 }), item(2, { amount: -1 }), item(3, { amount: 2 })]);
    render(FreezerPage);

    const rows = await screen.findAllByTestId('freezer-item');
    expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual([
      '#0001 Item 1 — none left',
      '#0002 Item 2 — none left',
      '#0003 Item 3 — 2 packs',
    ]);
  });
});

describe('freezer stock — the recipe link on a row', () => {
  it('links to the recipe, with its hero picture', async () => {
    mockState.set(loaded([GARAGE]));
    mockRecipes.set([recipe('r-stew', 'Beef stew', 'https://img.example/stew.jpg')]);
    stocked([item(1, { recipeId: 'r-stew' })]);
    render(FreezerPage);

    const link = await screen.findByTestId('freezer-item-recipe-link');
    expect(link).toHaveAttribute('href', '#/recipes/r-stew');
    expect(link).toHaveAccessibleName('Open Beef stew');
    expect(link.querySelector('img')?.getAttribute('src')).toContain(
      'https://img.example/stew.jpg',
    );
  });

  it('links with a placeholder when the recipe has no picture yet', async () => {
    mockState.set(loaded([GARAGE]));
    mockRecipes.set([recipe('r-stew', 'Beef stew')]);
    stocked([item(1, { recipeId: 'r-stew' })]);
    render(FreezerPage);

    const link = await screen.findByTestId('freezer-item-recipe-link');
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('span')).not.toBeNull();
  });

  it('shows no link for an unlinked item, or one whose recipe is not here', async () => {
    mockState.set(loaded([GARAGE]));
    stocked([item(1), item(2, { recipeId: 'r-deleted' })]);
    render(FreezerPage);

    expect(await screen.findAllByTestId('freezer-item')).toHaveLength(2);
    expect(screen.queryByTestId('freezer-item-recipe-link')).not.toBeInTheDocument();
  });
});

describe('freezer stock — recounting on edit', () => {
  async function openEdit(of: FreezerItem): Promise<HTMLElement> {
    mockState.set(loaded([GARAGE]));
    stocked([of]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    return screen.findByRole('dialog');
  }

  it('shows the count, and sends it only when it was changed', async () => {
    const sheet = await openEdit(item(47, { amount: 2 }));
    const packs = within(sheet).getByTestId('freezer-item-packs') as HTMLInputElement;
    expect(packs.value).toBe('2');

    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() => expect(mockUpdateItem).toHaveBeenCalledOnce());
    expect(mockUpdateItem.mock.calls[0]?.[1]).not.toHaveProperty('amount');
  });

  it('sends a changed count', async () => {
    const sheet = await openEdit(item(47, { amount: 2 }));

    await fireEvent.input(within(sheet).getByTestId('freezer-item-packs'), {
      target: { value: '3' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(47, expect.objectContaining({ amount: 3 })),
    );
  });

  it('opens an item in a freezer with no shelves at that freezer', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([item(9, { freezerId: KITCHEN.id, shelf: null })]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');

    expect(within(sheet).getByRole('button', { name: 'Kitchen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ place: { freezerId: KITCHEN.id, shelf: null } }),
      ),
    );
  });

  it('shows a count below zero as 0, and refuses a bad count in edit words', async () => {
    mockUpdateItem.mockResolvedValue(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT }),
    );
    const sheet = await openEdit(item(47, { amount: -1 }));
    expect((within(sheet).getByTestId('freezer-item-packs') as HTMLInputElement).value).toBe('0');

    await fireEvent.input(within(sheet).getByTestId('freezer-item-packs'), {
      target: { value: '' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(
        47,
        expect.objectContaining({ amount: Number.NaN }),
      ),
    );
    expect(await within(sheet).findByTestId('freezer-item-error')).toHaveTextContent(
      'Say how many packs — a whole number, 0 or more.',
    );
  });
});

describe('freezer stock — linking an ingredient and a recipe', () => {
  function typeName(sheet: HTMLElement, value: string): Promise<boolean> {
    return fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value },
    });
  }

  function optionsShown(sheet: HTMLElement): (string | undefined)[] {
    return within(sheet)
      .queryAllByRole('option')
      .map((o) => o.textContent?.trim());
  }

  it('offers the ingredients the description matches — by name or by synonym — and links the one picked', async () => {
    mockState.set(loaded([GARAGE]));
    mockCanon.set([canon('c-pork', 'pork loin'), canon('c-lamb', 'lamb shoulder', ['hogget'])]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    expect(within(sheet).queryAllByRole('option')).toHaveLength(0);
    await typeName(sheet, 'hogget');
    await waitFor(() => expect(optionsShown(sheet)).toEqual(['Lamb Shoulder', 'Create "hogget"']));

    await typeName(sheet, 'Pork');
    await fireEvent.click(await within(sheet).findByRole('option', { name: 'Pork Loin' }));

    const field = within(sheet).getByTestId('freezer-item-name') as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('Pork Loin'));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Pork Loin', canonId: 'c-pork' }),
      ),
    );
  });

  it('takes words typed freely as the description, linking an ingredient only when they are its name', async () => {
    mockState.set(loaded([GARAGE]));
    mockCanon.set([canon('c-pork', 'pork loin')]);
    // Refused, so the sheet stays open for the second save.
    mockAddItem.mockResolvedValue(failure({ kind: 'NetworkError', reason: 'transient' }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await typeName(sheet, 'Pork loin steaks');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Pork loin steaks', canonId: null }),
      ),
    );

    await typeName(sheet, ' pork LOIN ');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: ' pork LOIN ', canonId: 'c-pork' }),
      ),
    );
  });

  it('opens an item with its own description, and keeps its link until the description is changed', async () => {
    mockState.set(loaded([GARAGE]));
    mockCanon.set([canon('c-pork', 'pork loin')]);
    stocked([item(47, { name: 'Pork chops', canonId: 'c-pork' })]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');

    const field = within(sheet).getByTestId('freezer-item-name') as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('Pork chops'));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenLastCalledWith(
        47,
        expect.objectContaining({ name: 'Pork chops', canonId: 'c-pork' }),
      ),
    );
  });

  it('a changed description drops a link it no longer names', async () => {
    mockState.set(loaded([GARAGE]));
    mockCanon.set([canon('c-pork', 'pork loin')]);
    stocked([item(47, { name: 'Pork loin', canonId: 'c-pork' })]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');

    await waitFor(() =>
      expect((within(sheet).getByTestId('freezer-item-name') as HTMLInputElement).value).toBe(
        'Pork Loin',
      ),
    );
    await typeName(sheet, 'Bolognese');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(
        47,
        expect.objectContaining({ name: 'Bolognese', canonId: null }),
      ),
    );
  });

  it('keeps a link to an ingredient not on this device', async () => {
    mockState.set(loaded([GARAGE]));
    mockCanon.set([canon('c-pork', 'pork loin')]);
    stocked([item(47, { name: 'Pork loin', canonId: 'c-gone', recipeId: 'r-gone' })]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');

    await waitFor(() =>
      expect((within(sheet).getByTestId('freezer-item-name') as HTMLInputElement).value).toBe(
        'Pork loin',
      ),
    );
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(
        47,
        expect.objectContaining({ canonId: 'c-gone', recipeId: 'r-gone' }),
      ),
    );
  });

  it('links the recipe picked from the dropdown, and Unlink takes it off', async () => {
    mockState.set(loaded([GARAGE]));
    mockRecipes.set([recipe('r-stew', 'Beef stew'), recipe('r-hock', 'Ham hock')]);
    // Refused, so the sheet stays open for the second save.
    mockAddItem.mockResolvedValue(failure({ kind: 'NetworkError', reason: 'transient' }));
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    const picker = within(sheet).getByTestId('freezer-item-recipe-picker');
    await fireEvent.input(picker, { target: { value: 'hock' } });
    await waitFor(() => expect(optionsShown(sheet)).toEqual(['Ham hock']));
    await fireEvent.click(within(sheet).getByRole('option', { name: 'Ham hock' }));

    expect(await within(sheet).findByTestId('freezer-item-recipe')).toHaveTextContent('Ham hock');
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenLastCalledWith(expect.objectContaining({ recipeId: 'r-hock' })),
    );

    const linked = within(sheet).getByTestId('freezer-item-recipe');
    await fireEvent.click(within(linked).getByRole('button', { name: 'Unlink' }));
    expect(within(sheet).getByTestId('freezer-item-recipe-picker')).toBeInTheDocument();
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenLastCalledWith(expect.objectContaining({ recipeId: null })),
    );
  });
});

describe('freezer stock — the places bought from', () => {
  it('offers the remembered places, narrows them as one is typed, and a pick fills the field', async () => {
    render(FreezerItemSheet, {
      open: true,
      item: null,
      freezers: [GARAGE],
      suggestedNumber: 1,
      suppliers: ['Swaledale', 'Booths', 'Swaledale Butchers'],
    });
    const sheet = await screen.findByRole('dialog');
    const field = within(sheet).getByTestId('freezer-item-supplier') as HTMLInputElement;
    const shown = () =>
      within(sheet)
        .queryAllByRole('option')
        .map((o) => o.textContent?.trim());

    // Tapped with nothing typed: every place, in order.
    await fireEvent.click(field);
    await waitFor(() => expect(shown()).toEqual(['Booths', 'Swaledale', 'Swaledale Butchers']));

    await fireEvent.input(field, { target: { value: 'swale' } });
    await waitFor(() =>
      expect(shown()).toEqual(['Swaledale', 'Swaledale Butchers', 'Create "swale"']),
    );

    await fireEvent.click(within(sheet).getByRole('option', { name: 'Swaledale' }));
    await waitFor(() => expect(field.value).toBe('Swaledale'));

    await fireEvent.input(field, { target: { value: 'Tesco' } });
    await waitFor(() => expect(shown()).toEqual(['Create "Tesco"']));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));
    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(expect.objectContaining({ purchasedFrom: 'Tesco' })),
    );
  });

  it('opens an item at a place no longer remembered with that place filled in', async () => {
    mockState.set(loaded([GARAGE], ['Booths']));
    stocked([item(47, { purchasedFrom: 'Swaledale' })]);
    render(FreezerPage);
    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');

    await waitFor(() =>
      expect((within(sheet).getByTestId('freezer-item-supplier') as HTMLInputElement).value).toBe(
        'Swaledale',
      ),
    );
  });

  it('still offers a place after its only item has been removed', async () => {
    mockState.set(loaded([GARAGE], ['Swaledale']));
    stocked([]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    await fireEvent.click(within(sheet).getByTestId('freezer-item-supplier'));
    expect(await within(sheet).findByRole('option', { name: 'Swaledale' })).toBeInTheDocument();
  });

  it('lists the places in Manage freezers, and forgets one', async () => {
    mockState.set(loaded([GARAGE], ['Swaledale', 'Swaledle']));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    const places = within(sheet).getByTestId('manage-suppliers');
    expect(
      within(places)
        .getAllByTestId('manage-supplier')
        .map((p) => p.textContent?.trim()),
    ).toEqual(['Swaledale', 'Swaledle']);
    await fireEvent.click(within(places).getByRole('button', { name: 'Forget Swaledle' }));

    await waitFor(() => expect(mockForget).toHaveBeenCalledWith('Swaledle'));
  });

  it('Done closes the Manage freezers sheet', async () => {
    mockState.set(loaded([GARAGE], ['Swaledale']));
    render(FreezerPage);
    const sheet = await openSheet('freezer-manage');

    await fireEvent.click(within(sheet).getByTestId('manage-freezers-done'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows no places section when none are remembered', async () => {
    render(ManageFreezersSheet, { open: true, stock: [] });
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('manage-suppliers')).not.toBeInTheDocument();
  });
});
