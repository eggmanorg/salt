/**
 * The recipe module's reads — what the two contract nets do not hold (#928, #939).
 *
 * Gone from this file, because they are held harder elsewhere:
 *   • the collection target, the unsubscribe, the delivered id set and the
 *     corrupt-document skip — `tests/subscriptionContract.emulator.test.ts`,
 *     the `subscribeRecipes` row, against a real emulator;
 *   • `saveRecipeDoc` / `deleteRecipe` — `tests/writerContract.test.ts`, which pins
 *     the exact op, path and payload and the classified `Failure` on three
 *     Firestore codes.
 *
 * What is left is what neither net can see:
 *
 *   1. THE DELIVERED DOCUMENT. The contract net normalises every collection row
 *      to a list of ids (its own `projection` field says so: a per-document
 *      transform is invisible to it, and only canon declares one). Its recipe
 *      fixture is deliberately minimal — empty `ingredients`, empty `steps` — so
 *      nothing there would notice a parse that dropped the nested quantity union
 *      off a real recipe. The fixture below is a populated one and the assertion
 *      is whole-object equality.
 *   2. THE STREAM PATH, and that it forwards the RAW error alongside the
 *      classified one — the one arity every subscription now declares, since
 *      #928 Phase 1 deleted the `forwardsRawError` field that held the
 *      asymmetry with `subscribeMembers` open (finding B2-009). No emulator row
 *      exercises it, because provoking a stream error would mean revoking a
 *      rule mid-listen.
 *   3. `loadRecipe`, a one-shot `getDoc`. `writerContract.test.ts` classifies it
 *      as a `'read'` and covers no reads; the subscription net covers no
 *      one-shots. The single-document read contract — `null` for absent,
 *      `StorageError`/`corruption` for a document that fails its schema — lives
 *      only here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockGetDoc, mockDoc, mockCollection, mockGetFirestore } =
  vi.hoisted(() => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockGetDoc: vi.fn(),
    mockDoc: vi.fn(() => 'mock-doc-ref'),
    mockCollection: vi.fn(() => 'mock-collection-ref'),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }));

vi.mock('firebase/app', () => ({
  getApp: vi.fn(() => ({})),
}));

// The SDK boundary (UT-B3). `setDoc`/`deleteDoc` are declared because the module
// imports them; the writers answer to writerContract.test.ts.
vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: mockCollection,
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDoc: mockGetDoc,
}));

import { subscribeRecipes, loadRecipe } from '../src/recipeSubscription.js';
import type { Recipe } from '@salt/domain';
import { emptyRecipe } from '@salt/domain';

type SnapDoc = { id: string; data: () => unknown };
type CollectionCallback = (snap: QuerySnapshotDouble) => void;
type ErrorCallback = (err: Error & { code?: string }) => void;

/**
 * As much of a `QuerySnapshot` as the parse loop reads — BOTH halves of it.
 *
 * `subscribeCollection` asks a snapshot which documents actually changed (#939)
 * and re-parses only those, so a double carrying `docs` alone is a double that
 * lies about the SDK: the code under test can no longer tell a first snapshot
 * from an update, and every test built on it dies on
 * `snap.docChanges is not a function` — an error about the fixture wearing the
 * costume of a behaviour failure (UT-H1).
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

// A recipe with the nested shapes a minimal fixture cannot exercise: an
// ingredient group, a parsed quantity union, and a display string.
const RECIPE: Recipe = {
  ...emptyRecipe('recipe-1', '2026-06-11T10:00:00.000Z'),
  title: 'Round-trip Recipe',
  ingredients: [
    {
      id: 'grp-1',
      name: 'For the sauce',
      items: [
        {
          id: 'ing-1',
          rawText: '1 ½ cups passata',
          parsed: {
            quantity: { type: 'single', value: 360 },
            unit: 'ml',
            item: 'passata',
            preparation: [],
            notes: null,
            displayText: '1½ cups',
          },
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  updatedAt: '2026-06-11T10:05:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeRecipes', () => {
  it('delivers a fully-populated recipe exactly as it was stored', () => {
    const onRecipes = vi.fn();
    subscribeRecipes(onRecipes, () => {});

    (mockOnSnapshot.mock.calls[0]![1] as CollectionCallback)(
      firstSnapshot([{ id: 'recipe-1', data: () => RECIPE }]),
    );

    // Whole-object equality: the emulator row sees ids only, so a parse that
    // dropped `parsed.quantity` or flattened a group would be invisible to it.
    const [received] = onRecipes.mock.calls[0] as [Recipe[]];
    expect(received).toEqual([RECIPE]);
  });

  it('classifies a stream error and forwards the raw one alongside it', () => {
    const calls: unknown[][] = [];
    subscribeRecipes(
      () => {},
      (...args) => calls.push(args),
    );

    const raw = Object.assign(new Error('e'), { code: 'permission-denied' });
    (mockOnSnapshot.mock.calls[0]![2] as ErrorCallback)(raw);

    // TWO arguments — the classified kind for the caller to branch on, and the
    // original error so a reporting call site can send the real stack. Asserted
    // as the argument list because the arity is the point (#928 B2-009).
    expect(calls).toEqual([[{ kind: 'AuthError', reason: 'forbidden' }, raw]]);
  });
});

describe('loadRecipe', () => {
  it('targets recipes/{id} and returns the recipe', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => RECIPE });
    const result = await loadRecipe('recipe-1');
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'recipes', 'recipe-1');
    expect(result).toEqual({ kind: 'ok', value: RECIPE });
  });

  it('returns null when the recipe does not exist', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    const result = await loadRecipe('missing');
    expect(result).toEqual({ kind: 'ok', value: null });
  });

  it('returns a corruption Failure on an invalid doc (single-doc-read contract)', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ id: 'x', schemaVersion: 2 }),
    });
    const result = await loadRecipe('recipe-1');
    expect(result).toEqual({ kind: 'err', error: { kind: 'StorageError', reason: 'corruption' } });
  });

  it('returns failure (never throws) on a Firestore error', async () => {
    mockGetDoc.mockRejectedValue(Object.assign(new Error('e'), { code: 'unavailable' }));
    const result = await loadRecipe('recipe-1');
    expect(result).toEqual({ kind: 'err', error: { kind: 'NetworkError', reason: 'offline' } });
  });
});
