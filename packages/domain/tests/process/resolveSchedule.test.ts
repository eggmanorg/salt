import { describe, it, expect } from 'vitest';
import { resolveSchedule } from '../../src/index.js';
import type { ProcessStage, StageDuration } from '../../src/schemas/index.js';
import type { ResolveScheduleResult } from '../../src/process/index.js';

// The overnight white tin's own process, as the extraction flow reads it off the
// method: mix, bulk ferment, shape, prove, preheat, bake. Six stages, five and a
// half hours, and a household that wants the loaf out of the oven at breakfast.
//
// Every time below is checkable by hand against the minutes in the fixture. If the
// suite says 02:00 and you make it 02:30 on paper, one of us is wrong — and it is
// visible before a batch is ever written.

function stage(
  id: string,
  label: string,
  kind: 'active' | 'wait',
  duration: StageDuration | null,
): ProcessStage {
  return {
    id,
    label,
    kind,
    environment: null,
    duration,
    until: null,
    stepId: null,
    optional: false,
  };
}

const fixed = (minutes: number): StageDuration => ({ kind: 'fixed', minutes });
const range = (minMinutes: number, maxMinutes: number): StageDuration => ({
  kind: 'range',
  minMinutes,
  maxMinutes,
});

// mix 20 · bulk 180 · shape 15 · prove 60 · preheat 20 · bake 45 = 340 minutes.
const LOAF: ProcessStage[] = [
  stage('mix', 'Mix and knead', 'active', fixed(20)),
  stage('bulk', 'Bulk ferment', 'wait', fixed(180)),
  stage('shape', 'Shape into the tin', 'active', fixed(15)),
  stage('prove', 'Final prove', 'wait', fixed(60)),
  // THE BAKE IS `active`, THE PREHEAT IS `wait` — quoted from
  // ProcessStageKindSchema, and the fixture obeys it so nobody reads a
  // counter-example here.
  stage('preheat', 'Preheat the oven', 'wait', fixed(20)),
  stage('bake', 'Bake', 'active', fixed(45)),
];

function planned(result: ResolveScheduleResult<ProcessStage>) {
  if (!result.ok) throw new Error(result.reason.kind);
  return result.stages.map((s) => [s.id, s.plannedStartAt, s.plannedEndAt]);
}

