import type { BatchDoc, BatchStageDoc } from '../schemas/index.js';
import { resolveSchedule } from '../process/index.js';

// The run's state machine (issue #812, phase 1 of epic #778). Pure producers over
// a frozen batch, in the `cookSession` / `process` producer style: take the
// document, return a new one, never mutate.
//
// EVERY ONE IS TOTAL. An unknown stage id is a no-op, a batch that is not running
// is a no-op, and re-marking a stage that is already done is a correction rather
// than an error. A batch is poked at over weeks on a phone in a kitchen; a producer
// that threw on a mis-tap would turn a fat thumb into a crash.
//
// NO CLOCK (CLAUDE.md Rule 1): every instant is injected. `updatedAt` is likewise
// NOT touched here — the write path stamps it on the way to Firestore, the same
// split `guidedPlanService.persist` makes, so there is exactly one place a document
// can disagree with itself about when it was last written.
//
// NOTHING HERE RESCALES. There is no producer that changes a quantity, a total or a
// yield, and there will not be one: freezing is what stops a batch growing versions.
// Re-timing is a different thing entirely — the numbers stand, only the clock moves.

/**
 * What condition a stage is in — the ONE derivation, so no surface re-derives it.
 *
 * Four conditions out of three nullable timestamps, in the precedence
 * `BatchStageSchema.skipped` states and this function enforces:
 *
 *   skipped       != null  →  'skipped'
 *   actualEndAt   != null  →  'done'
 *   actualStartAt != null  →  'inProgress'
 *   otherwise              →  'notStarted'
 *
 * SKIPPED WINS OVER DONE, and that ordering is the load-bearing half. A stage can
 * hold both stamps — start the oven, then decide not to bother and skip it; or skip
 * a stage that a predecessor's advance had already stamped `actualStartAt` on. The
 * skip is the later decision and the one the cook actually made, so it is what the
 * run reads back. Nothing here clears the other fields: they are a record of what
 * was observed, and erasing them would lose the fact that the oven really did go on.
 *
 * There is no stored `status` enum for the same reason `actualEndAt` is not a `done`
 * boolean — see `BatchStageSchema`.
 */
export type StageStatus = 'notStarted' | 'inProgress' | 'done' | 'skipped';

export function stageStatus(stage: BatchStageDoc): StageStatus {
  if (stage.skipped !== null) return 'skipped';
  if (stage.actualEndAt !== null) return 'done';
  if (stage.actualStartAt !== null) return 'inProgress';
  return 'notStarted';
}

/**
 * The stage the batch is on: the first one that is neither done nor skipped.
 *
 * IT STEPS OVER A SKIPPED STAGE, which is the whole of "it never reappears as the
 * thing the run is waiting for". A stage marked in progress is still the current
 * one — being under way is not being finished with, and the run is still waiting for
 * it to end.
 *
 * `null` when every stage is done or skipped (the run is over in all but name — see
 * `BatchStateSchema` for why that is derived rather than stored) and `null` for an
 * abandoned batch, which has no next action by definition.
 *
 * NOTE what this deliberately no longer answers on its own: since a stage can be
 * marked started while an earlier one still runs, "the current stage" is the one
 * NEXT ACTION and not the set of everything under way. A surface that wants the
 * in-progress set reads `stageStatus` over the stages.
 */
export function currentStage(batch: BatchDoc): BatchStageDoc | null {
  if (batch.state !== 'running') return null;
  return (
    batch.stages.find(
      (stage) => stageStatus(stage) === 'notStarted' || stageStatus(stage) === 'inProgress',
    ) ?? null
  );
}

/**
 * Mark a stage done at `at`, and RE-TIME EVERYTHING AFTER IT.
 *
 * This is the point of the producer. A prove that ran twenty minutes long does not
 * just record twenty minutes: it moves the shape, the second prove and the bake
 * twenty minutes later, and it does so through the same `resolveSchedule` that
 * placed them in the first place — so a re-timed schedule is indistinguishable from
 * one that was resolved that way to begin with. Early works identically: mark it at
 * 45 minutes and the loaf comes out early, correctly.
 *
 * The stage after this one has, by that same fact, STARTED — its `actualStartAt` is
 * the instant its predecessor ended. That is the only actual this phase infers, and
 * it is not really an inference: it is one boundary with two names.
 *
 * A no-op when the id is unknown, when the batch is not running, or when the
 * instant cannot be read as a time.
 */
