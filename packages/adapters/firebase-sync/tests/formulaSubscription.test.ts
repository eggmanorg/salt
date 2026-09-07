import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockSetDoc, mockGetDoc, mockDoc, mockGetFirestore } =
  vi.hoisted(() => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockSetDoc: vi.fn(),
    mockGetDoc: vi.fn(),
    mockDoc: vi.fn(() => 'mock-doc-ref'),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }));

vi.mock('firebase/app', () => ({
  getApp: vi.fn(() => ({})),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  setDoc: mockSetDoc,
  getDoc: mockGetDoc,
}));

import { subscribeFormula, loadFormula, saveFormula } from '../src/formulaSubscription.js';
import type { Formula } from '@salt/domain/schemas';

type Snap = { id: string; exists: () => boolean; data: () => unknown };
type DocCallback = (snap: Snap) => void;
type ErrorCallback = (err: Error & { code?: string }) => void;

// The overnight white tin as baker's percentages: 500 g flour is the 100%.
const FORMULA: Formula = {
  recipeId: 'recipe-1',
  components: [
    { ingredientId: 'ing-flour', percent: 100, inBasis: true },
    { ingredientId: 'ing-water', percent: 70, inBasis: false },
    { ingredientId: 'ing-salt', percent: 2, inBasis: false },
    { ingredientId: 'ing-yeast', percent: 1.4, inBasis: false },
  ],
  referenceYield: {
    kind: 'target',
    shape: { count: 1, unitDoughGrams: 900 },
  },
  schemaVersion: 1,
};

function snap(data: unknown, exists = true): Snap {
  return { id: 'recipe-1', exists: () => exists, data: () => data };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
  mockSetDoc.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('subscribeFormula', () => {
  it('targets formulas/{recipeId} and returns the unsubscribe', () => {
    const unsub = subscribeFormula(
      'recipe-1',
      () => {},
      () => {},
    );
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'formulas', 'recipe-1');
    expect(unsub).toBe(mockUnsubscribe);
  });

  it('emits the parsed formula', () => {
    const onFormula = vi.fn();
    subscribeFormula('recipe-1', onFormula, () => {});
    (mockOnSnapshot.mock.calls[0]![1] as DocCallback)(snap(FORMULA));
    expect(onFormula).toHaveBeenCalledWith(FORMULA);
  });

  it('emits null when nothing has been mapped yet', () => {
    const onFormula = vi.fn();
    subscribeFormula('recipe-1', onFormula, () => {});
    (mockOnSnapshot.mock.calls[0]![1] as DocCallback)(snap(undefined, false));
    expect(onFormula).toHaveBeenCalledWith(null);
  });

  it('reports a corrupt formula as an error, NOT as "no formula yet"', () => {
    // The same divergence from cookSessionSubscription that guidedPlans makes, for
    // the same reason: a formula is not disposable. Someone chose the basis, typed
    // grams for the eggs and declared what the recipe makes. Emitting null shows
    // the first-visit state over a document that is still there, and the user maps
    // it again over the top.
    const onFormula = vi.fn();
    const onError = vi.fn();
    subscribeFormula('recipe-1', onFormula, onError);
    (mockOnSnapshot.mock.calls[0]![1] as DocCallback)(
      snap({ recipeId: 'recipe-1', components: 7 }),
    );
    expect(onFormula).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ kind: 'StorageError', reason: 'corruption' });
    expect(console.error).toHaveBeenCalled();
  });

  it('classifies stream-level errors and forwards the raw error', () => {
    const onError = vi.fn();
    subscribeFormula('recipe-1', () => {}, onError);
    const raw = Object.assign(new Error('e'), { code: 'permission-denied' });
    (mockOnSnapshot.mock.calls[0]![2] as ErrorCallback)(raw);
    expect(onError).toHaveBeenCalledWith({ kind: 'AuthError', reason: 'forbidden' }, raw);
  });
});

describe('loadFormula', () => {
  it('returns the formula', async () => {
    mockGetDoc.mockResolvedValue(snap(FORMULA));
    expect(await loadFormula('recipe-1')).toEqual({ kind: 'ok', value: FORMULA });
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'formulas', 'recipe-1');
  });

  it('returns null when there is no formula', async () => {
    mockGetDoc.mockResolvedValue(snap(undefined, false));
    expect(await loadFormula('recipe-1')).toEqual({ kind: 'ok', value: null });
  });

  it('returns a corruption Failure on an invalid doc (single-doc-read contract)', async () => {
    mockGetDoc.mockResolvedValue(snap({ recipeId: 'recipe-1', components: 7 }));
    expect(await loadFormula('recipe-1')).toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    });
  });

  it('returns failure (never throws) on a Firestore error', async () => {
    mockGetDoc.mockRejectedValue(Object.assign(new Error('e'), { code: 'unavailable' }));
    expect((await loadFormula('recipe-1')).kind).toBe('err');
  });
});

describe('saveFormula', () => {
  it('writes the WHOLE document to formulas/{recipeId} — a re-map replaces, never merges', async () => {
    const result = await saveFormula(FORMULA);
    expect(mockDoc).toHaveBeenCalledWith('mock-db', 'formulas', 'recipe-1');
    expect(mockSetDoc).toHaveBeenCalledWith('mock-doc-ref', { ...FORMULA });
    expect(result).toEqual({ kind: 'ok', value: undefined });
  });

  it('returns failure (never throws) on a Firestore error', async () => {
    mockSetDoc.mockRejectedValue(Object.assign(new Error('e'), { code: 'permission-denied' }));
    expect(await saveFormula(FORMULA)).toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' },
    });
  });
});
