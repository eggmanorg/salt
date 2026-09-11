import { describe, it, expect } from 'vitest';
import { withIngredientChecked, withAllIngredientsChecked, withGroupChecked } from '@salt/domain';
import type { CookSessionDoc, IngredientGroupDoc } from '@salt/domain/schemas';

// Mise-en-place tick state (issue #556): the single toggle, the symmetric
// whole-recipe bulk tick, and the section-scoped one. All immutable, none of them
// stamp `updatedAt`.

function session(checkedIngredientIds: string[]): CookSessionDoc {
  return {
    id: 'r1_u1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: 'r1',
    serveAt: null,
    servings: null,
    recipeUpdatedAtAtStart: '2026-07-01T09:00:00.000Z',
    checkedIngredientIds,
    checkedPrepIds: [],
    completedStepIds: ['s1'],
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

describe('withIngredientChecked', () => {
  // [starting checked ids, toggled id, expected checked ids]
  const cases: Array<[string[], string, string[]]> = [
    [[], 'i1', ['i1']],
    [['i1'], 'i2', ['i1', 'i2']],
    [['i1'], 'i1', []],
    [['i1', 'i2', 'i3'], 'i2', ['i1', 'i3']],
    [['i1', 'i2'], 'i3', ['i1', 'i2', 'i3']],
  ];

  it.each(cases)('%j toggled by %s = %j', (start, id, expected) => {
    expect(withIngredientChecked(session(start), id).checkedIngredientIds).toEqual(expected);
  });

  it('round-trips: toggling the same id twice restores the original set', () => {
    const s = session(['i1', 'i2']);
    const there = withIngredientChecked(s, 'i3');
    const back = withIngredientChecked(there, 'i3');
    expect(back.checkedIngredientIds).toEqual(s.checkedIngredientIds);
  });

  it('is pure — never mutates the input session', () => {
    const s = session(['i1']);
    withIngredientChecked(s, 'i2');
    withIngredientChecked(s, 'i1');
    expect(s.checkedIngredientIds).toEqual(['i1']);
  });

  it('returns a new session and leaves updatedAt / step state alone', () => {
    const s = session([]);
    const next = withIngredientChecked(s, 'i1');
    expect(next).not.toBe(s);
    expect(next.updatedAt).toBe(s.updatedAt);
    expect(next.completedStepIds).toEqual(s.completedStepIds);
    expect(next.activeTimers).toEqual(s.activeTimers);
  });
});

describe('withAllIngredientsChecked', () => {
  const ALL = ['i1', 'i2', 'i3'];

  it('ticks everything when not everything is currently ticked', () => {
    expect(withAllIngredientsChecked(session(['i1']), ALL, false).checkedIngredientIds).toEqual(
      ALL,
    );
  });

  it('clears everything when everything is currently ticked (symmetric)', () => {
    expect(withAllIngredientsChecked(session(ALL), ALL, true).checkedIngredientIds).toEqual([]);
  });

  it('ticks from an empty start', () => {
    expect(withAllIngredientsChecked(session([]), ALL, false).checkedIngredientIds).toEqual(ALL);
  });

  it('replaces rather than merges — stale ids for deleted ingredients are dropped', () => {
    // 'gone' refers to an ingredient edited out of the recipe since the session
    // started; a bulk tick is a clean rewrite of the whole set.
    const next = withAllIngredientsChecked(session(['gone']), ALL, false);
    expect(next.checkedIngredientIds).toEqual(ALL);
    expect(next.checkedIngredientIds).not.toContain('gone');
  });

  it('copies the id list instead of aliasing the caller’s array', () => {
    const allIds = [...ALL];
    const next = withAllIngredientsChecked(session([]), allIds, false);
    expect(next.checkedIngredientIds).not.toBe(allIds);
  });

  it('is pure — never mutates the input session', () => {
    const s = session(['i1']);
    withAllIngredientsChecked(s, ALL, false);
    expect(s.checkedIngredientIds).toEqual(['i1']);
  });

  it('does not stamp updatedAt', () => {
    const s = session([]);
    expect(withAllIngredientsChecked(s, ALL, false).updatedAt).toBe(s.updatedAt);
  });
});

describe('withGroupChecked', () => {
  function group(id: string, itemIds: string[]): IngredientGroupDoc {
    return {
      id,
      name: id,
      items: itemIds.map((itemId) => ({
        id: itemId,
        rawText: itemId,
        parsed: null,
        canonId: null,
        matchState: 'matched' as const,
        isOptional: false,
        firstUsedInStepId: null,
      })),
    };
  }

  const SAUCE = group('sauce', ['s1', 's2']);

  it('ticks every ingredient in the group', () => {
    expect(withGroupChecked(session([]), SAUCE, true).checkedIngredientIds).toEqual(['s1', 's2']);
  });

  it('clears every ingredient in the group', () => {
    expect(withGroupChecked(session(['s1', 's2']), SAUCE, false).checkedIngredientIds).toEqual([]);
  });

  // The whole point of a per-section control: the sections you are not touching keep
  // their ticks, in both directions. `withAllIngredientsChecked` cannot do this — it
  // rewrites the entire set.
  it('leaves the other sections’ ticks alone when ticking', () => {
    const next = withGroupChecked(session(['p1']), SAUCE, true);
    expect(next.checkedIngredientIds).toEqual(['p1', 's1', 's2']);
  });

  it('leaves the other sections’ ticks alone when clearing', () => {
    const next = withGroupChecked(session(['p1', 's1', 's2']), SAUCE, false);
    expect(next.checkedIngredientIds).toEqual(['p1']);
  });

  it('cannot duplicate an id when a partly-ticked group is ticked', () => {
    const next = withGroupChecked(session(['s2']), SAUCE, true);
    expect(next.checkedIngredientIds).toEqual(['s1', 's2']);
  });

  it('keeps a stale id for an ingredient edited out of the recipe', () => {
    // Unlike the whole-recipe rewrite, this is a targeted set operation: an id the
    // group no longer contains is none of its business either way.
    expect(withGroupChecked(session(['gone']), SAUCE, false).checkedIngredientIds).toEqual([
      'gone',
    ]);
  });

  it('is a no-op set-wise for an empty group', () => {
    expect(
      withGroupChecked(session(['s1']), group('empty', []), true).checkedIngredientIds,
    ).toEqual(['s1']);
  });

  it('is pure — never mutates the input session', () => {
    const s = session(['i1']);
    withGroupChecked(s, SAUCE, true);
    withGroupChecked(s, SAUCE, false);
    expect(s.checkedIngredientIds).toEqual(['i1']);
  });

  it('returns a new session and does not stamp updatedAt', () => {
    const s = session([]);
    const next = withGroupChecked(s, SAUCE, true);
    expect(next).not.toBe(s);
    expect(next.updatedAt).toBe(s.updatedAt);
    expect(next.completedStepIds).toEqual(s.completedStepIds);
    expect(next.activeTimers).toEqual(s.activeTimers);
  });
});
