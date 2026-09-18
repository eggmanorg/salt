import { describe, expect, it } from 'vitest';
import {
  resolveEquipmentItem,
  resolveKitEntryEquipment,
  resolveKitEntryItem,
} from '../../src/index.js';
import type { EquipmentItem } from '../../src/index.js';

// The link half of "which of your things is this?" (issue #1465).
//
// The property worth pinning here is the DEGRADATION, not the happy path: a link
// that no longer answers to anything must read exactly as no link at all, because
// that is the whole reason the manifest needs no cleanup job and no write back to
// recipes when something is deleted.

const MAGIMIX: EquipmentItem = {
  id: 'magimix',
  schemaVersion: 1,
  name: 'Magimix Cook Expert',
  kind: 'equipment',
  accessories: [
    {
      id: 'acc-thermo',
      name: 'Thermo Bowl',
      owned: true,
      included: true,
      note: '',
      borrowedPicture: null,
    },
    {
      id: 'acc-cocotte',
      name: 'Cocotte Slow Cook Pot',
      owned: true,
      included: false,
      note: '',
      borrowedPicture: null,
    },
  ],
  rules: [],
  note: '',
  environment: null,
  borrowedPicture: null,
  updatedAt: '',
};

const PANS: EquipmentItem = {
  id: 'pans',
  schemaVersion: 1,
  name: 'Frying Pans',
  kind: 'family',
  accessories: [
    {
      id: 'acc-tefal',
      name: 'Tefal non-stick 28cm',
      owned: true,
      included: false,
      note: '',
      borrowedPicture: null,
    },
  ],
  rules: [],
  note: '',
  environment: null,
  borrowedPicture: null,
  updatedAt: '',
};

const MANIFEST = [MAGIMIX, PANS];

describe('resolveKitEntryEquipment', () => {
  it('resolves a link naming the item itself', () => {
    const got = resolveKitEntryEquipment(
      { equipment: { itemId: 'magimix', accessoryId: null } },
      MANIFEST,
    );
    expect(got?.item.id).toBe('magimix');
    expect(got?.accessory).toBeNull();
  });

  it('resolves a link naming one of the item’s entries', () => {
    const got = resolveKitEntryEquipment(
      { equipment: { itemId: 'magimix', accessoryId: 'acc-thermo' } },
      MANIFEST,
    );
    expect(got?.item.id).toBe('magimix');
    expect(got?.accessory?.name).toBe('Thermo Bowl');
  });

  it('reaches a family member no rule over the words could find', () => {
    // The case the whole feature turns on. "Tefal non-stick 28cm" carries no word
    // of "Frying Pans", so the word resolver says nothing — correctly, and it
    // stays that way. The link is the only thing that can answer.
    expect(resolveEquipmentItem('Tefal non-stick 28cm', MANIFEST)).toBeNull();
    const got = resolveKitEntryEquipment(
      { equipment: { itemId: 'pans', accessoryId: 'acc-tefal' } },
      MANIFEST,
    );
    expect(got?.item.kind).toBe('family');
    expect(got?.accessory?.name).toBe('Tefal non-stick 28cm');
  });

  it('answers null for an entry with no link', () => {
    expect(resolveKitEntryEquipment({}, MANIFEST)).toBeNull();
    expect(resolveKitEntryEquipment({ equipment: null }, MANIFEST)).toBeNull();
  });

  it('answers null when the item has been deleted from the manifest', () => {
    expect(
      resolveKitEntryEquipment({ equipment: { itemId: 'gone', accessoryId: null } }, MANIFEST),
    ).toBeNull();
  });

  it('answers null when the ENTRY has been deleted, never the item instead', () => {
    // The stated choice: demoting to the item would have the row claim to BE the
    // appliance, which is a false statement rather than a missing one.
    const got = resolveKitEntryEquipment(
      { equipment: { itemId: 'magimix', accessoryId: 'acc-gone' } },
      MANIFEST,
    );
    expect(got).toBeNull();
  });

  it('answers null for an item carrying no accessories array', () => {
    // A partial item — a page fixture, a projection. Degrading to "names nothing"
    // costs one picture; throwing would take the whole row down.
    const partial = [{ id: 'magimix', name: 'Magimix Cook Expert' }] as unknown as EquipmentItem[];
    expect(
      resolveKitEntryEquipment(
        { equipment: { itemId: 'magimix', accessoryId: 'acc-thermo' } },
        partial,
      ),
    ).toBeNull();
  });

  it('answers null against an empty manifest — the cold-load reading', () => {
    expect(
      resolveKitEntryEquipment({ equipment: { itemId: 'magimix', accessoryId: null } }, []),
    ).toBeNull();
  });
});

describe('resolveKitEntryItem', () => {
  // The composed answer to "which of your things is this row" — the link,
  // falling back to the words. Review of #1482 (issue #1465): the picker was
  // branching on the link alone, so a row that names one of your things ONLY by
  // words — every unlinked stored recipe, until Phase 4 re-runs them — took the
  // "ordinary words" act although `kitIcons.ts` was already rendering it as one
  // of your things. This is the one function both now read through.

  it('prefers the link, exactly as resolveKitEntryEquipment does', () => {
    const got = resolveKitEntryItem(
      { label: 'anything at all', equipment: { itemId: 'magimix', accessoryId: 'acc-thermo' } },
      MANIFEST,
    );
    expect(got?.item.id).toBe('magimix');
    expect(got?.accessory?.name).toBe('Thermo Bowl');
  });

  it('falls back to the words when there is no link, unlike the link-only query', () => {
    expect(resolveKitEntryEquipment({}, MANIFEST)).toBeNull();
    const got = resolveKitEntryItem({ label: 'Magimix Cook Expert' }, MANIFEST);
    expect(got?.item.id).toBe('magimix');
    // A word match never names a specific accessory — only the resolver that
    // reads an id can do that.
    expect(got?.accessory).toBeNull();
  });

  it('falls back to the words when the recorded link no longer answers', () => {
    const got = resolveKitEntryItem(
      { label: 'Magimix Cook Expert', equipment: { itemId: 'gone', accessoryId: null } },
      MANIFEST,
    );
    expect(got?.item.id).toBe('magimix');
    expect(got?.accessory).toBeNull();
  });

  it('answers null when neither the link nor the words resolve', () => {
    expect(resolveKitEntryItem({ label: 'a wooden spoon' }, MANIFEST)).toBeNull();
  });

  it('still answers null for a family member no rule over the words could find', () => {
    // The case #1465 exists for: without a link, "Tefal non-stick 28cm" resolves
    // to nothing either way, and that is correct — the words alone cannot reach
    // a family member.
    expect(resolveKitEntryItem({ label: 'Tefal non-stick 28cm' }, MANIFEST)).toBeNull();
  });
});
