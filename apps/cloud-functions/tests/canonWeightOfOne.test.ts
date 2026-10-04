import { describe, expect, it } from 'vitest';

import {
  planWeightOfOneWrites,
  proposalsFor,
  weightOfOneTargets,
} from '../scripts/lib/canonWeightOfOne.js';

// The pure half of scripts/fill-canon-weight-of-one.ts (issue #1643, Phase 4).
// The script reaches Firestore and Gemini at import time, so this exercises the
// only part a test can reach (docs/one-shot-scripts.md §2).

describe('weightOfOneTargets', () => {
  it('asks about counted items with no weight of one, and nothing else', () => {
    const targets = weightOfOneTargets([
      { id: 'onion', name: 'Red Onion', unit: 'count' },
      { id: 'egg', name: 'Egg', unit: 'count', gramsPerItem: 50 },
      { id: 'flour', name: 'Plain Flour', unit: 'g' },
      { id: 'fennel', name: 'Fennel' },
      { id: 'lemon', name: 'Lemon', unit: 'count' },
    ]);
    expect(targets).toEqual([
      { id: 'lemon', name: 'Lemon' },
      { id: 'onion', name: 'Red Onion' },
    ]);
  });

  it('treats a non-positive stored weight as none, as the shopping list does', () => {
    expect(weightOfOneTargets([{ id: 'x', name: 'X', unit: 'count', gramsPerItem: 0 }])).toEqual([
      { id: 'x', name: 'X' },
    ]);
  });
});

describe('proposalsFor', () => {
  const targets = [
    { id: 'lemon', name: 'Lemon' },
    { id: 'onion', name: 'Red Onion' },
    { id: 'leaf', name: 'Bay Leaf' },
  ];

  it('names every target, answered or not, and refuses a non-positive answer', () => {
    expect(
      proposalsFor(targets, [
        { id: 'onion', gramsPerItem: 150 },
        { id: 'leaf', gramsPerItem: 0 },
        { id: 'not-asked', gramsPerItem: 99 },
      ]),
    ).toEqual([
      { id: 'lemon', name: 'Lemon', gramsPerItem: null },
      { id: 'onion', name: 'Red Onion', gramsPerItem: 150 },
      { id: 'leaf', name: 'Bay Leaf', gramsPerItem: null },
    ]);
  });
});

describe('planWeightOfOneWrites', () => {
  it('writes the reviewed value, and lets canon as it is NOW win over the plan', () => {
    const plan = planWeightOfOneWrites(
      [
        { id: 'onion', unit: 'count' },
        { id: 'lemon', unit: 'count', gramsPerItem: 120 }, // set in admin since the dry run
        { id: 'fennel', unit: 'g' }, // no longer counted
        { id: 'leaf', unit: 'count' },
      ],
      [
        { id: 'onion', name: 'Red Onion', gramsPerItem: 150 },
        { id: 'lemon', name: 'Lemon', gramsPerItem: 100 },
        { id: 'fennel', name: 'Fennel', gramsPerItem: 250 },
        { id: 'leaf', name: 'Bay Leaf', gramsPerItem: null },
        { id: 'gone', name: 'Deleted', gramsPerItem: 10 },
      ],
    );
    expect(plan.write).toEqual([{ id: 'onion', name: 'Red Onion', gramsPerItem: 150 }]);
    expect(plan.skip.map((s) => [s.id, s.reason])).toEqual([
      ['lemon', 'already-set'],
      ['fennel', 'not-counted'],
      ['leaf', 'no-proposal'],
      ['gone', 'gone'],
    ]);
  });

  it('refuses a hand-edited plan value that is not a positive number — a quoted "150" included', () => {
    const typed = JSON.parse('[{"id":"onion","name":"Red Onion","gramsPerItem":"150"}]') as [];
    for (const proposals of [[{ id: 'onion', name: 'Red Onion', gramsPerItem: -5 }], typed]) {
      const plan = planWeightOfOneWrites([{ id: 'onion', unit: 'count' }], proposals);
      expect(plan.write).toEqual([]);
      expect(plan.skip[0]?.reason).toBe('no-proposal');
    }
  });
});
