import type { BatchDoc } from '../schemas/index.js';

// The batch cook page's two check-off lists (issue #1327), as pure producers over
// the run — the same shape and the same rules as `./transitions.ts`: take the
// document, return a new one, never mutate, never read a clock, never stamp
// `updatedAt` (the write path owns that).
//
// NAMED `withBatch…` RATHER THAN `withIngredientChecked` / `withStepDone`. Those
// two names are already taken at the domain's public surface by the cook SESSION's
// producers (`cookSession/withIngredientChecked.ts`, `withStepDone.ts`), which the
// two recipe cook screens use. A batch is not a cook session and its ticks live on
// a different document, so these are different functions — and giving them the
// same name would mean one of the two could only ever be imported through a deep
// path, which is exactly the kind of near-identical import a later edit picks the
// wrong one of.
//
// IDENTITY WHEN NOTHING CHANGES, and that is load-bearing rather than an
// optimisation: `batchService` skips the write when the producer returns the
// document it was given, so a re-tap on an already-ticked row costs no Firestore
// write and no `updatedAt` bump.
//
// NEITHER TOUCHES `stages`. A tick is not a stage transition: it re-times nothing,
// it starts nothing, and the reminder trigger's diff key is
// `${stage.id}@${plannedStartAt}` — so a tick write enqueues no push. That claim is
// pinned in `apps/cloud-functions/tests/triggers/onBatchWritten.test.ts`, not just
// stated here.

/** Add or remove `id` from a list, returning the same array when nothing moves. */
function withMembership(ids: readonly string[], id: string, present: boolean): readonly string[] {
  const has = ids.includes(id);
  if (has === present) return ids;
  return present ? [...ids, id] : ids.filter((existing) => existing !== id);
}

/**
 * Tick (or untick) one weigh-out row.
 *
 * EXPLICIT `checked` rather than a toggle: the row's state comes from the document
 * everyone on the batch shares, so a toggle computed from a stale local snapshot
 * would flip the wrong way when two phones are on the same bake.
 *
 * Total — an id that names nothing is stored as given, exactly as an observation's
 * `stageId` is. Nothing here knows what the run's ingredients are.
 */
export function withBatchIngredientChecked(
  batch: BatchDoc,
  id: string,
  checked: boolean,
): BatchDoc {
  const next = withMembership(batch.checkedIngredientIds, id, checked);
  if (next === batch.checkedIngredientIds) return batch;
  return { ...batch, checkedIngredientIds: [...next] };
}

/**
 * Mark (or unmark) one recipe step done on this run.
 *
 * The steps are the LIVE recipe's, so an id here can outlive the step it names —
 * see `BatchSchema.completedStepIds` for why that is harmless.
 */
export function withBatchStepDone(batch: BatchDoc, id: string, done: boolean): BatchDoc {
  const next = withMembership(batch.completedStepIds, id, done);
  if (next === batch.completedStepIds) return batch;
  return { ...batch, completedStepIds: [...next] };
}
