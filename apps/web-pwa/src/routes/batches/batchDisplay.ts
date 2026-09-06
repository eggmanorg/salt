import { currentStage, stageStatus } from '@salt/domain';
import type { BatchDoc, BatchStageDoc, BatchTotalsDoc } from '@salt/domain/schemas';
import { formatInstant } from '../../lib/dateFormat.js';
import { formatMinutes, formatStatedDuration } from '../../lib/durationDisplay.js';
import { formatGrams } from '../../lib/quantityDisplay.js';

// How a batch READS (issue #812, phase 1 of epic #778) — the words and formats the
// two batch screens share, in one place so the list and the run's own page can
// never disagree about what the next action is or when it lands.
//
// NOTHING HERE COMPUTES A QUANTITY OR A TIME. Every number a batch screen shows was
// frozen when the run started (see `schemas/batch.ts`) and everything below only
// chooses how to say it. The moment one of these multiplies a gram figure or adds a
// minute, a screen has begun re-deriving what the freeze exists to pin down — which
// is exactly how "batch nine at 78% hydration" quietly becomes batch ten.
//
// The clock is INJECTED, defaulting to now. That keeps "today 09:00" a fixed string
// in a test and matches how the domain treats time everywhere in this feature.
//
// The duration formatters used to live here, duplicating a private helper on
// `FormulaPage`, above a note saying a third surface was the moment they would earn
// a home. Phase 2's proposal review was that third surface, so they moved to
// `lib/durationDisplay.ts` and are re-exported here — the batch screens keep
// importing one display module rather than two.
//
// `formatGrams` followed the same road for the same reason and now lives in
// `lib/quantityDisplay.ts` (issue #933). It is re-exported here rather than
// re-pointed at both batch screens so that this stays the one display module a
// batch screen imports; the pattern is deliberate, not an accident to unwind.

export { formatMinutes, formatStatedDuration, formatGrams };

/** True when the stage carries no length — observational, not instantaneous. */
export function isObservational(stage: BatchStageDoc): boolean {
  return stage.duration === null;
}

