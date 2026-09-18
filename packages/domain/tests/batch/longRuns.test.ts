import { describe, it, expect } from 'vitest';
import type { BatchDoc, BatchStageDoc } from '../../src/schemas/index.js';
import {
  LONG_WAIT_DAYS,
  longRunNudge,
  longRunsWantingReading,
  withBatchAbandoned,
  withStageAdvanced,
} from '../../src/index.js';

// The selection rule and the copy behind the weekly "what is drying" nudge (issue
// #1406). Three of the four claims that issue makes are safety claims, and each is
// pinned here or in the Cloud Function suite (CLAUDE.md rule 12):
//
//   1. BREAD NEVER TRIGGERS THIS — pinned below by a bread-shaped process.
//   2. A NINETY-DAY RUN IS NUDGED ~13 TIMES, NOT 90 — pinned below by sweeping every
//      Friday of its planned life and counting, plus the two things that stop it.
//   3. THE AUDIENCE IS THE STARTER — the grouping half is pinned below; the half that
//      matters (nobody else's phone is sent to) is pinned in
//      `apps/cloud-functions/tests/maintenance/remindBatchReadings.test.ts`.
//
// The fourth — that `startedBy` gates nothing — is convention, and `BatchSchema`
// says so rather than pretending a test holds it.

const MS_PER_DAY = 86_400_000;

function iso(dayOffsetFromEpochStart: number): string {
  return new Date(
    Date.parse('2026-01-02T10:00:00.000Z') + dayOffsetFromEpochStart * MS_PER_DAY,
  ).toISOString();
}

function stage(overrides: Partial<BatchStageDoc> & Pick<BatchStageDoc, 'id'>): BatchStageDoc {
  return {
    label: 'Dry',
    kind: 'wait',
    environment: null,
    duration: null,
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: iso(0),
    plannedEndAt: iso(90),
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...overrides,
  };
}

function batch(overrides: Partial<BatchDoc> & Pick<BatchDoc, 'id'>): BatchDoc {
  return {
    schemaVersion: 1,
    recipeId: 'coppa',
    recipeTitle: 'Coppa',
    recipeKind: 'cure',
    cureCategory: 'dry_cured_whole_muscle',
    target: null,
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 2400, totalGrams: 2460, usableGrams: 2460, units: null },
    stages: [stage({ id: 'dry' })],
    rationale: null,
    ambientCelsius: null,
    checkedIngredientIds: [],
    completedStepIds: [],
    startedBy: 'uid-daniel',
    createdAt: iso(0),
    updatedAt: iso(0),
    ...overrides,
  };
}

/** The bread shape: short active stages and an OVERNIGHT retard, the longest wait it has. */
function breadBatch(): BatchDoc {
  return batch({
    id: 'batch-bread',
    recipeId: 'overnight-white-tin',
    recipeTitle: 'Overnight white tin',
    recipeKind: 'recipe',
    cureCategory: null,
    stages: [
      stage({
        id: 'mix',
        label: 'Mix',
        kind: 'active',
        plannedStartAt: iso(0),
        plannedEndAt: new Date(Date.parse(iso(0)) + 20 * 60_000).toISOString(),
        actualEndAt: new Date(Date.parse(iso(0)) + 20 * 60_000).toISOString(),
      }),
      stage({
        id: 'retard',
        label: 'Overnight retard',
        kind: 'wait',
        plannedStartAt: iso(0),
        // Sixteen hours — bread's longest wait, and nowhere near a week.
        plannedEndAt: new Date(Date.parse(iso(0)) + 16 * 3_600_000).toISOString(),
      }),
    ],
  });
}

