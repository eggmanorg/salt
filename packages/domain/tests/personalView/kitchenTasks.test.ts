import { describe, it, expect } from 'vitest';
import { kitchenTasks, emptyWeek, setDayRecipes, type MealPlanWeek } from '../../src/index.js';
import type { Defrost } from '../../src/index.js';

// The projection behind Kitchen's To do (#1685), and the one the 09:00 push
// (#1683) scans. Under test: the night (soonest planned, stored keys), the due
// date (the day before), undated cases, and the order.

const CHILLI = 'recipe-chilli';
const PIE = 'recipe-pie';

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
    ...over,
  };
}

// A Monday-start week with `recipeId` planned on each of `dates`.
function weekWith(start: string, recipeId: string, dates: string[]): MealPlanWeek {
  return dates.reduce((w, d) => setDayRecipes(w, d, [recipeId]), emptyWeek(start));
}

describe('kitchenTasks', () => {
  it('is for the soonest planned night from today on', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-09', '2026-06-13', '2026-06-11']);

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [week], '2026-06-10');

    expect(task?.forDate).toBe('2026-06-11');
    expect(task?.id).toBe('defrost:047_recipe-chilli');
  });

  it('a meal tomorrow is due today', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-11']);

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [week], '2026-06-10');

    expect(task?.dueDate).toBe('2026-06-10');
  });

  it('a meal today was due yesterday — and still shows', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-10']);

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [week], '2026-06-10');

    expect(task?.forDate).toBe('2026-06-10');
    expect(task?.dueDate).toBe('2026-06-09');
  });

  it('a recipe planned only on nights already gone is undated, and stays', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-09']);

    const tasks = kitchenTasks({ defrosts: [defrost()] }, [week], '2026-06-10');

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.forDate).toBeNull();
    expect(tasks[0]?.dueDate).toBeNull();
  });

  it('a recipe planned nowhere is undated', () => {
    const week = weekWith('2026-06-08', PIE, ['2026-06-11']);

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [week], '2026-06-10');

    expect(task?.forDate).toBeNull();
  });

  it('a hand-added row is undated', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-11']);

    const [task] = kitchenTasks(
      { defrosts: [defrost({ recipeId: null, recipeTitle: null })] },
      [week],
      '2026-06-10',
    );

    expect(task?.id).toBe('defrost:047_manual');
    expect(task?.forDate).toBeNull();
    expect(task?.dueDate).toBeNull();
  });

  it('a "make it yourself" producer, never in recipeIds, is undated', () => {
    // The lasagne is planned; the ragù that goes into it is not, and the planner
    // never holds a producer's id.
    const week = weekWith('2026-06-08', 'recipe-lasagne', ['2026-06-11']);

    const [task] = kitchenTasks(
      { defrosts: [defrost({ recipeId: 'recipe-ragu', recipeTitle: 'Ragù' })] },
      [week],
      '2026-06-10',
    );

    expect(task?.forDate).toBeNull();
  });

  it('reads the keys a week STORES, not the ones its start implies', () => {
    // Written when the cycle started on Friday; `startDate` now says Monday. The
    // stored Saturday key is outside the computed cycle and must still be found.
    const written = weekWith('2026-06-05', CHILLI, ['2026-06-06']);
    const relabelled: MealPlanWeek = { ...written, id: '2026-06-08', startDate: '2026-06-08' };

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [relabelled], '2026-06-05');

    expect(task?.forDate).toBe('2026-06-06');
  });

  it('spans two weeks across the boundary', () => {
    const thisWeek = weekWith('2026-06-08', PIE, ['2026-06-13']);
    const nextWeek = weekWith('2026-06-15', CHILLI, ['2026-06-16']);

    const [task] = kitchenTasks({ defrosts: [defrost()] }, [thisWeek, nextWeek], '2026-06-12');

    expect(task?.forDate).toBe('2026-06-16');
    expect(task?.dueDate).toBe('2026-06-15');
  });

  it('orders dated by due date, then undated by commit time, ties on id', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-12']);
    const withPie = setDayRecipes(week, '2026-06-10', [PIE]);
    const defrosts = [
      defrost({ freezerNumber: 3, recipeId: null, committedAt: '2026-06-08T12:00:00.000Z' }),
      defrost({ freezerNumber: 2, recipeId: null, committedAt: '2026-06-08T08:00:00.000Z' }),
      defrost({ freezerNumber: 1, recipeId: null, committedAt: '2026-06-08T08:00:00.000Z' }),
      defrost({ freezerNumber: 9, recipeId: CHILLI }),
      defrost({ freezerNumber: 8, recipeId: PIE }),
    ];

    const ids = kitchenTasks({ defrosts }, [withPie], '2026-06-09').map((t) => t.id);

    expect(ids).toEqual([
      'defrost:008_recipe-pie',
      'defrost:009_recipe-chilli',
      'defrost:001_manual',
      'defrost:002_manual',
      'defrost:003_manual',
    ]);
  });
});
