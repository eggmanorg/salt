/**
 * Use from the freezer on the shopping list (issue #1685): the row's freezer
 * line, the combined row's hint, the per-recipe offer in the breakdown, and the
 * gate. The write itself is `freezerService.useFromFreezer`, mocked here at that
 * seam — what is this page's own is WHICH row, WHICH recipe and WHICH bag it
 * hands over.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { CanonItem, FreezerItem, ShoppingList, ShoppingListItem } from '@salt/domain';

const {
  mockCanonItems,
  mockAisles,
  mockLists,
  mockItems,
  mockDefaultListId,
  mockLoading,
  mockFreezerGate,
  mockFreezerItems,
  mockFreezerConfig,
  mockUseFromFreezer,
  mockSubscribeKitchenWeeks,
  mockReleaseKitchenWeeks,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCanonItems: makeStore<CanonItem[]>([]),
    mockAisles: makeStore<{ id: string; name: string; order: number }[]>([]),
    mockLists: makeStore<ShoppingList[]>([]),
    mockItems: makeStore<ShoppingListItem[]>([]),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockLoading: makeStore<boolean>(false),
    mockFreezerGate: makeStore<{ enabled: boolean; settled: boolean }>({
      enabled: true,
      settled: true,
    }),
    mockFreezerItems: makeStore<unknown>({ status: 'loaded', items: [] }),
    mockFreezerConfig: makeStore<unknown>({
      status: 'loaded',
      config: {
        schemaVersion: 1,
        updatedAt: '',
        freezers: [{ id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] }],
        suppliers: [],
      },
    }),
    mockUseFromFreezer: vi.fn(),
    mockSubscribeKitchenWeeks: vi.fn(),
    mockReleaseKitchenWeeks: vi.fn(),
  };
});

// Five seams, the UT-B1 ceiling: the router and the toast store are left real —
// nothing here navigates, and a toast is not what these cases assert.
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  aisles: mockAisles,
  purchaseCounts: {
    subscribe(fn: (v: Record<string, number>) => void) {
      fn({});
      return () => {};
    },
  },
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: { subscribe: (fn: (v: never[]) => void) => (fn([]), () => {}) },
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({
  lists: mockLists,
  defaultListId: mockDefaultListId,
  itemsForActiveList: mockItems,
  isLoadingShoppingList: mockLoading,
  setActiveListId: vi.fn(),
  addItemToList: vi.fn(),
  updateItemRawText: vi.fn(),
  updateItemAmountUnit: vi.fn(),
  updateItemNotes: vi.fn(),
  toggleItemChecked: vi.fn(),
  checkItems: vi.fn(),
  uncheckItems: vi.fn(),
  removeItem: vi.fn(),
  removeItems: vi.fn(),
  clearChecked: vi.fn(),
  moveSelectedItems: vi.fn(),
}));
vi.mock('../src/lib/featureGate.js', () => ({ freezerGate: mockFreezerGate }));
vi.mock('../src/lib/freezerService.js', () => ({
  freezerItemsState: mockFreezerItems,
  freezerConfigState: mockFreezerConfig,
  freezerPlace: (config: { freezers: { id: string; name: string }[] }, item: FreezerItem) => {
    const freezer = config.freezers.find((f) => f.id === item.freezerId);
    return freezer ? { freezer: freezer.name, shelf: item.shelf } : null;
  },
  initFreezerSync: vi.fn(() => () => {}),
  initDefrostSync: vi.fn(() => () => {}),
  useFromFreezer: mockUseFromFreezer,
}));
vi.mock('../src/lib/mealPlanService.js', () => ({
  subscribeKitchenWeeks: mockSubscribeKitchenWeeks,
}));

import ShoppingListPage from '../src/routes/shopping/ShoppingListPage.svelte';
import { dismissToast, toasts } from '../src/lib/toastStore.js';

const toastMessages = (): string[] => get(toasts).map((t) => t.message);

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: 'a-meat',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

function item(overrides: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return {
    rawText: 'pork loin',
    notes: '',
    sources: [],
    canonId: 'c-pork',
    matchState: 'matched',
    checked: false,
    needsCheck: false,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function bag(number: number, over: Partial<FreezerItem> = {}): FreezerItem {
  return {
    schemaVersion: 1,
    number,
    name: 'Pork loin',
    freezerId: 'fz-garage',
    shelf: 'B',
    amount: 1,
    canonId: 'c-pork',
    recipeId: null,
    purchasedFrom: null,
    packWeight: null,
    notes: null,
    addedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const fromRecipe = (label: string, recipeId: string) => [
  { kind: 'recipe' as const, recipeId, servings: 2, label },
];

const props = { props: { params: { listId: 'list-1' } } };

beforeEach(() => {
  mockCanonItems._set([
    canonItem({ id: 'c-pork', name: 'pork loin' }),
    canonItem({ id: 'c-mince', name: 'beef mince' }),
  ]);
  mockAisles._set([{ id: 'a-meat', name: 'Meat', order: 1 }]);
  mockLists._set([{ id: 'list-1', name: 'Weekly', createdAt: '', updatedAt: '' } as ShoppingList]);
  mockItems._set([]);
  mockFreezerGate._set({ enabled: true, settled: true });
  mockFreezerItems._set({ status: 'loaded', items: [bag(47)] });
  mockUseFromFreezer.mockReset();
  mockSubscribeKitchenWeeks.mockReset();
  mockReleaseKitchenWeeks.mockReset();
  mockSubscribeKitchenWeeks.mockReturnValue(mockReleaseKitchenWeeks);
  mockUseFromFreezer.mockResolvedValue({
    kind: 'ok',
    value: {
      defrost: { name: 'Pork loin', freezerNumber: 47 },
      last: true,
      written: Promise.resolve({ kind: 'ok', value: undefined }),
    },
  });
});

afterEach(() => {
  for (const t of get(toasts)) dismissToast(t.id);
  cleanup();
  document.body.innerHTML = '';
});

describe('ShoppingListPage — use from the freezer', () => {
  it('says where a matched row’s ingredient is', async () => {
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);

    const line = await view.findByTestId('shopping-item-freezer');
    expect(line.textContent).toContain('in the freezer · Garage, shelf B · #0047 · 1 pack');
  });

  it('renders nothing extra for a row whose ingredient is in no freezer', async () => {
    mockItems._set([item({ id: 'i1', canonId: 'c-mince', rawText: 'beef mince' })]);
    const view = render(ShoppingListPage, props);

    await view.findAllByTestId('shopping-item-row');
    expect(view.queryByTestId('shopping-item-freezer')).not.toBeInTheDocument();
  });

  it('with the freezer gate off, a row in the freezer looks as it always has', async () => {
    mockFreezerGate._set({ enabled: false, settled: true });
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);

    await view.findAllByTestId('shopping-item-row');
    expect(view.queryByTestId('shopping-item-freezer')).not.toBeInTheDocument();
  });

  // #1696: a commit dates its night from the Kitchen weeks, so the page holds
  // them — but only for a person the freezer is shown to.
  it('holds the Kitchen weeks while the freezer is on, and lets them go on leaving', async () => {
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);
    await view.findAllByTestId('shopping-item-row');

    expect(mockSubscribeKitchenWeeks).toHaveBeenCalledTimes(1);
    expect(mockReleaseKitchenWeeks).not.toHaveBeenCalled();

    view.unmount();

    expect(mockReleaseKitchenWeeks).toHaveBeenCalledTimes(1);
  });

  it('with the freezer gate off, claims no Kitchen weeks', async () => {
    mockFreezerGate._set({ enabled: false, settled: true });
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);
    await view.findAllByTestId('shopping-item-row');

    expect(mockSubscribeKitchenWeeks).not.toHaveBeenCalled();
  });

  it('hands over the row, its recipe and the bag', async () => {
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);

    await fireEvent.click(await view.findByTestId('shopping-item-use-from-freezer'));
    expect(await view.findByTestId('use-from-freezer-last')).toBeInTheDocument();
    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));

    expect(mockUseFromFreezer).toHaveBeenCalledWith({
      number: 47,
      count: 1,
      recipe: { id: 'r-chilli', title: 'Chilli' },
      shoppingRow: { listId: 'list-1', itemId: 'i1' },
    });
  });

  // Issue #1712: the sheet starts at what the row needs from the bag.
  it('starts at the packs the row needs: 1.2 kg from 500 g bags is 3', async () => {
    mockFreezerItems._set({
      status: 'loaded',
      items: [bag(47, { amount: 4, packWeight: { amount: 500, unit: 'g' } })],
    });
    mockItems._set([item({ id: 'i1', amount: 1.2, unit: 'kg', sources: [{ kind: 'manual' }] })]);
    const view = render(ShoppingListPage, props);

    await fireEvent.click(await view.findByTestId('shopping-item-use-from-freezer'));
    expect((await view.findByTestId('use-from-freezer-count')).textContent).toBe('3');
    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));
    expect(mockUseFromFreezer).toHaveBeenCalledWith(expect.objectContaining({ count: 3 }));
  });

  it('a hand-added row is for no recipe', async () => {
    mockItems._set([item({ id: 'i1', sources: [{ kind: 'manual' }] })]);
    const view = render(ShoppingListPage, props);

    await fireEvent.click(await view.findByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));

    expect(mockUseFromFreezer).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: null, shoppingRow: { listId: 'list-1', itemId: 'i1' } }),
    );
  });

  it('a combined row hints, and each recipe in its breakdown offers its own', async () => {
    // 100 g packs, so each recipe's own amount gives its own count (#1712): the
    // pie's 300 g starts at 3, where the combined 500 g would start at 5.
    mockFreezerItems._set({
      status: 'loaded',
      items: [bag(47, { amount: 10, packWeight: { amount: 100, unit: 'g' } })],
    });
    mockItems._set([
      item({ id: 'i1', amount: 200, unit: 'g', sources: fromRecipe('Chilli', 'r-chilli') }),
      item({ id: 'i2', amount: 300, unit: 'g', sources: fromRecipe('Cottage pie', 'r-pie') }),
    ]);
    const view = render(ShoppingListPage, props);

    expect(await view.findByTestId('shopping-combined-freezer-hint')).toBeInTheDocument();
    expect(view.queryByTestId('shopping-item-use-from-freezer')).not.toBeInTheDocument();

    await fireEvent.click(view.getByTestId('shopping-combined-toggle'));
    const breakdown = await view.findByTestId('shopping-combined-breakdown');
    const offers = within(breakdown).getAllByTestId('shopping-item-use-from-freezer');
    expect(offers).toHaveLength(2);

    await fireEvent.click(offers[1]!);
    expect((await view.findByTestId('use-from-freezer-count')).textContent).toBe('3');
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));
    expect(mockUseFromFreezer).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 3,
        recipe: { id: 'r-pie', title: 'Cottage pie' },
        shoppingRow: { listId: 'list-1', itemId: 'i2' },
      }),
    );
  });

  it('offers every bag oldest first, and takes the one and the count chosen', async () => {
    mockFreezerItems._set({
      status: 'loaded',
      items: [
        bag(47, { amount: 3, addedAt: '2026-09-01T00:00:00.000Z' }),
        bag(12, {
          amount: 2,
          shelf: null,
          freezerId: 'fz-gone',
          addedAt: '2026-08-01T00:00:00.000Z',
        }),
      ],
    });
    mockItems._set([item({ id: 'i1', sources: fromRecipe('Chilli', 'r-chilli') })]);
    const view = render(ShoppingListPage, props);

    const line = await view.findByTestId('shopping-item-freezer');
    expect(line.textContent).toContain('Not placed · #0012 · 2 packs · 1 more');

    await fireEvent.click(view.getByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByRole('radio', { name: /#0047/ }));
    await fireEvent.click(view.getByTestId('use-from-freezer-more'));
    await fireEvent.click(view.getByTestId('use-from-freezer-more'));
    await fireEvent.click(view.getByTestId('use-from-freezer-fewer'));
    expect(view.getByTestId('use-from-freezer-count').textContent).toBe('2');
    expect(view.queryByTestId('use-from-freezer-last')).not.toBeInTheDocument();
    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));

    expect(mockUseFromFreezer).toHaveBeenCalledWith(
      expect.objectContaining({ number: 47, count: 2 }),
    );
  });

  it('a checked row has no freezer line — it is bought', async () => {
    mockItems._set([item({ id: 'i1', checked: true })]);
    const view = render(ShoppingListPage, props);

    await view.findByTestId('shopping-checked');
    expect(view.queryByTestId('shopping-item-freezer')).not.toBeInTheDocument();
  });

  it('says so when the bag has gone, now or once the server answers', async () => {
    mockItems._set([item({ id: 'i1', sources: [{ kind: 'manual' }] })]);
    const view = render(ShoppingListPage, props);

    mockUseFromFreezer.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezerItem', id: '47' },
    });
    await fireEvent.click(await view.findByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));
    await waitFor(() =>
      expect(toastMessages()).toEqual(['That pack is no longer in the freezer.']),
    );

    mockUseFromFreezer.mockResolvedValueOnce({ kind: 'err', error: { kind: 'StorageError' } });
    await fireEvent.click(view.getByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));
    await waitFor(() => expect(toastMessages()).toContain("Couldn't use that from the freezer."));

    mockUseFromFreezer.mockResolvedValueOnce({
      kind: 'ok',
      value: {
        defrost: { name: 'Pork loin', freezerNumber: 47 },
        last: false,
        written: Promise.resolve({
          kind: 'err',
          error: { kind: 'NotFound', resource: 'freezerItem', id: '47' },
        }),
      },
    });
    await fireEvent.click(view.getByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));
    await waitFor(() =>
      expect(toastMessages().slice(-2)).toEqual([
        'Pork loin is in Kitchen to get out.',
        'That pack is no longer in the freezer.',
      ]),
    );
  });

  it('a recipe row with no label is for its recipe, title unknown', async () => {
    mockItems._set([
      item({ id: 'i1', sources: [{ kind: 'recipe', recipeId: 'r-gone', servings: 2 }] }),
    ]);
    const view = render(ShoppingListPage, props);

    await fireEvent.click(await view.findByTestId('shopping-item-use-from-freezer'));
    await fireEvent.click(await view.findByTestId('use-from-freezer-confirm'));

    expect(mockUseFromFreezer).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: { id: 'r-gone', title: null } }),
    );
  });
});
