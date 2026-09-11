import { describe, it, expect } from 'vitest';
import { recipeChangedSince } from '../../src/index.js';

// The batch's staleness comparison (issue #1327) — an ORDERING, where
// `hasRecipeChanged` is an inequality. The distinction is the whole reason this
// function exists: a batch stamps no `recipeUpdatedAtAtStart`, so handing
// `hasRecipeChanged` a batch's `createdAt` would flag every run ever started.

const STARTED = '2026-09-11T06:00:00.000Z';

describe('recipeChangedSince', () => {
  it('is true only when the recipe was written AFTER the run started', () => {
    expect(recipeChangedSince(STARTED, '2026-09-11T07:30:00.000Z')).toBe(true);
    expect(recipeChangedSince(STARTED, '2026-09-10T22:00:00.000Z')).toBe(false);
  });

  it('is false for a recipe last written at the instant the run started', () => {
    // The ordinary case: `freezeBatch` stamps `createdAt` from the same clock that
    // has just read the recipe, and an equal stamp is not a change.
    expect(recipeChangedSince(STARTED, STARTED)).toBe(false);
  });

  it('is false while either side is still unknown', () => {
    // The banner must not flash as the stores resolve, and a deleted recipe is not
    // an edited one.
    expect(recipeChangedSince(null, '2026-09-11T07:30:00.000Z')).toBe(false);
    expect(recipeChangedSince(undefined, '2026-09-11T07:30:00.000Z')).toBe(false);
    expect(recipeChangedSince(STARTED, null)).toBe(false);
    expect(recipeChangedSince(STARTED, undefined)).toBe(false);
  });

  it('orders across a day, a month and a year boundary', () => {
    // ISO-8601 UTC strings order lexically — the property the comparison rests on.
    expect(recipeChangedSince('2026-09-11T23:59:00.000Z', '2026-09-12T00:01:00.000Z')).toBe(true);
    expect(recipeChangedSince('2026-09-30T23:59:00.000Z', '2026-10-01T00:01:00.000Z')).toBe(true);
    expect(recipeChangedSince('2026-12-31T23:59:00.000Z', '2027-01-01T00:01:00.000Z')).toBe(true);
    expect(recipeChangedSince('2027-01-01T00:01:00.000Z', '2026-12-31T23:59:00.000Z')).toBe(false);
  });
});
