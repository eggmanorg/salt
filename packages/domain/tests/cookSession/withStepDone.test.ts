import { describe, it, expect } from 'vitest';
import { withStepDone } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';

// Guided-step completion (issue #556). Immutable, and a no-op returns the SAME
// reference so the caller can skip a pointless Firestore write.

function session(completedStepIds: string[]): CookSessionDoc {
  return {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    serveAt: null,
    servings: null,
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    checkedIngredientIds: ['ing-1'],
    checkedPrepIds: [],
    completedStepIds,
    activeTimers: [
      {
        id: 's1',
        stepId: 's1',
        label: null,
        durationMinutes: null,
        endsAt: '2026-07-22T18:35:00.000Z',
        notify: true,
      },
    ],
    createdAt: '2026-07-22T18:30:00.000Z',
    updatedAt: '2026-07-22T18:30:00.000Z',
  };
}

describe('withStepDone', () => {
  // [starting completed ids, step id, done, expected completed ids]
  const cases: Array<[string[], string, boolean, string[]]> = [
    [[], 's1', true, ['s1']],
    [['s1'], 's2', true, ['s1', 's2']],
    [['s1', 's2'], 's3', true, ['s1', 's2', 's3']],
    [['s1'], 's1', false, []],
    [['s1', 's2', 's3'], 's2', false, ['s1', 's3']],
    // Unticking a step that was never ticked leaves the list alone.
    [['s1'], 's9', false, ['s1']],
    // Out-of-order completion is allowed — steps are never a gate.
    [['s3'], 's1', true, ['s3', 's1']],
  ];

  it.each(cases)('%j + (%s → done=%s) = %j', (start, stepId, done, expected) => {
    expect(withStepDone(session(start), stepId, done).completedStepIds).toEqual(expected);
  });

  it('appends in completion order, not recipe order', () => {
    // The order is a record of what the cook actually did; recipe order is
    // reimposed by the queries that need it.
    const result = withStepDone(withStepDone(session([]), 's3', true), 's1', true);
    expect(result.completedStepIds).toEqual(['s3', 's1']);
  });

  it('returns the SAME session when the step is already done', () => {
    const s = session(['s1']);
    expect(withStepDone(s, 's1', true)).toBe(s);
  });

  it('returns the SAME session when the step is already not done', () => {
    const s = session(['s1']);
    expect(withStepDone(s, 's2', false)).toBe(s);
  });

  it('returns a NEW session whenever completion actually changes', () => {
    const s = session([]);
    expect(withStepDone(s, 's1', true)).not.toBe(s);
  });

  it('is pure — never mutates the input session', () => {
    const s = session(['s1']);
    const before = [...s.completedStepIds];
    withStepDone(s, 's2', true);
    withStepDone(s, 's1', false);
    expect(s.completedStepIds).toEqual(before);
  });

  it('does not stamp updatedAt — the persistence seam owns that', () => {
    const s = session([]);
    expect(withStepDone(s, 's1', true).updatedAt).toBe(s.updatedAt);
  });

  it('leaves every other field untouched', () => {
    const s = session([]);
    const next = withStepDone(s, 's1', true);
    expect(next.checkedIngredientIds).toEqual(s.checkedIngredientIds);
    expect(next.activeTimers).toEqual(s.activeTimers);
    expect(next.recipeUpdatedAtAtStart).toBe(s.recipeUpdatedAtAtStart);
    expect(next.createdAt).toBe(s.createdAt);
  });
});
