import { describe, it, expect } from 'vitest';
import {
  buildBatchLog,
  withBatchAbandoned,
  withStageAdvanced,
  withStageSkipped,
  withStageStarted,
} from '../../src/index.js';
import type { BatchLogEntry } from '../../src/index.js';
import type { BatchDoc, BatchObservationDoc, BatchStageDoc } from '../../src/schemas/index.js';

// The batch log (issue #1280) over the epic's own loaf: mixed on the Saturday
// evening, out of the oven on the Sunday morning, with a fold skipped in between,
// the oven put on before the retard finished, and a reading either side of the bake.
//
// Every instant here is a fixed string, because the producer reads no clock.
//
// THE FULL-BAKE FIXTURE IS BUILT THROUGH THE REAL PRODUCERS rather than by hand.
// What the log has to get right is which timestamps `withStageAdvanced`,
// `withStageStarted` and `withStageSkipped` actually leave on a run — above all
// which stage gets a start stamped on it and which does not — and a hand-written
// fixture would pin the log against this test's guess at that instead.

function stage(
  id: string,
  minutes: number | null,
  plannedStartAt: string,
  plannedEndAt: string,
): BatchStageDoc {
  return {
    id,
    label: id,
    kind: 'wait',
    environment: null,
    duration: minutes === null ? null : { kind: 'fixed', minutes },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt,
    plannedEndAt,
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
  };
}

function observation(
  id: string,
  at: string,
  over: Partial<BatchObservationDoc> = {},
): BatchObservationDoc {
  return {
    id,
    schemaVersion: 1,
    at,
    stageId: null,
    weightGrams: null,
    ph: null,
    temperatureC: null,
    note: '',
    image: null,
    ...over,
  };
}

function loaf(stages: BatchStageDoc[], over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'overnight-white-tin',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages,
    rationale: null,
    ambientCelsius: null,
    createdAt: '2026-09-05T17:12:00.000Z',
    updatedAt: '2026-09-05T17:12:00.000Z',
    ...over,
  };
}

// The schedule as it was resolved at 17:12 on the Saturday: a contiguous queue, mix
// through bake, with the overnight retard doing the waiting.
function plannedLoaf(): BatchStageDoc[] {
  return [
    stage('mix', 60, '2026-09-05T20:00:00.000Z', '2026-09-05T21:00:00.000Z'),
    stage('bulk', 180, '2026-09-05T21:00:00.000Z', '2026-09-06T00:00:00.000Z'),
    stage('fold', 10, '2026-09-06T00:00:00.000Z', '2026-09-06T00:10:00.000Z'),
    stage('shape', 15, '2026-09-06T00:10:00.000Z', '2026-09-06T00:25:00.000Z'),
    stage('prove', 335, '2026-09-06T00:25:00.000Z', '2026-09-06T06:00:00.000Z'),
    stage('bake', 45, '2026-09-06T06:00:00.000Z', '2026-09-06T06:45:00.000Z'),
  ];
}

function kinds(log: BatchLogEntry[]): string[] {
  return log.map((entry) => entry.kind);
}

/**
 * The bake as it actually ran, driven through the producers in the order the cook
 * would have tapped them.
 *
 * The oven goes on at 06:12 BEFORE the retard is marked done at 06:20, which is the
 * only way a start ever gets an instant of its own: once a stage is advanced, its
 * successor's start is that boundary.
 */
function bakedLoaf(): BatchDoc {
  let run = loaf(plannedLoaf());
  run = withStageStarted(run, 'mix', '2026-09-05T20:00:00.000Z');
  run = withStageAdvanced(run, 'mix', '2026-09-05T21:04:00.000Z');
  run = withStageAdvanced(run, 'bulk', '2026-09-06T00:19:00.000Z');
  run = withStageSkipped(run, 'fold', '2026-09-06T00:21:00.000Z', 'dough was already there');
  run = withStageAdvanced(run, 'shape', '2026-09-06T00:40:00.000Z');
  run = withStageStarted(run, 'bake', '2026-09-06T06:12:00.000Z');
  run = withStageAdvanced(run, 'prove', '2026-09-06T06:20:00.000Z');
  return withStageAdvanced(run, 'bake', '2026-09-06T07:04:00.000Z');
}

const readings = [
  observation('obs-shape', '2026-09-06T00:45:00.000Z', {
    weightGrams: 1483,
    note: 'felt slack, dusted heavily',
    stageId: 'shape',
    image: { url: 'https://example.test/a.jpg', source: 'upload' },
  }),
  observation('obs-out', '2026-09-06T07:10:00.000Z', { weightGrams: 108, note: 'good crumb' }),
];

describe('buildBatchLog — a run with nothing in it', () => {
  it('is one line: the run being started', () => {
    // A run with nothing but a start reads as a run with nothing but a start, and
    // the caller renders it rather than treating it as an empty screen.
    expect(buildBatchLog(loaf(plannedLoaf()), [])).toEqual([
      { kind: 'batchStarted', at: '2026-09-05T17:12:00.000Z' },
    ]);
  });

  it('says nothing about stages that are only planned', () => {
    // PLANNED IS NOT ACTUAL. Nothing back-fills an actual from a planned time, and
    // the log must not either — a schedule is not a record of what happened.
    expect(kinds(buildBatchLog(loaf(plannedLoaf()), []))).toEqual(['batchStarted']);
  });
});

