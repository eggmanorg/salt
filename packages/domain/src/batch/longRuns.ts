import type { BatchDoc } from '../schemas/index.js';
import type { RecipeKind } from '../recipe/index.js';
import { stageStatus } from './transitions.js';
import { dateInZone, daysBetween } from '../shoppingDay/index.js';

// Which runs want weighing (issue #1406) — the selection rule behind the weekly
// "what is drying" nudge.
//
// THE PROBLEM IT SOLVES. A cure runs for months and a kraut for weeks, and the
// existing stage reminders fire at a stage's START. A ninety-day dry has exactly one
// stage, so after the day you hang it the app goes silent until the day you take it
// down, and the readings that make the log worth keeping never get entered because
// nothing ever asks. This picks the runs that are in that silence.
//
// SELECTION IS GATED ON THE RUN'S FROZEN KIND, THEN ON PRESENCE — NOT "BY PRESENCE,
// NEVER BY KIND" AS THIS COMMENT ONCE CLAIMED (#1449 round 2). That claim held right
// up until it was checked against bread: a cure's observational dry
// (`duration: null`, `until: '30% weight loss'`) and bread's observational
// cool-down (`duration: null`, `until: 'allow the crust to crackle'`, live in
// production as "Cool the cobs") are the IDENTICAL SHAPE on the document — presence
// alone cannot tell them apart, because neither has a planned span to measure. Only
// the run's frozen kind can. Daniel's decision (#1449 park comment) was to branch on
// it: **cures and ferments**, via `isLongRunKind` below.
//
// THIS IS NOT A VIOLATION of CLAUDE.md's never-branch-on-`recipeKind` invariant — it
// is that rule's own sanctioned exit: a single named capability predicate living in
// `packages/domain`, in the same register as `isCookable` / `isPlannable` in
// `recipe/queries/capabilities.ts`, never an inline `=== 'cure'` at a call site.
// Presence still decides everything else this function asks — which stage, whether
// it has actually started, how long it has run. `docs/formulas-schedules-batches.md`
// → *Kind versus presence* is updated to match: this predicate is exactly the
// "capabilities answer questions about the kind" half of that rule, not an exception
// to it.
//
// PURE AND CLOCKLESS (Rule 1): `nowIso` is injected, exactly as `freezeBatch`'s `now`
// is. `timeZone` is injected too, for the same reason `shopDayHeadline` takes
// pre-computed calendar facts rather than a zone-reading clock of its own — see the
// day-number comment below. Nothing here reads a clock, and every test is therefore a
// fixed string.
//
// IT ASKS; IT DOES NOT CHASE. There is no check for whether a reading was already
// logged this week — that would be a subcollection read per batch and it would turn a
// prompt into a chase. A second weighing costs nothing: the observation log is
// append-only, and Salt records rather than polices.

/**
 * How long a DECLARED wait has to be before its run is worth a weekly nudge, in
 * whole days.
 *
 * SEVEN, AND THE FIGURE IS WHAT KEEPS A SHORT DECLARED WAIT OUT. Bread's longest
 * declared wait is an overnight fridge retard — twelve hours, sixteen at the
 * outside — so it never reaches this. A cure's month-long declared dry clears it
 * comfortably.
 *
 * WHAT THIS CONSTANT DOES NOT DO (#1449 round 2 regression, CLAUDE.md rule 12): by
 * itself it does not keep bread out of the nudge. An OBSERVATIONAL wait
 * (`duration: null`) has no planned span to measure against this figure at all —
 * bread's own "Cool the cobs" (`{ duration: null, until: 'allow the crust to
 * crackle' }`) is exactly that shape, and it is live in production today. What
 * excludes bread from THAT branch is `isLongRunKind`, gated on the run's frozen
 * `recipeKind`, not this threshold. `tests/batch/longRuns.test.ts` pins bread out
 * through the real fixture shape (built via `resolveSchedule`, matching
 * production's document), not through this constant.
 */
