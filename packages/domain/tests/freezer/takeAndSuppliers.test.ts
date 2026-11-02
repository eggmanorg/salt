import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import {
  addFreezerItem,
  displayAmount,
  editFreezerItem,
  containerSpelling,
  containerSuggestions,
  emptyFreezerConfig,
  forgetContainer,
  forgetSupplier,
  rememberContainer,
  rememberSupplier,
  setFreezerItemAmount,
  supplierSpelling,
  supplierSuggestions,
  takeFreezerPacks,
} from '@salt/domain';
import type { FreezerConfig, FreezerItem } from '@salt/domain';
import { FreezerConfigSchema } from '@salt/domain/schemas';

// Freezer stock, Phase 2 (issue #1684) — taking packs out, correcting the count,
// the links, and the remembered suppliers.

const NOW = '2026-10-12T09:00:00.000Z';
const LATER = '2026-10-12T10:00:00.000Z';
const WEIGHT = { amount: 500, unit: 'g' } as const;

const GARAGE = { id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] };

function config(suppliers: string[] = [], containers: string[] = []): FreezerConfig {
  return {
    schemaVersion: 1,
    updatedAt: NOW,
    freezers: [GARAGE],
    suppliers,
    containers,
    highestNumber: 0,
  };
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
    packWeight: null,
    notes: null,
    container: null,
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

describe('takeFreezerPacks', () => {
  it('returns a delta and the item as it should show, one pack less', () => {
    const taken = ok(
      takeFreezerPacks([item(47, { amount: 5 })], { number: 47, count: 1, now: LATER }),
    );

    expect(taken.delta).toBe(-1);
    expect(taken.item).toEqual(item(47, { amount: 4, updatedAt: LATER }));
    expect(taken.last).toBe(false);
  });

  it('says the last one was taken when nothing is left', () => {
    const taken = ok(
      takeFreezerPacks([item(47, { amount: 1 })], { number: 47, count: 1, now: LATER }),
    );

    expect(taken.delta).toBe(-1);
    expect(taken.item.amount).toBe(0);
    expect(taken.last).toBe(true);
  });

  it('takes no more than is left', () => {
    const taken = ok(
      takeFreezerPacks([item(47, { amount: 2 })], { number: 47, count: 5, now: LATER }),
    );

    expect(taken.delta).toBe(-2);
    expect(taken.item.amount).toBe(0);
  });

  it('takes nothing from an item already at or below zero, and offers removing it', () => {
    for (const amount of [0, -1]) {
      const taken = ok(
        takeFreezerPacks([item(47, { amount })], { number: 47, count: 1, now: LATER }),
      );
      expect(Object.is(taken.delta, 0)).toBe(true);
      expect(taken.item.amount).toBe(amount);
      expect(taken.last).toBe(true);
    }
  });

  it('refuses a count that is not a whole number of at least one', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(errorOf(takeFreezerPacks([item(47)], { number: 47, count, now: LATER }))).toEqual({
        kind: 'ValidationError',
        code: ErrorCode.INVALID_FREEZER_AMOUNT,
      });
    }
  });

  it('is NotFound when another device has removed it', () => {
    expect(errorOf(takeFreezerPacks([], { number: 47, count: 1, now: LATER }))).toEqual({
      kind: 'NotFound',
      resource: 'freezerItem',
      id: '47',
    });
  });
});

describe('setFreezerItemAmount', () => {
  it('sets the count, zero included, and stamps updatedAt', () => {
    expect(ok(setFreezerItemAmount([item(47)], { number: 47, amount: 3, now: LATER }))).toEqual(
      item(47, { amount: 3, updatedAt: LATER }),
    );
    expect(ok(setFreezerItemAmount([item(47)], { number: 47, amount: 0, now: LATER })).amount).toBe(
      0,
    );
  });

  it('refuses a count that is not a whole number of zero or more', () => {
    for (const amount of [-1, 2.5, Number.NaN]) {
      expect(errorOf(setFreezerItemAmount([item(47)], { number: 47, amount, now: LATER }))).toEqual(
        { kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT },
      );
    }
  });

  it('is NotFound when another device has removed it', () => {
    expect(errorOf(setFreezerItemAmount([], { number: 47, amount: 1, now: LATER }))).toEqual({
      kind: 'NotFound',
      resource: 'freezerItem',
      id: '47',
    });
  });
});

