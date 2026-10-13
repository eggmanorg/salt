import { describe, it, expect } from 'vitest';
import { nextPlannedNight, emptyWeek, setDayRecipes, type MealPlanWeek } from '../../src/index.js';

// The night a pack used from the freezer is for, worked out once at commit
// (#1696; the rule #1685 used on every read). Under test: soonest planned from
// today on, stored keys, the first week holding a date wins, and the undated cases.

const CHILLI = 'recipe-chilli';
const PIE = 'recipe-pie';

// A Monday-start week with `recipeId` planned on each of `dates`.
function weekWith(start: string, recipeId: string, dates: string[]): MealPlanWeek {
  return dates.reduce((w, d) => setDayRecipes(w, d, [recipeId]), emptyWeek(start));
}

describe('nextPlannedNight', () => {
  it('is the soonest planned night from today on', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-09', '2026-06-13', '2026-06-11']);

    expect(nextPlannedNight([week], CHILLI, '2026-06-10')).toBe('2026-06-11');
  });

  it('counts tonight', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-10']);

    expect(nextPlannedNight([week], CHILLI, '2026-06-10')).toBe('2026-06-10');
  });

  it('is null when every planned night has gone', () => {
    const week = weekWith('2026-06-08', CHILLI, ['2026-06-09']);

    expect(nextPlannedNight([week], CHILLI, '2026-06-10')).toBeNull();
  });

  it('is null for a recipe planned nowhere', () => {
    const week = weekWith('2026-06-08', PIE, ['2026-06-11']);

    expect(nextPlannedNight([week], CHILLI, '2026-06-10')).toBeNull();
  });

  it('is null for a "make it yourself" producer, never in recipeIds', () => {
    // The lasagne is planned; the ragù that goes into it is not, and the planner
    // never holds a producer's id.
    const week = weekWith('2026-06-08', 'recipe-lasagne', ['2026-06-11']);

    expect(nextPlannedNight([week], 'recipe-ragu', '2026-06-10')).toBeNull();
  });

  it('reads the keys a week STORES, not the ones its start implies', () => {
    // Written when the cycle started on Friday; `startDate` now says Monday. The
    // stored Saturday key is outside the computed cycle and must still be found.
    const written = weekWith('2026-06-05', CHILLI, ['2026-06-06']);
    const relabelled: MealPlanWeek = { ...written, id: '2026-06-08', startDate: '2026-06-08' };

    expect(nextPlannedNight([relabelled], CHILLI, '2026-06-05')).toBe('2026-06-06');
  });

  it('spans two weeks across the boundary', () => {
    const thisWeek = weekWith('2026-06-08', PIE, ['2026-06-13']);
    const nextWeek = weekWith('2026-06-15', CHILLI, ['2026-06-16']);

    expect(nextPlannedNight([thisWeek, nextWeek], CHILLI, '2026-06-12')).toBe('2026-06-16');
  });

  it('the first week holding a date wins', () => {
    // The two weeks overlap on 11–14 June (one written under another
    // firstDayOfWeek). The first plans pie on the 11th, so the second's chilli on
    // that key is not counted; its chilli on the 16th, a key only it holds, is.
    const first = weekWith('2026-06-08', PIE, ['2026-06-11']);
    const second = weekWith('2026-06-11', CHILLI, ['2026-06-11', '2026-06-16']);

    expect(nextPlannedNight([first, second], CHILLI, '2026-06-10')).toBe('2026-06-16');
  });
});
