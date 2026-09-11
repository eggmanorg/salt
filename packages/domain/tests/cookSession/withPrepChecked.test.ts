import { describe, it, expect } from 'vitest';
import { withPrepChecked } from '@salt/domain';
import type { CookSessionDoc } from '@salt/domain/schemas';

// Guided-cook prep tick state (issue #751, Phase 2). Deliberately the same suite
// `withIngredientChecked` gets in miseProducers.test.ts, against the other list —
// including the two properties that matter most for a doc with no TTL: a stale id
// for a row that has since gone survives, and the id list is copied rather than
// aliased.

function session(checkedPrepIds: string[]): CookSessionDoc {
  return {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    serveAt: null,
    servings: null,
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    checkedIngredientIds: ['i1'],
    checkedPrepIds,
    completedStepIds: ['s1'],
    activeTimers: [
      {
        id: 's1',
        stepId: 's1',
        label: null,
        durationMinutes: null,
        endsAt: '2026-08-08T18:35:00.000Z',
        notify: true,
      },
    ],
    createdAt: '2026-08-08T18:30:00.000Z',
    updatedAt: '2026-08-08T18:30:00.000Z',
  };
}

describe('withPrepChecked', () => {
  // [starting checked ids, toggled id, expected checked ids]
  const cases: Array<[string[], string, string[]]> = [
    [[], 'p1', ['p1']],
    [['p1'], 'p2', ['p1', 'p2']],
    [['p1'], 'p1', []],
    [['p1', 'p2', 'p3'], 'p2', ['p1', 'p3']],
    [['p1', 'p2'], 'p3', ['p1', 'p2', 'p3']],
  ];

  it.each(cases)('%j toggled by %s = %j', (start, id, expected) => {
    expect(withPrepChecked(session(start), id).checkedPrepIds).toEqual(expected);
  });

  it('round-trips: toggling the same id twice restores the original set', () => {
    const s = session(['p1', 'p2']);
    const there = withPrepChecked(s, 'p3');
    const back = withPrepChecked(there, 'p3');
    expect(back.checkedPrepIds).toEqual(s.checkedPrepIds);
  });

  it('is pure — never mutates the input session', () => {
    const s = session(['p1']);
    withPrepChecked(s, 'p2');
    withPrepChecked(s, 'p1');
    expect(s.checkedPrepIds).toEqual(['p1']);
  });

  it('returns a new session and leaves updatedAt / every other list alone', () => {
    const s = session([]);
    const next = withPrepChecked(s, 'p1');
    expect(next).not.toBe(s);
    expect(next.updatedAt).toBe(s.updatedAt);
    // The two tick lists are separate facts: ticking a prep job must never be
    // mistaken for having the ingredient on the bench, or the other way round.
    expect(next.checkedIngredientIds).toEqual(s.checkedIngredientIds);
    expect(next.completedStepIds).toEqual(s.completedStepIds);
    expect(next.activeTimers).toEqual(s.activeTimers);
  });

  it('keeps a stale id for a prep entry the plan no longer has', () => {
    const next = withPrepChecked(session(['gone', 'p1']), 'p2');
    expect(next.checkedPrepIds).toEqual(['gone', 'p1', 'p2']);
  });

  it('cannot duplicate an id', () => {
    const next = withPrepChecked(withPrepChecked(session([]), 'p1'), 'p1');
    expect(next.checkedPrepIds).toEqual([]);
  });

  it('copies the id list instead of aliasing the caller-s array', () => {
    const start: string[] = [];
    const s = session(start);
    const next = withPrepChecked(s, 'p1');
    expect(next.checkedPrepIds).not.toBe(start);
    expect(start).toEqual([]);
  });
});
