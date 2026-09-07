import type { BatchDoc, BatchObservationDoc, BatchStageDoc } from '../schemas/index.js';

// The batch log (issue #1280, epic #778) — one ordered list of everything that
// happened to a run, DERIVED and never stored.
//
// Every fact below is already on the batch document or in its observation
// subcollection: `createdAt`, `abandonedAt`, each stage's `actualStartAt`,
// `actualEndAt` and `skipped.at`, and each observation's `at`. This file only
// merges and orders them. There is deliberately NO event collection beside the
// batch — that would be a second source of truth that a re-timing or a correction
// can contradict, which is the same call `stageStatus` already makes for a stage's
// condition (see `BatchStageSchema`).
//
// ─── WHAT THIS LOG CANNOT SAY, STATED RATHER THAN IMPLIED ───────────────────────
//
// It records STATE, not EDITS. Marking a stage done overwrites `actualEndAt`, so
// correcting a time an hour later moves the entry and leaves no trace that it was
// ever anything else. The log shows the corrected run, not the history of the
// record — a kitchen record, not an audit trail. That is the trade the derived
// shape buys, and it is a real limit.
//
// It also cannot say what the ORIGINAL schedule was. `withStageAdvanced` re-times
// every later stage in place through `resolveSchedule`, so a stage's `plannedEndAt`
// is the plan AS IT STOOD WHEN THAT STAGE BEGAN and the schedule first proposed is
// genuinely unrecoverable from the document. See `driftMinutes` below for what the
// over/under figure therefore means, and what it must not be read as.
//
// Pure, and takes no clock: an entry is placed by the instant that was recorded
// against it, and this file never asks what time it is now (CLAUDE.md Rule 1).

/**
 * One line of the log.
 *
 * A discriminated union over `kind`, every member carrying the ISO instant it is
 * placed by. Stage entries carry the stage's id — the LABEL is resolved against the
 * run's own frozen `stages` where the log is rendered (`stageLabelById`), not copied
 * here, because a batch's stages are frozen on the very document this reads and a
 * copy would be a second source of truth for a string that cannot go stale.
 */
export type BatchLogEntry =
  | { kind: 'batchStarted'; at: string }
  | { kind: 'stageStarted'; at: string; stageId: string }
  | { kind: 'stageDone'; at: string; stageId: string; driftMinutes: number | null }
  | { kind: 'stageSkipped'; at: string; stageId: string; note: string }
  | { kind: 'observation'; at: string; observation: BatchObservationDoc }
  | { kind: 'batchAbandoned'; at: string };

const MS_PER_MINUTE = 60_000;

/**
 * How much longer a stage ran than THE TIME IT WAS GIVEN, in signed minutes.
 * Positive is over, negative is under, zero is on the nose.
 *
 * `plannedEndAt` is the plan as it stood when this stage began — `withStageAdvanced`
 * re-times only what is still to come, so a stage's own planned times stop moving
 * once its predecessor is marked done. That makes this figure the useful one: it is
 * what a prove overran the plan it was actually running against.
 *
 * IT IS NOT DRIFT FROM THE ORIGINAL SCHEDULE, and no such number exists on this
 * document. The schedule the run started with is overwritten stage by stage, so
 * "the bake came out 40 minutes later than first planned" is unanswerable here and
 * nothing may claim it.
 *
 * `null` for a stage with NO DURATION. An observational stage ("until it has
 * doubled") is placed on the clock as a zero-length point, so `plannedEndAt` equals
 * `plannedStartAt` and the difference measures how late the cook got to it — not
 * how long it ran over. There is no time it was given, so there is no over or under.
 *
 * `null` too when either instant is unreadable.
 */
function driftMinutes(stage: BatchStageDoc, actualEndAt: string): number | null {
  if (stage.duration === null) return null;
  const actualMs = Date.parse(actualEndAt);
  const plannedMs = Date.parse(stage.plannedEndAt);
  if (!Number.isFinite(actualMs) || !Number.isFinite(plannedMs)) return null;
  return Math.round((actualMs - plannedMs) / MS_PER_MINUTE);
}

