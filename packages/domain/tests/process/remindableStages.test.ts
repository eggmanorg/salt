import { describe, it, expect } from 'vitest';
import { remindableStages } from '../../src/index.js';
import type { ProcessStage, StageDuration } from '../../src/schemas/index.js';

// The reminder rule (issue #812, phase 3 of epic #778): remind at the start of the
// FIRST stage, and at the start of any stage that FOLLOWS A `wait`.
//
// The overnight loaf below is THE PINNING TEST. Its expected answer is stated in
// the epic and in the trigger that consumes this function, so if a future edit
// makes the retard buzz at 02:00, this file is where it stops.

function stage(
  id: string,
  label: string,
  kind: 'active' | 'wait',
  duration: StageDuration | null = null,
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

// The overnight retarded loaf, exactly as the epic states it: mix(active),
// bulk(wait), shape(active), retard(wait), preheat(wait), bake(active). The retard
// is EIGHT HOURS in the fridge, which is the whole reason the rule exists.
const LOAF: ProcessStage[] = [
  stage('mix', 'Mix and knead', 'active', fixed(20)),
  stage('bulk', 'Bulk ferment', 'wait', fixed(180)),
  stage('shape', 'Shape into the tin', 'active', fixed(15)),
  stage('retard', 'Retard in the fridge', 'wait', fixed(480)),
  // THE BAKE IS `active`, THE PREHEAT IS `wait` — quoted from
  // ProcessStageKindSchema, and the fixture obeys it so nobody reads a
  // counter-example here.
  stage('preheat', 'Preheat the oven', 'wait', fixed(20)),
  stage('bake', 'Bake', 'active', fixed(45)),
];

const ids = (stages: readonly ProcessStage[]) => remindableStages(stages).map((s) => s.id);

describe('remindableStages — the overnight loaf (pinning test)', () => {
  it('reminds at mix, shape, preheat and bake — and nowhere else', () => {
    expect(ids(LOAF)).toEqual(['mix', 'shape', 'preheat', 'bake']);
  });

  it('says NOTHING across the eight overnight hours of the retard', () => {
    // The reminder before the retard is `shape`, the one after it is `preheat`.
    // Between them the fridge does the work and the phone stays silent — which is
    // the single behaviour the whole phase exists to produce.
    const remindable = ids(LOAF);
    expect(remindable).not.toContain('retard');
    expect(remindable).not.toContain('bulk');
    const shapeAt = remindable.indexOf('shape');
    expect(remindable[shapeAt + 1]).toBe('preheat');
  });

  it('reminds at the bake, because the preheat before it is a wait', () => {
    // The bake is the one stage a baker is guaranteed to want a ping for, and it
    // is in for the ordinary reason rather than a special case: the oven coming up
    // to temperature is unattended, so the bake is the end of that unattended
    // period.
    expect(ids(LOAF)).toContain('bake');
  });
});

describe('remindableStages — the rule', () => {
  it('always includes the first stage, whatever kind it is', () => {
    // A back-solved schedule ("out of the oven at 07:30") puts the start hours in
    // the future, and nothing else in the app announces it.
    expect(ids([stage('a', 'Mix', 'active'), stage('b', 'Prove', 'wait')])).toEqual(['a']);
    expect(ids([stage('a', 'Soak', 'wait'), stage('b', 'Drain', 'active')])).toEqual(['a', 'b']);
  });

  it('includes a wait that follows a wait — the handover still needs a person', () => {
    // Dough out of the fridge, oven on. The rule is about what PRECEDES a stage,
    // never about what the stage itself is.
    expect(ids([stage('a', 'Bulk', 'wait'), stage('b', 'Retard', 'wait')])).toEqual(['a', 'b']);
  });

  it('does NOT remind for a stage that follows an active one — you are already there', () => {
    expect(
      ids([stage('a', 'Mix', 'active'), stage('b', 'Knead', 'active'), stage('c', 'Rest', 'wait')]),
    ).toEqual(['a']);
  });

  it('gives a 90-day cure ONE reminder, not ninety', () => {
    // docs/formulas-schedules-batches.md: "A 90-day cure must not notify 90 times."
    // Reminders attach to stage transitions, never to elapsed time — so the length
    // of the stage is simply not an input, and a single 90-day dry is a single
    // reminder when it starts plus one for whatever follows it.
    const cure: ProcessStage[] = [
      stage('rub', 'Rub with cure', 'active', fixed(30)),
      stage('dry', 'Dry in the chamber', 'wait', fixed(90 * 24 * 60)),
      stage('slice', 'Slice', 'active', fixed(20)),
    ];
    expect(ids(cure)).toEqual(['rub', 'slice']);
  });

  it('is total on the empty and single-stage cases', () => {
    expect(remindableStages([])).toEqual([]);
    expect(ids([stage('only', 'Ferment', 'wait')])).toEqual(['only']);
  });

  it('returns the stages WHOLE, so a caller keeps whatever it passed in', () => {
    // The trigger passes BatchStageDocs and reads `plannedStartAt` straight off the
    // result. Generic in, generic out — no projection, no lookup.
    const rich = [
      { ...stage('mix', 'Mix', 'active'), plannedStartAt: '2026-08-14T06:00:00.000Z' },
      { ...stage('bulk', 'Bulk', 'wait'), plannedStartAt: '2026-08-14T06:20:00.000Z' },
      { ...stage('shape', 'Shape', 'active'), plannedStartAt: '2026-08-14T09:20:00.000Z' },
    ];
    expect(remindableStages(rich).map((s) => s.plannedStartAt)).toEqual([
      '2026-08-14T06:00:00.000Z',
      '2026-08-14T09:20:00.000Z',
    ]);
  });

  it('does not mutate or reorder its input', () => {
    const before = [...LOAF];
    remindableStages(LOAF);
    expect(LOAF).toEqual(before);
  });

  it('KNOWS NOTHING ABOUT A SKIP, and the rule is unchanged by one (issue #1275)', () => {
    // This module is pure and PLANNED-ONLY — its header says so, and the filtering
    // of a skipped stage belongs at enqueue in `onBatchWritten`, never here. The
    // pin is that the epic's loaf timeline is the same list whether or not a stage
    // in it has been skipped: the rule ("first stage, and any stage after a
    // `wait`") is about what PRECEDES a stage, and a skip does not change that.
    const withASkip = LOAF.map((stage) =>
      stage.id === 'shape'
        ? { ...stage, skipped: { at: '2026-08-14T09:20:00.000Z', note: 'already shaped' } }
        : stage,
    );
    expect(ids(withASkip)).toEqual(ids(LOAF));
    expect(ids(LOAF)).toEqual(['mix', 'shape', 'preheat', 'bake']);
  });
});
