import { getFirestore, doc, setDoc, deleteDoc, updateDoc, increment } from 'firebase/firestore';
import type { Firestore, WriteBatch } from 'firebase/firestore';
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
//
// `increment` is a Firebase SDK sentinel, so Rule 2 confines it to this package,
// as in `canonPurchaseSync.ts`; the domain hands over a delta, never a sentinel.

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

/** Remove the item at `number`. Deleting an absent one is a no-op. */
export async function deleteFreezerItem(number: number): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(number)));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

/**
 * Take packs out: `amount` moves by `delta` (negative) as a server-applied
 * transform, so two devices taking at once — one replaying an offline queue —
 * both count: five less two is three. It cannot stop at zero; `displayAmount`
 * clamps what is shown.
 *
 * `updateDoc`, NOT `canonPurchaseSync`'s `setDoc(…, { merge: true })`: a take
 * arriving after another device removed the item must not recreate a partial
 * `{ amount, updatedAt }` document that fails the schema and holds the number.
 * `updateDoc` refuses with `not-found` instead, which `classifyFirestoreError`
 * would report as a StorageError; it is mapped here to NotFound, which is not.
 */
export async function takeFreezerItemAmount(
  number: number,
  delta: number,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await updateDoc(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(number)), {
      amount: increment(delta),
      updatedAt: new Date().toISOString(),
    });
    return success(undefined);
  } catch (err) {
    if (isNotFound(err)) {
      return failure({ kind: 'NotFound', resource: 'freezerItem', id: String(number) });
    }
    return failure(classifyFirestoreError(err));
  }
}

/**
 * The same take, queued on a caller's batch rather than sent alone — for
 * `commitFromFreezer` (issue #1685), which must apply it atomically with the
 * Kitchen item and the shopping row. Kept here so the take-a-pack transform has
 * one home (the `fieldTransforms` test counts the files that import one). A
 * batch whose take finds the item gone fails `not-found` as a whole; map it with
 * `isNotFound`.
 */
export function queueFreezerTake(
  batch: WriteBatch,
  db: Firestore,
  number: number,
  delta: number,
): void {
  batch.update(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(number)), {
    amount: increment(delta),
    updatedAt: new Date().toISOString(),
  });
}

/** Firestore's `not-found` — an `update` on a document that is not there. */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'not-found'
  );
}
