import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import {
  addFreezerItem,
  editFreezerItem,
  itemAge,
  itemsByShelf,
  moveFreezerItem,
  nextBagNumber,
  oldestFirst,
  recordBagNumber,
  removeFreezerItem,
} from '@salt/domain';
import type { FreezerConfig, FreezerItem } from '@salt/domain';
import { FreezerItemSchema, freezerItemDocId } from '@salt/domain/schemas';

// Freezer stock (issue #1684) — the item commands and queries. Every refusal
// below names its code; a refused command returns no item, so nothing is written.

const NOW = '2026-10-12T09:00:00.000Z';
const LATER = '2026-10-12T10:00:00.000Z';

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] };
const CHEST = { id: 'fz-chest', name: 'Chest', shelves: [] };
const CONFIG: FreezerConfig = {
  schemaVersion: 1,
  updatedAt: NOW,
  freezers: [GARAGE, CHEST],
  suppliers: [],
  highestNumber: 0,
};

/** CONFIG with the bag-number mark at `highestNumber`. */
function marked(highestNumber: number): FreezerConfig {
  return { ...CONFIG, highestNumber };
}

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
    addedAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function ok<T>(r: { kind: string; value?: T }): T {
  expect(r.kind).toBe('ok');
  return r.value as T;
}

function errorOf(r: { kind: string; error?: unknown }): unknown {
  expect(r.kind).toBe('err');
  return r.error;
}

const ADD = {
  number: 47,
  name: ' Pork loin ',
  freezerId: GARAGE.id,
  shelf: 'B',
  amount: 5,
  purchasedFrom: ' Swaledale ',
  now: NOW,
};

describe('freezerItemDocId', () => {
  it('zero-pads to three digits and keeps a fourth', () => {
    expect(freezerItemDocId(7)).toBe('007');
    expect(freezerItemDocId(47)).toBe('047');
    expect(freezerItemDocId(1000)).toBe('1000');
  });
});

describe('FreezerItemSchema', () => {
  it('reads an amount below zero — concurrent takes can land there', () => {
    expect(FreezerItemSchema.safeParse(item(1, { amount: -1 })).success).toBe(true);
  });

  it('refuses a fractional amount and a non-positive number', () => {
    expect(FreezerItemSchema.safeParse(item(1, { amount: 1.5 })).success).toBe(false);
    expect(FreezerItemSchema.safeParse(item(0)).success).toBe(false);
  });
});

// Issue #1693: bag numbers count up and are never handed out twice. Each test
// below goes red if a number can come back as the suggestion.
describe('nextBagNumber', () => {
  it('is 1 for an empty freezer with no mark', () => {
    expect(nextBagNumber([], CONFIG)).toBe(1);
  });

  it('does NOT reuse a gap: bags 1, 2 and 4 with 1–6 given out before suggest 7', () => {
    expect(nextBagNumber([item(1), item(2), item(4)], marked(6))).toBe(7);
  });

  it('removing the top bag does not lower the suggestion while the mark holds it', () => {
    const items = [item(1), item(2), item(3), item(4), item(5)];
    expect(nextBagNumber(items, marked(5))).toBe(6);
    const removed = ok(removeFreezerItem(items, { number: 5 }));
    expect(
      nextBagNumber(
        items.filter((i) => i !== removed),
        marked(5),
      ),
    ).toBe(6);
  });

  it('falls back to the items when no mark is stored (it reads as 0)', () => {
    expect(nextBagNumber([item(1), item(2), item(4)], CONFIG)).toBe(5);
    expect(nextBagNumber([item(12), item(3)], CONFIG)).toBe(13);
  });

  it('takes the mark when it is above every item', () => {
    expect(nextBagNumber([item(3)], marked(120))).toBe(121);
    expect(nextBagNumber([], marked(9))).toBe(10);
  });

  it('takes an item above the mark — one another device added that this config copy has not seen', () => {
    expect(nextBagNumber([item(2), item(30)], marked(10))).toBe(31);
  });

  it('does not care what order the items come in', () => {
    expect(nextBagNumber([item(3), item(1), item(2)], CONFIG)).toBe(4);
    expect(nextBagNumber([item(5), item(2), item(1)], CONFIG)).toBe(6);
  });
});

describe('recordBagNumber', () => {
  it('hands back the SAME config — nothing to write — for a number not above the mark', () => {
    const config = marked(6);
    expect(recordBagNumber(config, 6, LATER)).toBe(config);
    expect(recordBagNumber(config, 3, LATER)).toBe(config);
  });

  it('never lowers the mark', () => {
    expect(recordBagNumber(marked(9999), 7, LATER).highestNumber).toBe(9999);
  });

  it('stores a higher number with a fresh updatedAt, and changes nothing else', () => {
    const config = { ...marked(6), suppliers: ['Swaledale'] };
    expect(recordBagNumber(config, 120, LATER)).toEqual({
      ...config,
      highestNumber: 120,
      updatedAt: LATER,
    });
    expect(config.highestNumber).toBe(6);
  });

  it('moves the next suggestion on: type 120, and 121 is offered', () => {
    const items = [item(1)];
    const config = recordBagNumber(marked(1), 120, LATER);
    expect(nextBagNumber([...items, item(120)], config)).toBe(121);
    expect(nextBagNumber(items, config)).toBe(121);
  });
});

