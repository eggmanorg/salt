import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import type { FreezerItem } from '@salt/domain';
import UseFromFreezerSheet from '../src/routes/shopping/UseFromFreezerSheet.svelte';

// The sheet (issue #1685) with nothing left to offer — another phone took the
// last pack while it was open. The page's use of it, with stock, is
// ShoppingListPage.freezer.test.ts.

function bagOf(number: number, over: Partial<FreezerItem> = {}): FreezerItem {
  return {
    schemaVersion: 1,
    number,
    name: 'Beef mince',
    freezerId: 'fz-garage',
    shelf: 'B',
    amount: 4,
    canonId: 'c-mince',
    recipeId: null,
    purchasedFrom: null,
    packWeight: { amount: 500, unit: 'g' },
    addedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function sheetFor(stock: FreezerItem[], need: { amount?: number; unit?: string }) {
  const onConfirm = vi.fn();
  const view = render(UseFromFreezerSheet, {
    props: {
      open: true,
      itemName: 'Beef Mince',
      stock,
      need,
      placeOf: () => 'Garage, shelf B',
      onConfirm,
    },
  });
  return { view, onConfirm };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('UseFromFreezerSheet', () => {
  it('offers nothing to confirm once the stock has gone', async () => {
    const onConfirm = vi.fn();
    const view = render(UseFromFreezerSheet, {
      props: {
        open: true,
        itemName: 'Pork Loin',
        stock: [],
        need: {},
        placeOf: () => '',
        onConfirm,
      },
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
      packWeight: null,
      addedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const onConfirm = vi.fn();
    const view = render(UseFromFreezerSheet, {
      props: {
        open: true,
        itemName: 'Pork Loin',
        stock: [bag],
        need: {},
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
      'That is the last of #0047. Its entry comes out of the freezer.',
    );
    // Its number does not come back to the count (issue #1693).
    expect(view.getByTestId('use-from-freezer-last')).not.toHaveTextContent(/free again/i);

    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ number: 47, count: 2 });
  });
});

// Issue #1712: the count starts at the packs the row needs from the chosen bag.
describe('UseFromFreezerSheet — starting at what the row needs', () => {
  it('1.2 kg against 500 g bags starts at 3, shows the weight, and −/+ still adjust', async () => {
    const { view, onConfirm } = sheetFor([bagOf(12)], { amount: 1.2, unit: 'kg' });

    expect((await view.findByTestId('use-from-freezer-entry')).textContent).toContain(
      'Beef mince — Garage, shelf B · 4 × 500 g',
    );
    expect(view.getByTestId('use-from-freezer-count').textContent).toBe('3');
    expect(view.queryByTestId('use-from-freezer-last')).not.toBeInTheDocument();

    await fireEvent.click(view.getByTestId('use-from-freezer-more'));
    expect(view.getByTestId('use-from-freezer-count').textContent).toBe('4');
    expect(view.getByTestId('use-from-freezer-more')).toBeDisabled();
    await fireEvent.click(view.getByTestId('use-from-freezer-fewer'));
    await fireEvent.click(view.getByTestId('use-from-freezer-fewer'));
    await fireEvent.click(view.getByTestId('use-from-freezer-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ number: 12, count: 2 });
  });

  it('needing more than the bag holds starts at all of them, with the last-of notice', async () => {
    const { view } = sheetFor([bagOf(12, { amount: 2 })], { amount: 3, unit: 'kg' });

    expect((await view.findByTestId('use-from-freezer-count')).textContent).toBe('2');
    expect(view.getByTestId('use-from-freezer-last')).toHaveTextContent(
      'That is the last of #0012.',
    );
  });

  it('works the count out again for the weight of another bag', async () => {
    const { view } = sheetFor(
      [bagOf(12), bagOf(14, { packWeight: { amount: 250, unit: 'g' }, amount: 6 })],
      { amount: 1000, unit: 'g' },
    );

    expect((await view.findByTestId('use-from-freezer-count')).textContent).toBe('2');
    expect(
      view.getByRole('radio', { name: /#0014 Beef mince — Garage, shelf B · 6 × 250 g/ }),
    ).toBeInTheDocument();
    await fireEvent.click(view.getByRole('radio', { name: /#0014/ }));
    expect(view.getByTestId('use-from-freezer-count').textContent).toBe('4');
  });

  it.each<[string, { amount?: number; unit?: string }, FreezerItem]>([
    ['a counted row', { amount: 3, unit: 'count' }, bagOf(12)],
    ['a row in tins', { amount: 2, unit: 'tins' }, bagOf(12)],
    ['a row with no amount', {}, bagOf(12)],
    [
      'a row in g against an ml bag',
      { amount: 1000, unit: 'g' },
      bagOf(12, { packWeight: { amount: 250, unit: 'ml' } }),
    ],
    ['a bag with no weight', { amount: 1000, unit: 'g' }, bagOf(12, { packWeight: null })],
  ])('%s starts at 1, as before', async (_, need, bag) => {
    const { view } = sheetFor([bag], need);
    expect((await view.findByTestId('use-from-freezer-count')).textContent).toBe('1');
  });

  it('a bag with no weight reads as its count alone', async () => {
    const { view } = sheetFor([bagOf(12, { packWeight: null })], {});
    expect((await view.findByTestId('use-from-freezer-entry')).textContent).toContain(
      'Garage, shelf B · 4 packs',
    );
  });
});
