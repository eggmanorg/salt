import type { MealPlanWeek } from '../entities/MealPlanWeek.js';

/**
 * The soonest stored date key `>= today` whose day plans `recipeId`, across the
 * held weeks, or null. Iterates STORED keys, never computed ones, for
 * `upcomingChefDays`'s reason: a week written under another `firstDayOfWeek`
 * holds the keys that were current when it was saved. First week holding a date
 * wins.
 */
export function nextPlannedNight(
  weeks: readonly MealPlanWeek[],
  recipeId: string,
  today: string,
): string | null {
  const seen = new Set<string>();
  let soonest: string | null = null;
  for (const week of weeks) {
    for (const [date, day] of Object.entries(week.days)) {
      if (date < today || seen.has(date)) continue;
      seen.add(date);
      if (!day.recipeIds.includes(recipeId)) continue;
      if (soonest === null || date < soonest) soonest = date;
    }
  }
  return soonest;
}
