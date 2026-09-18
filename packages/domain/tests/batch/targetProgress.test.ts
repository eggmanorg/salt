import { describe, it, expect } from 'vitest';
import { targetProgress } from '../../src/index.js';
import type { BatchDoc, BatchObservationDoc, FormulaTarget } from '../../src/schemas/index.js';

// How far along a run is (issue #1407, phase 04 of epic #778).
//
// The coppa of the issue's worked example: 2 400 g of green meat on the hook,
// aiming at 35% lost. The figure it has to produce is `26% lost of 35%` off a
// reading of 1 780 g — and it has to go on producing one past the target rather
// than deciding anything, which is the half of this feature that is a DECISION
// rather than arithmetic.

const GREEN_GRAMS = 2400;

function batch(target: FormulaTarget | null, basisGrams = GREEN_GRAMS): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'coppa',
    recipeTitle: 'Coppa',
    recipeKind: 'cure',
    cureCategory: 'dry_cured_whole_muscle',
    target,
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams, totalGrams: basisGrams, usableGrams: basisGrams, units: null },
    stages: [],
    rationale: null,
    ambientCelsius: null,
    checkedIngredientIds: [],
    completedStepIds: [],
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
  };
}

function reading(
  at: string,
  measurements: { weightGrams?: number | null; ph?: number | null } = {},
): BatchObservationDoc {
  return {
    id: `obs-${at}`,
    schemaVersion: 1,
    at,
    stageId: null,
    weightGrams: measurements.weightGrams ?? null,
    ph: measurements.ph ?? null,
    temperatureC: null,
    relativeHumidityPercent: null,
    note: '',
    image: null,
  };
}

const LOST_35: FormulaTarget = { weightLossPercent: 35, phAtMost: null };
const SALAMI: FormulaTarget = { weightLossPercent: 35, phAtMost: 5.3 };
const PH_ONLY: FormulaTarget = { weightLossPercent: null, phAtMost: 5.3 };

describe('targetProgress — the weight figure', () => {
  it('reads 1 780 g of a 2 400 g green weight as 26% lost of 35%', () => {
    const progress = targetProgress(batch(LOST_35), [
      reading('2026-07-01T09:00:00.000Z', { weightGrams: 1780 }),
    ]);

    expect(progress?.weightLoss).toEqual({
      startingGrams: 2400,
      latestGrams: 1780,
      percentLost: ((2400 - 1780) / 2400) * 100,
      targetPercent: 35,
    });
    expect(Math.round(progress?.weightLoss?.percentLost ?? 0)).toBe(26);
  });

  it('takes the LATEST weighing by when it was observed, not by arrival order', () => {
    // The back-filled Tuesday reading, entered on the Thursday. The log's order is
    // `at` and nothing else, so the later INSTANT wins whatever position it holds.
    const log = [
      reading('2026-07-20T09:00:00.000Z', { weightGrams: 1700 }),
      reading('2026-07-10T09:00:00.000Z', { weightGrams: 2000 }),
    ];

    expect(targetProgress(batch(LOST_35), log)?.weightLoss?.latestGrams).toBe(1700);
  });

  it('ignores entries that carry no weight', () => {
    const log = [
      reading('2026-07-10T09:00:00.000Z', { weightGrams: 2000 }),
      // A note or a photo, and later than the weighing above.
      reading('2026-07-20T09:00:00.000Z'),
    ];

    expect(targetProgress(batch(LOST_35), log)?.weightLoss?.latestGrams).toBe(2000);
  });

  it('skips a reading whose instant cannot be read rather than letting it win', () => {
    const log = [
      reading('2026-07-10T09:00:00.000Z', { weightGrams: 2000 }),
      reading('not a time', { weightGrams: 1 }),
    ];

    expect(targetProgress(batch(LOST_35), log)?.weightLoss?.latestGrams).toBe(2000);
  });
});

