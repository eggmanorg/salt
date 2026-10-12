import type { Defrost } from '../freezer/index.js';
import type { MealPlanWeek } from '../mealPlan/index.js';
import { addCalendarDays } from '../shoppingDay/index.js';
import { defrostDocId } from '../schemas/index.js';

/**
 * What Kitchen asks somebody to do, and where each kind comes from (issue
 * #1685). A later kind joins by adding a field here, a member to `KitchenTask`
 * and a branch below — never a second function, because the 09:00 push (#1683)
 * scans this one.
 */
export interface KitchenTaskSources {
  readonly defrosts: readonly Defrost[];
}

interface KitchenTaskBase {
  /** Stable key: `${kind}:${source document id}`. */
  readonly id: string;
  /** `YYYY-MM-DD` the thing should be done ON; null = undated. */
  readonly dueDate: string | null;
  /** `YYYY-MM-DD` of the planned night it serves; null = none found in the held weeks. */
  readonly forDate: string | null;
}

/** Packs to get out of the freezer, the day before the night they are for. */
export interface DefrostTask extends KitchenTaskBase {
  readonly kind: 'defrost';
  readonly defrost: Defrost;
}

/** Discriminated on `kind`; one member today. */
export type KitchenTask = DefrostTask;

/**
 * The soonest stored date key `>= today` whose day plans `recipeId`, across the
 * held weeks, or null. Iterates STORED keys, never computed ones, for
 * `upcomingChefDays`'s reason: a week written under another `firstDayOfWeek`
 * holds the keys that were current when it was saved. First week holding a date
 * wins.
 */
function nextPlannedNight(
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

/**
 * Everything Kitchen lists under To do, in order: dated tasks by `dueDate`, then
 * undated ones by when they were committed; ties on `id`.
 *
 * A defrost with a recipe is for the soonest planned night of that recipe from
 * `today` on, and is due the day before. It is UNDATED when there is no such
 * night in `weeks`: a hand-added row (no recipe), a "make it yourself" producer
 * (planners hold the meals, not their producers), a recipe planned nowhere — or
 * planned beyond the weeks the caller holds. That last case is why undated never
 * means "not planned": Kitchen holds one or two weeks, so a meal further out
 * reads undated until the window reaches it.
 *
 * Pure: no clock and no I/O. The caller supplies `today` and whatever weeks it
 * holds.
 */
export function kitchenTasks(
  sources: KitchenTaskSources,
  weeks: readonly MealPlanWeek[],
  today: string,
): readonly KitchenTask[] {
  const tasks: KitchenTask[] = sources.defrosts.map((defrost) => {
    const forDate =
      defrost.recipeId === null ? null : nextPlannedNight(weeks, defrost.recipeId, today);
    return {
      kind: 'defrost',
      id: `defrost:${defrostDocId(defrost.freezerNumber, defrost.recipeId)}`,
      forDate,
      dueDate: forDate === null ? null : addCalendarDays(forDate, -1),
      defrost,
    };
  });
  return tasks.sort(compareTasks);
}

// Dated before undated (`0` sorts before `1`); dated by due date, undated by
// commit time — both ISO strings, so text order is time order; then the id.
function sortKey(task: KitchenTask): string {
  return task.dueDate !== null ? `0:${task.dueDate}` : `1:${task.defrost.committedAt}`;
}

function compareTasks(a: KitchenTask, b: KitchenTask): number {
  return sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id);
}
