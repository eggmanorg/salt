import type { BatchDoc, BatchObservationDoc } from '../schemas/index.js';

// HOW FAR ALONG A RUN IS (issue #1407, phase 04 of epic #778) — the first live
// number a batch screen has ever shown.
//
// Salt already records every weighing on a run and says nothing at all about what
// they add up to; you have the readings and do the arithmetic in your head. This is
// that arithmetic, once, so `1 780 g` can read as `26% lost of 35%`.
//
// ─── WHY IT IS HERE AND NOT BESIDE THE OTHER BATCH DISPLAY HELPERS ─────────────
//
// `apps/web-pwa/src/routes/batches/batchDisplay.ts` states as a deliberate
// property that NOTHING THERE COMPUTES A QUANTITY OR A TIME — every number a batch
// screen shows was frozen when the run started. Percent lost is the first number
// that is not frozen, so the computation lives here, in the pure module, and that
// sentence stays literally true of the display layer. What the display layer does
// with what this returns is choose words for it.
//
// ─── IT DECIDES NOTHING ───────────────────────────────────────────────────────
//
// There is no "finished", no "ready", no "overdue", no verdict of any kind, and
// nothing downstream blocks or warns on what comes back. PAST THE TARGET THE FIGURE
// KEEPS COUNTING — 38 lost of 35 — because the figure is a fact and stopping is a
// judgement, and only one of those is Salt's. `BatchStateSchema` says the same
// thing from the other end: there is no `finished` state and there will not be one.
//
// There is also NO ESTIMATE OF WHEN a run will reach its target — not here, not
// rendered, not as dormant code. A cure is done on feel and experience, and a
// projected date would be a confident number that is usually wrong.
//
// ─── A LIMIT, STATED RATHER THAN IMPLIED (CLAUDE.md rule 12) ──────────────────
//
// NOTHING CHECKS THAT A LOGGED WEIGHT MEASURES THE SAME THING `basisGrams` FROZE.
// Weigh one salami out of a batch of five and the percentage is nonsense, and Salt
// will render it without comment. Observations carry a `stageId` and no piece
// identity (see `BatchObservationSchema`), so there is nothing here to check
// against. Per-piece tracking is not in this issue and must not be read into it.
//
// The starting weight is `batch.totals.basisGrams` — for a basis-driven solve, the
// weight of what went in — and this reads whatever was frozen there without asking
// how that figure was arrived at.

/** The weight half, when the run names a weight-loss target and has been weighed. */
export interface WeightLossProgress {
  /** `batch.totals.basisGrams`, as frozen at the start of the run. */
  startingGrams: number;
  /** The most recent weighing, by WHEN IT WAS OBSERVED. */
  latestGrams: number;
  /**
   * Percent of the starting weight lost, UNROUNDED — the display layer rounds.
   *
   * It may exceed the target (a run taken further) and it may be NEGATIVE (a run
   * that gained weight, which a brine does). Both are facts about the log and
   * neither is corrected here.
   */
  percentLost: number;
  /** What the run was aiming at, frozen. */
  targetPercent: number;
}

/**
 * The pH half — the LATEST READING AGAINST ITS TARGET, with no percentage and no
 * bar anywhere downstream.
 *
 * A pH curve has no frozen zero: nothing records the meat's pH before fermentation,
 * and freezing the first observation instead would make the same run show different
 * progress depending on when somebody first happened to measure it. Inventing a
 * starting pH is precisely the made-up coefficient the fermentation-model ban
 * exists to stop.
 */
export interface PhProgress {
  /** The most recent pH reading, by when it was observed. */
  latest: number;
  /** "Below this", frozen. */
  targetAtMost: number;
}

export interface TargetProgress {
  weightLoss: WeightLossProgress | null;
  ph: PhProgress | null;
}

/**
 * The most recent observation carrying a measurement, by `at` — WHEN IT WAS
 * OBSERVED, never when it arrived.
 *
 * The log arrives ordered (`subscribeBatchObservations` uses a Firestore
 * `orderBy('at')`), and this deliberately does not rely on that: it takes the
 * maximum itself, so a caller holding an unsorted array gets the same answer.
 * Entries whose `at` cannot be read as an instant are skipped — an entry with no
 * readable instant has no place in an ordering — and a tie on `at` is broken by
 * position, so the later-constructed entry wins.
 */
function latestBy<T>(
  observations: readonly BatchObservationDoc[],
  read: (observation: BatchObservationDoc) => T | null,
): T | null {
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const value = read(observation);
    if (value === null) continue;
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at)) continue;
    if (at >= bestAt) {
      best = value;
      bestAt = at;
    }
  }
  return best;
}

/**
 * How far along a run is against what it was aiming at, or `null` when there is
 * nothing to say.
 *
 * `null` in three cases, and they are the same case seen from different sides:
 * the run carries no target at all; the target names a figure but nothing has been
 * measured against it yet; or — only possible for a weight target — the run froze a
 * starting weight of zero, which nothing can be a percentage of.
 *
 * The two halves are independent. A salami with both a weight and a pH target that
 * has only ever been weighed comes back with the weight half filled and the pH half
 * `null`, and the screen shows the one figure it has.
 */
export function targetProgress(
  batch: BatchDoc,
  observations: readonly BatchObservationDoc[],
): TargetProgress | null {
  const target = batch.target;
  if (target === null) return null;

  const startingGrams = batch.totals.basisGrams;
  const latestGrams =
    target.weightLossPercent === null || startingGrams <= 0
      ? null
      : latestBy(observations, (observation) => observation.weightGrams);

  const weightLoss: WeightLossProgress | null =
    target.weightLossPercent === null || latestGrams === null
      ? null
      : {
          startingGrams,
          latestGrams,
          percentLost: ((startingGrams - latestGrams) / startingGrams) * 100,
          targetPercent: target.weightLossPercent,
        };

  const latestPh =
    target.phAtMost === null ? null : latestBy(observations, (observation) => observation.ph);
  const ph: PhProgress | null =
    target.phAtMost === null || latestPh === null
      ? null
      : { latest: latestPh, targetAtMost: target.phAtMost };

  // A target nothing has been measured against yet is the same as no figure to
  // show: the caller renders nothing, rather than a meter at zero for a run
  // nobody has put on the scales.
  if (weightLoss === null && ph === null) return null;
  return { weightLoss, ph };
}