export const LONG_WAIT_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * Whether a run's frozen kind is the sort of long, unattended process the weekly
 * nudge exists for — Daniel's words, **"cures and ferments"** (#1449 round 2 park
 * comment), landed on the two real fields a batch carries.
 *
 * THE MAPPING, STATED, BECAUSE IT IS NOT TWO BRANCHES. `recipeKind` has exactly one
 * member in this domain — `'cure'` — and it already covers all five `cureCategory`
 * values (`dry_cured_whole_muscle`, `cooked_whole_muscle`, `fermented_dry_cured`,
 * `semi_dry`, `cooked_emulsified`; see `CureCategorySchema`). Two of those five ARE
 * ferments by their own schema comment — `fermented_dry_cured` is lactic
 * acidification, `semi_dry` is rapid acidification — so "cures and ferments" is not
 * two conditions to write, it is one: `recipeKind === 'cure'` already spans both
 * halves of the phrase within the cured-meat domain, and `cureCategory` adds no
 * further narrowing once that holds — every category under `cure` is a run worth a
 * weekly weighing.
 *
 * THE BOUNDARY, STATED (CLAUDE.md rule 12). A VEGETABLE ferment — sauerkraut,
 * kimchi, "a kraut's single three-week ferment" from this feature's own pitch — is
 * NOT reachable by this predicate today, because it has no `recipeKind` of its own
 * to check: `docs/formulas-schedules-batches.md` → *Kind versus presence* is
 * explicit that `ferment` "is not built", and its own table freezes Sauerkraut and
 * Kimchi as plain `recipeKind: 'recipe'` — byte-for-byte the same kind bread
 * carries. A kraut run through today's app with an observational wait is therefore
 * excluded exactly as bread is: an ACCEPTED gap, stated rather than discovered, and
 * this is the one place to widen when `ferment` (or an equivalent field) exists.
 */
export function isLongRunKind(recipeKind: RecipeKind): boolean {
  return recipeKind === 'cure';
}

/** One qualifying run, as the nudge needs to word it. */
export interface LongRunDescriptor {
  /** The `batches/{batchId}` id. Carried for the caller's logs, never for a deep link — the nudge opens the list. */
  readonly batchId: string;
  /** The run's frozen `recipeTitle` — "Coppa". The log survives the dish being renamed. */
  readonly recipeTitle: string;
  /**
   * Which calendar day of the run this is: `1` for the day it was hung, `12` when
   * twelve calendar dates (in `timeZone`) have passed since — the way a cure log is
   * actually counted, and read against `createdAt`'s date rather than its instant.
   */
  readonly dayNumber: number;
  /** Who started it. Never null here — a run with no starter has nobody to ask, and is dropped. */
  readonly startedBy: string;
}

/**
 * The runs sitting in a long wait, grouped by whoever started them.
 *
 * A run qualifies when all of these hold:
 *
 *   • its frozen kind passes `isLongRunKind` — cures and ferments, in Daniel's
 *     words, which today means `recipeKind === 'cure'` (see that predicate for the
 *     mapping and its stated boundary). This is checked FIRST and is what stops
 *     bread's own observational cool-down from ever reaching the branch below
 *     (#1449 round 2);
 *   • it is still running — an abandoned run is dropped outright;
 *   • among its frozen stages there is a `wait`, not yet marked done or skipped,
 *     THAT IS NOT `currentStage` NECESSARILY (see below) — nobody needs telling to
 *     weigh something while they are stood over an `active` stage, but an `active`
 *     stage nobody has tapped must not hide a wait that has, by the plan, already
 *     begun;
 *   • that wait counts as LONG (see the two branches below);
 *   • that wait's PLANNED START is at or before `nowIso` — "planned" rather than
 *     "marked started" deliberately, so a run nobody remembered to tap is still asked
 *     about;
 *   • it records a `startedBy`. A run that does not has nobody to ask, and is dropped
 *     rather than broadcast to the household.
 *
 * ─── WHICH STAGE, AND WHY NOT `currentStage` (#1449 review finding 2) ───────────
 *
 * `currentStage` answers "what's the next action", which is the wrong question here.
 * A cure process is typically `[active "Weigh and rub the cure", wait "Cure 14 d",
 * active "Rinse and tie", wait "Dry 60 d"]`, and `freezeBatch` starts every stage
 * `notStarted`. Until somebody taps the thirty-minute rub done, `currentStage` is
 * stuck on it — an `active` stage — for the WHOLE run, even once "Cure 14 d"'s
 * planned window has long since arrived. This function looks instead for the first
 * `wait` among the frozen stages that is not yet done or skipped, regardless of
 * whether an earlier `active` stage was ever tapped. A wait genuinely further down
 * the process that has not actually arrived yet is excluded by the planned-start
 * check below anyway, since `resolveSchedule` lays every stage's planned time out
 * sequentially from the anchor regardless of what has actually been tapped — so this
 * cannot reach ahead of the plan.
 *
 * ─── WHICH WAIT COUNTS AS "LONG" (#1449 review finding 1) ───────────────────────
 *
 * Two real shapes exist, and they are judged differently because only one of them
 * HAS a length to judge:
 *
 *   • a wait with a `duration` is scheduled at its full planned span up front (see
 *     `resolveSchedule`), so "cure for 90 days" qualifies the moment it starts:
 *     `plannedEndAt - plannedStartAt >= LONG_WAIT_DAYS`.
 *   • an OBSERVATIONAL wait — `duration: null`, typically paired with an `until`
 *     condition such as "until 30% weight loss", which is the natural spelling of a
 *     cure dry — has no length to schedule. `resolveSchedule` places it at ZERO
 *     elapsed time on purpose (see its header), so there is no planned span here to
 *     compare against `LONG_WAIT_DAYS`; the only fact available is how long it has
 *     ACTUALLY been sitting since its planned start: `now - plannedStartAt`.
 *     Judged that way, "prove until doubled" — typically over within the hour —
 *     never qualifies, and a dry that has been open for a week does. Without this
 *     branch an observational long dry has a permanent zero-length planned span and
 *     is dropped forever, which is exactly the run this feature exists to catch.
 *
 * THE OBSERVATIONAL BRANCH HAS NO UPPER BOUND OF ITS OWN, WHICH IS WHY THE KIND
 * GATE ABOVE IS NOT OPTIONAL (#1449 round 2). Nothing about `now - plannedStartAt`
 * can distinguish "a cure open a week, worth asking about" from "a loaf cooling
 * for a week, nobody left to ask" — both are the same shape, indefinitely. That
 * distinction is exactly what `isLongRunKind` exists to draw, and it is drawn
 * once, before this branch runs, rather than folded into the arithmetic here.
 *
 * THE UPPER BOUND, STATED, BECAUSE THERE ISN'T ONE (CLAUDE.md rule 12). A run whose
 * planned end has passed (or, for an observational wait, one that has simply been
 * open a long time) and whose stage nobody has marked done KEEPS QUALIFYING, and
 * that is intended: a coppa still hanging on day 97 is still worth weighing. So the
 * "a ninety-day cure gets thirteen nudges, not ninety" claim is a statement about its
 * PLANNED LIFE — thirteen Fridays inside ninety days — and not a claim that the
 * nudges stop of their own accord. What stops them is the stage being marked done, or
 * the run being abandoned; `tests/batch/longRuns.test.ts` pins both halves.
 *
 * ─── THE DAY NUMBER, IN CALENDAR DAYS (#1449 review finding 3) ──────────────────
 *
 * `dateInZone` + `daysBetween`, not a raw division of the instants by
 * `MS_PER_DAY` — a local day is 23 or 25 hours across a DST change, so floor-dividing
 * raw milliseconds disagrees with the calendar by a day right at the boundary that
 * matters, and drifts further across October. Counting calendar DATES in `timeZone`
 * instead is what makes "day 12" mean what the log's own dates say it means,
 * regardless of which hour either instant falls at or how many hours actually
 * elapsed between two Fridays either side of a clock change.
 *
 * Grouped because the caller sends one notification per person. Order is the input's,
 * and the map's key order is first appearance, so the answer is deterministic.
 */
