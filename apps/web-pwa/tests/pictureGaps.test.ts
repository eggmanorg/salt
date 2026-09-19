import { describe, it, expect } from 'vitest';
import type { EquipmentItem, KitLabelSource } from '@salt/domain';
import type { EquipmentIconDoc, KitchenToolDoc } from '@salt/domain/schemas';
import { pictureGapCount } from '../src/lib/pictureGaps.js';

// The Admin badge's third summand (issue #1458, Phase 1). The arithmetic is the
// thing worth pinning: the badge is the only place in the app where two
// unrelated backlogs are added together, and the number is what tells somebody a
// gap exists at all.

function item(id: string, name: string, overrides: Partial<EquipmentItem> = {}): EquipmentItem {
  return {
    id,
    schemaVersion: 1,
    name,
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
    subjectBrief: 'A brief.',
    briefSourceName: 'A record',
    thumbnail: null,
    ...overrides,
  };
}

function tool(id: string, label: string, matchers: string[] = []): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail: `https://example.test/${id}.webp`,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  };
}

function recipe(...labels: string[]): KitLabelSource {
  return { kit: labels.map((label) => ({ label, equipment: null })) };
}

describe('pictureGapCount', () => {
  it('is zero when nothing is missing a picture', () => {
    expect(
      pictureGapCount(
        [item('spin', 'Salad Spinner')],
        new Map([['spin', icon({ thumbnail: 'https://example.test/spin.webp' })]]),
        [recipe('Mixing bowl')],
        [tool('mixing-bowl', 'Mixing bowl')],
      ),
    ).toBe(0);
  });

  it('counts a record with nothing drawn for it', () => {
    expect(
      pictureGapCount(
        [item('spin', 'Salad Spinner'), item('cas', 'Casseroles and Braising Dishes')],
        new Map([['spin', icon()]]),
        [],
        [],
      ),
    ).toBe(2);
  });

  it('counts a kit label the vocabulary cannot answer', () => {
    expect(
      pictureGapCount(
        [],
        new Map(),
        [recipe('Tagine'), recipe('Tagine', 'Mixing bowl')],
        [tool('mixing-bowl', 'Mixing bowl')],
      ),
    ).toBe(1);
  });

  it('adds the two backlogs together', () => {
    expect(
      pictureGapCount(
        [item('spin', 'Salad Spinner')],
        new Map([['spin', icon()]]),
        [recipe('Tagine', 'Heatproof bowl')],
        [],
      ),
    ).toBe(3);
  });

  // The two halves can never name the same thing: `unresolvedKitLabels` excludes
  // a label that resolves to one of the household's records, so a record with no
  // drawing is counted once as a record and never again as a word.
  it('does not count an undrawn record twice when a recipe also names it', () => {
    expect(
      pictureGapCount(
        [item('spin', 'Salad Spinner')],
        new Map([['spin', icon()]]),
        [recipe('Salad Spinner')],
        [],
      ),
    ).toBe(1);
  });

  it('does not count a hidden picture or a borrowed one', () => {
    expect(
      pictureGapCount(
        [
          item('spin', 'Salad Spinner'),
          item('pan', 'Frying Pans', {
            borrowedPicture: { family: 'kitchenTool', id: 'frying-pan' },
          }),
        ],
        new Map([
          ['spin', icon({ thumbnail: 'hidden' })],
          ['pan', icon()],
        ]),
        [],
        [],
      ),
    ).toBe(0);
  });

  // THE STATED BOUNDARY, checked in the only way it can be: a guided plan's
  // container fields are not an input at all, so a gap only a plan names cannot
  // reach this number. It is a floor, not a total — see `pictureGaps.ts`'s header
  // for why buying a whole-collection read on every admin's boot is not worth the
  // difference. This assertion goes red the moment a plans argument is added
  // without that paragraph being revisited.
  it('takes no guided plans, so a plan-only gap can never reach the badge', () => {
    expect(pictureGapCount).toHaveLength(4);
  });
});
