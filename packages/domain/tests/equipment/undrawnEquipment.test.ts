import { describe, it, expect } from 'vitest';
import { undrawnEquipment } from '../../src/index.js';
import type { EquipmentItem } from '../../src/index.js';
import type { EquipmentIconDoc } from '../../src/schemas/equipmentIcon.js';

// The backlog half of `equipmentIcons` (issue #1458, Phase 1): which records have
// no picture at all. Every case here is one of the four states the header
// enumerates — nothing drawn, drawn, hidden, borrowed — plus the boundary it
// admits to: a borrow is a reference, never resolved, so a record pointed at a
// drawing that is hidden, or at a record since removed, reads as "has a picture"
// here regardless.

function item(overrides: Partial<EquipmentItem> = {}): EquipmentItem {
  return {
    id: 'eq-1',
    schemaVersion: 1,
    name: 'Salad Spinner',
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

function icon(overrides: Partial<EquipmentIconDoc> = {}): EquipmentIconDoc {
  return {
    subjectBrief: 'A plastic salad spinner with a crank lid.',
    briefSourceName: 'Salad Spinner',
    thumbnail: null,
    ...overrides,
  };
}

function icons(entries: Record<string, EquipmentIconDoc>): Map<string, EquipmentIconDoc> {
  return new Map(Object.entries(entries));
}

describe('undrawnEquipment', () => {
  it('reports a record whose description was authored but never drawn', () => {
    const spinner = item();
    expect(undrawnEquipment([spinner], icons({ 'eq-1': icon() }))).toEqual([spinner]);
  });

  it('reports a record with no icon document at all', () => {
    const spinner = item();
    expect(undrawnEquipment([spinner], new Map())).toEqual([spinner]);
  });

  it('does not report a record that has a drawing', () => {
    expect(
      undrawnEquipment(
        [item()],
        icons({ 'eq-1': icon({ thumbnail: 'https://example.test/eq-1.webp' }) }),
      ),
    ).toEqual([]);
  });

  // "Hidden" is an answer, not an omission. Counting it would put a row on the
  // Admin badge that no act can clear — Draw is the only un-hide there is, and
  // pressing it is exactly what the user declined.
  it('does not report a record whose picture was deliberately hidden', () => {
    expect(undrawnEquipment([item()], icons({ 'eq-1': icon({ thumbnail: 'hidden' }) }))).toEqual(
      [],
    );
  });

  // #1465 Phase 3: a thing can have a picture without one having been drawn for
  // it. A row that shows a picture is not missing one.
  it('does not report a record pointed at a picture that already exists', () => {
    expect(
      undrawnEquipment(
        [item({ borrowedPicture: { family: 'kitchenTool', id: 'salad-spinner' } })],
        icons({ 'eq-1': icon() }),
      ),
    ).toEqual([]);
  });

  it('reports a record whose borrow was withdrawn and nothing drawn since', () => {
    const spinner = item({ borrowedPicture: null });
    expect(undrawnEquipment([spinner], icons({ 'eq-1': icon() }))).toEqual([spinner]);
  });

  // THE STATED BOUNDARY, pinned as behaviour rather than asserted as a property.
  // A borrow is read as the presence of a reference, never resolved — so a record
  // pointed at an id nothing owns any more shows no picture and is not reported.
  // If this ever goes red, the query gained a resolution path and the header's
  // boundary paragraph is the thing to re-read.
  it('does NOT report a record whose borrowed picture no longer exists', () => {
    expect(
      undrawnEquipment(
        [item({ borrowedPicture: { family: 'equipment', id: 'deleted-record' } })],
        icons({ 'eq-1': icon() }),
      ),
    ).toEqual([]);
  });

  // THE SAME BOUNDARY, REACHED BY HIDE. `hideEquipmentIconFor` withdraws only
  // the borrow HELD BY the record being hidden — never the borrows POINTING AT
  // it. This query reads only `item.borrowedPicture`'s presence, so a borrower
  // of a now-hidden drawing still reads as "has a picture" here.
  it('does NOT report a record whose borrowed picture points at a now-hidden drawing', () => {
    expect(
      undrawnEquipment(
        [item({ borrowedPicture: { family: 'equipment', id: 'eq-hidden-source' } })],
        icons({ 'eq-1': icon(), 'eq-hidden-source': icon({ thumbnail: 'hidden' }) }),
      ),
    ).toEqual([]);
  });

  // AND IT IS NOT "ONE ROW": every borrower of the same hidden source goes
  // unreported at once, which is the header's corrected claim, not the original
  // "under-reports by one row".
  it('under-reports every borrower of a hidden source at once, not just one row', () => {
    const a = item({ id: 'a', borrowedPicture: { family: 'equipment', id: 'source' } });
    const b = item({ id: 'b', borrowedPicture: { family: 'equipment', id: 'source' } });
    expect(undrawnEquipment([a, b], icons({ source: icon({ thumbnail: 'hidden' }) }))).toEqual([]);
  });

  // ~140 entries exist and nothing is ever drawn for one automatically. A record
  // that has its own drawing is answered, whatever its entries lack.
  it('ignores entries entirely — an undrawn accessory is not a gap', () => {
    const magimix = item({
      id: 'eq-2',
      name: 'Magimix Cook Expert',
      accessories: [
        {
          id: 'acc-a',
          name: 'Thermo Bowl',
          owned: true,
          included: true,
          note: '',
          borrowedPicture: null,
        },
        {
          id: 'acc-b',
          name: 'Steam Basket',
          owned: true,
          included: true,
          note: '',
          borrowedPicture: null,
        },
      ],
    });
    expect(
      undrawnEquipment(
        [magimix],
        icons({ 'eq-2': icon({ thumbnail: 'https://example.test/eq-2.webp' }) }),
      ),
    ).toEqual([]);
  });

  it('preserves the order it was handed, so a sorted list stays sorted', () => {
    const a = item({ id: 'a', name: 'Apple corer' });
    const b = item({ id: 'b', name: 'Braising dish' });
    const c = item({ id: 'c', name: 'Casserole' });
    expect(
      undrawnEquipment(
        [a, b, c],
        icons({ b: icon({ thumbnail: 'https://example.test/b.webp' }) }),
      ).map((i) => i.id),
    ).toEqual(['a', 'c']);
  });

  it('is empty for an empty manifest', () => {
    expect(undrawnEquipment([], new Map())).toEqual([]);
  });
});
