import { describe, it, expect } from 'vitest';
import {
  currentStage,
  stageStatus,
  withBatchAbandoned,
  withStageAdvanced,
  withStageSkipped,
  withStageStarted,
} from '../../src/index.js';
import type { BatchDoc, BatchStageDoc } from '../../src/schemas/index.js';

// The run moving along, on the same loaf the freeze test starts: mixed at 01:50,
// out of the oven at 07:30. What is under test is that marking a stage done EARLY
// OR LATE re-times everything after it — the schedule is a live plan, not a
// decoration written once and left to be wrong.

function stage(
  id: string,
  minutes: number,
  plannedStartAt: string,
  plannedEndAt: string,
): BatchStageDoc {
  return {
    id,
    label: id,
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt,
    plannedEndAt,
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
  };
}

function runningLoaf(): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'overnight-white-tin',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    quantities: [
      { ingredientId: 'ing-flour', label: '500g strong white', percent: 100, grams: 841 },
    ],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages: [
      stage('bulk', 180, '2026-08-15T02:10:00.000Z', '2026-08-15T05:10:00.000Z'),
      stage('shape', 15, '2026-08-15T05:10:00.000Z', '2026-08-15T05:25:00.000Z'),
      stage('prove', 60, '2026-08-15T05:25:00.000Z', '2026-08-15T06:25:00.000Z'),
      stage('bake', 45, '2026-08-15T06:25:00.000Z', '2026-08-15T07:10:00.000Z'),
    ],
    rationale: null,
    createdAt: '2026-08-14T21:00:00.000Z',
    updatedAt: '2026-08-14T21:00:00.000Z',
  };
}

describe('currentStage', () => {
  it('is the first stage nobody has marked done', () => {
    expect(currentStage(runningLoaf())?.id).toBe('bulk');
  });

  it('moves on as stages are marked done', () => {
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:10:00.000Z');
    expect(currentStage(advanced)?.id).toBe('shape');
  });

  it('is null once every stage is done', () => {
    // No `finished` state is stored: "the run is over" is answerable from the
    // stages themselves, which is why the enum does not carry one yet.
    let batch = runningLoaf();
    for (const id of ['bulk', 'shape', 'prove', 'bake']) {
      batch = withStageAdvanced(batch, id, '2026-08-15T07:10:00.000Z');
    }
    expect(currentStage(batch)).toBeNull();
  });

  it('is null for an abandoned batch, which has no next action', () => {
    expect(currentStage(withBatchAbandoned(runningLoaf()))).toBeNull();
  });
});

describe('withStageAdvanced', () => {
  it('records when the stage actually ended', () => {
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:40:00.000Z');
    expect(advanced.stages[0]?.actualEndAt).toBe('2026-08-15T05:40:00.000Z');
  });

  it('starts the next stage on the same instant — one boundary with two names', () => {
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:40:00.000Z');
    expect(advanced.stages[1]?.actualStartAt).toBe('2026-08-15T05:40:00.000Z');
    // And no further: a stage the cook has not reached has not started.
    expect(advanced.stages[2]?.actualStartAt).toBeNull();
    expect(advanced.stages[3]?.actualStartAt).toBeNull();
  });

  it('pushes the whole rest of the schedule back when a stage runs long', () => {
    // The bulk ferment took thirty minutes longer than planned. Breakfast moves.
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:40:00.000Z');
    expect(advanced.stages.map((s) => [s.id, s.plannedStartAt, s.plannedEndAt])).toEqual([
      // The stage that is done keeps the times it was planned at; its actual end is
      // recorded separately, so the plan and what happened can still be compared.
      ['bulk', '2026-08-15T02:10:00.000Z', '2026-08-15T05:10:00.000Z'],
      ['shape', '2026-08-15T05:40:00.000Z', '2026-08-15T05:55:00.000Z'],
      ['prove', '2026-08-15T05:55:00.000Z', '2026-08-15T06:55:00.000Z'],
      ['bake', '2026-08-15T06:55:00.000Z', '2026-08-15T07:40:00.000Z'],
    ]);
  });

  it('pulls it forward just the same when a stage finishes early', () => {
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T04:40:00.000Z');
    expect(advanced.stages[3]?.plannedEndAt).toBe('2026-08-15T06:40:00.000Z');
  });

  it('leaves the frozen quantities and totals entirely alone', () => {
    const before = runningLoaf();
    const after = withStageAdvanced(before, 'bulk', '2026-08-15T05:40:00.000Z');
    expect(after.quantities).toEqual(before.quantities);
    expect(after.totals).toEqual(before.totals);
  });

  it('does not stamp updatedAt — the write path owns that', () => {
    const advanced = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:40:00.000Z');
    expect(advanced.updatedAt).toBe('2026-08-14T21:00:00.000Z');
  });

  it('never mutates the batch it was given', () => {
    const before = runningLoaf();
    withStageAdvanced(before, 'bulk', '2026-08-15T05:40:00.000Z');
    expect(before.stages[0]?.actualEndAt).toBeNull();
    expect(before.stages[1]?.plannedStartAt).toBe('2026-08-15T05:10:00.000Z');
  });

  it('is a no-op on an unknown stage id', () => {
    const before = runningLoaf();
    expect(withStageAdvanced(before, 'not-a-stage', '2026-08-15T05:40:00.000Z')).toEqual(before);
  });

  it('is a no-op on a batch that is not running', () => {
    const abandoned = withBatchAbandoned(runningLoaf());
    expect(withStageAdvanced(abandoned, 'bulk', '2026-08-15T05:40:00.000Z')).toEqual(abandoned);
  });

  it('is a no-op rather than a half-applied mark when the instant cannot be read', () => {
    const before = runningLoaf();
    expect(withStageAdvanced(before, 'bulk', 'about five')).toEqual(before);
  });

  it('re-marks a stage as a correction rather than refusing it', () => {
    // The cook tapped the wrong row, then fixed it. A producer that threw on the
    // disagreement would turn a mis-tap into a crash.
    const once = withStageAdvanced(runningLoaf(), 'bulk', '2026-08-15T05:40:00.000Z');
    const corrected = withStageAdvanced(once, 'bulk', '2026-08-15T05:10:00.000Z');
    expect(corrected.stages[0]?.actualEndAt).toBe('2026-08-15T05:10:00.000Z');
    expect(corrected.stages[1]?.plannedStartAt).toBe('2026-08-15T05:10:00.000Z');
  });
});

