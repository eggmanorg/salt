import { getFirestore, doc, setDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { Defrost } from '@salt/domain';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import {
  DefrostSchema,
  DEFROSTS_COLLECTION,
  FREEZER_ITEMS_COLLECTION,
  defrostDocId,
  freezerItemDocId,
} from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';
import { isNotFound, queueFreezerTake } from './freezerItemSync.js';
import { ITEMS_SUB, LISTS_COLLECTION } from './shoppingListItemSubscription.js';

// Packs promised out of the freezer (issue #1685) — `defrosts/{number}_{recipe}`,
// family-shared. One is written, atomically with the stock decrement and the
// shopping row's removal, by `commitFromFreezer`; it is deleted by Got it out in
// Kitchen and put back, whole, by that toast's Undo.

/**
 * Every Kitchen item, live. A LIST read: a document the schema refuses is skipped
 * and logged, and the valid rest is delivered.
 */
export function subscribeDefrosts(
  onDefrosts: (defrosts: Defrost[]) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [DEFROSTS_COLLECTION],
      schema: DefrostSchema,
      label: 'DefrostSchema',
      project: (defrost) => defrost,
    },
    onDefrosts,
    onError,
  );
}

export interface CommitFromFreezerInput {
  /** The bag number the packs come out of. */
  readonly itemNumber: number;
  /** What to add to its `amount` — negative, from `takeFreezerPacks`. */
  readonly take: number;
  /** The packs taken were the last: the entry goes too. */
  readonly removeItem: boolean;
  /** The Kitchen item to write whole, from `commitDefrost`. */
  readonly defrost: Defrost;
  /** The ONE shopping row it replaces — a contributor, never a whole combined row. */
  readonly shoppingRow?: { readonly listId: string; readonly itemId: string };
}

/**
 * Use packs from the freezer, as ONE `writeBatch`: the decrement, the Kitchen
 * item and the shopping row's removal apply together or not at all — a row never
 * vanishes without the pack being spoken for, and a pack is never spoken for
 * without a Kitchen item.
 *
 * The take is always queued, even for the last pack, and the delete follows it in
 * the same batch: an `update` on an item another phone has already removed fails
 * the batch `not-found`, so nothing applies, where a lone `delete` would succeed
 * on the missing document and write the Kitchen item anyway. `not-found` is
 * mapped to NotFound, as `takeFreezerItemAmount` maps it, and is not reported.
 */
export async function commitFromFreezer(
  input: CommitFromFreezerInput,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const batch = writeBatch(db);
    queueFreezerTake(batch, db, input.itemNumber, input.take);
    if (input.removeItem) {
      batch.delete(doc(db, FREEZER_ITEMS_COLLECTION, freezerItemDocId(input.itemNumber)));
    }
    batch.set(doc(db, DEFROSTS_COLLECTION, defrostIdOf(input.defrost)), { ...input.defrost });
    if (input.shoppingRow) {
      batch.delete(
        doc(db, LISTS_COLLECTION, input.shoppingRow.listId, ITEMS_SUB, input.shoppingRow.itemId),
      );
    }
    await batch.commit();
    return success(undefined);
  } catch (err) {
    if (isNotFound(err)) {
      return failure({ kind: 'NotFound', resource: 'freezerItem', id: String(input.itemNumber) });
    }
    return failure(classifyFirestoreError(err));
  }
}

/** Write a Kitchen item whole at its id — Got it out's Undo. */
export async function saveDefrost(defrost: Defrost): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, DEFROSTS_COLLECTION, defrostIdOf(defrost)), { ...defrost });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

/** Got it out: delete the Kitchen item, for everybody. Deleting an absent one is a no-op. */
export async function deleteDefrost(id: string): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, DEFROSTS_COLLECTION, id));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

function defrostIdOf(defrost: Defrost): string {
  return defrostDocId(defrost.freezerNumber, defrost.recipeId);
}