describe('buildBatchLog — the whole of a bake, in order', () => {
  it('puts everything that happened in one list, oldest first', () => {
    expect(buildBatchLog(bakedLoaf(), readings).map((entry) => [entry.kind, entry.at])).toEqual([
      ['batchStarted', '2026-09-05T17:12:00.000Z'],
      ['stageStarted', '2026-09-05T20:00:00.000Z'],
      ['stageDone', '2026-09-05T21:04:00.000Z'],
      ['stageDone', '2026-09-06T00:19:00.000Z'],
      ['stageSkipped', '2026-09-06T00:21:00.000Z'],
      ['stageDone', '2026-09-06T00:40:00.000Z'],
      ['observation', '2026-09-06T00:45:00.000Z'],
      ['stageStarted', '2026-09-06T06:12:00.000Z'],
      ['stageDone', '2026-09-06T06:20:00.000Z'],
      ['stageDone', '2026-09-06T07:04:00.000Z'],
      ['observation', '2026-09-06T07:10:00.000Z'],
    ]);
  });

  it('prints one boundary once, not twice', () => {
    // THE COLLAPSE, and the reason the fixture goes through the producers. The bulk
    // starts when the mix ends and the fold when the bulk ends — both stamped by
    // `withStageAdvanced`, both the same fact as the line above them. Only the mix's
    // own start (nothing precedes it) and the oven going on at 06:12 survive.
    const starts = buildBatchLog(bakedLoaf(), []).filter((entry) => entry.kind === 'stageStarted');
    expect(starts).toEqual([
      { kind: 'stageStarted', at: '2026-09-05T20:00:00.000Z', stageId: 'mix' },
      { kind: 'stageStarted', at: '2026-09-06T06:12:00.000Z', stageId: 'bake' },
    ]);
  });

  it('puts the independent start before the stage that was still running', () => {
    // The whole point of `withStageStarted`: the oven at 06:12 while the retard runs
    // to 06:20. Ordering by instant is what makes the overlap readable.
    const log = buildBatchLog(bakedLoaf(), []);
    const ovenOn = log.findIndex(
      (entry) => entry.kind === 'stageStarted' && entry.stageId === 'bake',
    );
    const proveDone = log.findIndex(
      (entry) => entry.kind === 'stageDone' && entry.stageId === 'prove',
    );
    expect(ovenOn).toBeLessThan(proveDone);
  });

  it('carries the skip reason on the skip, not somewhere to be joined by eye', () => {
    expect(buildBatchLog(bakedLoaf(), []).find((entry) => entry.kind === 'stageSkipped')).toEqual({
      kind: 'stageSkipped',
      at: '2026-09-06T00:21:00.000Z',
      stageId: 'fold',
      note: 'dough was already there',
    });
  });

  it('carries the whole reading — weight, note, stage and photo — on its own line', () => {
    const entry = buildBatchLog(bakedLoaf(), readings).find((item) => item.kind === 'observation');
    expect(entry).toEqual({
      kind: 'observation',
      at: '2026-09-06T00:45:00.000Z',
      observation: readings[0],
    });
  });

  it('says how each finished step ran against the time it was given', () => {
    const drift = buildBatchLog(bakedLoaf(), [])
      .filter((entry) => entry.kind === 'stageDone')
      .map((entry) => [entry.stageId, entry.driftMinutes]);
    // Four minutes over on the mix, fifteen on the bulk, four on the shape, five on
    // the retard — and the bake a minute under. Each against the plan as it stood
    // when that stage began, which is what the re-timing leaves behind.
    expect(drift).toEqual([
      ['mix', 4],
      ['bulk', 15],
      ['shape', 4],
      ['prove', 5],
      ['bake', -1],
    ]);
  });
});

