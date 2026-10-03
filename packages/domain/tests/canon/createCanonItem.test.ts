import { describe, it, expect } from 'vitest';
import { createCanonItem } from '@salt/domain';
import { ErrorCode } from '@salt/shared-types';
import type { IdGenerator } from '../../src/canon/index.js';

function counterIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return {
    newCanonId: () => `${prefix}-${++n}`,
    newAisleId: () => `aisle-${++n}`,
  };
}

describe('createCanonItem', () => {
  it('returns Success with a CanonItem when name is valid', () => {
    const result = createCanonItem({ name: '  Tomato  ' }, counterIds());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value).toEqual({
      id: 'id-1',
      schemaVersion: 5,
      name: 'Tomato',
      synonyms: [],
      aisleId: null,
      thumbnail: null,
      embedding: null,
      needs_approval: true,
      shoppingBehavior: 'needed',
      // Seeded because the item lands flagged (issue #193). No rawInput: none
      // was supplied, so there is nothing that differs from the name.
      pendingChanges: [{ kind: 'created' }],
      updatedAt: '',
    });
  });

  // Issue #193 — "this item is brand new" must be recorded, and distinguishable
  // from an existing item that merely gained a synonym.
  describe('pendingChanges seeding', () => {
    it('seeds a created entry when the item lands flagged', () => {
      const result = createCanonItem({ name: 'Tomatoes' }, counterIds());
      expect(result.kind === 'ok' && result.value.pendingChanges).toEqual([{ kind: 'created' }]);
    });

    it('seeds NO entry when the item is created already-approved', () => {
      const result = createCanonItem({ name: 'Tomatoes', needs_approval: false }, counterIds());
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      // Key omitted entirely — never an empty array.
      expect(result.value.pendingChanges).toBeUndefined();
      expect('pendingChanges' in result.value).toBe(false);
    });

    it('carries rawInput when the raw entry differs from the name', () => {
      const result = createCanonItem(
        { name: 'Tomatoes', rawInput: '2 tins chopped toms' },
        counterIds(),
      );
      expect(result.kind === 'ok' && result.value.pendingChanges).toEqual([
        { kind: 'created', rawInput: '2 tins chopped toms' },
      ]);
    });

    it('omits rawInput when it is literally the name', () => {
      const result = createCanonItem({ name: 'Tomatoes', rawInput: 'Tomatoes' }, counterIds());
      expect(result.kind === 'ok' && result.value.pendingChanges).toEqual([{ kind: 'created' }]);
    });

    it('omits rawInput when it differs only by surrounding whitespace', () => {
      const result = createCanonItem({ name: '  Tomatoes ', rawInput: 'Tomatoes  ' }, counterIds());
      expect(result.kind === 'ok' && result.value.pendingChanges).toEqual([{ kind: 'created' }]);
    });
  });

  it('uses the IdGenerator for the new id', () => {
    const ids = counterIds('canon');
    const a = createCanonItem({ name: 'Tomato' }, ids);
    const b = createCanonItem({ name: 'Onion' }, ids);
    expect(a.kind === 'ok' && a.value.id).toBe('canon-1');
    expect(b.kind === 'ok' && b.value.id).toBe('canon-2');
  });

  it('trims and drops empty synonyms', () => {
    const result = createCanonItem(
      { name: 'Tomato', synonyms: [' tom ', '', '   ', 'tomate'] },
      counterIds(),
    );
    expect(result.kind === 'ok' && result.value.synonyms).toEqual(['tom', 'tomate']);
  });

  it('preserves aisleId when supplied', () => {
    const result = createCanonItem({ name: 'Tomato', aisleId: 'produce' }, counterIds());
    expect(result.kind === 'ok' && result.value.aisleId).toBe('produce');
  });

  it('returns Failure with INVALID_CANON_NAME when name is blank', () => {
    const result = createCanonItem({ name: '   ' }, counterIds());
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_CANON_NAME,
    });
  });

  it('returns Failure when name is empty', () => {
    const result = createCanonItem({ name: '' }, counterIds());
    expect(result.kind === 'err' && result.error.kind).toBe('ValidationError');
  });

  it('defaults shoppingBehavior to "needed" when not supplied', () => {
    const result = createCanonItem({ name: 'Tomato' }, counterIds());
    expect(result.kind === 'ok' && result.value.shoppingBehavior).toBe('needed');
  });

  it('uses supplied shoppingBehavior when provided', () => {
    const result = createCanonItem({ name: 'Salt', shoppingBehavior: 'stocked' }, counterIds());
    expect(result.kind === 'ok' && result.value.shoppingBehavior).toBe('stocked');
  });

  it('accepts "check" as shoppingBehavior', () => {
    const result = createCanonItem({ name: 'Flour', shoppingBehavior: 'check' }, counterIds());
    expect(result.kind === 'ok' && result.value.shoppingBehavior).toBe('check');
  });

  it('omits largeQuantityThreshold when not supplied', () => {
    const result = createCanonItem({ name: 'Salt' }, counterIds());
    expect(result.kind === 'ok' && result.value).not.toHaveProperty('largeQuantityThreshold');
  });

  it('sets largeQuantityThreshold when supplied', () => {
    const result = createCanonItem({ name: 'Flour', largeQuantityThreshold: 500 }, counterIds());
    expect(result.kind === 'ok' && result.value.largeQuantityThreshold).toBe(500);
  });

  it('sets the weight of one when supplied (issue #1643)', () => {
    const result = createCanonItem(
      { name: 'Onion', unit: 'count', gramsPerItem: 150 },
      counterIds(),
    );
    expect(result.kind === 'ok' && result.value.gramsPerItem).toBe(150);
  });
});