describe('targetProgress — it decides nothing', () => {
  // The claim CLAUDE.md rule 12 asks to be pinned rather than asserted: "past the
  // target the figure simply keeps counting". These go red the moment anything
  // clamps, caps, or reports a run as finished.

  it('keeps counting past the target', () => {
    const progress = targetProgress(batch(LOST_35), [
      reading('2026-09-01T09:00:00.000Z', { weightGrams: 1488 }),
    ]);

    expect(Math.round(progress?.weightLoss?.percentLost ?? 0)).toBe(38);
    expect(progress?.weightLoss?.targetPercent).toBe(35);
  });

  it('reports a run that GAINED weight as a negative figure rather than clamping it', () => {
    // A brine. It is a fact about the log, and correcting it here would be Salt
    // deciding which readings it believes.
    const progress = targetProgress(batch(LOST_35), [
      reading('2026-07-01T09:00:00.000Z', { weightGrams: 2520 }),
    ]);

    expect(progress?.weightLoss?.percentLost).toBeCloseTo(-5, 10);
  });

  it('returns a figure for an abandoned run exactly as for a running one', () => {
    // The run's state gates nothing here: an abandoned run keeps what it recorded.
    const stopped: BatchDoc = {
      ...batch(LOST_35),
      state: 'abandoned',
      abandonedAt: '2026-08-01T09:00:00.000Z',
    };

    expect(
      targetProgress(stopped, [reading('2026-07-01T09:00:00.000Z', { weightGrams: 1780 })]),
    ).not.toBeNull();
  });
});

describe('targetProgress — the pH figure', () => {
  it('reports the latest reading against its target, with no percentage of any kind', () => {
    const progress = targetProgress(batch(SALAMI), [
      reading('2026-07-02T09:00:00.000Z', { ph: 5.8 }),
      reading('2026-07-04T09:00:00.000Z', { ph: 5.1 }),
    ]);

    expect(progress?.ph).toEqual({ latest: 5.1, targetAtMost: 5.3 });
    // No frozen zero exists to measure from, so there is nothing here that could
    // become a bar or a percentage. This is what stops one being added by habit.
    expect(Object.keys(progress?.ph ?? {})).toEqual(['latest', 'targetAtMost']);
  });

  it('fills the halves independently — a salami weighed but never measured for pH', () => {
    const progress = targetProgress(batch(SALAMI), [
      reading('2026-07-04T09:00:00.000Z', { weightGrams: 1780 }),
    ]);

    expect(progress?.weightLoss).not.toBeNull();
    expect(progress?.ph).toBeNull();
  });

  it('reports a pH target on a run that has never been weighed', () => {
    const progress = targetProgress(batch(PH_ONLY), [
      reading('2026-07-04T09:00:00.000Z', { ph: 4.9 }),
    ]);

    expect(progress?.weightLoss).toBeNull();
    expect(progress?.ph).toEqual({ latest: 4.9, targetAtMost: 5.3 });
  });
});

describe('targetProgress — when there is nothing to say', () => {
  it('is null for a run that carries no target', () => {
    expect(
      targetProgress(batch(null), [reading('2026-07-01T09:00:00.000Z', { weightGrams: 1780 })]),
    ).toBeNull();
  });

  it('is null for a target nothing has been measured against yet', () => {
    expect(targetProgress(batch(LOST_35), [])).toBeNull();
    expect(targetProgress(batch(LOST_35), [reading('2026-07-01T09:00:00.000Z')])).toBeNull();
  });

  it('is null when the run froze a starting weight of zero, rather than dividing by it', () => {
    const progress = targetProgress(batch(LOST_35, 0), [
      reading('2026-07-01T09:00:00.000Z', { weightGrams: 1780 }),
    ]);

    expect(progress).toBeNull();
  });

  it('ignores a measurement the target did not ask for', () => {
    // A weight logged on a run that only ever named a pH is a fact about the log
    // and not a figure this reports: there is nothing to report it against.
    const progress = targetProgress(batch(PH_ONLY), [
      reading('2026-07-01T09:00:00.000Z', { weightGrams: 1780 }),
    ]);

    expect(progress).toBeNull();
  });
});
