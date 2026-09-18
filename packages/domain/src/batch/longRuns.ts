import type { BatchDoc } from '../schemas/index.js';
import { currentStage } from './transitions.js';

// Which runs want weighing (issue #1406) — the selection rule behind the weekly
// "what is drying" nudge.
//
// THE PROBLEM IT SOLVES. A cure runs for months and a kraut for weeks, and the
// existing stage reminders fire at a stage's START. A ninety-day dry has exactly one
// stage, so after the day you hang it the app goes silent until the day you take it
// down, and the readings that make the log worth keeping never get entered because
// nothing ever asks. This picks the runs that are in that silence.
//
// SELECTION IS BY PRESENCE, NEVER BY KIND (CLAUDE.md's never-branch-on-`recipeKind`
// invariant, and `docs/formulas-schedules-batches.md` → *Kind versus presence*). The
// rule is a property of the run's frozen stages, so it works with or without the
// `cure` kind and with or without a cure category.
//
// PURE AND CLOCKLESS (Rule 1): `nowIso` is injected, exactly as `freezeBatch`'s `now`
// is. Nothing here reads a clock, and every test is therefore a fixed string.
//
// IT ASKS; IT DOES NOT CHASE. There is no check for whether a reading was already
// logged this week — that would be a subcollection read per batch and it would turn a
// prompt into a chase. A second weighing costs nothing: the observation log is
// append-only, and Salt records rather than polices.

/**
 * How long a wait has to be before its run is worth a weekly nudge, in whole days.
 *
 * SEVEN, AND THE FIGURE IS WHAT KEEPS BREAD OUT. Bread's longest wait is an overnight
 * fridge retard — twelve hours, sixteen at the outside — so no bread batch can ever
 * qualify, which is why this ships dark: every batch in production today is bread and
 * is silent to the nudge. A kraut's single three-week ferment and a cure's month-long
 * dry both clear it comfortably. `tests/batch/longRuns.test.ts` pins the bread half.
 */
export const LONG_WAIT_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** One qualifying run, as the nudge needs to word it. */
export interface LongRunDescriptor {
  /** The `batches/{batchId}` id. Carried for the caller's logs, never for a deep link — the nudge opens the list. */
  readonly batchId: string;
  /** The run's frozen `recipeTitle` — "Coppa". The log survives the dish being renamed. */
  readonly recipeTitle: string;
  /** Which day of the run this is: `1` for the first twenty-four hours, `12` on the twelfth day. */
  readonly dayNumber: number;
  /** Who started it. Never null here — a run with no starter has nobody to ask, and is dropped. */
  readonly startedBy: string;
}

/**
 * The runs sitting in a long wait, grouped by whoever started them.
 *
 * A run qualifies when all of these hold:
 *
 *   • it is still running — an abandoned run has no current stage at all
 *     (`currentStage` returns `null` for one, and that is what is relied on here);
 *   • its current stage is a `wait`, not an `active` one — nobody needs telling to
 *     weigh something while they are stood over it;
 *   • that stage's PLANNED SPAN is `LONG_WAIT_DAYS` or more;
 *   • that stage's PLANNED START is at or before `nowIso` — "planned" rather than
 *     "marked started" deliberately, so a run nobody remembered to tap is still asked
 *     about;
 *   • it records a `startedBy`. A run that does not has nobody to ask, and is dropped
 *     rather than broadcast to the household.
 *
 * THE UPPER BOUND, STATED, BECAUSE THERE ISN'T ONE (CLAUDE.md rule 12). A run whose
 * planned end has passed and whose stage nobody has marked done KEEPS QUALIFYING, and
 * that is intended: a coppa still hanging on day 97 is still worth weighing. So the
 * "a ninety-day cure gets thirteen nudges, not ninety" claim is a statement about its
 * PLANNED LIFE — thirteen Fridays inside ninety days — and not a claim that the
 * nudges stop of their own accord. What stops them is the stage being marked done, or
 * the run being abandoned; `tests/batch/longRuns.test.ts` pins both halves.
 *
 * Grouped because the caller sends one notification per person. Order is the input's,
 * and the map's key order is first appearance, so the answer is deterministic.
 */
export function longRunsWantingReading(
  batches: readonly BatchDoc[],
  nowIso: string,
): ReadonlyMap<string, readonly LongRunDescriptor[]> {
  const grouped = new Map<string, LongRunDescriptor[]>();
  const now = Date.parse(nowIso);
  // An unreadable instant asks about nothing rather than comparing against NaN, where
  // every `>` is false and every run would silently qualify.
  if (Number.isNaN(now)) return grouped;

  for (const batch of batches) {
    const startedBy = batch.startedBy;
    if (startedBy === null || startedBy === '') continue;

    const stage = currentStage(batch);
    if (stage === null || stage.kind !== 'wait') continue;

    const plannedStart = Date.parse(stage.plannedStartAt);
    const plannedEnd = Date.parse(stage.plannedEndAt);
    const created = Date.parse(batch.createdAt);
    if (Number.isNaN(plannedStart) || Number.isNaN(plannedEnd) || Number.isNaN(created)) continue;

    if (plannedStart > now) continue;
    if (plannedEnd - plannedStart < LONG_WAIT_DAYS * MS_PER_DAY) continue;

    const descriptor: LongRunDescriptor = {
      batchId: batch.id,
      recipeTitle: batch.recipeTitle,
      // Day 1 for the first twenty-four hours, so "day 12" means twelve days in — the
      // way a cure log is counted. Floored at 1 so a run whose `createdAt` is somehow
      // ahead of `now` still reads as a real day rather than as zero or a negative.
      dayNumber: Math.max(1, Math.floor((now - created) / MS_PER_DAY) + 1),
      startedBy,
    };

    const existing = grouped.get(startedBy);
    if (existing === undefined) grouped.set(startedBy, [descriptor]);
    else existing.push(descriptor);
  }

  return grouped;
}
