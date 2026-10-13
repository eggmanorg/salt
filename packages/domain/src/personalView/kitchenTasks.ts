import type { Defrost } from '../freezer/index.js';
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
  /** `YYYY-MM-DD` of the planned night it serves, as stored on the source; null = undated. */
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
 * Everything Kitchen lists under To do, in order: dated tasks by `dueDate`, then
 * undated ones by when they were committed; ties on `id`.
 *
 * A defrost is for the night stored on it when its pack was used (`forDate`,
 * #1696), and is due the day before. Nothing here reads the planner, so planning
 * the recipe again or moving the meal leaves the task where it was; only another
 * commit to the same document re-dates it. A night already gone stays dated, so
 * an un-ticked item sorts first rather than vanishing.
 *
 * Pure: no clock and no I/O.
 */
export function kitchenTasks(sources: KitchenTaskSources): readonly KitchenTask[] {
  const tasks: KitchenTask[] = sources.defrosts.map((defrost) => ({
    kind: 'defrost',
    id: `defrost:${defrostDocId(defrost.freezerNumber, defrost.recipeId)}`,
    forDate: defrost.forDate,
    dueDate: defrost.forDate === null ? null : addCalendarDays(defrost.forDate, -1),
    defrost,
  }));
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
