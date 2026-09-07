import { getFirestore, doc, setDoc, orderBy } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import { BatchObservationSchema, type BatchObservationDoc } from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';

// The observation log (issue #812, phase 4 of epic #778). One document per entry at
// `batches/{batchId}/observations/{observationId}` — Salt's first purpose-built
// SUBCOLLECTION, the only precedent being `shoppingLists/{listId}/items`.
//
// WHY NOT AN ARRAY FIELD ON THE BATCH, which would have been simpler: the log is
// append-only over WEEKS (a 90-day cure weighed twice a week), and Salt is
// last-write-wins per document. Two people logging a weight on the same day would
// mean the second phone to sync silently erasing the first partner's entry — on
// exactly the record the feature exists to keep. Separate documents make that
// collision impossible, with no merge logic anywhere (there is none in this
// codebase, by design).
//
// FAMILY-SHARED, no `ownerUid`, gated on "signed in" alone exactly as the parent
// run is: one of them weighs the coppa, the other reads what it weighed.
//
// ORDERED BY `at`, ASCENDING, AND ORDERED HERE. `at` is when the reading was
// OBSERVED, not when it was typed, so a back-filled Tuesday weight belongs before
// Thursday's however late it was entered — arrival order would quietly make the
// curve wrong. Firestore's own `orderBy` does it: no index to declare on a single
// field, no cost, and no caller able to forget. (This is also why the epic has no
// `withObservationAdded` domain producer: appending to an array is not a decision,
// and the one decision in the neighbourhood — the order — is answered right here.
// See packages/domain/src/batch/index.ts.)
//
// LIST READ, so a corrupt document is skipped and logged and the valid subset is
// delivered (Zod conventions): one unreadable entry must not blank six weeks of a
// cure's log.
//
// NO DELETE, and no `loadObservations` one-shot. The log is append-only — that is
// the noun — and an unused delete on a family-shared document is a foot-gun waiting
// for a caller. A mis-typed entry is corrected by re-writing the same id, which the
// `setDoc` below already does.
//
// Enforced, not merely asserted: `apps/cloud-functions/tests/maintenance/
// batchDeleterGuard.test.ts` fails if a deleter appears in this file or beside it
// (#968). It guards the Firestore orphans a delete would leave; the photo an entry
// carries is already handled by the `batch-images/` sweep.
//
// Writes never throw for operational errors: they cross the boundary as
// Failure<DomainError> (Rule 10). This adapter must not import @salt/observability
// (Rule 4).

const BATCHES_COLLECTION = 'batches';
const OBSERVATIONS_SUB = 'observations';

/**
 * Subscribe to one run's observation log, oldest reading first.
 *
 * Unfiltered and unpaged: a run's log is tens of documents at the very most, and a
 * cure's whole point is the shape of the whole curve.
 */
export function subscribeBatchObservations(
  batchId: string,
  onObservations: (observations: BatchObservationDoc[]) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [BATCHES_COLLECTION, batchId, OBSERVATIONS_SUB],
      // Ordered by when the reading was OBSERVED — see the header for why that
      // is not arrival order and why the query rather than the caller owns it.
      constraints: [orderBy('at', 'asc')],
      schema: BatchObservationSchema,
      label: 'BatchObservationSchema',
      project: (observation) => observation,
    },
    onObservations,
    onError,
  );
}

/**
 * Append an entry to a run's log. Keyed by `observation.id`, which IS the doc id.
 *
 * Writes the WHOLE observation, which is the honest shape here and not a
 * contradiction of the LWW note above: an entry is one person's reading at one
 * instant, so nobody else is writing this document. The photo is the single
 * exception and it is deliberately not written from the client — the
 * setObservationImageUpload callable stamps `image` on with a partial update after
 * the object is in Storage, so attaching a photo cannot clobber the note it belongs
 * to. That ordering is why the entry must be written FIRST.
 */
export async function addBatchObservation(
  batchId: string,
  observation: BatchObservationDoc,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, BATCHES_COLLECTION, batchId, OBSERVATIONS_SUB, observation.id), {
      ...observation,
    });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
