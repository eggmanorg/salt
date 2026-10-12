/**
 * Shopping-list reads — what the two contract nets do not hold (#928, #939).
 *
 * `createShoppingList`, `renameShoppingList` and `deleteShoppingList` moved to
 * `tests/writerContract.test.ts` — including `renameShoppingList`'s partial
 * `updateDoc`, whose exact payload is a row there. The collection target, the unsubscribe, the delivered id set, the empty
 * collection and the corrupt-document skip moved to the `subscribeShoppingLists`
 * row of `tests/subscriptionContract.emulator.test.ts`, which seeds a decoy in a
 * same-named subcollection so a widening to `collectionGroup` costs something.
 *
 * What is left is what neither net can see:
 *
 *   1. THE DELIVERED DOCUMENT, including what the schema does with a document
 *      that is missing everything. The contract net normalises the row to a list
 *      of ids, so a lost field is invisible to it — and `ShoppingListSchema`
 *      defaulting rather than refusing is the difference between a legacy
 *      document appearing with an empty name and vanishing from the list
 *      entirely.
 *   2. THE STREAM path and its arity — two arguments, the second the raw
 *      Firestore error. No emulator row drives a collection subscription's
 *      error callback.
 *   3. `listShoppingLists`, the one-shot `getDocs`. `writerContract.test.ts`
 *      classifies it as a `'read'` and covers no reads; the subscription net
 *      covers no one-shots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockGetDocs, mockDoc, mockCollection, mockGetFirestore } =
  vi.hoisted(() => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockGetDocs: vi.fn(),
    mockDoc: vi.fn(() => 'mock-doc-ref'),
    mockCollection: vi.fn(() => 'mock-collection-ref'),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }));

vi.mock('firebase/app', () => ({
  getApp: vi.fn(() => ({})),
}));

// The SDK boundary (UT-B3). The write primitives are declared because the module
// imports them; the writers answer to writerContract.test.ts.
vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: mockCollection,
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocs: mockGetDocs,
  updateDoc: vi.fn(),
}));

import { subscribeShoppingLists, listShoppingLists } from '../src/shoppingListSubscription.js';
import type { ShoppingList } from '@salt/domain';

type SnapDoc = { id: string; data: () => unknown };
type SnapCallback = (snap: QuerySnapshotDouble) => void;
type ErrorCallback = (err: Error & { code?: string }) => void;

/**
 * As much of a `QuerySnapshot` as the parse loop reads — BOTH halves of it.
 * `subscribeCollection` asks which documents changed (#939) and re-parses only
 * those, so a double carrying `docs` alone lies about the SDK and fails on
 * `snap.docChanges is not a function` rather than on any behaviour.
 */
interface QuerySnapshotDouble {
  docs: SnapDoc[];
  docChanges: () => { type: 'added'; doc: SnapDoc; oldIndex: number; newIndex: number }[];
}

/** Every document reported as `added` — which is what a real FIRST snapshot says. */
function firstSnapshot(docs: SnapDoc[]): QuerySnapshotDouble {
  return {
    docs,
    docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })),
  };
}

