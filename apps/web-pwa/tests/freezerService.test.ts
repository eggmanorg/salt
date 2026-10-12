import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCode, failure, success } from '@salt/shared-types';
import type { Defrost, FreezerConfig, FreezerItem } from '@salt/domain';

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
  mockTake,
  mockStopConfig,
  mockStopItems,
  mockSubscribeDefrosts,
  mockCommit,
  mockSaveDefrost,
  mockDeleteDefrost,
} = vi.hoisted(() => ({
  mockSubscribeDefrosts: vi.fn(),
  mockCommit: vi.fn(),
  mockSaveDefrost: vi.fn(),
  mockDeleteDefrost: vi.fn(),
  mockSubscribe: vi.fn(),
  mockSave: vi.fn(),
  mockReport: vi.fn(),
  mockSubscribeItems: vi.fn(),
  mockSaveItem: vi.fn(),
  mockDeleteItem: vi.fn(),
  mockTake: vi.fn(),
  mockStopConfig: vi.fn(),
  mockStopItems: vi.fn(),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeFreezerConfig: mockSubscribe,
  saveFreezerConfig: mockSave,
  subscribeFreezerItems: mockSubscribeItems,
  saveFreezerItem: mockSaveItem,
  deleteFreezerItem: mockDeleteItem,
  takeFreezerItemAmount: mockTake,
  subscribeDefrosts: mockSubscribeDefrosts,
  commitFromFreezer: mockCommit,
  saveDefrost: mockSaveDefrost,
  deleteDefrost: mockDeleteDefrost,
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
  forgetSupplier,
  freezerItemsState,
  initFreezerSync,
  removeFreezer,
  removeFreezerItem,
  renameFreezer,
  setFreezerShelves,
  takeOneFreezerPack,
  updateFreezerItem,
  defrostsState,
  freezerPlace,
  getDefrostsSnapshot,
  initDefrostSync,
  tickOffDefrost,
  undoTickOff,
  useFromFreezer,
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

function config(freezers: FreezerConfig['freezers'], suppliers: string[] = []): FreezerConfig {
  return { schemaVersion: 1, updatedAt: '2026-10-12T09:00:00.000Z', freezers, suppliers };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue(success(undefined));
  mockSaveItem.mockResolvedValue(success(undefined));
  mockDeleteItem.mockResolvedValue(success(undefined));
  mockTake.mockResolvedValue(success(undefined));
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

// ─── Taking packs out, and the links (issue #1684 Phase 2) ───────────────────

function storedConfig(): FreezerConfig | null {
  const state = get(freezerConfigState);
  return state.status === 'loaded' ? state.config : null;
}

describe('freezer service — taking a pack out', () => {
  beforeEach(() => {
    emit(config([GARAGE]));
    emitItems([item(1, { amount: 5 }), item(2, { amount: 1 }), item(3, { amount: 0 })]);
  });

  it('takes one from five: four shown at once, and a decrement of one sent', async () => {
    const result = await takeOneFreezerPack(1);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value).toMatchObject({ delta: -1, last: false });
    expect(result.value.item.amount).toBe(4);
    expect(storedItems().find((i) => i.number === 1)?.amount).toBe(4);
    expect(mockTake).toHaveBeenCalledWith(1, -1);
    expect(mockSaveItem).not.toHaveBeenCalled();
  });

  it('taking the only pack says it was the last, and still sends the decrement', async () => {
    const result = await takeOneFreezerPack(2);

    expect(result.kind === 'ok' && result.value.last).toBe(true);
    expect(storedItems().find((i) => i.number === 2)?.amount).toBe(0);
    expect(mockTake).toHaveBeenCalledWith(2, -1);
  });

  it('an item already showing none takes nothing, writes nothing, and says it was the last', async () => {
    const result = await takeOneFreezerPack(3);

    expect(result.kind === 'ok' && result.value).toMatchObject({ delta: 0, last: true });
    expect(mockTake).not.toHaveBeenCalled();
    expect(storedItems().find((i) => i.number === 3)?.amount).toBe(0);
  });

  it('is NotFound for an item this device no longer holds, and writes nothing', async () => {
    const result = await takeOneFreezerPack(99);

    expect(result).toEqual(failure({ kind: 'NotFound', resource: 'freezerItem', id: '99' }));
    expect(mockTake).not.toHaveBeenCalled();
  });

  it('hands a refused decrement to the reporter, by category, without awaiting it', async () => {
    // The category gate is inside the real port: a NotFound (another phone removed
    // the item) is dropped there, a StorageError is sent. Here the port is the
    // mock, so both arrive, each with its category.
    mockTake.mockResolvedValueOnce(failure({ kind: 'NotFound', resource: 'freezerItem', id: '1' }));
    const gone = await takeOneFreezerPack(1);
    expect(gone.kind).toBe('ok');
    expect(mockTake).toHaveBeenCalledWith(1, -1);
    expect(storedItems().find((i) => i.number === 1)?.amount).toBe(4);

    mockTake.mockResolvedValueOnce(failure({ kind: 'StorageError', reason: 'unavailable' }));
    await takeOneFreezerPack(1);

    await vi.waitFor(() => expect(mockReport).toHaveBeenCalledTimes(2));
    expect(mockReport.mock.calls.map((c) => c[1])).toEqual(['NotFound', 'StorageError']);
  });

  it('takes nothing before the stock has arrived', async () => {
    // A fresh subscription: both stores back to loading until the snapshots land.
    stop = initFreezerSync();
    emit(config([GARAGE]));
    expect(await takeOneFreezerPack(1)).toEqual(
      failure({ kind: 'NetworkError', reason: 'transient' }),
    );
    expect(mockTake).not.toHaveBeenCalled();
  });
});

describe('freezer service — recounting and linking on edit', () => {
  beforeEach(() => {
    emit(config([GARAGE]));
    emitItems([item(47, { amount: 2, canonId: 'c-pork', recipeId: 'r-stew' })]);
  });

  it('recounts when a count is given', async () => {
    const result = await updateFreezerItem(47, {
      name: 'Item 47',
      purchasedFrom: null,
      place: null,
      amount: 6,
    });

    expect(result.kind).toBe('ok');
    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ number: 47, amount: 6 });
  });

  it('leaves the count, and the links, alone when they are omitted', async () => {
    await updateFreezerItem(47, { name: 'Renamed', purchasedFrom: null, place: null });

    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({
      name: 'Renamed',
      amount: 2,
      canonId: 'c-pork',
      recipeId: 'r-stew',
    });
  });

  it('refuses a count that is not a whole number of 0 or more, and writes nothing', async () => {
    const result = await updateFreezerItem(47, {
      name: 'Item 47',
      purchasedFrom: null,
      place: null,
      amount: -1,
    });

    expect(result).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT }),
    );
    expect(mockSaveItem).not.toHaveBeenCalled();
  });

  it('saves the links given, and clears one given as null', async () => {
    await updateFreezerItem(47, {
      name: 'Item 47',
      purchasedFrom: null,
      place: null,
      canonId: 'c-lamb',
      recipeId: null,
    });

    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ canonId: 'c-lamb', recipeId: null });
  });

  it('saves the links an add is given', async () => {
    await addFreezerItem({ ...ADD, canonId: 'c-pork', recipeId: 'r-stew' });

    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({
      canonId: 'c-pork',
      recipeId: 'r-stew',
    });
  });
});