describe('buildBatchLog — the drift figure, and what it is not', () => {
  it('is signed: negative when the step came in under the time it was given', () => {
    const stages = plannedLoaf();
    stages[0] = { ...stages[0]!, actualEndAt: '2026-09-05T20:53:00.000Z' };
    const done = buildBatchLog(loaf(stages), []).find((entry) => entry.kind === 'stageDone');
    expect(done?.kind === 'stageDone' && done.driftMinutes).toBe(-7);
  });

  it('has no figure for a step that was given no time', () => {
    // An observational stage ("until it has doubled") is a zero-length point on the
    // clock, so the difference would measure how late the cook GOT TO IT rather than
    // how long it ran over. There is no time it was given, so there is no over or
    // under — and the log must not print one.
    const bench = stage('prove', null, '2026-09-05T21:00:00.000Z', '2026-09-05T21:00:00.000Z');
    const stages = [{ ...bench, actualEndAt: '2026-09-05T23:30:00.000Z' }];
    const done = buildBatchLog(loaf(stages), []).find((entry) => entry.kind === 'stageDone');
    expect(done?.kind === 'stageDone' && done.driftMinutes).toBeNull();
  });

  it('measures against the plan as it stood when the step began, not the original', () => {
    // THE LIMIT, PINNED. The bake was planned for 06:00–06:45 when the run started;
    // by the time it was reached the re-timings had moved it to 06:20–07:05, and it
    // came out at 07:04. The log says ONE MINUTE UNDER, against the plan the bake was
    // actually running to — not the 19 minutes late it is against the schedule the
    // run started with. That original figure is unrecoverable from the document and
    // nothing may claim it.
    const original = plannedLoaf().at(-1)!;
    expect(original.plannedEndAt).toBe('2026-09-06T06:45:00.000Z');

    const run = bakedLoaf();
    expect(run.stages.at(-1)!.plannedEndAt).toBe('2026-09-06T07:05:00.000Z');

    const bake = buildBatchLog(run, []).find(
      (entry) => entry.kind === 'stageDone' && entry.stageId === 'bake',
    );
    expect(bake?.kind === 'stageDone' && bake.driftMinutes).toBe(-1);
  });
});

describe('buildBatchLog — order is total, and stable', () => {
  it('sorts a back-dated reading to when it was taken, not when it arrived', () => {
    // `at` is WHEN IT WAS OBSERVED. A weight read before the mix and typed in the
    // next morning belongs where it was read, and the caller's order must not move it.
    const stages = plannedLoaf();
    stages[0] = { ...stages[0]!, actualEndAt: '2026-09-05T21:04:00.000Z' };
    const log = buildBatchLog(loaf(stages), [
      observation('typed-late', '2026-09-05T18:00:00.000Z', { note: 'typed in on Sunday' }),
      observation('typed-early', '2026-09-05T22:00:00.000Z'),
    ]);
    expect(log.map((entry) => entry.at)).toEqual([
      '2026-09-05T17:12:00.000Z',
      '2026-09-05T18:00:00.000Z',
      '2026-09-05T21:04:00.000Z',
      '2026-09-05T22:00:00.000Z',
    ]);
  });

  it('breaks a tie the same way every time — stage before reading, caller order kept', () => {
    // TWO ENTRIES AT ONE INSTANT. The tiebreak is construction order — the batch,
    // then the stages in process order, then the observations — carried explicitly so
    // the same two never swap between renders.
    const at = '2026-09-05T21:04:00.000Z';
    const stages = plannedLoaf();
    stages[0] = { ...stages[0]!, actualEndAt: at };
    const a = observation('obs-a', at);
    const b = observation('obs-b', at);

    const log = buildBatchLog(loaf(stages), [a, b]);
    expect(kinds(log)).toEqual(['batchStarted', 'stageDone', 'observation', 'observation']);
    expect(log.filter((e) => e.kind === 'observation').map((e) => e.observation.id)).toEqual([
      'obs-a',
      'obs-b',
    ]);

    // The caller's own order at a shared instant is what it is — Firestore's `orderBy
    // at` falls back to the random document id — and the producer preserves it rather
    // than imposing a second one.
    const reversed = buildBatchLog(loaf(stages), [b, a]);
    expect(kinds(reversed)).toEqual(kinds(log));
    expect(reversed.filter((e) => e.kind === 'observation').map((e) => e.observation.id)).toEqual([
      'obs-b',
      'obs-a',
    ]);
  });

  it('leaves out an entry whose instant cannot be read', () => {
    // Omitted rather than sorted arbitrarily to one end of the list.
    const stages = plannedLoaf();
    stages[0] = { ...stages[0]!, actualEndAt: 'not a time' };
    const log = buildBatchLog(loaf(stages), [observation('obs-bad', 'nor this')]);
    expect(kinds(log)).toEqual(['batchStarted']);
  });
});

describe('buildBatchLog — a run that was stopped', () => {
  it('says when it was abandoned, at the end of the list', () => {
    const stopped = withBatchAbandoned(bakedLoaf(), '2026-09-06T08:10:00.000Z');
    expect(buildBatchLog(stopped, readings).at(-1)).toEqual({
      kind: 'batchAbandoned',
      at: '2026-09-06T08:10:00.000Z',
    });
  });

  it('claims no time for a run abandoned before the field existed', () => {
    // HONEST ABOUT WHAT IT DOES NOT KNOW. A run stopped before `abandonedAt` shipped
    // carries `null`, so there is simply no abandonment line — `updatedAt` is a later
    // write's timestamp and would be a lie dressed as a record.
    const log = buildBatchLog(loaf(plannedLoaf(), { state: 'abandoned' }), []);
    expect(kinds(log)).toEqual(['batchStarted']);
  });

  it('invents no finished line for a run whose every stage is done', () => {
    // There is no `finished` state (see `BatchStateSchema`) and the log must not
    // conjure one: the run ends on its last stage, which is what happened.
    const log = buildBatchLog(bakedLoaf(), []);
    expect(log.at(-1)).toMatchObject({ kind: 'stageDone', stageId: 'bake' });
    expect(kinds(log)).not.toContain('batchAbandoned');
  });
});
