import { describe, it, expect } from 'vitest';
import { targetProgress, NEARING_FRACTION } from '../../src/index.js';
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
      fractionOfTarget: (((2400 - 1780) / 2400) * 100) / 35,
      stance: 'tracking',
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

describe('targetProgress — the three appearances (issue #1407, phase 2)', () => {
  // The cue is a THREE-state one, and the commonest way it would silently become a
  // two-state one is a later edit collapsing `nearing` into a neighbour. These pin
  // all three AT THEIR BOUNDARIES, which is the only place that collapse shows.
  //
  // 2 400 g green, aiming at 35% lost. The weights are stated rather than computed
  // from `NEARING_FRACTION`: a test that derives its own input from the constant
  // under test moves with it and stops checking anything. 1 686 g IS exactly the
  // nearing threshold (29.75 of 35, i.e. 0.85), and 1 560 g is exactly at the
  // target.
  function stanceAt(grams: number, target = LOST_35, basisGrams = GREEN_GRAMS) {
    return targetProgress(batch(target, basisGrams), [
      reading('2026-07-01T09:00:00.000Z', { weightGrams: grams }),
    ])?.weightLoss;
  }

  it('is tracking well short of the target', () => {
    expect(stanceAt(2200)?.stance).toBe('tracking');
  });

  it('is tracking one gram short of the nearing boundary', () => {
    expect(stanceAt(1687)?.stance).toBe('tracking');
  });

  it('is nearing AT the boundary, inclusively', () => {
    const at = stanceAt(1686);
    expect(at?.fractionOfTarget).toBe(NEARING_FRACTION);
    expect(at?.stance).toBe('nearing');
  });

  // THE ISSUE'S OWN EXEMPLAR (#1426 review, blocking 2) — not a boundary value,
  // the actual figures #1407 names: 31% of a 35% target must read `nearing`
  // beside 12% of the same target reading `tracking`. This is what the constant
  // above exists to satisfy, pinned directly rather than only at its boundary,
  // since a boundary-only suite is exactly what let the constant drift out from
  // under the requirement it was chosen for undetected.
  it('reads the issue’s own exemplar as nearing, and its contrast as tracking', () => {
    expect(stanceAt(1656)?.stance).toBe('nearing'); // 31% lost, exactly.
    expect(stanceAt(2112)?.stance).toBe('tracking'); // 12% lost, exactly.
  });

  it('is still nearing one gram short of the target', () => {
    expect(stanceAt(1561)?.stance).toBe('nearing');
  });

  it('is at-or-past AT the target, inclusively', () => {
    const at = stanceAt(1560);
    expect(at?.fractionOfTarget).toBe(1);
    expect(at?.stance).toBe('atOrPast');
  });

  it('stays at-or-past however far past it goes', () => {
    expect(stanceAt(1488)?.stance).toBe('atOrPast');
    expect(stanceAt(500)?.stance).toBe('atOrPast');
  });

  it('is tracking for a run that has gained weight', () => {
    expect(stanceAt(2520)?.stance).toBe('tracking');
  });

  it('reports the fraction UNCLAMPED, so the figure can outrun the meter', () => {
    // The meter clamps for its own geometry (`Progress` does that itself). Nothing
    // here does, which is what lets the number beside it keep counting.
    expect(stanceAt(1488)?.fractionOfTarget).toBeGreaterThan(1);
    expect(stanceAt(2520)?.fractionOfTarget).toBeLessThan(0);
  });

  it('scales with the target rather than sitting a fixed distance from it', () => {
    // Three points short of 35% and three points short of 12% are very different
    // distances, so the constant is a FRACTION. A 10% target reached nine-tenths of
    // the way must read the same stance as a 35% one — and a run the same NUMBER of
    // points short of a small target is already past it.
    const SMALL = { weightLossPercent: 10, phAtMost: null };
    expect(stanceAt(1820, SMALL, 2000)?.stance).toBe('nearing');
    expect(stanceAt(1800, SMALL, 2000)?.stance).toBe('atOrPast');
  });
});
