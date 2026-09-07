import { describe, it, expect } from 'vitest';
import { BatchSchema } from '../../src/schemas/index.js';
import { currentStage, withBatchAbandoned } from '../../src/index.js';

// A `batches/{batchId}` document WRITTEN BEFORE #1274, read by the code after it
// (rule-12 claim 1).
//
// The sibling of `tests/formula/legacyFormulaDocument.test.ts`, and the same
// argument: #1274 deleted `totals.units.label` and `totals.units.bakedUnitGrams`
// rather than renaming anything, so a stored document still carrying them parses
// with its surviving figures intact. It also ADDED `vessel`, and a document
// written before that has none — which must read as "this run named no vessel",
// not as a parse failure.
//
// `schemaVersion` stays at 1; there is no migration.

const LEGACY_BATCH = {
  id: 'batch-legacy-1',
  schemaVersion: 1,
  recipeId: 'overnight-white-tin',
  recipeTitle: 'Overnight white tin',
  state: 'running',
  quantities: [{ ingredientId: 'ing-flour', label: '500g strong white', percent: 100, grams: 816 }],
  totals: {
    basisGrams: 816,
    totalGrams: 1483,
    usableGrams: 1440,
    units: {
      label: '120 g roll',
      count: 12,
      unitDoughGrams: 120,
      bakedUnitGrams: 108,
    },
  },
  stages: [
    {
      id: 'bulk',
      label: 'Bulk',
      kind: 'wait',
      environment: null,
      duration: { kind: 'fixed', minutes: 180 },
      until: null,
      stepId: null,
      plannedStartAt: '2026-08-15T02:10:00.000Z',
      plannedEndAt: '2026-08-15T05:10:00.000Z',
      actualStartAt: null,
      actualEndAt: null,
    },
  ],
  rationale: null,
  createdAt: '2026-08-14T21:00:00.000Z',
  updatedAt: '2026-08-14T21:00:00.000Z',
};

describe('a batch document written before #1274', () => {
  it('still parses, with the frozen figures untouched', () => {
    const parsed = BatchSchema.safeParse(LEGACY_BATCH);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Including `totalGrams` and `usableGrams` DISAGREEING by the 3% handling
    // allowance that was live when this was frozen. A batch is a historical
    // record: what it says it weighed out is what it weighed out, and nothing
    // re-derives it.
    expect(parsed.data.totals.totalGrams).toBe(1483);
    expect(parsed.data.totals.usableGrams).toBe(1440);
    expect(parsed.data.totals.units).toEqual({ count: 12, unitDoughGrams: 120 });
  });

  it('reads as a run that named no vessel, rather than refusing to parse', () => {
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.vessel).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain('vessel');
  });

  it('still runs — the producers do not depend on anything that was deleted', () => {
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(currentStage(parsed)?.id).toBe('bulk');
    expect(withBatchAbandoned(parsed).state).toBe('abandoned');
  });
});
