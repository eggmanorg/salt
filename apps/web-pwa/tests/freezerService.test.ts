import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCode, failure, success } from '@salt/shared-types';
import type { FreezerConfig, FreezerItem } from '@salt/domain';

// The freezer service (issue #1682) — the store over `freezerConfig/current` and
// the one write path for it.
//
// What is worth pinning is WHEN it will write. The document is the whole
// household's setup, written whole; a write issued before the first snapshot, or
// after the listener has died, would replace a real setup with whatever this
// device happens to hold.

const {
  mockSubscribe,
  mockSave,
  mockReport,
  mockSubscribeItems,
  mockSaveItem,
  mockDeleteItem,
  mockStopConfig,
  mockStopItems,
} = vi.hoisted(() => ({
  mockSubscribe: vi.fn(),
  mockSave: vi.fn(),
  mockReport: vi.fn(),
  mockSubscribeItems: vi.fn(),
  mockSaveItem: vi.fn(),
  mockDeleteItem: vi.fn(),
  mockStopConfig: vi.fn(),
  mockStopItems: vi.fn(),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeFreezerConfig: mockSubscribe,
  saveFreezerConfig: mockSave,
  subscribeFreezerItems: mockSubscribeItems,
  saveFreezerItem: mockSaveItem,
  deleteFreezerItem: mockDeleteItem,
  isAuthTransitioning: () => false,
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: mockReport }),
}));

import { get } from 'svelte/store';
import {
  addFreezer,
  addFreezerItem,
  freezerConfigState,
  freezerItemsState,
  initFreezerSync,
  removeFreezer,
  removeFreezerItem,
  renameFreezer,
  setFreezerShelves,
  updateFreezerItem,
} from '../src/lib/freezerService.js';

type OnConfig = (config: FreezerConfig | null) => void;
type OnItems = (items: FreezerItem[]) => void;
type OnError = (err: unknown, raw?: unknown) => void;

let emit: OnConfig;
let fail: OnError;
let emitItems: OnItems;
let failItems: OnError;
let stop: () => void;

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] };

function config(freezers: FreezerConfig['freezers']): FreezerConfig {
  return { schemaVersion: 1, updatedAt: '2026-10-12T09:00:00.000Z', freezers };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue(success(undefined));
  mockSaveItem.mockResolvedValue(success(undefined));
  mockDeleteItem.mockResolvedValue(success(undefined));
  mockSubscribe.mockImplementation((onConfig: OnConfig, onError: OnError) => {
    emit = onConfig;
    fail = onError;
    return mockStopConfig;
  });
  mockSubscribeItems.mockImplementation((onItems: OnItems, onError: OnError) => {
    emitItems = onItems;
    failItems = onError;
    return mockStopItems;
  });
  stop = initFreezerSync();
});

describe('freezer service — the state it may write from', () => {
  it('is loading until the first snapshot, and writes nothing then', async () => {
    expect(get(freezerConfigState)).toEqual({ status: 'loading' });

    const result = await addFreezer('Garage');

    expect(result).toEqual(failure({ kind: 'NetworkError', reason: 'transient' }));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('starts from an empty config when the document is absent', async () => {
    emit(null);
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: null });

    const result = await addFreezer(' Garage ', ['A', 'B']);

    expect(result.kind).toBe('ok');
    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toHaveLength(1);
    expect(saved.freezers[0]).toMatchObject({ name: 'Garage', shelves: ['A', 'B'] });
    // Minted, opaque — not the name.
    expect(saved.freezers[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: saved });
  });

  it('refuses to write once the listener has failed, and reports the failure', async () => {
    emit(config([GARAGE]));
    fail({ kind: 'StorageError', reason: 'corruption' });

    expect(get(freezerConfigState)).toEqual({ status: 'failed' });
    expect(mockReport).toHaveBeenCalledOnce();

    const result = await removeFreezer(GARAGE.id);

    expect(result.kind).toBe('err');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('freezer service — writes', () => {
  beforeEach(() => emit(config([GARAGE])));

  it('saves nothing and leaves the store alone when the domain refuses', async () => {
    const result = await addFreezer('garage');

    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.DUPLICATE_FREEZER_NAME }),
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(get(freezerConfigState)).toEqual({ status: 'loaded', config: config([GARAGE]) });
  });

  it('renames in place, keeping the id', async () => {
    await renameFreezer(GARAGE.id, 'Shed');

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toEqual([{ ...GARAGE, name: 'Shed' }]);
  });

  it('replaces the shelf list', async () => {
    await setFreezerShelves(GARAGE.id, ['A', 'B', 'C']);

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers[0]?.shelves).toEqual(['A', 'B', 'C']);
  });

  it('removes a freezer', async () => {
    await removeFreezer(GARAGE.id);

    const saved = mockSave.mock.calls[0]?.[0] as FreezerConfig;
    expect(saved.freezers).toEqual([]);
  });

  it('returns the domain verdict without awaiting the save, and reports a refused save', async () => {
    mockSave.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));

    const result = await renameFreezer(GARAGE.id, 'Shed');

    expect(result.kind).toBe('ok');
    await vi.waitFor(() => expect(mockReport).toHaveBeenCalledOnce());
  });
});

// ─── Stock (issue #1684) ─────────────────────────────────────────────────────

const KITCHEN = { id: 'fz-kitchen', name: 'Kitchen', shelves: [] };

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

const ADD = {
  number: 3,
  name: 'Pork loin',
  freezerId: GARAGE.id,
  shelf: 'B',
  amount: 5,
  purchasedFrom: 'Swaledale',
};

function storedItems(): readonly FreezerItem[] {
  const state = get(freezerItemsState);
  return state.status === 'loaded' ? state.items : [];
}