export function withStageAdvanced(batch: BatchDoc, stageId: string, at: string): BatchDoc {
  if (batch.state !== 'running') return batch;
  const index = batch.stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return batch;

  const done: BatchStageDoc = { ...batch.stages[index]!, actualEndAt: at };

  // Re-time only what is still going to happen. A skipped stage keeps its now-stale
  // planned times (see `withStageSkipped`) and must not be handed a fresh plan for
  // something nobody is going to do — nor push everything after it by its duration.
  const rest = batch.stages.slice(index + 1);
  const live = rest.filter((stage) => stage.skipped === null);
  const retimed = resolveSchedule(live, { kind: 'startAt', at });
  // An unreadable instant leaves the batch exactly as it was rather than half-
  // applying the mark: a stage recorded as done against a schedule that still says
  // otherwise is worse than nothing recorded at all.
  if (!retimed.ok) return batch;

  // Only the immediate SUCCESSOR THAT IS STILL GOING TO HAPPEN starts here. Anything
  // further along is still planned, not observed, and stamping it would claim
  // knowledge of a stage the cook has not reached; a skipped one never starts at all.
  //
  // AND THE INFERRED STAMP NEVER OVERWRITES AN OBSERVED ONE (issue #1275). Since
  // `withStageStarted` exists, the successor may already carry a real "I put the oven
  // on at 06:40", which is earlier and truer than this boundary. `??` is what keeps
  // it.
  let firstLive = true;
  let cursor = 0;
  const after: BatchStageDoc[] = rest.map((stage) => {
    if (stage.skipped !== null) return stage;
    const next = retimed.stages[cursor++]!;
    if (!firstLive) return next;
    firstLive = false;
    return { ...next, actualStartAt: next.actualStartAt ?? at };
  });

  return { ...batch, stages: [...batch.stages.slice(0, index), done, ...after] };
}

/**
 * Mark a stage STARTED at `at`, without marking it done.
 *
 * This is overlap-by-marking, and it is the whole of it: the oven goes on twenty
 * minutes before the prove finishes, both stages read as in progress, and each is
 * marked done when it actually ends. RE-TIMES NOTHING — `resolveSchedule` is
 * untouched and the plan stays a strict queue (issue #1275). The plan stays a plan;
 * the run is the record.
 *
 * IDEMPOTENT ON AN OBSERVED START. A stage that already carries an `actualStartAt`
 * keeps the one it has, whether that was observed here or inferred by
 * `withStageAdvanced` stamping a predecessor's end onto it. The first time anyone
 * said this stage began is the true answer; a second tap must not move it later.
 *
 * A no-op when the id is unknown, when the batch is not running, or when the instant
 * cannot be read as a time.
 */
export function withStageStarted(batch: BatchDoc, stageId: string, at: string): BatchDoc {
  if (batch.state !== 'running') return batch;
  if (!Number.isFinite(Date.parse(at))) return batch;
  const index = batch.stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return batch;

  const stage = batch.stages[index]!;
  if (stage.actualStartAt !== null) return batch;

  const started: BatchStageDoc = { ...stage, actualStartAt: at };
  return {
    ...batch,
    stages: [...batch.stages.slice(0, index), started, ...batch.stages.slice(index + 1)],
  };
}