// Whole local calendar days from `from` to `to`. Local, not UTC: "tomorrow" is a
// fact about the kitchen's morning, not about Greenwich's.
function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * An instant, as a person waiting for it would say it.
 *
 * A bread schedule runs overnight, so the DAY matters as much as the time — but
 * spelling out a date for something happening in twenty minutes is noise. Today,
 * tomorrow and yesterday get their words; anything further off gets its weekday.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const time = formatInstant(at, { hour: '2-digit', minute: '2-digit' });
  const days = calendarDaysBetween(now, at);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  const day = formatInstant(at, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/** A calendar day in words — for "started on", where the time of day is noise. */
export function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return formatInstant(at, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * What this run makes, from the frozen totals alone.
 *
 * `units` is null for a basis-driven solve (weigh the meat, see what you get), and
 * then the honest headline is the weight itself.
 */
export function yieldSummary(totals: BatchTotalsDoc): string {
  if (totals.units === null) return formatGrams(totals.totalGrams);
  return `${totals.units.count} × ${totals.units.label}`;
}

// ─── The next action ────────────────────────────────────────────────────────────

/**
 * What this run wants next, which is the whole of a card on the in-flight surface.
 *
 * Three cases, and `currentStage` decides all of them: the stage in hand, a run
 * whose stages are all done (there is deliberately no `finished` STATE — see
 * `BatchStateSchema`), and one that was stopped.
 *
 * `currentStage` STEPS OVER A SKIPPED STAGE (issue #1275), so a skipped stage never
 * appears here and a run whose last stage was skipped rather than done reads
 * `'done'` exactly as a fully-done one does. This function does not know that — it
 * is the domain's derivation, read once, so the list card and the run's own page
 * cannot disagree about it.
 */
export type NextAction =
  { kind: 'stage'; stage: BatchStageDoc } | { kind: 'done' } | { kind: 'abandoned' };

export function nextAction(batch: BatchDoc): NextAction {
  if (batch.state === 'abandoned') return { kind: 'abandoned' };
  const stage = currentStage(batch);
  return stage === null ? { kind: 'done' } : { kind: 'stage', stage };
}

// ─── Which stage a reading is about ─────────────────────────────────────────────

/**
 * The stage a new log entry should be filed against, before anyone touches the
 * control (issue #1276).
 *
 * ONE named function, for the reason `nextAction` above it is one: "which stage is
 * now" must have exactly one answer, and a sheet re-deriving its own would be a
 * second one waiting to disagree.
 *
 * Precedence, and it answers all four run conditions with one rule:
 *
 *   1. the EARLIEST stage that is in progress. Plural since #1275 — the oven can go
 *      on while the prove is still running — and the earliest of them is the one the
 *      cook is standing in front of;
 *   2. else the stage `nextAction` names, which is the stage about to be started;
 *   3. else `null`, "the whole batch". A run with nothing in progress and nothing
 *      next is a finished one, and that is exactly when the end-of-run prompt opens
 *      the sheet to ask "how did it go?" — a verdict on the run, not on its bake.
 *
 * A DEFAULT AND NOT A DECISION: every stage stays selectable, including a skipped
 * one, and `null` is a real answer a person can choose (see `BatchObservationSheet`).
 */
export function defaultObservationStageId(batch: BatchDoc): string | null {
  const inProgress = batch.stages.find((stage) => stageStatus(stage) === 'inProgress');
  if (inProgress) return inProgress.id;
  const next = nextAction(batch);
  return next.kind === 'stage' ? next.stage.id : null;
}

/**
 * The label to print beside a log entry, joined against the run's OWN frozen stages.
 *
 * `null` for an entry about the whole run, and `null` for an id that no longer names
 * a stage — an entry whose stage cannot be resolved renders as one about the run
 * rather than as an error, which is the same thing a dangling `recipeId` does.
 */
export function stageLabelById(batch: BatchDoc, stageId: string | null): string | null {
  if (stageId === null) return null;
  return batch.stages.find((stage) => stage.id === stageId)?.label ?? null;
}

/**
 * The in-flight surface's order: whatever needs doing soonest, first.
 *
 * Explicitly NOT "newest first". A batch is a thing you are waiting on, so the only
 * ordering that helps is by the clock it is waiting against — and a run with
 * nothing left to do has no such clock, so those fall to the bottom, most recently
 * started first, where they read as a log rather than as a queue.
 *
 * Unordered on the wire by design (see `batchSync.ts`): ordering is a rendering
 * decision, and this is the rendering.
 */
export function orderBatches(batches: readonly BatchDoc[]): BatchDoc[] {
  const pending: { batch: BatchDoc; at: string }[] = [];
  const ended: BatchDoc[] = [];
  for (const batch of batches) {
    const next = nextAction(batch);
    if (next.kind === 'stage') pending.push({ batch, at: next.stage.plannedStartAt });
    else ended.push(batch);
  }
  pending.sort((a, b) => a.at.localeCompare(b.at));
  ended.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...pending.map((entry) => entry.batch), ...ended];
}

// ─── The batch log ──────────────────────────────────────────────────────────────
//
// How `buildBatchLog`'s entries READ (issue #1280). The ORDER is the domain's and
// nothing here re-sorts: these only choose words and group what arrives.

/** The clock time alone — a log row sits under a date heading that says the day. */
export function formatTimeOfDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return formatInstant(at, { hour: '2-digit', minute: '2-digit' });
}

/**
 * How a finished step ran against THE TIME IT WAS GIVEN, in words.
 *
 * `null` in, `null` out — a stage given no length has no over or under, and the row
 * prints nothing rather than "0 min over" (see `buildBatchLog`'s `driftMinutes`).
 *
 * NOT drift from the schedule the run started with: that number is unrecoverable
 * from the document, and this phrasing must not be read as claiming it.
 */
export function formatDrift(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === 0) return 'on time';
  return `${formatMinutes(Math.abs(minutes))} ${minutes > 0 ? 'over' : 'under'}`;
}

/**
 * The log split into calendar days, in the order it arrived.
 *
 * A four-month cure is unreadable as one flat list, and a date on every row is the
 * same date forty times. LOCAL days, like `calendarDaysBetween` above: a bake that
 * finishes at one in the morning belongs to the morning it finished in, wherever
 * Greenwich thinks the day turned.
 *
 * A pure regrouping — entries stay in the order they were given, and a day appears
 * once at the position of its first entry.
 */
export function groupLogByDay<T extends { at: string }>(
  entries: readonly T[],
): { key: string; label: string; entries: T[] }[] {
  const days: { key: string; label: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else days.push({ key, label: formatDate(entry.at), entries: [entry] });
  }
  return days;
}
