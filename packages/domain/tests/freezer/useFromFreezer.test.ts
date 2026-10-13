import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import { commitDefrost, freezerStockFor } from '@salt/domain';
import type { Defrost, FreezerItem } from '@salt/domain';
import { DefrostSchema, defrostDocId } from '@salt/domain/schemas';

// Using a pack from the freezer instead of buying it (issue #1685).

const NOW = '2026-10-12T09:00:00.000Z';
const LATER = '2026-10-12T10:00:00.000Z';

const INPUT = {
  freezerNumber: 47,
  name: 'Pork loin',
  location: 'Garage · shelf B',
  recipeId: 'recipe-chilli',
  recipeTitle: 'Chilli',
  amount: 1,
  forDate: '2026-10-15',
};

function item(number: number, over: Partial<FreezerItem> = {}): FreezerItem {
  return {
    schemaVersion: 1,
    number,
    name: `Item ${number}`,
    freezerId: 'fz-garage',
    shelf: 'A',
    amount: 1,
    canonId: 'canon-pork',
    recipeId: null,
    purchasedFrom: null,
    addedAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('defrostDocId', () => {
  it('pads the number and names the recipe, or manual', () => {
    expect(defrostDocId(47, 'abc123')).toBe('047_abc123');
    expect(defrostDocId(12, null)).toBe('012_manual');
  });
});

describe('DefrostSchema', () => {
  it('reads a document written before #1696, with no forDate, as undated', () => {
    const { forDate: _omitted, ...legacy } = { schemaVersion: 1, ...INPUT, committedAt: NOW };

    const parsed = DefrostSchema.safeParse(legacy);

    expect(parsed.success && parsed.data.forDate).toBeNull();
  });
});

describe('commitDefrost', () => {
  it('creates the Kitchen item, valid against the schema', () => {
    const result = commitDefrost(null, INPUT, NOW);

    expect(result).toEqual({
      kind: 'ok',
      value: { schemaVersion: 1, ...INPUT, committedAt: NOW },
    });
    if (result.kind === 'ok') expect(DefrostSchema.safeParse(result.value).success).toBe(true);
  });

  it('sums the packs onto an existing item, keeping when it was first committed', () => {
    const existing: Defrost = { schemaVersion: 1, ...INPUT, amount: 2, committedAt: NOW };

    const result = commitDefrost(existing, { ...INPUT, location: 'Garage · shelf A' }, LATER);

    expect(result.kind === 'ok' && result.value).toMatchObject({
      amount: 3,
      committedAt: NOW,
      location: 'Garage · shelf A',
    });
  });

  // #1696: the night is fixed at commit, and a recommit's night replaces the
  // stored one — a stale night left on an un-ticked item must not capture a fresh
  // commit.
  it('stores the night the commit is for', () => {
    const result = commitDefrost(null, INPUT, NOW);

    expect(result.kind === 'ok' && result.value.forDate).toBe('2026-10-15');
  });

  it.each([
    ['a later night', '2026-10-22'],
    ['no night', null],
  ])('a recommit takes the new commit’s night: %s', (_label, forDate) => {
    const existing: Defrost = {
      schemaVersion: 1,
      ...INPUT,
      forDate: '2026-09-18',
      committedAt: NOW,
    };

    const result = commitDefrost(existing, { ...INPUT, forDate }, LATER);

    expect(result.kind === 'ok' && result.value.forDate).toBe(forDate);
  });

  it.each([0, -1, 1.5])('refuses %s packs', (amount) => {
    expect(commitDefrost(null, { ...INPUT, amount }, NOW)).toEqual({
      kind: 'err',
      error: { kind: 'ValidationError', code: ErrorCode.INVALID_FREEZER_AMOUNT },
    });
  });
});

describe('freezerStockFor', () => {
  it('matches the canon exactly', () => {
    const items = [item(1), item(2, { canonId: 'canon-pork-belly' }), item(3, { canonId: null })];

    expect(freezerStockFor(items, 'canon-pork').map((i) => i.number)).toEqual([1]);
  });

  it('leaves out an entry with nothing left to show', () => {
    const items = [item(1, { amount: 0 }), item(2, { amount: -1 }), item(3, { amount: 2 })];

    expect(freezerStockFor(items, 'canon-pork').map((i) => i.number)).toEqual([3]);
  });

  it('matches nothing for a row still matching', () => {
    expect(freezerStockFor([item(1, { canonId: null })], null)).toEqual([]);
  });

  it('lists the oldest first', () => {
    const items = [
      item(1, { addedAt: '2026-09-01T00:00:00.000Z' }),
      item(2, { addedAt: '2026-07-01T00:00:00.000Z' }),
    ];

    expect(freezerStockFor(items, 'canon-pork').map((i) => i.number)).toEqual([2, 1]);
  });
});