export function longRunsWantingReading(
  batches: readonly BatchDoc[],
  nowIso: string,
  timeZone: string,
): ReadonlyMap<string, readonly LongRunDescriptor[]> {
  const grouped = new Map<string, LongRunDescriptor[]>();
  const now = Date.parse(nowIso);
  // An unreadable instant asks about nothing rather than comparing against NaN, where
  // every `>` is false and every run would silently qualify.
  if (Number.isNaN(now)) return grouped;

  for (const batch of batches) {
    if (!isLongRunKind(batch.recipeKind)) continue;
    const startedBy = batch.startedBy;
    if (startedBy === null || startedBy === '') continue;
    if (batch.state !== 'running') continue;

    const stage = batch.stages.find((candidate) => {
      if (candidate.kind !== 'wait') return false;
      const status = stageStatus(candidate);
      return status !== 'done' && status !== 'skipped';
    });
    if (stage === undefined) continue;

    const plannedStart = Date.parse(stage.plannedStartAt);
    const plannedEnd = Date.parse(stage.plannedEndAt);
    const created = Date.parse(batch.createdAt);
    if (Number.isNaN(plannedStart) || Number.isNaN(plannedEnd) || Number.isNaN(created)) continue;

    if (plannedStart > now) continue;

    // See the header for why these two are judged differently.
    const isObservational = stage.duration === null;
    const qualifyingMs = isObservational ? now - plannedStart : plannedEnd - plannedStart;
    if (qualifyingMs < LONG_WAIT_DAYS * MS_PER_DAY) continue;

    const createdDate = dateInZone(new Date(created), timeZone);
    const nowDate = dateInZone(new Date(now), timeZone);

    const descriptor: LongRunDescriptor = {
      batchId: batch.id,
      recipeTitle: batch.recipeTitle,
      // Day 1 the calendar date it was hung, so "day 12" means twelve calendar dates
      // have passed — the way a cure log is counted. Floored at 1 so a run whose
      // `createdAt` is somehow ahead of `now` still reads as a real day rather than
      // as zero or a negative.
      dayNumber: Math.max(1, daysBetween(createdDate, nowDate) + 1),
      startedBy,
    };

    const existing = grouped.get(startedBy);
    if (existing === undefined) grouped.set(startedBy, [descriptor]);
    else existing.push(descriptor);
  }

  return grouped;
}
