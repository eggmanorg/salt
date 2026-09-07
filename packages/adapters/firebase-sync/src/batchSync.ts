import { getFirestore, doc, setDoc } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import { BatchSchema, type BatchDoc } from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';
import { subscribeDocument } from './subscribeDocument.js';

// Batch persistence (issue #812, phase 1 of epic #778). One document per RUN at
// `batches/{batchId}` — a RANDOM UUID minted by `batchService`, which is the whole
// difference from `formulas/{recipeId}` and `guidedPlans/{recipeId}`: a recipe has
// one formula and many runs. So this collection is both QUERIED (the in-flight
// surface wants every run) and LOOKED UP (a run's own screen wants one).
//
// Family-shared: no `ownerUid`, firestore.rules gates on "signed in" alone, and
// either partner may mark the prove done. Whole-document last-write-wins — the
// document is frozen at start and only its stage times and state ever move, so
// there is nothing to merge.
//
// TWO READ CONTRACTS, because the Zod conventions give list and single-document
// reads different answers, and both are right here:
//
//   • `subscribeBatches` is a LIST read: a corrupt document is skipped and logged
//     and the valid subset is delivered. One unreadable run must not blank the
//     surface that shows the other three.
//   • `subscribeBatch` is a SINGLE-DOCUMENT read, and follows formulaSubscription
//     rather than cookSessionSubscription: a batch is NOT disposable state. It is
//     the log of a run that has been going for hours or weeks, and reporting a
//     failed parse as "no such batch" would invite the screen to offer starting a
//     fresh one over the top. So it surfaces as a StorageError/corruption through
//     `onError` and the caller keeps what it had.
//
// No `deleteBatch`: nothing in this phase removes a run, and abandoning one is a
// STATE (there are no tombstones in this codebase — a delete would be a real
// delete). An unused delete on a family-shared document is a foot-gun waiting for a
// caller.
//
// AND ADDING ONE IS NOT FREE, so this sentence is no longer only a sentence.
// Deleting `batches/{batchId}` does NOT delete its `observations` subcollection —
// those documents survive as Firestore orphans nothing sweeps — so a deleter has
// to cascade, or something has to reclaim them. `apps/cloud-functions/tests/
// maintenance/batchDeleterGuard.test.ts` goes red the moment one appears here
// (#968); read its header before deleting the guard along with this comment.
//
// Writes never throw for operational errors: they cross the boundary as
// Failure<DomainError> (Rule 10). This adapter must not import @salt/observability
// (Rule 4).

const COLLECTION = 'batches';

/**
 * Subscribe to every batch — what the in-flight surface is built on.
 *
 * Unordered and unfiltered on purpose. Ordering is a rendering decision (next
 * action first is not "newest first"), and filtering to running batches would hide
 * exactly the history the log exists for. The collection grows by a handful of
 * documents a month; a `where`/`limit` earns its place when that stops being true.
 */
export function subscribeBatches(
  onBatches: (batches: BatchDoc[]) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [COLLECTION],
      schema: BatchSchema,
      label: 'BatchSchema',
      project: (batch) => batch,
    },
    onBatches,
    onError,
  );
}

/**
 * Subscribe to ONE run. Emits the parsed batch, or `null` when the document
 * genuinely does not exist (a link to a run that was deleted).
 *
 * A document that fails validation is NOT reported as absent: it goes to `onError`
 * as a corruption Failure (see the header).
 */
export function subscribeBatch(
  batchId: string,
  onBatch: (batch: BatchDoc | null) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeDocument(
    {
      path: [COLLECTION, batchId],
      schema: BatchSchema,
      label: 'BatchSchema',
    },
    onBatch,
    onError,
  );
}

/**
 * Write a run. Keyed by `batch.id`, which IS the doc id.
 *
 * Whole-document last-write-wins. Two people marking two different stages done in
 * the same minute is the only way that can bite, and the honest answer is the one
 * the rest of Salt gives: the later write stands. Nothing here merges, and nothing
 * here rescales — the quantities on the document are the ones frozen at start.
 */
export async function saveBatch(batch: BatchDoc): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, COLLECTION, batch.id), { ...batch });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