describe('freezer service — the places bought from', () => {
  beforeEach(() => {
    emit(config([GARAGE], ['Swaledale']));
    emitItems([item(1, { purchasedFrom: 'Swaledale' })]);
  });

  it('saves a known place in its remembered spelling, and writes no config', async () => {
    await addFreezerItem({ ...ADD, purchasedFrom: ' swaledale ' });

    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ purchasedFrom: 'Swaledale' });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('remembers a new place: the config is saved with it on the end', async () => {
    await addFreezerItem({ ...ADD, purchasedFrom: ' Booths ' });

    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ purchasedFrom: 'Booths' });
    expect(mockSave).toHaveBeenCalledOnce();
    expect((mockSave.mock.calls[0]?.[0] as FreezerConfig).suppliers).toEqual([
      'Swaledale',
      'Booths',
    ]);
    expect(storedConfig()?.suppliers).toEqual(['Swaledale', 'Booths']);
  });

  it('writes no config for a blank place, or none at all', async () => {
    await addFreezerItem({ ...ADD, purchasedFrom: '  ' });
    const { purchasedFrom: _omitted, ...withoutPlace } = ADD;
    await addFreezerItem({ ...withoutPlace, number: 4 });

    expect(mockSaveItem).toHaveBeenCalledTimes(2);
    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ purchasedFrom: null });
    expect(mockSaveItem.mock.calls[1]?.[0]).toMatchObject({ purchasedFrom: null });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('an edit is spelt and remembered the same way', async () => {
    await updateFreezerItem(1, { name: 'Item 1', purchasedFrom: 'SWALEDALE', place: null });
    expect(mockSaveItem.mock.calls[0]?.[0]).toMatchObject({ purchasedFrom: 'Swaledale' });
    expect(mockSave).not.toHaveBeenCalled();

    await updateFreezerItem(1, { name: 'Item 1', purchasedFrom: 'Booths', place: null });
    expect((mockSave.mock.calls[0]?.[0] as FreezerConfig).suppliers).toEqual([
      'Swaledale',
      'Booths',
    ]);
  });

  it('remembers a place on an edit made before anybody set up a freezer', async () => {
    emit(null);
    await updateFreezerItem(1, { name: 'Item 1', purchasedFrom: 'Booths', place: null });

    expect((mockSave.mock.calls[0]?.[0] as FreezerConfig).suppliers).toEqual(['Booths']);
  });

  it('reports a refused config save from remembering a place', async () => {
    mockSave.mockResolvedValue(failure({ kind: 'StorageError', reason: 'unavailable' }));
    await addFreezerItem({ ...ADD, purchasedFrom: 'Booths' });
    await vi.waitFor(() => expect(mockReport).toHaveBeenCalledOnce());
  });

  it('forgets a place: taken off the list and saved, no item changed', async () => {
    const result = await forgetSupplier('swaledale');

    expect(result.kind).toBe('ok');
    expect((mockSave.mock.calls[0]?.[0] as FreezerConfig).suppliers).toEqual([]);
    expect(mockSaveItem).not.toHaveBeenCalled();
    expect(storedItems()[0]?.purchasedFrom).toBe('Swaledale');
  });

  it('keeps a place on the list after its only item is removed', async () => {
    await removeFreezerItem(1);

    expect(storedItems()).toEqual([]);
    expect(mockSave).not.toHaveBeenCalled();
    expect(storedConfig()?.suppliers).toEqual(['Swaledale']);
  });
});

