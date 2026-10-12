import { getFirestore, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { FreezerItem } from '@salt/domain';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import {
  FreezerItemSchema,
  FREEZER_ITEMS_COLLECTION,
  freezerItemDocId,
} from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';

// What is in the freezers (issue #1684) — `freezerItems/{number}`, one document
// per bag number, family-shared. The id is the number zero-padded
// (`freezerItemDocId`), so a move rewrites the document in place.

/**
 * Every item, live. A LIST read, so it follows the list contract: a document the
 * schema refuses is skipped and logged, and the valid rest is delivered — one bad
 * document must not empty the freezer page.
 */
export function subscribeFreezerItems(
  onItems: (items: FreezerItem[]) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [FREEZER_ITEMS_COLLECTION],
      schema: FreezerItemSchema,
      label: 'FreezerItemSchema',
      project: (item) => item,
    },
    onItems,
    onError,
  );
}

/**
 * Write an item whole at its number — adding, editing and moving alike.
 * Whole-document LWW, no field transform: an edit made from a copy that had not
 * yet seen another device's change overwrites it.
 */
export async function saveFreezerItem(item: FreezerItem): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(item.number)), { ...item });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

/** Remove the item at `number`, freeing the number. Deleting an absent one is a no-op. */
export async function deleteFreezerItem(number: number): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(number)));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