describe('resolveSchedule — forward, from a start', () => {
  it('runs the stages nose to tail from the anchor', () => {
    expect(
      planned(resolveSchedule(LOAF, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' })),
    ).toEqual([
      ['mix', '2026-08-14T09:00:00.000Z', '2026-08-14T09:20:00.000Z'],
      ['bulk', '2026-08-14T09:20:00.000Z', '2026-08-14T12:20:00.000Z'],
      ['shape', '2026-08-14T12:20:00.000Z', '2026-08-14T12:35:00.000Z'],
      ['prove', '2026-08-14T12:35:00.000Z', '2026-08-14T13:35:00.000Z'],
      ['preheat', '2026-08-14T13:35:00.000Z', '2026-08-14T13:55:00.000Z'],
      ['bake', '2026-08-14T13:55:00.000Z', '2026-08-14T14:40:00.000Z'],
    ]);
  });

  it('starts the first stage on the anchor exactly', () => {
    const result = resolveSchedule(LOAF, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    if (!result.ok) throw new Error(result.reason.kind);
    expect(result.stages[0]?.plannedStartAt).toBe('2026-08-14T09:00:00.000Z');
  });
});

describe('resolveSchedule — backward, to a finish', () => {
  // The reason the function is bidirectional. "Out of the oven at 07:30" is the
  // input, not something approached by adding six stages up and hoping.
  it('lands the last stage on the anchor exactly, and back-solves the rest', () => {
    expect(
      planned(resolveSchedule(LOAF, { kind: 'endAt', at: '2026-08-15T07:30:00.000Z' })),
    ).toEqual([
      // 07:30 less 340 minutes puts the mix at 01:50 the same night.
      ['mix', '2026-08-15T01:50:00.000Z', '2026-08-15T02:10:00.000Z'],
      ['bulk', '2026-08-15T02:10:00.000Z', '2026-08-15T05:10:00.000Z'],
      ['shape', '2026-08-15T05:10:00.000Z', '2026-08-15T05:25:00.000Z'],
      ['prove', '2026-08-15T05:25:00.000Z', '2026-08-15T06:25:00.000Z'],
      ['preheat', '2026-08-15T06:25:00.000Z', '2026-08-15T06:45:00.000Z'],
      ['bake', '2026-08-15T06:45:00.000Z', '2026-08-15T07:30:00.000Z'],
    ]);
  });

  it('is the exact inverse of the forward direction', () => {
    const forward = resolveSchedule(LOAF, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    if (!forward.ok) throw new Error(forward.reason.kind);
    const finishesAt = forward.stages[forward.stages.length - 1]!.plannedEndAt;

    // Back-solving from where the forward schedule ended must reproduce it
    // boundary for boundary. Nothing about the direction may round or drift.
    expect(planned(resolveSchedule(LOAF, { kind: 'endAt', at: finishesAt }))).toEqual(
      planned(forward),
    );
  });
});

describe('resolveSchedule — a duration that is a range', () => {
  // Pinned because the choice is a judgement, not an accident: a schedule needs one
  // number, and it takes the LONG end. A prove that takes 45–60 minutes is not
  // reliably done at 45, and 52.5 appears nowhere on the recipe.
  const proveRange: ProcessStage[] = [
    stage('shape', 'Shape', 'active', fixed(15)),
    stage('prove', 'Prove until springy', 'wait', range(45, 60)),
    stage('bake', 'Bake', 'active', fixed(30)),
  ];

  it('schedules a range at its long end', () => {
    expect(
      planned(resolveSchedule(proveRange, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' })),
    ).toEqual([
      ['shape', '2026-08-14T09:00:00.000Z', '2026-08-14T09:15:00.000Z'],
      // 60, not 45 and not 52.5.
      ['prove', '2026-08-14T09:15:00.000Z', '2026-08-14T10:15:00.000Z'],
      ['bake', '2026-08-14T10:15:00.000Z', '2026-08-14T10:45:00.000Z'],
    ]);
  });

  it('leaves the recipe’s own range untouched on the scheduled stage', () => {
    const result = resolveSchedule(proveRange, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    if (!result.ok) throw new Error(result.reason.kind);
    // The frozen batch must still be able to say what the recipe asked for, beside
    // the single time the schedule committed to.
    expect(result.stages[1]?.duration).toEqual({ kind: 'range', minMinutes: 45, maxMinutes: 60 });
  });

  it('reads a range typed backwards as the same range', () => {
    // A hand-edited stage may say "60 to 45"; the schema deliberately carries no
    // refine that would fail a whole document over it.
    const backwards = [stage('prove', 'Prove', 'wait', range(60, 45))];
    const result = resolveSchedule(backwards, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    if (!result.ok) throw new Error(result.reason.kind);
    expect(result.stages[0]?.plannedEndAt).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('resolveSchedule — a stage with no duration', () => {
  // "Until doubled" has no length. It takes zero elapsed time in the plan — the
  // same answer totalDurationMinutes gives by declining to add it to either end —
  // and the plan around it is provisional until somebody marks it done.
  const untilDoubled: ProcessStage[] = [
    stage('mix', 'Mix', 'active', fixed(20)),
    { ...stage('bulk', 'Bulk ferment', 'wait', null), until: 'until doubled' },
    stage('bake', 'Bake', 'active', fixed(45)),
  ];

  it('gives it a zero-length window going forward', () => {
    expect(
      planned(resolveSchedule(untilDoubled, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' })),
    ).toEqual([
      ['mix', '2026-08-14T09:00:00.000Z', '2026-08-14T09:20:00.000Z'],
      ['bulk', '2026-08-14T09:20:00.000Z', '2026-08-14T09:20:00.000Z'],
      ['bake', '2026-08-14T09:20:00.000Z', '2026-08-14T10:05:00.000Z'],
    ]);
  });

  it('copes going backwards too, and still lands the finish on the anchor', () => {
    expect(
      planned(resolveSchedule(untilDoubled, { kind: 'endAt', at: '2026-08-14T12:00:00.000Z' })),
    ).toEqual([
      ['mix', '2026-08-14T10:55:00.000Z', '2026-08-14T11:15:00.000Z'],
      ['bulk', '2026-08-14T11:15:00.000Z', '2026-08-14T11:15:00.000Z'],
      ['bake', '2026-08-14T11:15:00.000Z', '2026-08-14T12:00:00.000Z'],
    ]);
  });
});

describe('resolveSchedule — totality', () => {
  it('resolves an empty process to an empty schedule, not a failure', () => {
    const result = resolveSchedule([], { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    expect(result).toEqual({ ok: true, stages: [] });
  });

  it('refuses an anchor that is not a time, rather than producing Invalid Date', () => {
    const result = resolveSchedule(LOAF, { kind: 'endAt', at: 'breakfast' });
    expect(result).toEqual({ ok: false, reason: { kind: 'invalidAnchor', at: 'breakfast' } });
  });

  it('refuses rather than throwing when the arithmetic leaves the range of a date', () => {
    const forever = [stage('cure', 'Cure', 'wait', fixed(Number.MAX_SAFE_INTEGER))];
    const result = resolveSchedule(forever, { kind: 'startAt', at: '2026-08-14T09:00:00.000Z' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.kind).toBe('unschedulable');
  });

  it('carries every other field of the stage through untouched', () => {
    const rich: ProcessStage = {
      id: 'retard',
      label: 'Fridge retard',
      kind: 'wait',
      environment: { celsius: 4 },
      duration: fixed(600),
      until: null,
      stepId: 'step-3',
      optional: false,
    };
    const result = resolveSchedule([rich], { kind: 'startAt', at: '2026-08-14T21:00:00.000Z' });
    if (!result.ok) throw new Error(result.reason.kind);
    expect(result.stages[0]).toEqual({
      ...rich,
      plannedStartAt: '2026-08-14T21:00:00.000Z',
      plannedEndAt: '2026-08-15T07:00:00.000Z',
    });
  });
});
