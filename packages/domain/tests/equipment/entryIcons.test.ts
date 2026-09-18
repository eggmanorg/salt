import { describe, it, expect } from 'vitest';
import { equipmentEntrySubjectName, equipmentIconOwnerIds } from '../../src/index.js';
import type { EquipmentItem } from '../../src/index.js';

// The two pure halves of "an entry may have a picture of its own" (issue #1465,
// Phase 2): which documents the icon collection may hold, and what words one
// entry's picture is described from.

function item(overrides: Partial<EquipmentItem> = {}): EquipmentItem {
  return {
    id: 'eq-1',
    schemaVersion: 1,
    name: 'Magimix Cook Expert',
    kind: 'equipment',
    accessories: [],
    rules: [],
    note: '',
    environment: null,
    borrowedPicture: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function accessory(id: string, name: string) {
  return { id, name, owned: true, included: true, note: '', borrowedPicture: null };
}

describe('equipmentIconOwnerIds', () => {
  // The property that matters: this set is the COMPLEMENT of what the manifest
  // trigger deletes, so an id missing from it is a picture destroyed.
  it('holds every item id and every entry id in the manifest', () => {
    const ids = equipmentIconOwnerIds([
      item({ id: 'eq-1', accessories: [accessory('acc-a', 'Thermo Bowl')] }),
      item({
        id: 'eq-2',
        kind: 'family',
        accessories: [accessory('acc-b', 'De Buyer 28cm'), accessory('acc-c', 'Tefal 28cm')],
      }),
    ]);
    expect([...ids].sort()).toEqual(['acc-a', 'acc-b', 'acc-c', 'eq-1', 'eq-2']);
  });

  it('is empty for an empty manifest, rather than holding anything by accident', () => {
    expect(equipmentIconOwnerIds([]).size).toBe(0);
  });

  // The `?? []` arm. A partial item must read as "no entries" on the path that
  // DELETES documents, never throw inside it.
  it('reads an item with no accessories array as owning only its own id', () => {
    expect([...equipmentIconOwnerIds([{ id: 'eq-9' }])]).toEqual(['eq-9']);
  });
});

describe('equipmentEntrySubjectName', () => {
  it("qualifies an appliance's part with the appliance", () => {
    expect(equipmentEntrySubjectName(item(), accessory('acc-a', 'Steam Basket'))).toBe(
      'Steam Basket (Magimix Cook Expert)',
    );
  });

  // A family's entry names a whole object. Attaching the family's name would tell
  // the text model it is looking at a category when it is looking at one pan.
  it('leaves a family member standing alone', () => {
    expect(
      equipmentEntrySubjectName(
        item({ kind: 'family', name: 'Frying Pans' }),
        accessory('acc-b', 'De Buyer Mineral B Carbon Steel 28cm'),
      ),
    ).toBe('De Buyer Mineral B Carbon Steel 28cm');
  });

  it('trims both halves rather than composing the whitespace in', () => {
    expect(
      equipmentEntrySubjectName(
        { name: '  Kenwood Chef  ', kind: 'equipment' },
        { name: ' Bowl ' },
      ),
    ).toBe('Bowl (Kenwood Chef)');
  });

  it('falls back to the record when the entry has no name of its own', () => {
    expect(equipmentEntrySubjectName(item(), accessory('acc-c', '   '))).toBe(
      'Magimix Cook Expert',
    );
  });

  it('falls back to the entry when the record has no name', () => {
    expect(
      equipmentEntrySubjectName({ name: '', kind: 'equipment' }, { name: 'Grill plate' }),
    ).toBe('Grill plate');
  });
});