describe('withBatchAbandoned', () => {
  it('stops the run without touching what it recorded', () => {
    const before = runningLoaf();
    const abandoned = withBatchAbandoned(before);
    expect(abandoned.state).toBe('abandoned');
    expect(abandoned.quantities).toEqual(before.quantities);
    expect(abandoned.stages).toEqual(before.stages);
  });

  it('is idempotent, and returns the same document when there is nothing to change', () => {
    const abandoned = withBatchAbandoned(runningLoaf());
    expect(withBatchAbandoned(abandoned)).toBe(abandoned);
  });
});

// ─── Four conditions on a run (issue #1275) ────────────────────────────────────

describe('stageStatus — the four conditions, and their precedence', () => {
  const base = stage('s', 30, '2026-08-15T02:10:00.000Z', '2026-08-15T02:40:00.000Z');

  it('reads a stage nobody has touched as not started', () => {
    expect(stageStatus(base)).toBe('notStarted');
  });

  it('reads a started-but-unfinished stage as in progress', () => {
    expect(stageStatus({ ...base, actualStartAt: '2026-08-15T02:10:00.000Z' })).toBe('inProgress');
  });

  it('reads a finished stage as done, started or not', () => {
    expect(stageStatus({ ...base, actualEndAt: '2026-08-15T02:40:00.000Z' })).toBe('done');
    expect(
      stageStatus({
        ...base,
        actualStartAt: '2026-08-15T02:10:00.000Z',
        actualEndAt: '2026-08-15T02:40:00.000Z',
      }),
    ).toBe('done');
  });

  it('reads a skipped stage as skipped', () => {
    expect(stageStatus({ ...base, skipped: { at: '2026-08-15T02:10:00.000Z', note: '' } })).toBe(
      'skipped',
    );
  });

  it('puts SKIPPED ABOVE DONE, and above in progress', () => {
    // The load-bearing half of the precedence. A stage can carry both stamps —
    // start the oven, then decide not to bother — and the skip is the later
    // decision and the one the cook actually made. Nothing clears the other
    // fields: the oven really did go on, and erasing that would lose it.
    const both: BatchStageDoc = {
      ...base,
      actualStartAt: '2026-08-15T02:10:00.000Z',
      actualEndAt: '2026-08-15T02:40:00.000Z',
      skipped: { at: '2026-08-15T02:45:00.000Z', note: 'changed my mind' },
    };
    expect(stageStatus(both)).toBe('skipped');
    expect(both.actualEndAt).not.toBeNull();
  });
});

