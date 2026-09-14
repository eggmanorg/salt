import { getFirestore, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import {
  LibraryPageSchema,
  LIBRARY_PAGE_COLLECTION,
  type LibraryPageDoc,
} from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';

// The library (epic #1372) — the household's reference pages. One document per page
// at `libraryPages/{id}`, a random id, so this is a COLLECTION subscription.
//
// UNFILTERED AND UNORDERED on the wire, deliberately: the library is tens of
// documents, and searching titles and filtering by tag happen client-side over the
// delivered list. That is why there is no `firestore.indexes.json` entry — a
// composite index exists to make a query cheap, and there is no query.
//
// FAMILY-SHARED, like kitchenMemories beside it: no `ownerUid`, no pinning, and
// firestore.rules gates on "signed in" alone. `createdBy`/`lastEditedBy` are display
// NAMES denormalised at write time, never uids.
//
// Read contract: the LIST contract, like recipeSubscription and kitchenMemories. A
// page that fails validation is skipped and logged and the valid ones are delivered
// — one corrupt document must not empty the library.
//
// Writes never throw for operational errors: they cross the boundary as
// Failure<DomainError> (Rule 10). This adapter must not import @salt/observability
// (Rule 4).

// Named alongside the schema because Phase 4's chef reads the same collection
// through the Admin SDK — one name, two runtimes, no second literal to drift.
const COLLECTION = LIBRARY_PAGE_COLLECTION;

/**
 * Subscribe to every library page. Both members see the same set, live — subject
 * to the browser-side feature gate, which hides the SURFACE and not the data
 * (see apps/web-pwa/src/lib/featureGate.ts).
 */
export function subscribeLibraryPages(
  onPages: (pages: LibraryPageDoc[]) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [COLLECTION],
      schema: LibraryPageSchema,
      label: 'LibraryPageSchema',
      project: (page) => page,
    },
    onPages,
    onError,
  );
}

/**
 * Write a page. Keyed by `page.id`; whole-document last-write-wins, exactly as
 * everything else in Salt — the `revisions` array travelling inside the document
 * is what makes a clobbered page recoverable, not a different write shape.
 */
export async function saveLibraryPage(
  page: LibraryPageDoc,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, COLLECTION, page.id), { ...page });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

/**
 * Delete a page, and its history with it. A real delete, not a flag — Firestore is
 * the master and there are no tombstones in this codebase. Idempotent on an absent
 * document, as Firestore's own `deleteDoc` is.
 */
export async function deleteLibraryPage(id: string): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, COLLECTION, id));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