/**
 * SKIP a stage at `at`, with an optional reason, and re-time everything after it.
 *
 * Skipping the stage IN HAND pulls the tail forward exactly as marking it done
 * would — through the same `resolveSchedule`, anchored at the same instant — because
 * from the schedule's point of view the two are the same event: this stage is over,
 * and everything after it starts now.
 *
 * Skipping a stage the run HAS NOT REACHED YET is the other half, and it anchors
 * differently: the tail comes forward by the skipped stage's own length, from where
 * the plan already had it, rather than to the clock. The anchor is the later of `at`
 * and the skipped stage's `plannedStartAt` — see the comment at the call.
 *
 * ANY STAGE IS SKIPPABLE. `optional` is the recipe's opinion and gates nothing (see
 * `ProcessStageContentSchema.optional`); there is no gate here, no confirmation, and
 * no branch on that flag anywhere in this file. Salt records what happened in the
 * kitchen rather than holding an opinion about it.
 *
 * THE SKIPPED STAGE'S OWN PLANNED TIMES ARE LEFT ALONE. They are now meaningless and
 * the surface stops rendering them — but blanking them in the document would be a
 * write that destroys what the plan said, on the one record that exists to say what
 * the plan said. `resolveSchedule` is run over the UNSKIPPED remainder only, so an
 * already-skipped stage further down keeps its stale times too.
 *
 * `note` is trimmed and defaults to the empty string, never null — see
 * `StageSkipSchema`. Re-skipping an already-skipped stage RESTAMPS it, which is how
 * a wrong reason is corrected: producers here are total and a correction is not an
 * error.
 *
 * A no-op when the id is unknown, when the batch is not running, or when the instant
 * cannot be read as a time.
 */
export function withStageSkipped(
  batch: BatchDoc,
  stageId: string,
  at: string,
  note: string = '',
): BatchDoc {
  if (batch.state !== 'running') return batch;
  const index = batch.stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return batch;

  const skipped: BatchStageDoc = {
    ...batch.stages[index]!,
    skipped: { at, note: note.trim() },
  };

  // WHERE THE TAIL IS RE-ANCHORED, and it is NOT unconditionally `at`. Skipping the
  // stage in hand means everything after it starts now, exactly as marking it done
  // would. But Skip is offered on every stage that has not happened yet, INCLUDING
  // one further down the list — and anchoring the tail at `at` there would claim the
  // run had jumped ahead of a predecessor that is still going: skip the shape while
  // the bulk has three hours left and the bake gets re-planned for this afternoon,
  // reminder and all. So the anchor is the LATER of the two, and a future skip pulls
  // the tail forward by the skipped stage's own length and nothing more.
  //
  // An unreadable instant falls through to `at`, so `resolveSchedule` still refuses
  // it below and this producer stays total.
  const atMs = Date.parse(at);
  const plannedMs = Date.parse(skipped.plannedStartAt);
  const anchorAt =
    Number.isFinite(atMs) && Number.isFinite(plannedMs) && plannedMs > atMs
      ? skipped.plannedStartAt
      : at;

  // Only the stages that are still going to happen are re-timed. A skipped stage
  // among them would otherwise be handed a fresh plan for something nobody is going
  // to do, and would push everything after it by its own duration.
  const rest = batch.stages.slice(index + 1);
  const live = rest.filter((stage) => stage.skipped === null);
  const retimed = resolveSchedule(live, { kind: 'startAt', at: anchorAt });
  // An unreadable instant leaves the batch exactly as it was rather than half-
  // applying the skip — the same refusal `withStageAdvanced` makes, and for the same
  // reason: a stage recorded as skipped against a schedule that still says otherwise
  // is worse than nothing recorded at all.
  if (!retimed.ok) return batch;

  // Back into process order. `resolveSchedule` returns the live stages in the order
  // it was given them, so walking `rest` and taking the next re-timed stage for each
  // unskipped entry restores the original sequence with the skipped ones in place.
  let cursor = 0;
  const after: BatchStageDoc[] = rest.map((stage) =>
    stage.skipped === null ? retimed.stages[cursor++]! : stage,
  );

  return { ...batch, stages: [...batch.stages.slice(0, index), skipped, ...after] };
}

/**
 * Stop the run.
 *
 * The dough over-proved, the kraut went to mould, the plan changed. Abandoning is a
 * STATE, not a delete: the log of what was mixed and how far it got is exactly what
 * makes batch ten better than batch nine, and Salt has no tombstones because it has
 * no soft-delete — a batch nobody wants to keep is deleted for real, elsewhere.
 *
 * Idempotent, and one-way: nothing here brings a batch back to `running`, because
 * the schedule it was abandoned against is hours or weeks stale and un-abandoning
 * would present those planned times as if they still meant something.
 */
export function withBatchAbandoned(batch: BatchDoc): BatchDoc {
  if (batch.state === 'abandoned') return batch;
  return { ...batch, state: 'abandoned' };
}
