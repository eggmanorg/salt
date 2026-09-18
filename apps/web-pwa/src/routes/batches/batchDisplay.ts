import { currentStage, stageStatus } from '@salt/domain';
import type { CureCategory } from '@salt/domain';
import type { BatchDoc, BatchStageDoc, BatchTotalsDoc } from '@salt/domain/schemas';
import { CureCategorySchema } from '@salt/domain/schemas';
import { KIND_COPY } from '../recipes/recipeKind.js';
import { formatInstant } from '../../lib/dateFormat.js';
import { formatMinutes, formatStatedDuration } from '../../lib/durationDisplay.js';
import { formatDoughAmount, formatGrams } from '../../lib/quantityDisplay.js';

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
// `formatDoughAmount` arrived the same way (issue #1274): four surfaces say
// "2 × 900 g — 1.8 kg of dough" and two of them are these.

export { formatMinutes, formatStatedDuration, formatGrams, formatDoughAmount };

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
 *
 * Since #1274 the units carry no name — "2 × 900 g — 1.8 kg of dough" rather than
 * "2 × 900 g tin loaf", because the recipe is what says it is a tin loaf and the
 * old label never said whether 900 g was the pan, the dough or the bread. What the
 * run was baked in is a separate snapshot on the batch (`vessel`), rendered beside
 * this by the screens that show it.
 */
export function yieldSummary(totals: BatchTotalsDoc): string {
  if (totals.units === null) return formatGrams(totals.totalGrams);
  return formatDoughAmount(totals.units);
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

// ─── What kind of cure a run was (issue #1404) ──────────────────────────────────
//
// Both of these read the run's OWN frozen `recipeKind` / `cureCategory`, never the
// recipe's — which is the whole point of freezing them. A coppa whose recipe was
// renamed, re-mapped or deleted last February still turns up under Dry-cured whole
// muscle, and that is what makes "the last three bresaola" answerable a year later.
//
// The WORDS come from `KIND_COPY`, which is the library's vocabulary: a second set
// of labels here is the drift this module's own header warns about, one screen
// along. Nothing compares against a kind or a category literal — the copy table is
// asked whether the kind has a category vocabulary at all.

/**
 * Whether this run's OWN kind declares a category vocabulary at all — the one
 * gate `categoryLabel` and `categoriesPresent` must ask the same way (#1425
 * review, should-fix 3). Before this, `categoryLabel` asked the copy table
 * while `categoriesPresent` asked only "is `cureCategory` non-null?" — two
 * different questions that agree everywhere a `cureCategory` can legitimately
 * exist today, and disagree the moment one does not (a stray value on a kind
 * whose copy has no category editor), which is exactly the case
 * `categoryLabel`'s own test pins as reading nothing.
 */
function hasCategoryVocabulary(kind: BatchDoc['recipeKind']): boolean {
  return KIND_COPY[kind].categoryCopy !== undefined;
}

/** How this run's category reads, or `null` when it has none to read. */
export function categoryLabel(batch: BatchDoc): string | null {
  if (!hasCategoryVocabulary(batch.recipeKind) || batch.cureCategory === null) return null;
  return KIND_COPY[batch.recipeKind].categoryCopy!.options[batch.cureCategory];
}

/**
 * The filter row: one entry per category these runs actually carry, with the words
 * to put on its chip.
 *
 * The LABELS are resolved here rather than in the page, so `KIND_COPY` stays out of
 * a Svelte file — and with it any temptation to reach for a category by name. A
 * label is looked up through the same copy table the library uses, so the two
 * screens cannot come to call the same category different things.
 */
export function categoryChips(
  batches: readonly BatchDoc[],
): { value: CureCategory; label: string }[] {
  const copy = KIND_COPY.cure.categoryCopy;
  return categoriesPresent(batches).map((value) => ({
    value,
    // `?? value` is unreachable while `cure` declares a vocabulary, and is here
    // because the field is optional by design — four kinds have none. It degrades
    // to the stored word rather than to an empty chip.
    label: copy?.options[value] ?? value,
  }));
}

/**
 * The categories these runs actually carry, in the stored enum's order.
 *
 * DERIVED FROM THE RUNS, not from the enum, so a household that has never cured
 * anything gets an empty list and no filter row at all — the screen grows chrome
 * on the day it has something to filter, and never before. Ordered by the enum
 * rather than by first appearance so the row does not reshuffle itself as runs
 * start and end.
 *
 * Its boundary, stated: it can only see the runs it is handed. `/batches` holds
 * the whole collection, so on that screen this is every category the household has
 * ever run — but it is a property of the argument, not of Firestore.
 *
 * Gated through `hasCategoryVocabulary`, the same question `categoryLabel` asks —
 * not merely "is `cureCategory` non-null?" A run whose `cureCategory` is set but
 * whose `recipeKind` declares no vocabulary (unreachable on today's write path,
 * see `assembleRecipeDraft`'s correlation, but not something this display module
 * should assume forever) contributes no chip: `categoryLabel` already reads
 * nothing for that same run, and a filter row must not offer to narrow to a
 * category no card on the list will ever say it belongs to.
 */
export function categoriesPresent(batches: readonly BatchDoc[]): CureCategory[] {
  const seen = new Set(
    batches.flatMap((b) =>
      hasCategoryVocabulary(b.recipeKind) && b.cureCategory !== null ? [b.cureCategory] : [],
    ),
  );
  return CureCategorySchema.options.filter((category) => seen.has(category));
}
