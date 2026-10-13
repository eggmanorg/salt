import { describe, it, expect } from 'vitest';
import { kitchenTasks } from '../../src/index.js';
import type { Defrost } from '../../src/index.js';

// The projection behind Kitchen's To do (#1685), and the one the 09:00 push
// (#1683) scans. Under test: the night is the one STORED on the defrost at commit
// (#1696) and nothing else, the due date (the day before), undated cases, and the
// order. The night rule itself is `nextPlannedNight`'s, tested beside it.

const CHILLI = 'recipe-chilli';

function defrost(over: Partial<Defrost> = {}): Defrost {
  return {
    schemaVersion: 1,
    freezerNumber: 47,
    name: 'Pork loin',
    location: 'Garage · shelf B',
    recipeId: CHILLI,
    recipeTitle: 'Chilli',
    amount: 1,
    committedAt: '2026-06-08T09:00:00.000Z',
    forDate: '2026-06-11',
    ...over,
  };
}

describe('kitchenTasks', () => {
  it('is for the stored night, and due the day before', () => {
    const [task] = kitchenTasks({ defrosts: [defrost()] });

    expect(task?.id).toBe('defrost:047_recipe-chilli');
    expect(task?.forDate).toBe('2026-06-11');
    expect(task?.dueDate).toBe('2026-06-10');
  });

  it('takes no planner: its only input is the sources', () => {
    // The pin for "nothing re-dates on read": with no weeks and no today to read,
    // the stored night is the only date there is.
    expect(kitchenTasks.length).toBe(1);
  });

  it('a night already gone stays dated', () => {
    const [task] = kitchenTasks({ defrosts: [defrost({ forDate: '2026-05-01' })] });

    expect(task?.forDate).toBe('2026-05-01');
    expect(task?.dueDate).toBe('2026-04-30');
  });

  it('no stored night is undated — a hand-added row, or a recipe that was not planned', () => {
    const tasks = kitchenTasks({
      defrosts: [
        defrost({ recipeId: null, recipeTitle: null, forDate: null }),
        defrost({ freezerNumber: 12, forDate: null }),
      ],
    });

    expect(tasks.map((t) => [t.id, t.forDate, t.dueDate])).toEqual([
      ['defrost:012_recipe-chilli', null, null],
      ['defrost:047_manual', null, null],
    ]);
  });

  it('orders dated by due date, then undated by commit time, ties on id', () => {
    const defrosts = [
      defrost({
        freezerNumber: 3,
        recipeId: null,
        forDate: null,
        committedAt: '2026-06-08T12:00:00.000Z',
      }),
      defrost({
        freezerNumber: 2,
        recipeId: null,
        forDate: null,
        committedAt: '2026-06-08T08:00:00.000Z',
      }),
      defrost({
        freezerNumber: 1,
        recipeId: null,
        forDate: null,
        committedAt: '2026-06-08T08:00:00.000Z',
      }),
      defrost({ freezerNumber: 9, forDate: '2026-06-12' }),
      defrost({ freezerNumber: 8, recipeId: 'recipe-pie', forDate: '2026-06-10' }),
    ];

    const ids = kitchenTasks({ defrosts }).map((t) => t.id);

    expect(ids).toEqual([
      'defrost:008_recipe-pie',
      'defrost:009_recipe-chilli',
      'defrost:001_manual',
      'defrost:002_manual',
      'defrost:003_manual',
    ]);
  });

  it('a past night sorts first', () => {
    const defrosts = [
      defrost({ freezerNumber: 9, forDate: '2026-06-12' }),
      defrost({ freezerNumber: 4, forDate: '2026-05-01' }),
    ];

    const ids = kitchenTasks({ defrosts }).map((t) => t.id);

    expect(ids).toEqual(['defrost:004_recipe-chilli', 'defrost:009_recipe-chilli']);
  });
});