describe('displayAmount', () => {
  it('shows a count below zero as none, and every other count as it is', () => {
    expect(displayAmount(-1)).toBe(0);
    expect(displayAmount(0)).toBe(0);
    expect(displayAmount(4)).toBe(4);
  });
});

describe('the links', () => {
  it('are saved on add when picked, and null when not', () => {
    const input = {
      number: 1,
      name: 'Stew',
      freezerId: GARAGE.id,
      shelf: 'A',
      amount: 2,
      packWeight: WEIGHT,
      now: NOW,
    };
    const linked = ok(addFreezerItem([], config(), { ...input, canonId: 'c-1', recipeId: 'r-1' }));
    expect([linked.canonId, linked.recipeId]).toEqual(['c-1', 'r-1']);

    const plain = ok(addFreezerItem([], config(), input));
    expect([plain.canonId, plain.recipeId]).toEqual([null, null]);
  });

  it('change on edit when given, and are left alone when omitted', () => {
    const before = item(47, { canonId: 'c-1', recipeId: 'r-1' });
    const kept = ok(
      editFreezerItem([before], {
        number: 47,
        name: 'Stew',
        purchasedFrom: null,
        packWeight: WEIGHT,
        now: LATER,
      }),
    );
    expect([kept.canonId, kept.recipeId]).toEqual(['c-1', 'r-1']);

    const cleared = ok(
      editFreezerItem([before], {
        number: 47,
        name: 'Stew',
        purchasedFrom: null,
        packWeight: WEIGHT,
        canonId: null,
        recipeId: 'r-2',
        now: LATER,
      }),
    );
    expect([cleared.canonId, cleared.recipeId]).toEqual([null, 'r-2']);
  });
});

describe('FreezerConfigSchema', () => {
  it('reads a document written before the supplier list as an empty list', () => {
    const parsed = FreezerConfigSchema.parse({ schemaVersion: 1, updatedAt: NOW, freezers: [] });
    expect(parsed.suppliers).toEqual([]);
  });

  it('gives an empty config an empty list', () => {
    expect(emptyFreezerConfig(NOW).suppliers).toEqual([]);
  });
});

describe('rememberSupplier', () => {
  it('appends a new place, trimmed, and stamps updatedAt', () => {
    expect(ok(rememberSupplier(config(['Swaledale']), ' Booths ', LATER))).toEqual({
      ...config(['Swaledale', 'Booths']),
      updatedAt: LATER,
    });
  });

  it('hands back the same config for a place it has in another case or spacing, keeping the first spelling', () => {
    const before = config(['Swaledale']);
    for (const typed of ['swaledale', ' SWALEDALE ', 'Swaledale']) {
      expect(ok(rememberSupplier(before, typed, LATER))).toBe(before);
    }
  });

  it('hands back the same config for a blank or absent place', () => {
    const before = config(['Swaledale']);
    for (const typed of ['', '   ', null]) {
      expect(ok(rememberSupplier(before, typed, LATER))).toBe(before);
    }
  });
});

describe('forgetSupplier', () => {
  it('takes the place off, matched in any case, and stamps updatedAt', () => {
    expect(
      ok(forgetSupplier(config(['Swaledale', 'Booths']), { supplier: 'swaledale', now: LATER })),
    ).toEqual({
      ...config(['Booths']),
      updatedAt: LATER,
    });
  });

  it('hands back the same config when the list does not have it', () => {
    const before = config(['Booths']);
    expect(ok(forgetSupplier(before, { supplier: 'Swaledale', now: LATER }))).toBe(before);
  });
});

describe('supplierSuggestions', () => {
  const list = config(['Swaledale', 'Booths', 'Bolton Abbey Foods']);

  it('offers every remembered place, alphabetically, when nothing is typed', () => {
    expect(supplierSuggestions(list, '')).toEqual(['Bolton Abbey Foods', 'Booths', 'Swaledale']);
  });

  it('offers the places containing what is typed, in any case', () => {
    expect(supplierSuggestions(list, 'bo')).toEqual(['Bolton Abbey Foods', 'Booths']);
    expect(supplierSuggestions(list, 'DALE')).toEqual(['Swaledale']);
    expect(supplierSuggestions(list, 'tesco')).toEqual([]);
  });

  it('leaves the stored list in its order', () => {
    supplierSuggestions(list, '');
    expect(list.suppliers).toEqual(['Swaledale', 'Booths', 'Bolton Abbey Foods']);
  });
});

