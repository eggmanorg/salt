import { describe, it, expect } from 'vitest';
import { BatchSchema } from '../../src/schemas/index.js';
import {
  currentStage,
  longRunsWantingReading,
  targetProgress,
  withBatchAbandoned,
} from '../../src/index.js';

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

  it('reads as a run that used the product its recipe named (#1402)', () => {
    // `cureSaltSubstitution` is optional rather than defaulted, exactly as `vessel`
    // above is, so a document written before it is ABSENT rather than an empty
    // object — and absent means "the recipe's own product went on", which is what
    // every run in production did.
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.cureSaltSubstitution).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain('cureSaltSubstitution');
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

// Issue #1406 added `startedBy`, again with a read default and again with no migration.
// A run started before the field existed recorded no starter, which is what `null`
// says — and therefore has nobody to ask about it on a Friday.
describe('a batch document written before #1406', () => {
  it('reads as a run whose starter was never recorded', () => {
    expect('startedBy' in LEGACY_BATCH).toBe(false);
    expect(BatchSchema.parse(LEGACY_BATCH).startedBy).toBeNull();
  });

  it('is silent to the weekly nudge rather than broadcast to the household', () => {
    // The accepted answer to the one open question on #1406: no starter, no nudge. It
    // costs nothing — the one run in production predating the field is bread, and
    // bread's longest wait could never qualify anyway. A fallback to the household
    // would reintroduce the broadcast the per-starter audience replaced.
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(longRunsWantingReading([parsed], '2026-09-15T09:00:00.000Z', 'Europe/London').size).toBe(
      0,
    );
  });
});

// Issue #1405 added `stageId` to each frozen quantity, again with a read default and
// again with no migration. The strongest of these to state, and for the same reason
// the formula side's is: `null` is LITERALLY WHAT EVERY RUN ALREADY IN PRODUCTION
// MEANT — before this field, every gram went in at the beginning.
//
// THE BOUNDARY: this says nothing about a run whose quantity names a stage the run
// does not carry. That is a legal document by design (the schema validates no FK) and
// what it renders as is `stageAdditions`' claim, pinned in
// `tests/process/stageAdditions.test.ts`.
describe('a batch document written before #1405', () => {
  it('reads as a run where everything went in at the start', () => {
    const parsed = BatchSchema.parse(LEGACY_BATCH);
    expect(parsed.quantities.map((q) => q.stageId)).toEqual([null]);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('leaves the frozen weights exactly where they were', () => {
    // A stage says WHEN, never how much — so an old run's grams are untouched.
    expect(BatchSchema.parse(LEGACY_BATCH).quantities[0]?.grams).toBe(816);
  });

  it('carries an assignment through the parse when a run has one', () => {
    const parsed = BatchSchema.parse({
      ...LEGACY_BATCH,
      quantities: [
        ...LEGACY_BATCH.quantities,
        {
          ingredientId: 'ing-wine',
          label: '40 g red wine',
          percent: 2,
          grams: 36,
          stageId: 'bulk',
        },
      ],
    });
    expect(parsed.quantities.map((q) => q.stageId)).toEqual([null, 'bulk']);
  });
});
