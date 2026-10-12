import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  writeBatch,
} from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { ShoppingListItem } from '@salt/domain';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import { ShoppingListItemSchema } from '@salt/domain/schemas';
import { classifyFirestoreError } from './firestoreErrors.js';
import { parseDocuments } from './schemaParsing.js';
import { subscribeCollection } from './subscribeCollection.js';

export const LISTS_COLLECTION = 'shoppingLists';
export const ITEMS_SUB = 'items';

export function subscribeShoppingListItems(
  listId: string,
  onItems: (items: ShoppingListItem[]) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      // A SUBCOLLECTION: the items of one list, never every list's items.
      path: [LISTS_COLLECTION, listId, ITEMS_SUB],
      schema: ShoppingListItemSchema,
      label: 'ShoppingListItemSchema',
      // The DOCUMENT id is authoritative, not the `id` field (issue #1114). The
      // two are a copy of each other by construction — every writer here sets
      // the field from the same value it uses as the path segment
      // (`saveShoppingListItem` below, and `moveShoppingListItems`) — but only
      // the field can come back blank, and a blank one is not confined to its
      // own row: `deleteShoppingListItems` and `moveShoppingListItems` build one
      // `writeBatch` for the whole selection, so a single empty id fails the
      // batch and takes every other selected row with it. Taking the id the
      // adapter is already holding makes that structurally impossible rather
      // than merely unlikely. Same move, same reason, as
      // `equipmentIconSubscription.ts:46`.
      //
      // Measured before it was relied on: 0 of 62 item documents across prod,
      // staging and dev carry an `id` that differs from their document id
      // (scripts/audit-shopping-list-fields.mjs, 2026-09-03), so nothing
      // observable changes today.
      project: (item, id) => ({ ...item, id }),
    },
    onItems,
    onError,
  );
}

export async function listShoppingListItems(
  listId: string,
): Promise<ReadResult<readonly ShoppingListItem[], DomainError>> {
  try {
    const db = getFirestore(getApp());
    const snap = await getDocs(collection(db, LISTS_COLLECTION, listId, ITEMS_SUB));
    // Same parse loop as the subscription above (#928, B2-006).
    return success(
      parseDocuments(snap.docs, ShoppingListItemSchema, 'ShoppingListItemSchema', (item, id) => ({
        ...item,
        id,
      })),
    );
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function saveShoppingListItem(
  listId: string,
  item: ShoppingListItem,
  // Distributed-trace correlation (issue #362, Phase 5). When the browser roots a
  // trace at "add to shopping list", it passes the action span's W3C `traceparent`
  // here so it is stamped onto the doc as `traceContext`; the
  // onShoppingListItemWrite trigger reads it back and continues that trace. Plain
  // string only — firebase-sync NEVER imports observability (Rule 4); it just
  // stores the value. Optional + last-positional so every existing call site
  // (edits, check toggles, batch writes) stays unchanged and writes no field.
  traceparent?: string,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await setDoc(doc(db, LISTS_COLLECTION, listId, ITEMS_SUB, item.id), {
      ...item,
      ...(traceparent ? { traceContext: traceparent } : {}),
    });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function deleteShoppingListItem(
  listId: string,
  itemId: string,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, LISTS_COLLECTION, listId, ITEMS_SUB, itemId));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function deleteShoppingListItems(
  listId: string,
  itemIds: readonly string[],
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const batch = writeBatch(db);
    for (const itemId of itemIds) {
      batch.delete(doc(db, LISTS_COLLECTION, listId, ITEMS_SUB, itemId));
    }
    await batch.commit();
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function moveShoppingListItems(
  sourceListId: string,
  targetListId: string,
  items: readonly ShoppingListItem[],
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const batch = writeBatch(db);
    for (const item of items) {
      batch.delete(doc(db, LISTS_COLLECTION, sourceListId, ITEMS_SUB, item.id));
      batch.set(doc(db, LISTS_COLLECTION, targetListId, ITEMS_SUB, item.id), { ...item });
    }
    await batch.commit();
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
