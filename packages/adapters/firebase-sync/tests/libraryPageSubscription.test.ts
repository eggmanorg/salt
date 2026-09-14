import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockCollection, mockQuery, mockDoc, mockGetFirestore } =
  vi.hoisted(() => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockCollection: vi.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
    mockQuery: vi.fn(),
    mockDoc: vi.fn(() => 'mock-doc-ref'),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }));

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: mockCollection,
  query: mockQuery,
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

import { subscribeLibraryPages } from '../src/libraryPageSubscription.js';
import { classifyFirestoreError } from '../src/firestoreErrors.js';
import type { LibraryPageDoc } from '@salt/domain/schemas';

// The library's read contract (epic #1372). The writers are covered by the
// writer-contract table and the live behaviour against a real emulator by the
// subscription-contract table; what is left for this file is the two decisions
// this module makes on its own — that the read is UNBOUNDED (no query, no index)
// and that it follows the LIST contract, where one unreadable page must not take
// the library down with it.

type Snap = { id: string; data: () => unknown };

function page(over: Partial<LibraryPageDoc> = {}): LibraryPageDoc {
  return {
    id: 'page-1',
    schemaVersion: 1,
    kind: 'note',
    title: 'Weck jars',
    body: '| Model | Brim |\n| --- | --- |\n| 742 | 580 g |',
    tags: ['Fermentation'],
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

function emit(docs: Snap[]): void {
  const onNext = mockOnSnapshot.mock.calls[0]?.[1] as (snap: unknown) => void;
  onNext({
    docs,
    docChanges: () => docs.map((d) => ({ type: 'added', doc: d })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
});

describe('subscribeLibraryPages', () => {
  it('reads the whole collection — no query, so no composite index', () => {
    subscribeLibraryPages(vi.fn(), vi.fn());
    expect(mockCollection).toHaveBeenCalledWith('mock-db', 'libraryPages');
    // The unbounded branch of `subscribeCollection`: the CollectionReference goes
    // straight to `onSnapshot`. Searching and tag filtering are client-side over
    // tens of documents, which is why there is nothing to index.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('delivers every valid page', () => {
    const onPages = vi.fn();
    subscribeLibraryPages(onPages, vi.fn());
    emit([
      { id: 'page-1', data: () => page() },
      { id: 'page-2', data: () => page({ id: 'page-2', title: 'Sous vide' }) },
    ]);
    expect(onPages.mock.calls[0]?.[0].map((p: LibraryPageDoc) => p.id)).toEqual([
      'page-1',
      'page-2',
    ]);
  });

  // The LIST contract. A page that fails validation is skipped and logged; the
  // rest are delivered, and `onError` is not called — a stream-level failure is a
  // different event from a document the schema refused.
  it('skips a corrupt page and still delivers the rest', () => {
    const onPages = vi.fn();
    const onError = vi.fn();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeLibraryPages(onPages, onError);
    emit([
      { id: 'bad', data: () => ({ id: 'bad', title: 42 }) },
      { id: 'page-1', data: () => page() },
    ]);
    expect(onPages.mock.calls[0]?.[0].map((p: LibraryPageDoc) => p.id)).toEqual(['page-1']);
    expect(onError).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  // Classification itself is `classifyFirestoreError`'s job and is pinned by its
  // own suite; what this asserts is the seam — a stream failure CROSSES as a
  // DomainError rather than throwing, with the original error alongside it so a
  // reporting call site upstream can send the real stack.
  it('crosses a stream failure as a classified DomainError, never a throw', () => {
    const onError = vi.fn();
    subscribeLibraryPages(vi.fn(), onError);
    const raw = Object.assign(new Error('nope'), { code: 'permission-denied' });
    expect(() => (mockOnSnapshot.mock.calls[0]?.[2] as (err: unknown) => void)(raw)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(classifyFirestoreError(raw), raw);
  });

  it('returns Firestore’s own unsubscribe', () => {
    expect(subscribeLibraryPages(vi.fn(), vi.fn())).toBe(mockUnsubscribe);
  });
});
