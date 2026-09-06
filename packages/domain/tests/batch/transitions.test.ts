import { describe, it, expect } from 'vitest';
import * as transitions from '../../src/batch/transitions.js';
import { currentStage, withBatchAbandoned, withStageAdvanced } from '../../src/index.js';
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
    plannedStartAt,
    plannedEndAt,
    actualStartAt: null,
    actualEndAt: null,
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
      { ingredientId: 'ing-flour', label: '500g strong white', percent: 100, grams: 816 },
    ],
    totals: {
      basisGrams: 816,
      totalGrams: 1440,
      usableGrams: 1440,
      units: { count: 2, unitDoughGrams: 720 },
    },
    vessel: '900 g loaf tin',
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

// ─── The freeze holds (issue #1274, rule-12 claim 5) ────────────────────────────
//
// `BatchSchema.vessel` is justified by one property: a batch's figures and the
// vessel they were resolved against are stamped TOGETHER by `freezeBatch` and
// never move again, so — unlike on a live formula — they cannot drift into
// disagreeing.
//
// THAT NEEDED CHECKING, because a batch document is NOT immutable. `advanceStage`
// and `abandonBatch` both rewrite the whole document through `saveBatch`'s
// full-document `setDoc`, exactly as CLAUDE.md's LWW note describes, so the only
// guard available is at the producer.
//
// ITS REAL BOUNDARY: `totals` and `vessel` are written once, by `freezeBatch`, and
// no other producer touches them. This walks EVERY EXPORTED PRODUCER rather than
// the two named above, so a third one added later is covered the day it lands —
// which is the only way this claim can quietly break.
describe('every producer leaves the frozen figures alone', () => {
  // A producer is an exported function taking a batch and returning one. The
  // remaining exports (`currentStage`) are queries and return no document.
  const producers: ReadonlyArray<[string, (batch: BatchDoc) => BatchDoc]> = [
    ['withStageAdvanced', (batch) => withStageAdvanced(batch, 'bulk', '2026-08-15T05:30:00.000Z')],
    ['withBatchAbandoned', (batch) => withBatchAbandoned(batch)],
  ];

  it('covers every producer this module exports', () => {
    // The guard against the claim rotting: a producer added and not listed here
    // fails this before it can silently escape the assertion below.
    const exported = Object.entries(transitions)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    const queries = ['currentStage'];
    expect(new Set(exported)).toEqual(new Set([...queries, ...producers.map(([name]) => name)]));
  });

  for (const [name, apply] of producers) {
    it(`${name} returns totals and vessel referentially identical to what went in`, () => {
      const before = runningLoaf();
      const after = apply(before);
      // REFERENTIAL, not deep: a producer that rebuilt an equal `totals` would
      // pass a deep comparison while having taken ownership of a field the freeze
      // owns, and the next edit to it would be the one that changed a number.
      expect(after.totals).toBe(before.totals);
      expect(after.vessel).toBe(before.vessel);
    });
  }

  it('holds through a whole run, not just one step', () => {
    const before = runningLoaf();
    let batch = before;
    for (const stageId of ['bulk', 'shape', 'prove', 'bake']) {
      batch = withStageAdvanced(batch, stageId, '2026-08-15T05:30:00.000Z');
    }
    batch = withBatchAbandoned(batch);
    expect(batch.totals).toBe(before.totals);
    expect(batch.vessel).toBe(before.vessel);
  });
});
