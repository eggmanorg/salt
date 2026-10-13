/**
 * `commitFromFreezer`'s own mapping of `not-found` to NotFound (issue #1685) —
 * the one thing the writer-contract row, whose failure is the classified kind,
 * does not reach. The batch's shape is that row; that a commit against a removed
 * item applies nothing is `tests/defrostSync.emulator.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

const { mockCommit, mockOnSnapshot } = vi.hoisted(() => ({
  mockCommit: vi.fn(),
  mockOnSnapshot: vi.fn(() => vi.fn()),
}));

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => 'db'),
  collection: vi.fn(),
  doc: vi.fn(),
  onSnapshot: mockOnSnapshot,
  query: vi.fn(),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateDoc: vi.fn(),
  getDocs: vi.fn(),
  increment: vi.fn((n: number) => ({ __increment: n })),
  writeBatch: vi.fn(() => ({ set: vi.fn(), update: vi.fn(), delete: vi.fn(), commit: mockCommit })),
}));

import { commitFromFreezer, subscribeDefrosts } from '../src/defrostSync.js';

const INPUT = {
  itemNumber: 47,
  take: -1,
  removeItem: false,
  defrost: {
    schemaVersion: 1 as const,
    freezerNumber: 47,
    name: 'Pork loin',
    location: 'Garage · shelf B',
    recipeId: null,
    recipeTitle: null,
    amount: 1,
    committedAt: '2026-10-12T09:00:00.000Z',
    forDate: null,
  },
};

describe('commitFromFreezer', () => {
  it('answers NotFound — not a reported StorageError — when the item has gone', async () => {
    mockCommit.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not-found' }));

    await expect(commitFromFreezer(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NotFound', resource: 'freezerItem', id: '47' },
    });
  });
});

describe('subscribeDefrosts', () => {
  it('delivers each Kitchen item whole', () => {
    const delivered: unknown[] = [];
    subscribeDefrosts((ds) => delivered.push(ds), vi.fn());

    const docs = [{ id: '047_manual', data: () => INPUT.defrost }];
    const onSnap = (mockOnSnapshot.mock.calls[0] as unknown[])[1] as (snap: unknown) => void;
    onSnap({
      docs,
      docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })),
    });

    expect(delivered).toEqual([[INPUT.defrost]]);
  });
});