describe('withStageStarted — overlap is recorded, never planned', () => {
  it('marks a stage in progress without marking it done', () => {
    const started = withStageStarted(runningLoaf(), 'bulk', '2026-08-15T02:10:00.000Z');
    const bulk = started.stages[0]!;
    expect(stageStatus(bulk)).toBe('inProgress');
    expect(bulk.actualEndAt).toBeNull();
  });

  it('RE-TIMES NOTHING — the plan stays a strict queue', () => {
    // The whole decision behind overlap-by-marking: starting a stage early records
    // what you did, it does not re-draw the timings. If this ever starts moving
    // planned times, `resolveSchedule` has been dragged into the run.
    const before = runningLoaf();
    const after = withStageStarted(before, 'bake', '2026-08-15T05:00:00.000Z');
    expect(after.stages.map((s) => [s.plannedStartAt, s.plannedEndAt])).toEqual(
      before.stages.map((s) => [s.plannedStartAt, s.plannedEndAt]),
    );
  });

  it('lets two stages be in progress at once, and each be finished in either order', () => {
    // The oven goes on twenty minutes before the prove finishes.
    let run = withStageStarted(runningLoaf(), 'prove', '2026-08-15T05:25:00.000Z');
    run = withStageStarted(run, 'bake', '2026-08-15T06:05:00.000Z');
    expect(run.stages.filter((s) => stageStatus(s) === 'inProgress').map((s) => s.id)).toEqual([
      'prove',
      'bake',
    ]);

    // …and the bake is marked done before the prove, which is the wrong order for a
    // queue and the right one for a record.
    run = withStageAdvanced(run, 'bake', '2026-08-15T07:10:00.000Z');
    run = withStageAdvanced(run, 'prove', '2026-08-15T06:25:00.000Z');
    expect(run.stages.map(stageStatus)).toEqual(['notStarted', 'notStarted', 'done', 'done']);
  });

  it('keeps the FIRST start it was given rather than moving it later', () => {
    const first = withStageStarted(runningLoaf(), 'bulk', '2026-08-15T02:10:00.000Z');
    const again = withStageStarted(first, 'bulk', '2026-08-15T03:00:00.000Z');
    expect(again.stages[0]!.actualStartAt).toBe('2026-08-15T02:10:00.000Z');
  });

  it('does not let the INFERRED successor stamp overwrite an observed one', () => {
    // `withStageAdvanced` stamps the successor's `actualStartAt` from the boundary.
    // Since `withStageStarted` exists, that successor may already carry a real "I
    // put the oven on at 06:40", which is earlier and truer.
    const started = withStageStarted(runningLoaf(), 'shape', '2026-08-15T04:00:00.000Z');
    const advanced = withStageAdvanced(started, 'bulk', '2026-08-15T05:10:00.000Z');
    expect(advanced.stages[1]!.actualStartAt).toBe('2026-08-15T04:00:00.000Z');
  });

  it('is total: unknown id, abandoned run and unreadable instant all no-op', () => {
    const run = runningLoaf();
    expect(withStageStarted(run, 'nope', '2026-08-15T02:10:00.000Z')).toEqual(run);
    expect(withStageStarted(run, 'bulk', 'not a time')).toEqual(run);
    const stopped = withBatchAbandoned(run);
    expect(withStageStarted(stopped, 'bulk', '2026-08-15T02:10:00.000Z')).toEqual(stopped);
  });
});

