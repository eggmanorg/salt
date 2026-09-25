import { describe, it, expect } from 'vitest';
import { equipmentIconAwaitingApproval } from '../../src/index.js';
import type { EquipmentIconDoc } from '../../src/schemas/index.js';

// `equipmentIconAwaitingApproval` is the whole of the equipment icon review
// gate's state (issue #877): derived from two names, never stored. These cases
// are the ones its doc comment names.

function icon(overrides: Partial<EquipmentIconDoc> = {}): EquipmentIconDoc {
  return {
    subjectBrief: 'A squat round food processor with a clear bowl and a single dial.',
    briefSourceName: 'Magimix Cook Expert',
    thumbnail: 'https://example.test/equipment-icons/eq-1.webp',
    sourceName: 'Magimix Cook Expert',
    iconRequestedAt: 1_758_000_000_000,
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('equipmentIconAwaitingApproval', () => {
  it('is false when there is no icon document (null)', () => {
    expect(equipmentIconAwaitingApproval(null)).toBe(false);
  });

  it('is false when there is no icon document (undefined)', () => {
    expect(equipmentIconAwaitingApproval(undefined)).toBe(false);
  });

  it('is true when the item has never been drawn — sourceName absent', () => {
    const { sourceName: _omitted, ...neverDrawn } = icon({ thumbnail: null });
    expect(equipmentIconAwaitingApproval(neverDrawn)).toBe(true);
  });

  it('is true when the item was renamed since the last draw', () => {
    expect(
      equipmentIconAwaitingApproval(
        icon({ briefSourceName: 'Magimix Cook Expert XL', sourceName: 'Magimix Cook Expert' }),
      ),
    ).toBe(true);
  });

  it('is false when the picture was drawn from the current brief', () => {
    expect(equipmentIconAwaitingApproval(icon())).toBe(false);
  });

  // The doc comment's "deliberately does NOT consider thumbnail": a renamed item
  // keeps its picture and still awaits approval, and a current one with no
  // picture (or a hidden one) does not.
  it('ignores thumbnail — every thumbnail state leaves the name comparison in charge', () => {
    for (const thumbnail of [null, 'hidden', 'https://example.test/x.webp']) {
      expect(equipmentIconAwaitingApproval(icon({ thumbnail }))).toBe(false);
      expect(
        equipmentIconAwaitingApproval(icon({ thumbnail, briefSourceName: 'Renamed kettle' })),
      ).toBe(true);
    }
  });
});
