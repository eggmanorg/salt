import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrichmentFailureId } from '@salt/domain/schemas';

// The write side of `enrichmentFailures` (issue #1419).
//
// Two properties are load-bearing and both are asserted here rather than stated
// in a comment (Rule 12):
//
//   1. NEITHER CALL EVER REJECTS. They run inside catch blocks that are
//      themselves siblings under `Promise.allSettled`, so a rejection escaping
//      one would retry BOTH branches — paying a second time for the one that had
//      already succeeded. The two "…does not reject" cases below go red the day
//      someone removes an inner catch.
//   2. THE ID IS DERIVED FROM (kind, subject), so a job that fails twice
//      overwrites its own row, and a success can delete a row it can name
//      without reading anything.
//
// The classification is deliberately tested as best-effort: the "unknown"
// fallback case is as much the contract as the two it recognises.

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockSet = vi.fn<(doc: unknown) => Promise<undefined>>().mockResolvedValue(undefined);
const mockDelete = vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined);
const mockDoc = vi.fn((_id: string) => ({ set: mockSet, delete: mockDelete }));
const mockCollection = vi.fn((_name: string) => ({ doc: mockDoc }));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
}));

const { recordEnrichmentFailure, clearEnrichmentFailure, classifyEnrichmentFailure } =
  await import('../../src/adapters/enrichmentFailureStore.js');
const { AiTimeoutError } = await import('../../src/adapters/withAiTimeout.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

describe('classifyEnrichmentFailure', () => {
  it('reads the house timeout error as a timeout, by class and by name', () => {
    expect(classifyEnrichmentFailure(new AiTimeoutError('identifyRecipeKit', 40_000))).toBe(
      'timeout',
    );
    // The same error re-thrown across a Genkit boundary keeps its name and loses
    // its prototype — which is why the name check is not redundant.
    const renamed = new Error('identifyRecipeKit timed out after 40000ms');
    renamed.name = 'AiTimeoutError';
    expect(classifyEnrichmentFailure(renamed)).toBe('timeout');
  });

  it('reads the 2026-09-11 Gemini shape as upstream', () => {
    expect(classifyEnrichmentFailure(new Error('503 Service Unavailable'))).toBe('upstream');
    expect(classifyEnrichmentFailure(new Error('The model is overloaded. Try again later.'))).toBe(
      'upstream',
    );
    expect(classifyEnrichmentFailure(new Error('429 RESOURCE_EXHAUSTED'))).toBe('upstream');
  });

  it('reads a bare deadline message as a timeout — the flows are not the only clock', () => {
    // Firestore and gRPC both phrase it this way, and a trigger's own Cloud Run
    // quota does too; none of them throws an `AiTimeoutError`.
    expect(classifyEnrichmentFailure(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'))).toBe(
      'timeout',
    );
  });

  it('falls back to unknown rather than guessing — including for a non-Error throw', () => {
    expect(classifyEnrichmentFailure(new Error('Cannot read properties of undefined'))).toBe(
      'unknown',
    );
    expect(classifyEnrichmentFailure('a string nobody should have thrown')).toBe('unknown');
    expect(classifyEnrichmentFailure(undefined)).toBe('unknown');
  });
});

describe('recordEnrichmentFailure', () => {
  it('writes the whole record under the derived id', async () => {
    await recordEnrichmentFailure({
      enrichment: 'recipeKit',
      subjectId: 'r1',
      subjectLabel: 'Home-Cured Streaky Bacon',
      err: new AiTimeoutError('identifyRecipeKit', 40_000),
    });

    expect(mockCollection).toHaveBeenCalledWith('enrichmentFailures');
    expect(mockDoc).toHaveBeenCalledWith(enrichmentFailureId('recipeKit', 'r1'));
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.calls[0]?.[0]).toMatchObject({
      enrichment: 'recipeKit',
      subjectId: 'r1',
      subjectLabel: 'Home-Cured Streaky Bacon',
      reason: 'timeout',
    });
    expect(typeof (mockSet.mock.calls[0]?.[0] as { failedAt: unknown }).failedAt).toBe('number');
  });

  it('writes nothing of the error text — the reason is a closed enum', async () => {
    await recordEnrichmentFailure({
      enrichment: 'recipeKit',
      subjectId: 'r1',
      subjectLabel: 'Bacon',
      // Free-form model output that has quoted the cook's own ingredient line.
      err: new Error('model refused: "500g pork belly, my grandmother\'s cure"'),
    });
    const written = JSON.stringify(mockSet.mock.calls[0]?.[0]);
    expect(written).not.toContain('pork belly');
    expect(written).not.toContain('grandmother');
  });

  it('DOES NOT REJECT when the record itself cannot be written (Rule 10)', async () => {
    mockSet.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(
      recordEnrichmentFailure({
        enrichment: 'recipeImage',
        subjectId: 'r1',
        subjectLabel: 'Bacon',
        err: new Error('boom'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('clearEnrichmentFailure', () => {
  it('deletes the row for that (kind, subject) pair, unconditionally', async () => {
    await clearEnrichmentFailure('canonIcon', 'lime-juice');
    expect(mockDoc).toHaveBeenCalledWith(enrichmentFailureId('canonIcon', 'lime-juice'));
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('DOES NOT REJECT when the delete fails (Rule 10)', async () => {
    mockDelete.mockRejectedValue(new Error('UNAVAILABLE'));
    await expect(clearEnrichmentFailure('recipeKit', 'r1')).resolves.toBeUndefined();
  });
});