describe('addFreezerItem', () => {
  it('makes the item, trimmed, with no links and both stamps at now', () => {
    expect(ok(addFreezerItem([], CONFIG, ADD))).toEqual({
      schemaVersion: 1,
      number: 47,
      name: 'Pork loin',
      freezerId: GARAGE.id,
      shelf: 'B',
      amount: 5,
      canonId: null,
      recipeId: null,
      purchasedFrom: 'Swaledale',
      addedAt: NOW,
      updatedAt: NOW,
    });
  });

  it('takes a blank supplier as none', () => {
    expect(
      ok(addFreezerItem([], CONFIG, { ...ADD, purchasedFrom: '  ' })).purchasedFrom,
    ).toBeNull();
  });

  it('puts an item in a freezer with no shelves at shelf null', () => {
    const added = ok(addFreezerItem([], CONFIG, { ...ADD, freezerId: CHEST.id, shelf: null }));
    expect(added).toMatchObject({ freezerId: CHEST.id, shelf: null });
  });

  it('refuses a number this device already holds', () => {
    expect(errorOf(addFreezerItem([item(47)], CONFIG, ADD))).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.FREEZER_NUMBER_IN_USE,
    });
  });

  it.each([0, -3, 2.5, Number.NaN])('refuses %s as a number', (number) => {
    expect(errorOf(addFreezerItem([], CONFIG, { ...ADD, number }))).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_FREEZER_NUMBER,
    });
  });

  it('refuses a blank name', () => {
    expect(errorOf(addFreezerItem([], CONFIG, { ...ADD, name: '   ' }))).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_FREEZER_ITEM_NAME,
    });
  });

  it.each([0, -1, 1.5])('refuses %s packs', (amount) => {
    expect(errorOf(addFreezerItem([], CONFIG, { ...ADD, amount }))).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_FREEZER_AMOUNT,
    });
  });

  it.each([
    ['a freezer the setup does not have', { freezerId: 'fz-gone', shelf: 'A' }],
    ['a shelf the freezer does not have', { freezerId: GARAGE.id, shelf: 'Z' }],
    ['no shelf in a freezer that has shelves', { freezerId: GARAGE.id, shelf: null }],
    ['a shelf in a freezer with none', { freezerId: CHEST.id, shelf: 'A' }],
  ])('refuses %s', (_what, place) => {
    expect(errorOf(addFreezerItem([], CONFIG, { ...ADD, ...place }))).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.UNKNOWN_FREEZER_PLACE,
    });
  });
});

describe('editFreezerItem', () => {
  it('changes the name and supplier and nothing else but updatedAt', () => {
    const before = item(5, { amount: 3, purchasedFrom: 'Swaledale' });
    const edited = ok(
      editFreezerItem([before], { number: 5, name: ' Lamb ', purchasedFrom: '', now: LATER }),
    );
    expect(edited).toEqual({ ...before, name: 'Lamb', purchasedFrom: null, updatedAt: LATER });
  });

  it('edits an item whose place has been removed without filing it anywhere', () => {
    const orphan = item(5, { freezerId: 'fz-gone' });
    const edited = ok(
      editFreezerItem([orphan], { number: 5, name: 'X', purchasedFrom: null, now: LATER }),
    );
    expect(edited.freezerId).toBe('fz-gone');
  });

  it('refuses a blank name', () => {
    expect(
      errorOf(
        editFreezerItem([item(5)], { number: 5, name: ' ', purchasedFrom: null, now: LATER }),
      ),
    ).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_ITEM_NAME });
  });

  it('is NotFound when another device has removed it', () => {
    expect(
      errorOf(editFreezerItem([], { number: 5, name: 'X', purchasedFrom: null, now: LATER })),
    ).toEqual({ kind: 'NotFound', resource: 'freezerItem', id: '5' });
  });
});