const LIST_1: ShoppingList = {
  id: 'list-1',
  name: 'Weekly Shop',
  schemaVersion: 1,
  createdAt: '2026-05-14T10:00:00.000Z',
  updatedAt: '2026-05-14T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  mockGetDocs.mockResolvedValue({ docs: [] });
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeShoppingLists', () => {
  it('delivers each list exactly as it was stored', () => {
    const delivered: ShoppingList[][] = [];
    subscribeShoppingLists(
      (lists) => delivered.push(lists),
      () => {},
    );

    (mockOnSnapshot.mock.calls[0]![1] as SnapCallback)(
      firstSnapshot([{ id: LIST_1.id, data: () => ({ ...LIST_1 }) }]),
    );

    expect(delivered).toEqual([[LIST_1]]);
  });

  it('SKIPS a document missing fields rather than delivering it with blanks', () => {
    // This row used to assert the opposite, and the inversion IS the fix
    // (#1114). `ShoppingListSchema` defaulted every field, so a document with
    // pieces missing did not fail — it was filled in and delivered as a real,
    // unnamed list. The parse loop's whole contract is to skip an invalid
    // document and log it, and it was never given a failure to act on.
    const delivered: ShoppingList[][] = [];
    const errors: unknown[][] = [];
    subscribeShoppingLists(
      (lists) => delivered.push(lists),
      (...args) => errors.push(args),
    );

    (mockOnSnapshot.mock.calls[0]![1] as SnapCallback)(
      firstSnapshot([
        { id: 'legacy', data: () => ({}) },
        { id: LIST_1.id, data: () => ({ ...LIST_1 }) },
      ]),
    );

    // Skipped, not rejected wholesale: one bad document must never fail the
    // whole read, so the good list beside it still arrives.
    expect(delivered).toEqual([[LIST_1]]);
    expect(errors).toEqual([]);
  });

  it('classifies a stream error and forwards the raw one alongside it', () => {
    const calls: unknown[][] = [];
    subscribeShoppingLists(
      () => {},
      (...args) => calls.push(args),
    );

    const raw = Object.assign(new Error('err'), { code: 'permission-denied' });
    (mockOnSnapshot.mock.calls[0]![2] as ErrorCallback)(raw);

    // TWO arguments — see the header (#928 finding B2-009).
    expect(calls).toEqual([[{ kind: 'AuthError', reason: 'forbidden' }, raw]]);
  });
});

/**
 * The delivered `id` is the DOCUMENT id, never the `id` field (#1114).
 *
 * The field is a copy of the document id at every writer, so on real data these
 * two disagree nowhere — the audit found 0 of 12 list documents differing
 * across prod, staging and dev. What the projection buys is that a blank
 * `listId` is now structurally impossible rather than merely unobserved, and a
 * blank `listId` is the worst id in the feature: it is the path segment every
 * row read and write inside the list is built from.
 *
 * Both reads are driven, because they are two call sites of the same decision
 * and only a test of each stops one drifting from the other.
 */
describe('shopping lists — the delivered id', () => {
  const cases = [
    { name: 'an empty id field', stored: { ...LIST_1, id: '' } },
    { name: 'an id field disagreeing with the document', stored: { ...LIST_1, id: 'stale-id' } },
  ];

  it.each(cases)('the subscription delivers the document id despite $name', ({ stored }) => {
    const delivered: ShoppingList[][] = [];
    subscribeShoppingLists(
      (lists) => delivered.push(lists),
      () => {},
    );

    (mockOnSnapshot.mock.calls[0]![1] as SnapCallback)(
      firstSnapshot([{ id: 'list-1', data: () => stored }]),
    );

    expect(delivered).toEqual([[LIST_1]]);
  });

  it.each(cases)('listShoppingLists delivers the document id despite $name', async ({ stored }) => {
    mockGetDocs.mockResolvedValue({ docs: [{ id: 'list-1', data: () => stored }] });

    const result = await listShoppingLists();

    expect(result).toEqual({ kind: 'ok', value: [LIST_1] });
  });
});

describe('listShoppingLists', () => {
  it('reads the shoppingLists collection and returns the mapped lists', async () => {
    mockGetDocs.mockResolvedValue({ docs: [{ id: LIST_1.id, data: () => ({ ...LIST_1 }) }] });

    const result = await listShoppingLists();

    expect(mockCollection).toHaveBeenCalledWith('mock-db', 'shoppingLists');
    expect(result).toEqual({ kind: 'ok', value: [LIST_1] });
  });

  it('returns a Failure (never throws) on a Firestore error', async () => {
    mockGetDocs.mockRejectedValue(Object.assign(new Error('err'), { code: 'unauthenticated' }));

    const result = await listShoppingLists();

    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'unauthenticated' },
    });
  });
});