describe('longRunsWantingReading — what qualifies', () => {
  it('picks a run sitting in a wait of a week or more, with its day number', () => {
    const runs = longRunsWantingReading([batch({ id: 'batch-coppa' })], iso(11.5));
    expect([...runs.keys()]).toEqual(['uid-daniel']);
    expect(runs.get('uid-daniel')).toEqual([
      { batchId: 'batch-coppa', recipeTitle: 'Coppa', dayNumber: 12, startedBy: 'uid-daniel' },
    ]);
  });

  it('counts day 1 for the first twenty-four hours', () => {
    const sameEvening = longRunsWantingReading([batch({ id: 'batch-coppa' })], iso(0.4));
    expect(sameEvening.get('uid-daniel')?.[0]?.dayNumber).toBe(1);
    const nextMorning = longRunsWantingReading([batch({ id: 'batch-coppa' })], iso(1.1));
    expect(nextMorning.get('uid-daniel')?.[0]?.dayNumber).toBe(2);
  });

  it('BREAD NEVER QUALIFIES — its longest wait is an overnight retard', () => {
    // Claim 1, and the reason this feature ships dark with no flag: every batch in
    // production today is bread, so the sweep sends nothing at all. The figure that
    // does the work is LONG_WAIT_DAYS, so assert against it rather than against 7.
    expect(LONG_WAIT_DAYS).toBe(7);
    const retard = breadBatch().stages[1]!;
    const retardDays =
      (Date.parse(retard.plannedEndAt) - Date.parse(retard.plannedStartAt)) / MS_PER_DAY;
    expect(retardDays).toBeLessThan(LONG_WAIT_DAYS);
    expect(longRunsWantingReading([breadBatch()], iso(0.5)).size).toBe(0);
  });

  it('ignores a wait one minute short of the threshold, and takes one exactly on it', () => {
    const justShort = batch({
      id: 'batch-short',
      stages: [
        stage({
          id: 'ferment',
          plannedEndAt: new Date(
            Date.parse(iso(0)) + LONG_WAIT_DAYS * MS_PER_DAY - 60_000,
          ).toISOString(),
        }),
      ],
    });
    expect(longRunsWantingReading([justShort], iso(1)).size).toBe(0);

    const exactly = batch({
      id: 'batch-exact',
      stages: [
        stage({
          id: 'ferment',
          plannedEndAt: new Date(Date.parse(iso(0)) + LONG_WAIT_DAYS * MS_PER_DAY).toISOString(),
        }),
      ],
    });
    expect(longRunsWantingReading([exactly], iso(1)).size).toBe(1);
  });

  it('ignores an ACTIVE stage however long it is planned to take', () => {
    // Nobody needs telling to weigh something they are stood over. A fortnight-long
    // active stage is a data oddity, not a thing to nudge about.
    const active = batch({ id: 'batch-active', stages: [stage({ id: 'work', kind: 'active' })] });
    expect(longRunsWantingReading([active], iso(3)).size).toBe(0);
  });

  it('ignores a long wait whose planned start is still in the future', () => {
    const later = batch({
      id: 'batch-later',
      stages: [stage({ id: 'dry', plannedStartAt: iso(5), plannedEndAt: iso(95) })],
    });
    expect(longRunsWantingReading([later], iso(2)).size).toBe(0);
    expect(longRunsWantingReading([later], iso(6)).size).toBe(1);
  });

  it('asks about a run nobody remembered to tap — planned start, not marked start', () => {
    // Deliberate: "planned start at or before now" rather than "actualStartAt is set",
    // so a stage the cook never marked started is still asked about.
    const untapped = batch({ id: 'batch-untapped' });
    expect(untapped.stages[0]?.actualStartAt).toBeNull();
    expect(longRunsWantingReading([untapped], iso(9)).size).toBe(1);
  });

  it('drops a run with no starter rather than broadcasting it', () => {
    // A batch written before `startedBy` existed, and the reason no fallback to the
    // household exists: that would reintroduce the broadcast this replaced.
    const legacy = batch({ id: 'batch-legacy', startedBy: null });
    expect(longRunsWantingReading([legacy], iso(9)).size).toBe(0);
    expect(longRunsWantingReading([batch({ id: 'b', startedBy: '' })], iso(9)).size).toBe(0);
  });

  it('says nothing about an abandoned run', () => {
    const dropped = withBatchAbandoned(batch({ id: 'batch-dropped' }), iso(4));
    expect(longRunsWantingReading([dropped], iso(9)).size).toBe(0);
  });

  it('asks about nothing when the instant cannot be read', () => {
    // Without the guard every `>` against NaN is false and every run would qualify.
    expect(longRunsWantingReading([batch({ id: 'batch-coppa' })], 'not-an-instant').size).toBe(0);
  });

  it('skips a run whose own stored times cannot be read, rather than asking wrongly', () => {
    // The mirror of the case above, and the reason it is a `continue` rather than a
    // throw: this is a whole-collection sweep, so one corrupt run must not silence the
    // others. Each of the three parsed times is checked, because a NaN slipping past
    // any one of them makes every comparison below false and the run qualify by
    // accident.
    const badStart = batch({ id: 'b-1', stages: [stage({ id: 'dry', plannedStartAt: 'soon' })] });
    const badEnd = batch({ id: 'b-2', stages: [stage({ id: 'dry', plannedEndAt: 'later' })] });
    const badCreated = batch({ id: 'b-3', createdAt: 'whenever' });
    expect(longRunsWantingReading([badStart, badEnd, badCreated], iso(9)).size).toBe(0);

    // And a sound run beside them is still asked about.
    const sound = batch({ id: 'b-4' });
    expect(longRunsWantingReading([badStart, sound, badCreated], iso(9)).size).toBe(1);
  });
});

