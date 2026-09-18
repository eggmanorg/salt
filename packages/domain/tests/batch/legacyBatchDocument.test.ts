import { describe, it, expect } from 'vitest';
import { BatchSchema } from '../../src/schemas/index.js';
import { currentStage, targetProgress, withBatchAbandoned } from '../../src/index.js';

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

  it('reads as a run that recorded no place and no kitchen temperature (#1286)', () => {
    // Both fields are additive with a read default, so a document written before
    // them parses as "nowhere in particular, and nobody said how warm it was" —
    // which is exactly what it meant — rather than failing validation.
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.ambientCelsius).toBeNull();
    expect(parsed.stages[0]?.place).toBeNull();
  });

  it('reads as a run with nothing ticked off yet (#1327)', () => {
    // The batch cook page's two check-off lists are additive with a read default,
    // so every run already in production opens on that page with an empty weigh-out
    // and no steps done — which is what it means — rather than failing to parse.
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.checkedIngredientIds).toEqual([]);
    expect(parsed.completedStepIds).toEqual([]);
  });

  it('reads as a plain bread run, not a cure — and the default is TRUE (#1404)', () => {
    // `recipeKind` and `cureCategory` are additive with read defaults, so every
    // batch already in production parses unchanged and there is no migration. What
    // makes this more than a parse check is that the defaults are the FACTS: every
    // run in production today is bread, and bread is a `recipe` with no cure
    // category. A default that merely parsed would quietly file real history under
    // the wrong answer.
    expect('recipeKind' in LEGACY_BATCH).toBe(false);
    expect('cureCategory' in LEGACY_BATCH).toBe(false);
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.recipeKind).toBe('recipe');
    expect(parsed.cureCategory).toBeNull();
  });

  it('still runs — the producers do not depend on anything that was deleted', () => {
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(currentStage(parsed)?.id).toBe('bulk');
    expect(withBatchAbandoned(parsed, '2026-08-15T09:00:00.000Z').state).toBe('abandoned');
  });
});

// Issue #1407 added `target`, again with a read default, and again with no
// migration. A run started before the field existed aimed at nothing, which is
// what `null` says.
describe('a batch document written before #1407', () => {
  it('reads as a run that was aiming at nothing', () => {
    expect(BatchSchema.parse(LEGACY_BATCH).target).toBeNull();
  });

  it('shows no progress figure at all, however much it was weighed', () => {
    // The gate is `batch.target` and nothing else — not the recipe's kind, not the
    // cure category — so every run already in production stays exactly as it was.
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(
      targetProgress(parsed, [
        {
          id: 'obs-1',
          schemaVersion: 1,
          at: '2026-08-15T09:00:00.000Z',
          stageId: null,
          weightGrams: 1200,
          ph: null,
          temperatureC: null,
          relativeHumidityPercent: null,
          note: '',
          image: null,
        },
      ]),
    ).toBeNull();
  });
});
