import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type { FreezerItem } from '@salt/domain';
import UseFromFreezerSheet from '../src/routes/shopping/UseFromFreezerSheet.svelte';

// The sheet (issue #1685) with nothing left to offer — another phone took the
// last pack while it was open. The page's use of it, with stock, is
// ShoppingListPage.freezer.test.ts.

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('UseFromFreezerSheet', () => {
  it('offers nothing to confirm once the stock has gone', async () => {
    const onConfirm = vi.fn();
    const view = render(UseFromFreezerSheet, {
      props: { open: true, itemName: 'Pork Loin', stock: [], placeOf: () => '', onConfirm },
    });

    const confirm = await view.findByTestId('use-from-freezer-confirm');
    expect(confirm).toBeDisabled();
    expect(view.queryByTestId('use-from-freezer-count')).not.toBeInTheDocument();
    expect(view.queryByTestId('use-from-freezer-entry')).not.toBeInTheDocument();
  });

  it('one bag: names it, counts up to what it holds, and warns on the last', async () => {
    const bag: FreezerItem = {
      schemaVersion: 1,
      number: 47,
      name: 'Pork loin',
      freezerId: 'fz-garage',
      shelf: 'B',
      amount: 2,
      canonId: 'c-pork',
      recipeId: null,
      purchasedFrom: null,
      addedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const onConfirm = vi.fn();
    const view = render(UseFromFreezerSheet, {
      props: {
        open: true,
        itemName: 'Pork Loin',
        stock: [bag],
        placeOf: () => 'Garage, shelf B',
        onConfirm,
      },
    });

    expect((await view.findByTestId('use-from-freezer-entry')).textContent).toContain(
      'Garage, shelf B · 2 packs',
    );
    expect(view.queryByTestId('use-from-freezer-last')).not.toBeInTheDocument();
    await fireEvent.click(view.getByTestId('use-from-freezer-more'));
    expect(view.getByTestId('use-from-freezer-more')).toBeDisabled();
    expect(view.getByTestId('use-from-freezer-last')).toHaveTextContent(
      'That is the last of #47. Its entry comes out of the freezer.',
    );
    // Its number does not come back to the count (issue #1693).
    expect(view.getByTestId('use-from-freezer-last')).not.toHaveTextContent(/free again/i);

    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ number: 47, count: 2 });
  });
});
