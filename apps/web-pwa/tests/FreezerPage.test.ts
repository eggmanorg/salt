import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { ErrorCode, failure, success } from '@salt/shared-types';
import type { FreezerConfig, FreezerItem } from '@salt/domain';
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
  addFreezer: mockAdd,
  renameFreezer: mockRename,
  setFreezerShelves: mockSetShelves,
  removeFreezer: mockRemove,
}));
vi.mock('../src/lib/featureGate.js', () => ({
  freezerGate: mockGate,
  featureGate: () => mockGate,
  isFeatureEnabled: () => true,
}));

import { push } from 'svelte-spa-router';
import FreezerPage from '../src/routes/freezer/FreezerPage.svelte';
import FreezerItemSheet from '../src/routes/freezer/FreezerItemSheet.svelte';

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B', 'C', 'D'] };
const KITCHEN = { id: 'fz-kitchen', name: 'Kitchen', shelves: [] };

function loaded(freezers: FreezerConfig['freezers']): FreezerConfigState {
  return {
    status: 'loaded',
    config: { schemaVersion: 1, updatedAt: '2026-10-12T09:00:00.000Z', freezers },
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
  for (const fn of [mockAdd, mockRename, mockSetShelves, mockRemove]) fn.mockResolvedValue(OK);
  for (const fn of [mockAddItem, mockUpdateItem, mockRemoveItem]) {
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
      '#3 Prawns — 5 packs in since 5 Aug · 2 days',
      '#47 Pork loin — 1 pack in since 12 Jun · 8 weeks',
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
    ]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-view-oldest'));

    const rows = within(screen.getByTestId('freezer-oldest')).getAllByTestId('freezer-item');
    expect(rows.map((r) => r.dataset['number'])).toEqual(['2', '3', '1']);
    expect(
      rows.map((r) => within(r).getByTestId('freezer-item-meta').textContent?.split(' · ').pop()),
    ).toEqual(['Kitchen', 'Not placed', 'Garage, shelf A']);
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
  it('adds with the lowest free number pre-filled, at the first freezer and shelf', async () => {
    mockState.set(loaded([GARAGE, KITCHEN]));
    stocked([item(1), item(2), item(4)]);
    render(FreezerPage);
    const sheet = await openSheet('freezer-add');

    expect((within(sheet).getByTestId('freezer-item-number') as HTMLInputElement).value).toBe('3');
    await fireEvent.input(within(sheet).getByTestId('freezer-item-name'), {
      target: { value: 'Pork loin' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-packs'), {
      target: { value: '5' },
    });
    await fireEvent.input(within(sheet).getByTestId('freezer-item-supplier'), {
      target: { value: 'Swaledale' },
    });
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith({
        number: 3,
        name: 'Pork loin',
        freezerId: GARAGE.id,
        shelf: 'A',
        amount: 5,
        purchasedFrom: 'Swaledale',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({ number: 47, freezerId: GARAGE.id, shelf: 'C', amount: 1 }),
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
    [ErrorCode.INVALID_FREEZER_ITEM_NAME, 'Say what it is.'],
    [ErrorCode.INVALID_FREEZER_AMOUNT, 'Say how many packs — a whole number, 1 or more.'],
    [ErrorCode.UNKNOWN_FREEZER_PLACE, 'Pick a freezer and a shelf.'],
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
    stocked([item(47, { name: 'Pork loin', shelf: 'B', purchasedFrom: 'Swaledale' })]);
    render(FreezerPage);

    await fireEvent.click(await screen.findByTestId('freezer-item'));
    const sheet = await screen.findByRole('dialog');
    const number = within(sheet).getByTestId('freezer-item-number') as HTMLInputElement;
    expect(number.value).toBe('47');
    expect(number.readOnly).toBe(true);
    expect((within(sheet).getByTestId('freezer-item-name') as HTMLInputElement).value).toBe(
      'Pork loin',
    );
    expect(within(sheet).queryByTestId('freezer-item-packs')).not.toBeInTheDocument();

    await fireEvent.click(within(sheet).getByRole('button', { name: 'D' }));
    await fireEvent.click(within(sheet).getByTestId('freezer-item-save'));

    await waitFor(() =>
      expect(mockUpdateItem).toHaveBeenCalledWith(47, {
        name: 'Pork loin',
        purchasedFrom: 'Swaledale',
        place: { freezerId: GARAGE.id, shelf: 'D' },
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
        place: null,
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
        place: null,
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
      'Pick a freezer and a shelf.',
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
