import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUnsubscribe, mockOnSnapshot, mockCollection, mockQuery, mockGetFirestore } = vi.hoisted(
  () => ({
    mockUnsubscribe: vi.fn(),
    mockOnSnapshot: vi.fn(),
    mockCollection: vi.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
    mockQuery: vi.fn(),
    mockGetFirestore: vi.fn(() => 'mock-db'),
  }),
);

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));
vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: mockCollection,
  query: mockQuery,
  doc: vi.fn(() => 'mock-doc-ref'),
  onSnapshot: mockOnSnapshot,
}));

import { subscribeEnrichmentFailures } from '../src/enrichmentFailureSubscription.js';
import type { EnrichmentFailureDoc } from '@salt/domain/schemas';

// The read contract for `enrichmentFailures` (issue #1419). The live behaviour
// against a real emulator is the subscription-contract table's row; what is left
// for this file is the two decisions this module makes on its own — that it keys
// the delivered Map by DOCUMENT id, and that it follows the LIST contract, where
// one unreadable record must not cost the app every other marker.

type Snap = { id: string; data: () => unknown };

function failure(over: Partial<EnrichmentFailureDoc> = {}): EnrichmentFailureDoc {
  return {
    enrichment: 'recipeKit',
    subjectId: 'r1',
    subjectLabel: 'Home-Cured Streaky Bacon',
    reason: 'timeout',
    failedAt: 1_757_030_400_000,
    ...over,
  };
}

function emit(docs: Snap[]): void {
  const onNext = mockOnSnapshot.mock.calls[0]?.[1] as (snap: unknown) => void;
  onNext({ docs, docChanges: () => docs.map((d) => ({ type: 'added', doc: d })) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnSnapshot.mockReturnValue(mockUnsubscribe);
});

describe('subscribeEnrichmentFailures', () => {
  it('reads the whole collection — no query, so no composite index', () => {
    subscribeEnrichmentFailures(vi.fn(), vi.fn());
    expect(mockCollection).toHaveBeenCalledWith('mock-db', 'enrichmentFailures');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keys the delivered Map by DOCUMENT id, not by subjectId', () => {
    const onFailures = vi.fn();
    subscribeEnrichmentFailures(onFailures, vi.fn());
    emit([
      { id: 'recipeKit_r1', data: () => failure() },
      { id: 'recipeImage_r1', data: () => failure({ enrichment: 'recipeImage' }) },
    ]);

    const delivered = onFailures.mock.calls[0]?.[0] as Map<string, EnrichmentFailureDoc>;
    // Two records for ONE recipe. Keyed by subjectId they would collide and the
    // second would silently replace the first, so the hero marker and the kit
    // marker could never both be shown.
    expect([...delivered.keys()]).toEqual(['recipeKit_r1', 'recipeImage_r1']);
    expect(delivered.get('recipeImage_r1')?.enrichment).toBe('recipeImage');
  });

  it('skips a record the schema refuses and still delivers the rest', () => {
    const onFailures = vi.fn();
    const onError = vi.fn();
    subscribeEnrichmentFailures(onFailures, onError);
    emit([
      { id: 'bad', data: () => ({ enrichment: 'not-a-kind' }) },
      { id: 'recipeKit_r1', data: () => failure() },
    ]);

    const delivered = onFailures.mock.calls[0]?.[0] as Map<string, EnrichmentFailureDoc>;
    expect([...delivered.keys()]).toEqual(['recipeKit_r1']);
    // The parse path forwards nothing: a refused document is skipped and logged,
    // never raised. A marker collection that could take itself off the air over
    // one bad row would be worse than no markers.
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces a stream-level failure on onError and never throws', () => {
    const onError = vi.fn();
    subscribeEnrichmentFailures(vi.fn(), onError);
    const raw = new Error('permission-denied');
    const onStreamError = mockOnSnapshot.mock.calls[0]?.[2] as (err: unknown) => void;
    expect(() => onStreamError(raw)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe(raw);
  });

  it('hands back the unsubscribe it was given', () => {
    expect(subscribeEnrichmentFailures(vi.fn(), vi.fn())).toBe(mockUnsubscribe);
  });
});