describe('supplierSpelling', () => {
  const list = config(['Swaledale']);

  it('saves a remembered place with its remembered spelling', () => {
    expect(supplierSpelling(list, ' swaledale ')).toBe('Swaledale');
  });

  it('saves a new place as typed, trimmed, and a blank one as none', () => {
    expect(supplierSpelling(list, ' Booths ')).toBe('Booths');
    expect(supplierSpelling(list, '  ')).toBeNull();
    expect(supplierSpelling(list, null)).toBeNull();
  });
});

describe('the container', () => {
  const input = {
    number: 1,
    name: 'Stew',
    freezerId: GARAGE.id,
    shelf: 'A',
    amount: 2,
    packWeight: WEIGHT,
    now: NOW,
  };

  it('is saved on add, trimmed, and blank or absent is none', () => {
    expect(ok(addFreezerItem([], config(), { ...input, container: ' Deli pot ' })).container).toBe(
      'Deli pot',
    );
    expect(ok(addFreezerItem([], config(), { ...input, container: '  ' })).container).toBeNull();
    expect(ok(addFreezerItem([], config(), input)).container).toBeNull();
  });

  it('changes on edit when given, and is left alone when omitted', () => {
    const before = item(47, { container: 'Box' });
    const edit = { number: 47, name: 'Stew', purchasedFrom: null, packWeight: WEIGHT, now: LATER };
    expect(ok(editFreezerItem([before], edit)).container).toBe('Box');
    expect(ok(editFreezerItem([before], { ...edit, container: 'Bag' })).container).toBe('Bag');
    expect(ok(editFreezerItem([before], { ...edit, container: '' })).container).toBeNull();
  });
});

describe('the remembered containers', () => {
  it('start with the four kinds, on an empty config and on a document written before the list', () => {
    const kinds = ['Bag', 'Box', 'Deli pot', 'Vacuum bag'];
    expect(emptyFreezerConfig(NOW).containers).toEqual(kinds);
    const parsed = FreezerConfigSchema.parse({ schemaVersion: 1, updatedAt: NOW, freezers: [] });
    expect(parsed.containers).toEqual(kinds);
  });

  it('keep a list emptied by hand empty', () => {
    const parsed = FreezerConfigSchema.parse({
      schemaVersion: 1,
      updatedAt: NOW,
      freezers: [],
      containers: [],
    });
    expect(parsed.containers).toEqual([]);
  });

  it('remember a new kind, trimmed, and hand back the same config for one they have or a blank', () => {
    expect(ok(rememberContainer(config([], ['Box']), ' Tub ', LATER))).toEqual({
      ...config([], ['Box', 'Tub']),
      updatedAt: LATER,
    });
    const before = config([], ['Deli pot']);
    for (const typed of ['deli POT', ' ', null]) {
      expect(ok(rememberContainer(before, typed, LATER))).toBe(before);
    }
  });

  it('forget a kind matched in any case, leaving the suppliers alone', () => {
    expect(
      ok(forgetContainer(config(['Booths'], ['Box', 'Bag']), { container: 'box', now: LATER })),
    ).toEqual({ ...config(['Booths'], ['Bag']), updatedAt: LATER });
    const before = config([], ['Bag']);
    expect(ok(forgetContainer(before, { container: 'Box', now: LATER }))).toBe(before);
  });

  it('are offered alphabetically, narrowed by what is typed, and saved in their remembered spelling', () => {
    const list = config([], ['Vacuum bag', 'Box', 'Bag']);
    expect(containerSuggestions(list, '')).toEqual(['Bag', 'Box', 'Vacuum bag']);
    expect(containerSuggestions(list, 'BAG')).toEqual(['Bag', 'Vacuum bag']);
    expect(containerSpelling(list, ' vacuum BAG ')).toBe('Vacuum bag');
    expect(containerSpelling(list, ' Tub ')).toBe('Tub');
    expect(containerSpelling(list, '')).toBeNull();
  });
});