describe('withStageSkipped', () => {
  it('records the skip with its time and no note', () => {
    const run = withStageSkipped(runningLoaf(), 'shape', '2026-08-15T05:10:00.000Z');
    expect(run.stages[1]!.skipped).toEqual({ at: '2026-08-15T05:10:00.000Z', note: '' });
  });

  it('records the reason when one was given, trimmed', () => {
    const run = withStageSkipped(runningLoaf(), 'shape', '2026-08-15T05:10:00.000Z', '  no milk  ');
    expect(run.stages[1]!.skipped).toEqual({ at: '2026-08-15T05:10:00.000Z', note: 'no milk' });
  });

  it('pulls everything after it forward, exactly as marking it done would', () => {
    // Skipping the 15-minute shape at 05:10 starts the prove at 05:10 rather than
    // 05:25, and the bake follows it.
    const run = withStageSkipped(runningLoaf(), 'shape', '2026-08-15T05:10:00.000Z');
    expect(run.stages[2]!.plannedStartAt).toBe('2026-08-15T05:10:00.000Z');
    expect(run.stages[2]!.plannedEndAt).toBe('2026-08-15T06:10:00.000Z');
    expect(run.stages[3]!.plannedStartAt).toBe('2026-08-15T06:10:00.000Z');
  });

  it('leaves the SKIPPED stage’s own planned times alone', () => {
    // They are meaningless now and the surface stops rendering them — but blanking
    // them in the document would destroy what the plan said, on the one record that
    // exists to say what the plan said.
    const before = runningLoaf();
    const after = withStageSkipped(before, 'shape', '2026-08-15T05:10:00.000Z');
    expect(after.stages[1]!.plannedStartAt).toBe(before.stages[1]!.plannedStartAt);
    expect(after.stages[1]!.plannedEndAt).toBe(before.stages[1]!.plannedEndAt);
  });

  it('skips a REQUIRED stage — there is no gate on `optional`', () => {
    // Daniel's call: the app records what happened in the kitchen, it does not hold
    // an opinion about it. Every stage in this fixture is `optional: false`.
    const run = runningLoaf();
    expect(run.stages.every((s) => s.optional === false)).toBe(true);
    const skipped = withStageSkipped(run, 'bake', '2026-08-15T06:25:00.000Z');
    expect(stageStatus(skipped.stages[3]!)).toBe('skipped');
  });

  it('does not re-time a stage that was already skipped, nor let it push the rest', () => {
    // `resolveSchedule` runs over the UNSKIPPED remainder only. The prove was
    // skipped first; skipping the shape afterwards must leave the prove's stale
    // times alone AND must not add its 60 minutes to the bake.
    const first = withStageSkipped(runningLoaf(), 'prove', '2026-08-15T05:25:00.000Z');
    const provePlanned = first.stages[2]!.plannedStartAt;
    const second = withStageSkipped(first, 'shape', '2026-08-15T05:10:00.000Z');
    expect(second.stages[2]!.plannedStartAt).toBe(provePlanned);
    expect(second.stages[3]!.plannedStartAt).toBe('2026-08-15T05:10:00.000Z');
  });

  it('never asks for a skipped stage again — `currentStage` steps over it', () => {
    const run = withStageSkipped(runningLoaf(), 'bulk', '2026-08-15T02:10:00.000Z');
    expect(currentStage(run)?.id).toBe('shape');
  });

  it('finishes a run whose LAST stage was skipped rather than done', () => {
    let run = runningLoaf();
    for (const id of ['bulk', 'shape', 'prove']) {
      run = withStageAdvanced(run, id, '2026-08-15T06:25:00.000Z');
    }
    run = withStageSkipped(run, 'bake', '2026-08-15T06:25:00.000Z');
    expect(currentStage(run)).toBeNull();
  });

  it('restamps rather than refusing when a stage is skipped twice', () => {
    // Producers here are total and a correction is not an error — a wrong reason is
    // corrected by skipping again.
    const once = withStageSkipped(runningLoaf(), 'shape', '2026-08-15T05:10:00.000Z', 'wrong');
    const twice = withStageSkipped(once, 'shape', '2026-08-15T05:12:00.000Z', 'out of milk');
    expect(twice.stages[1]!.skipped).toEqual({
      at: '2026-08-15T05:12:00.000Z',
      note: 'out of milk',
    });
  });

  it('is total: unknown id, abandoned run and unreadable instant all no-op', () => {
    const run = runningLoaf();
    expect(withStageSkipped(run, 'nope', '2026-08-15T05:10:00.000Z')).toEqual(run);
    expect(withStageSkipped(run, 'shape', 'not a time')).toEqual(run);
    const stopped = withBatchAbandoned(run);
    expect(withStageSkipped(stopped, 'shape', '2026-08-15T05:10:00.000Z')).toEqual(stopped);
  });
});

describe('withStageAdvanced — with a skipped stage further down', () => {
  it('re-times over it, leaving its stale planned times alone', () => {
    // Skipping the prove, then marking the shape done. The bake must be re-timed
    // from the shape's real end WITHOUT the prove's 60 minutes being added, and the
    // prove's own now-meaningless times must not be rewritten.
    const skipped = withStageSkipped(runningLoaf(), 'prove', '2026-08-15T05:25:00.000Z');
    const provePlanned = skipped.stages[2]!.plannedStartAt;

    const advanced = withStageAdvanced(skipped, 'shape', '2026-08-15T05:30:00.000Z');

    expect(advanced.stages[2]!.plannedStartAt).toBe(provePlanned);
    expect(advanced.stages[3]!.plannedStartAt).toBe('2026-08-15T05:30:00.000Z');
  });

  it('starts the first successor that is still going to happen, never the skipped one', () => {
    const skipped = withStageSkipped(runningLoaf(), 'prove', '2026-08-15T05:25:00.000Z');

    const advanced = withStageAdvanced(skipped, 'shape', '2026-08-15T05:30:00.000Z');

    expect(advanced.stages[2]!.actualStartAt).toBeNull();
    expect(advanced.stages[3]!.actualStartAt).toBe('2026-08-15T05:30:00.000Z');
  });
});

describe('currentStage — in progress is not finished with', () => {
  it('still names a stage that has been started but not marked done', () => {
    const run = withStageStarted(runningLoaf(), 'bulk', '2026-08-15T02:10:00.000Z');
    expect(currentStage(run)?.id).toBe('bulk');
  });
});
