import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ShoppingList, ShoppingListItem, CanonItem } from '@salt/domain';
import { push } from 'svelte-spa-router';

// The "this list id resolves to nothing" branch, which #993 Phase 1 moved onto
// the `EmptyState` primitive. It had no coverage at all before — the branch
// four sibling pages express with the same primitive was the one place the
// migration could have silently changed what the user sees.

const { mockCanonItems, mockAisles, mockLists, mockItems, mockDefaultListId, mockLoading } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockAisles: makeStore<{ id: string; name: string; order: number }[]>([]),
      mockLists: makeStore<ShoppingList[]>([]),
      mockItems: makeStore<ShoppingListItem[]>([]),
      mockDefaultListId: makeStore<string | null>('list-1'),
      mockLoading: makeStore<boolean>(false),
    };
  });

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
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

import ShoppingListPage from '../src/routes/shopping/ShoppingListPage.svelte';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLists._set([{ id: 'list-1', name: 'Groceries' } as ShoppingList]);
  mockDefaultListId._set('list-1');
  mockLoading._set(false);
  mockAisles._set([]);
  mockCanonItems._set([]);
  mockItems._set([]);
});

describe('ShoppingListPage — a list id that resolves to nothing', () => {
  it('says the list was not found, and offers the way back to shopping', async () => {
    render(ShoppingListPage, { props: { params: { listId: 'deleted-list' } } });

    // `EmptyState`, so the words are the panel's heading — not a muted sentence.
    expect(screen.getByRole('heading', { level: 3, name: 'List not found' })).toBeTruthy();
    // `role="status"`, never `alert`: the list is absent, not unreachable
    // (ui-spec-v13 §8.31.2).
    expect(document.querySelector('[role="status"]')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Go to shopping' }));
    expect(push).toHaveBeenCalledWith('/shopping');
  });

  it('does not show it while the lists are still loading', () => {
    mockLoading._set(true);
    render(ShoppingListPage, { props: { params: { listId: 'deleted-list' } } });
    expect(screen.queryByRole('heading', { level: 3, name: 'List not found' })).toBeNull();
  });
});