describe('moveFreezerItem', () => {
  it('changes the place and keeps the number', () => {
    const before = item(47, { shelf: 'A' });
    const moved = ok(
      moveFreezerItem([before], CONFIG, {
        number: 47,
        freezerId: CHEST.id,
        shelf: null,
        now: LATER,
      }),
    );
    expect(moved).toEqual({ ...before, freezerId: CHEST.id, shelf: null, updatedAt: LATER });
  });

  it('refuses a place the setup does not have', () => {
    expect(
      errorOf(
        moveFreezerItem([item(47)], CONFIG, {
          number: 47,
          freezerId: GARAGE.id,
          shelf: 'Q',
          now: LATER,
        }),
      ),
    ).toEqual({ kind: 'ValidationError', code: ErrorCode.UNKNOWN_FREEZER_PLACE });
  });

  it('is NotFound before it looks at the place', () => {
    expect(
      errorOf(
        moveFreezerItem([], CONFIG, { number: 47, freezerId: 'fz-gone', shelf: null, now: LATER }),
      ),
    ).toEqual({ kind: 'NotFound', resource: 'freezerItem', id: '47' });
  });
});

describe('removeFreezerItem', () => {
  it('gives back the item to delete, and its number is NOT offered again', () => {
    const items = [item(1), item(2), item(3)];
    const removed = ok(removeFreezerItem(items, { number: 3 }));
    expect(removed).toBe(items[2]);
    expect(
      nextBagNumber(
        items.filter((i) => i.number !== removed.number),
        marked(3),
      ),
    ).toBe(4);
  });

  it('is NotFound when this device no longer holds it', () => {
    expect(errorOf(removeFreezerItem([], { number: 2 }))).toEqual({
      kind: 'NotFound',
      resource: 'freezerItem',
      id: '2',
    });
  });
});

describe('itemsByShelf', () => {
  it('files each item under its freezer and shelf, in setup order, by number', () => {
    const items = [item(9, { shelf: 'B' }), item(4, { shelf: 'A' }), item(2, { shelf: 'A' })];
    const filed = itemsByShelf(items, CONFIG);

    expect(filed.notPlaced).toEqual([]);
    expect(
      filed.freezers.map((f) => ({
        id: f.freezer.id,
        count: f.count,
        shelves: f.shelves.map((s) => [s.shelf, s.items.map((i) => i.number)]),
      })),
    ).toEqual([
      {
        id: GARAGE.id,
        count: 3,
        shelves: [
          ['A', [2, 4]],
          ['B', [9]],
        ],
      },
      { id: CHEST.id, count: 0, shelves: [[null, []]] },
    ]);
  });

  it('puts an item whose freezer or shelf is gone under Not placed, and loses nothing', () => {
    const items = [
      item(1, { freezerId: 'fz-removed' }),
      item(5, { shelf: 'C' }),
      item(3, { freezerId: CHEST.id, shelf: 'A' }),
      item(2, { shelf: null }),
      item(4),
    ];
    const filed = itemsByShelf(items, CONFIG);

    expect(filed.notPlaced.map((i) => i.number)).toEqual([1, 2, 3, 5]);
    expect(filed.freezers[0]?.shelves[0]?.items.map((i) => i.number)).toEqual([4]);
    const total = filed.notPlaced.length + filed.freezers.reduce((n, f) => n + f.count, 0);
    expect(total).toBe(items.length);
  });

  it('puts everything under Not placed when no freezer is set up', () => {
    const filed = itemsByShelf([item(1)], {
      schemaVersion: 1,
      updatedAt: NOW,
      freezers: [],
      suppliers: [],
      highestNumber: 0,
    });
    expect(filed.notPlaced.map((i) => i.number)).toEqual([1]);
    expect(filed.freezers).toEqual([]);
  });
});

describe('oldestFirst', () => {
  it('lists every item by when it went in, then by number', () => {
    const items = [
      item(1, { addedAt: '2026-08-01T00:00:00.000Z' }),
      item(3, { addedAt: '2026-06-12T00:00:00.000Z', freezerId: 'fz-gone' }),
      item(2, { addedAt: '2026-06-12T00:00:00.000Z' }),
    ];
    expect(oldestFirst(items).map((i) => i.number)).toEqual([2, 3, 1]);
    expect(items.map((i) => i.number)).toEqual([1, 3, 2]);
  });
});

describe('itemAge', () => {
  it('counts whole days and weeks from addedAt to now', () => {
    expect(itemAge('2026-06-12T09:00:00.000Z', '2026-08-07T08:00:00.000Z')).toEqual({
      days: 55,
      weeks: 7,
    });
    expect(itemAge('2026-06-12T09:00:00.000Z', '2026-08-07T09:00:00.000Z')).toEqual({
      days: 56,
      weeks: 8,
    });
  });

  it('is zero for an item added just now, or stamped ahead by a fast clock', () => {
    expect(itemAge(NOW, NOW)).toEqual({ days: 0, weeks: 0 });
    expect(itemAge(LATER, NOW)).toEqual({ days: 0, weeks: 0 });
  });

  it('is zero rather than NaN for an unreadable stamp', () => {
    expect(itemAge('not a date', NOW)).toEqual({ days: 0, weeks: 0 });
  });
});
