/**
 * Freezer stock reads (issue #1684) — what the two contract nets do not hold.
 *
 * `saveFreezerItem` and `deleteFreezerItem` answer to `tests/writerContract.test.ts`
 * (the zero-padded path, the whole payload, the classified `Failure`). The
 * delivered set, the corrupt-document skip and the nested decoy are the
 * `subscribeFreezerItems` row of `tests/subscriptionContract.emulator.test.ts`.
 *
 * Left here: the delivered DOCUMENT, whole — the contract row normalises to ids,
 * so a projection that dropped `shelf` or `purchasedFrom` would pass it — and
 * the stream path with its raw error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockCollection, mockGetFirestore } = vi.hoisted(() => ({
  mockUnsubscribe: vi.fn(),
  mockOnSnapshot: vi.fn(),
  mockCollection: vi.fn(() => 'mock-collection-ref'),
  mockGetFirestore: vi.fn(() => 'mock-db'),
}));

vi.mock('firebase/app', () => ({
  getApp: vi.fn(() => ({})),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: mockCollection,
  doc: vi.fn(),
  onSnapshot: mockOnSnapshot,
  query: vi.fn(),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
}));

import { subscribeFreezerItems } from '../src/freezerItemSync.js';
import type { FreezerItemDoc } from '@salt/domain/schemas';

type SnapDoc = { id: string; data: () => unknown };
type ErrorCallback = (err: Error & { code?: string }) => void;
type SnapCallback = (snap: {
  docs: SnapDoc[];
  docChanges: () => { type: 'added'; doc: SnapDoc; oldIndex: number; newIndex: number }[];
}) => void;

const ITEM: FreezerItemDoc = {
  schemaVersion: 1,
  number: 47,
  name: 'Pork loin',
  freezerId: 'fz-garage',
  shelf: 'B',
  amount: 5,
  canonId: null,
  recipeId: null,
  purchasedFrom: 'Swaledale',
  addedAt: '2026-06-12T09:00:00.000Z',
  updatedAt: '2026-06-12T09:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeFreezerItems', () => {
  it('reads the whole freezerItems collection and returns the listener unsubscribe', () => {
    const unsub = subscribeFreezerItems(
      () => {},
      () => {},
    );
    expect(mockCollection).toHaveBeenCalledWith('mock-db', 'freezerItems');
    expect(mockOnSnapshot.mock.calls[0]![0]).toBe('mock-collection-ref');
    expect(unsub).toBe(mockUnsubscribe);
  });

  it('delivers each item exactly as stored, and skips one the schema refuses', () => {
    const delivered: FreezerItemDoc[][] = [];
    subscribeFreezerItems(
      (items) => delivered.push(items),
      () => {},
    );

    const docs: SnapDoc[] = [
      { id: '047', data: () => ITEM },
      { id: '048', data: () => ({ ...ITEM, number: 48, amount: 1.5 }) },
    ];
    (mockOnSnapshot.mock.calls[0]![1] as SnapCallback)({
      docs,
      docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })),
    });

    expect(delivered).toEqual([[ITEM]]);
  });

  it('classifies a stream error and forwards the raw one alongside it', () => {
    const calls: unknown[][] = [];
    subscribeFreezerItems(
      () => {},
      (...args) => calls.push(args),
    );

    const err = Object.assign(new Error('nope'), { code: 'permission-denied' });
    (mockOnSnapshot.mock.calls[0]![2] as ErrorCallback)(err);

    expect(calls).toEqual([[{ kind: 'AuthError', reason: 'forbidden' }, err]]);
  });
});