describe('freezer service — the stock it may write from', () => {
  it('opens both listeners and closes both', () => {
    expect(mockSubscribe).toHaveBeenCalledOnce();
    expect(mockSubscribeItems).toHaveBeenCalledOnce();
    stop();
    expect(mockStopConfig).toHaveBeenCalledOnce();
    expect(mockStopItems).toHaveBeenCalledOnce();
  });

  it('writes no item until both the config and the stock have arrived', async () => {
    emit(config([GARAGE]));
    expect(get(freezerItemsState)).toEqual({ status: 'loading' });

    expect(await addFreezerItem(ADD)).toEqual(
      failure({ kind: 'NetworkError', reason: 'transient' }),
    );
    expect(await removeFreezerItem(1)).toEqual(
      failure({ kind: 'NetworkError', reason: 'transient' }),
    );
    expect(mockSaveItem).not.toHaveBeenCalled();
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it('refuses item writes once the stock listener has failed, and reports it', async () => {
    emit(config([GARAGE]));
    emitItems([item(1)]);
    failItems({ kind: 'StorageError', reason: 'corruption' });

    expect(get(freezerItemsState)).toEqual({ status: 'failed' });
    expect(mockReport).toHaveBeenCalledOnce();
    expect((await updateFreezerItem(1, { name: 'X', purchasedFrom: null, place: null })).kind).toBe(
      'err',
    );
    expect(mockSaveItem).not.toHaveBeenCalled();
  });
});

describe('freezer service — item writes', () => {
  beforeEach(() => {
    emit(config([GARAGE, KITCHEN]));
    emitItems([item(1), item(47, { shelf: 'B', name: 'Pork loin' })]);
  });

  it('adds: the item is in the store at once, and saved whole', async () => {
    const result = await addFreezerItem(ADD);

    expect(result.kind).toBe('ok');
    const saved = mockSaveItem.mock.calls[0]?.[0] as FreezerItem;
    expect(saved).toMatchObject({ ...ADD, canonId: null, recipeId: null });
    expect(saved.addedAt).toBe(saved.updatedAt);
    expect(storedItems().map((i) => i.number)).toEqual([1, 47, 3]);
  });

  it('refuses a number already held here, and writes nothing', async () => {
    const result = await addFreezerItem({ ...ADD, number: 47 });

    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.FREEZER_NUMBER_IN_USE }),
    );
    expect(mockSaveItem).not.toHaveBeenCalled();
    expect(storedItems()).toHaveLength(2);
  });

  it('starts from an empty setup when nobody has set one up, so any place is refused', async () => {
    emit(null);
    const result = await addFreezerItem(ADD);
    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.UNKNOWN_FREEZER_PLACE }),
    );
  });

  it('edits and moves in one write, keeping the number', async () => {
    const result = await updateFreezerItem(47, {
      name: 'Pork shoulder',
      purchasedFrom: 'Swaledale',
      place: { freezerId: KITCHEN.id, shelf: null },
    });

    expect(result.kind).toBe('ok');
    expect(mockSaveItem).toHaveBeenCalledOnce();
    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({
      number: 47,
      name: 'Pork shoulder',
      purchasedFrom: 'Swaledale',
      freezerId: KITCHEN.id,
      shelf: null,
    });
    expect(storedItems().find((i) => i.number === 47)?.freezerId).toBe(KITCHEN.id);
  });

  it('leaves the place alone when none is given — an item under Not placed stays there', async () => {
    emitItems([item(8, { freezerId: 'fz-removed' })]);

    const result = await updateFreezerItem(8, { name: 'Lamb', purchasedFrom: null, place: null });

    expect(result.kind).toBe('ok');
    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({
      name: 'Lamb',
      freezerId: 'fz-removed',
    });
  });

  it('does not re-check an unchanged place, and refuses a move to one that does not exist', async () => {
    emitItems([item(8, { freezerId: 'fz-removed', shelf: 'Q' })]);
    const same = await updateFreezerItem(8, {
      name: 'Lamb',
      purchasedFrom: null,
      place: { freezerId: 'fz-removed', shelf: 'Q' },
    });
    expect(same.kind).toBe('ok');

    const moved = await updateFreezerItem(8, {
      name: 'Lamb',
      purchasedFrom: null,
      place: { freezerId: GARAGE.id, shelf: 'Q' },
    });
    expect(moved).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.UNKNOWN_FREEZER_PLACE }),
    );
    expect(mockSaveItem).toHaveBeenCalledOnce();
  });

  it('refuses a blank name on edit', async () => {
    const result = await updateFreezerItem(47, { name: ' ', purchasedFrom: null, place: null });
    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_ITEM_NAME }),
    );
    expect(mockSaveItem).not.toHaveBeenCalled();
  });

  it('removes: gone from the store at once, deleted by number, the number free again', async () => {
    const result = await removeFreezerItem(47);

    expect(result.kind).toBe('ok');
    expect(mockDeleteItem).toHaveBeenCalledWith(47);
    expect(storedItems().map((i) => i.number)).toEqual([1]);
  });

  it('is NotFound removing an item this device no longer holds', async () => {
    const result = await removeFreezerItem(99);
    expect(result).toEqual(failure({ kind: 'NotFound', resource: 'freezerItem', id: '99' }));
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it('returns the verdict without awaiting the save, and reports a refused save or delete', async () => {
    mockSaveItem.mockReturnValue(new Promise(() => {}));
    expect((await addFreezerItem(ADD)).kind).toBe('ok');

    mockSaveItem.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));
    await addFreezerItem({ ...ADD, number: 4 });
    mockDeleteItem.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));
    await removeFreezerItem(1);

    await vi.waitFor(() => expect(mockReport).toHaveBeenCalledTimes(2));
  });
});