/**
 * The whole of a run, oldest first.
 *
 * ─── ORDER, AND THE TIEBREAK ────────────────────────────────────────────────────
 *
 * By instant ascending. Two entries at the SAME instant fall back to the order they
 * are built in, which is fixed and carried explicitly rather than left to the
 * engine's sort: the batch starting, then the stages in process order (each one's
 * start, then its completion, then its skip), then the observations in the order the
 * caller supplied, then the abandonment. So a reading taken at the moment a stage
 * ended prints under it, and the same two entries never swap between renders.
 *
 * ─── ONE BOUNDARY, ONE LINE ─────────────────────────────────────────────────────
 *
 * A stage's start is SUPPRESSED when its instant is also some earlier stage's
 * `actualEndAt`. `withStageAdvanced` stamps a stage's end onto its successor's
 * start — the schema calls it "one boundary with two names" — and printing "Bulk
 * ferment — done 22:45" above "Shape — started 22:45" is the same fact twice, which
 * makes a bake read as twice its real length. A start recorded independently
 * (`withStageStarted`: the oven on at 06:40, while the prove still runs) has its own
 * instant and keeps its own line, which is the entire point of that producer.
 *
 * Compared by instant rather than by string, and against any earlier stage rather
 * than only the immediate predecessor: a stage skipped after its start was stamped
 * leaves the boundary attached to the one after it.
 *
 * ─── WHAT IS OMITTED ────────────────────────────────────────────────────────────
 *
 * An entry whose instant cannot be read as a time is left out entirely, rather than
 * sorted arbitrarily to one end. A run abandoned before `abandonedAt` existed
 * carries `null` and simply has no abandonment line: the document never recorded
 * when, and the log does not invent one.
 *
 * There is no `finished` entry, because there is no `finished` state and this must
 * not invent one (see `BatchStateSchema`). A run whose every stage is done ends on
 * its last stage, which is what actually happened.
 */
export function buildBatchLog(
  batch: BatchDoc,
  observations: readonly BatchObservationDoc[],
): BatchLogEntry[] {
  // `seq` is the construction order, kept beside each entry so the tiebreak is
  // mechanical rather than a bet on `Array.prototype.sort` being stable.
  const built: { entry: BatchLogEntry; at: number; seq: number }[] = [];
  let seq = 0;
  const push = (entry: BatchLogEntry): void => {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) return;
    built.push({ entry, at, seq: seq++ });
  };

  push({ kind: 'batchStarted', at: batch.createdAt });

  batch.stages.forEach((stage, index) => {
    if (stage.actualStartAt !== null) {
      const startMs = Date.parse(stage.actualStartAt);
      // Only the ends of stages BEFORE this one can be this one's start. A stage's
      // own end landing on its own start is a zero-length stage, not a boundary.
      const isBoundary = batch.stages
        .slice(0, index)
        .some(
          (earlier) => earlier.actualEndAt !== null && Date.parse(earlier.actualEndAt) === startMs,
        );
      if (!isBoundary) push({ kind: 'stageStarted', at: stage.actualStartAt, stageId: stage.id });
    }
    if (stage.actualEndAt !== null) {
      push({
        kind: 'stageDone',
        at: stage.actualEndAt,
        stageId: stage.id,
        driftMinutes: driftMinutes(stage, stage.actualEndAt),
      });
    }
    // A stage can carry BOTH an end and a skip — start the oven, mark it done, then
    // decide it does not count. `stageStatus` reads that as skipped because the skip
    // is the later decision, but the log is a record of what happened and both
    // things did: each keeps its line, at the instant it was recorded.
    if (stage.skipped !== null) {
      push({
        kind: 'stageSkipped',
        at: stage.skipped.at,
        stageId: stage.id,
        note: stage.skipped.note,
      });
    }
  });

  for (const observation of observations) {
    push({ kind: 'observation', at: observation.at, observation });
  }

  if (batch.abandonedAt !== null) push({ kind: 'batchAbandoned', at: batch.abandonedAt });

  built.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at - b.at));
  return built.map((item) => item.entry);
}