describe('longRunsWantingReading — grouped by starter', () => {
  it('gives each person their own runs, and nobody else a mention', () => {
    const runs = longRunsWantingReading(
      [
        batch({ id: 'batch-a1', recipeTitle: 'Coppa', startedBy: 'uid-a' }),
        batch({ id: 'batch-b1', recipeTitle: 'Kraut', startedBy: 'uid-b' }),
        batch({ id: 'batch-a2', recipeTitle: 'Bresaola', startedBy: 'uid-a' }),
      ],
      iso(9),
    );
    expect([...runs.keys()]).toEqual(['uid-a', 'uid-b']);
    expect(runs.get('uid-a')?.map((r) => r.recipeTitle)).toEqual(['Coppa', 'Bresaola']);
    expect(runs.get('uid-b')?.map((r) => r.recipeTitle)).toEqual(['Kraut']);
  });
});

describe('longRunsWantingReading — thirteen nudges, not ninety', () => {
  it('nudges ~13 times across a ninety-day run, one Friday at a time', () => {
    // Claim 2. The run is swept on every seventh day of its PLANNED LIFE and the
    // qualifying sweeps are counted — ninety days of daily notifications would be
    // ninety, which `docs/formulas-schedules-batches.md` → *What not to build* forbids
    // outright.
    const coppa = batch({ id: 'batch-coppa' });
    let nudges = 0;
    for (let day = 0; day < 90; day += 7) {
      if (longRunsWantingReading([coppa], iso(day)).size > 0) nudges += 1;
    }
    expect(nudges).toBe(13);

    // And what ninety days of DAILY sweeps would have cost, for contrast.
    let daily = 0;
    for (let day = 0; day < 90; day += 1) {
      if (longRunsWantingReading([coppa], iso(day)).size > 0) daily += 1;
    }
    expect(daily).toBe(90);
  });

  it('keeps asking past the planned end — the boundary, stated and pinned', () => {
    // THERE IS NO UPPER BOUND, deliberately: a coppa still hanging on day 97 is still
    // worth weighing. So "thirteen, not ninety" is a claim about the run's PLANNED
    // LIFE and not a claim that the nudges stop by themselves. This is the half that
    // would make an unqualified "thirteen" false.
    const coppa = batch({ id: 'batch-coppa' });
    expect(longRunsWantingReading([coppa], iso(97)).size).toBe(1);
    expect(longRunsWantingReading([coppa], iso(400)).size).toBe(1);
  });

  it('stops the moment the stage is marked done, or the run abandoned', () => {
    // The two things that actually end the nudges.
    const coppa = batch({ id: 'batch-coppa' });
    expect(longRunsWantingReading([withStageAdvanced(coppa, 'dry', iso(92))], iso(97)).size).toBe(
      0,
    );
    expect(longRunsWantingReading([withBatchAbandoned(coppa, iso(92))], iso(97)).size).toBe(0);
  });
});

describe('longRunNudge', () => {
  it('names the one run and its day, and asks for the weight and the note', () => {
    const runs = longRunsWantingReading([batch({ id: 'batch-coppa' })], iso(11.5));
    expect(longRunNudge(runs.get('uid-daniel')!)).toEqual({
      title: 'Coppa — day 12',
      body: 'Weigh it and add a note.',
    });
  });

  it('collapses several runs into ONE sentence, never one notification each', () => {
    const runs = longRunsWantingReading(
      [
        batch({ id: 'batch-1', recipeTitle: 'Coppa' }),
        batch({ id: 'batch-2', recipeTitle: 'Bresaola' }),
      ],
      iso(11.5),
    );
    expect(longRunNudge(runs.get('uid-daniel')!)).toEqual({
      title: '2 runs under way',
      body: 'Weigh them and add a note.',
    });
  });

  it('never names a run whose title it was not given', () => {
    // The copy has ONE owner, and the wording is all it owns: no uid, no batch id, no
    // stage label rides on the sentence a notification carries.
    const runs = longRunsWantingReading([batch({ id: 'batch-coppa' })], iso(11.5));
    const copy = longRunNudge(runs.get('uid-daniel')!);
    expect(JSON.stringify(copy)).not.toContain('uid-daniel');
    expect(JSON.stringify(copy)).not.toContain('batch-coppa');
  });
});