// ─── Using packs from the freezer (issue #1685) ─────────────────────────────

describe('freezer service — use from the freezer', () => {
  type OnDefrosts = (defrosts: Defrost[]) => void;
  let emitDefrosts: OnDefrosts;
  let failDefrosts: OnError;

  const CHILLI = { id: 'r-chilli', title: 'Chilli' };
  const ROW = { listId: 'list-1', itemId: 'i1' };

  beforeEach(() => {
    mockCommit.mockResolvedValue(success(undefined));
    mockSaveDefrost.mockResolvedValue(success(undefined));
    mockDeleteDefrost.mockResolvedValue(success(undefined));
    mockSubscribeDefrosts.mockImplementation((onDefrosts: OnDefrosts, onError: OnError) => {
      emitDefrosts = onDefrosts;
      failDefrosts = onError;
      return vi.fn();
    });
    initDefrostSync();
    emit(config([GARAGE]));
    emitItems([item(47, { name: 'Pork loin', shelf: 'B', amount: 3 }), item(12, { amount: 1 })]);
    emitDefrosts([]);
  });

  it('writes nothing until the Kitchen items have loaded', async () => {
    initDefrostSync();

    const result = await useFromFreezer({ number: 47, count: 1, recipe: CHILLI, shoppingRow: ROW });

    expect(result).toEqual(failure({ kind: 'NetworkError', reason: 'transient' }));
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('takes the packs, writes the Kitchen item and removes the row, in one commit', async () => {
    const result = await useFromFreezer({ number: 47, count: 2, recipe: CHILLI, shoppingRow: ROW });

    expect(result.kind === 'ok' && result.value.last).toBe(false);
    const defrost = {
      schemaVersion: 1,
      freezerNumber: 47,
      name: 'Pork loin',
      location: 'Garage · shelf B',
      recipeId: 'r-chilli',
      recipeTitle: 'Chilli',
      amount: 2,
      committedAt: expect.any(String),
    };
    expect(mockCommit).toHaveBeenCalledWith({
      itemNumber: 47,
      take: -2,
      removeItem: false,
      defrost,
      shoppingRow: ROW,
    });
    expect(storedItems().find((i) => i.number === 47)?.amount).toBe(1);
    expect(getDefrostsSnapshot()).toEqual([defrost]);
  });

  it('removes the entry with its last pack', async () => {
    const result = await useFromFreezer({ number: 12, count: 1, recipe: null, shoppingRow: ROW });

    expect(result.kind === 'ok' && result.value.last).toBe(true);
    expect(mockCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        removeItem: true,
        defrost: expect.objectContaining({ recipeId: null }),
      }),
    );
    expect(storedItems().some((i) => i.number === 12)).toBe(false);
  });

  it('sums onto a Kitchen item already at the same id', async () => {
    emitDefrosts([
      {
        schemaVersion: 1,
        freezerNumber: 47,
        name: 'Pork loin',
        location: 'Garage · shelf B',
        recipeId: 'r-chilli',
        recipeTitle: 'Chilli',
        amount: 1,
        committedAt: '2026-10-11T09:00:00.000Z',
      },
    ]);

    await useFromFreezer({ number: 47, count: 1, recipe: CHILLI, shoppingRow: ROW });

    expect(mockCommit.mock.calls[0]?.[0].defrost).toMatchObject({
      amount: 2,
      committedAt: '2026-10-11T09:00:00.000Z',
    });
  });

  it('is NotFound for a bag this device no longer holds, and writes nothing', async () => {
    const result = await useFromFreezer({ number: 99, count: 1, recipe: null, shoppingRow: ROW });

    expect(result).toEqual(failure({ kind: 'NotFound', resource: 'freezerItem', id: '99' }));
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('hands the page the server’s answer, and the refusal to the reporter by category', async () => {
    // The category gate is inside the real port, which drops a NotFound; here
    // the port is the mock, so it arrives with its category.
    const gone = failure({ kind: 'NotFound', resource: 'freezerItem', id: '47' });
    mockCommit.mockResolvedValue(gone);

    const result = await useFromFreezer({ number: 47, count: 1, recipe: CHILLI, shoppingRow: ROW });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(await result.value.written).toEqual(gone);
    expect(mockReport.mock.calls.map((c) => c[1])).toEqual(['NotFound']);
  });

  it('Got it out deletes the item at its id; Undo writes the same one back', async () => {
    const defrost: Defrost = {
      schemaVersion: 1,
      freezerNumber: 12,
      name: 'Beef mince',
      location: 'Garage · shelf A',
      recipeId: null,
      recipeTitle: null,
      amount: 1,
      committedAt: '2026-10-11T09:00:00.000Z',
    };
    emitDefrosts([defrost]);

    await tickOffDefrost(defrost);
    expect(mockDeleteDefrost).toHaveBeenCalledWith('012_manual');
    expect(getDefrostsSnapshot()).toEqual([]);

    await undoTickOff(defrost);
    expect(mockSaveDefrost).toHaveBeenCalledWith(defrost);
    expect(getDefrostsSnapshot()).toEqual([defrost]);
  });

  it('a dead listener leaves the Kitchen items unwritable', async () => {
    failDefrosts({ kind: 'StorageError' });

    expect(get(defrostsState)).toEqual({ status: 'failed' });
    expect(await useFromFreezer({ number: 47, count: 1, recipe: null, shoppingRow: ROW })).toEqual(
      failure({ kind: 'NetworkError', reason: 'transient' }),
    );
  });

  it('stores where the bag was: the freezer alone without shelves, or Not placed', async () => {
    emit(config([{ id: 'fz-chest', name: 'Chest', shelves: [] }]));
    emitItems([
      item(5, { freezerId: 'fz-chest', shelf: null, amount: 2 }),
      item(6, { freezerId: 'fz-gone', amount: 2 }),
    ]);

    await useFromFreezer({ number: 5, count: 1, recipe: null, shoppingRow: ROW });
    await useFromFreezer({ number: 6, count: 1, recipe: null, shoppingRow: ROW });

    expect(mockCommit.mock.calls.map((c) => c[0].defrost.location)).toEqual([
      'Chest',
      'Not placed',
    ]);
  });

  it('a bag already showing none is refused, and writes nothing', async () => {
    emitItems([item(47, { amount: 0 })]);

    expect(await useFromFreezer({ number: 47, count: 1, recipe: null, shoppingRow: ROW })).toEqual(
      failure({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT }),
    );
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('ticks off and undoes even before the listener has delivered', async () => {
    initDefrostSync();
    const defrost: Defrost = {
      schemaVersion: 1,
      freezerNumber: 47,
      name: 'Pork loin',
      location: 'Garage · shelf B',
      recipeId: 'r-chilli',
      recipeTitle: 'Chilli',
      amount: 1,
      committedAt: '2026-10-11T09:00:00.000Z',
    };

    await tickOffDefrost(defrost);
    await undoTickOff(defrost);

    expect(mockDeleteDefrost).toHaveBeenCalledWith('047_r-chilli');
    expect(mockSaveDefrost).toHaveBeenCalledWith(defrost);
    expect(getDefrostsSnapshot()).toEqual([]);
  });

  it('names a bag’s place, or nothing when its freezer is gone', () => {
    expect(freezerPlace(config([GARAGE]), item(1, { shelf: 'B' }))).toEqual({
      freezer: 'Garage',
      shelf: 'B',
    });
    expect(freezerPlace(config([]), item(1))).toBeNull();
  });
});
