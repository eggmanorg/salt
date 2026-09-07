import { describe, it, expect } from 'vitest';
import {
  totalDurationMinutes,
  withStageAdded,
  withStageMoved,
  withStageRemoved,
  withStageUpdated,
} from '../../src/process/index.js';
import type { ProcessStage } from '../../src/schemas/index.js';

// The process module (issue #806, phase 2 of epic #778): ordering and total
// duration, and nothing else. No clock, no scheduling, no diff — those belong to a
// batch, which is a later phase and a different document.
//
// Every producer is TOTAL, and these tests are mostly about that: an unknown id and
// a move off either end are no-ops, because a review screen is exactly where the
// list under your finger and the list in your head disagree by one frame.

function stage(id: string, overrides: Partial<ProcessStage> = {}): ProcessStage {
  return {
    id,
    label: id,
    kind: 'wait',
    environment: null,
    duration: null,
    until: null,
    stepId: null,
    optional: false,
    ...overrides,
  };
}

const MIX = stage('mix', { kind: 'active', duration: { kind: 'fixed', minutes: 10 } });
const BULK = stage('bulk', { duration: { kind: 'range', minMinutes: 240, maxMinutes: 300 } });
const BAKE = stage('bake', { kind: 'active', duration: { kind: 'fixed', minutes: 40 } });

describe('withStageAdded', () => {
  it('appends by default', () => {
    expect(withStageAdded([MIX], BULK).map((s) => s.id)).toEqual(['mix', 'bulk']);
  });

  it('inserts in order when told where', () => {
    expect(withStageAdded([MIX, BAKE], BULK, 1).map((s) => s.id)).toEqual(['mix', 'bulk', 'bake']);
  });

  it('clamps an index off either end rather than tearing the list', () => {
    expect(withStageAdded([MIX], BULK, -5).map((s) => s.id)).toEqual(['bulk', 'mix']);
    expect(withStageAdded([MIX], BULK, 99).map((s) => s.id)).toEqual(['mix', 'bulk']);
  });

  it('does not mutate the list it was given', () => {
    const before = [MIX];
    withStageAdded(before, BULK);
    expect(before).toEqual([MIX]);
  });
});

describe('withStageRemoved', () => {
  it('removes by id', () => {
    expect(withStageRemoved([MIX, BULK, BAKE], 'bulk').map((s) => s.id)).toEqual(['mix', 'bake']);
  });

  it('leaves an unknown id alone', () => {
    expect(withStageRemoved([MIX], 'nope').map((s) => s.id)).toEqual(['mix']);
  });
});

describe('withStageUpdated', () => {
  it('patches one stage and touches no other', () => {
    const next = withStageUpdated([MIX, BULK], 'bulk', {
      environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: null },
    });
    expect(next[1]!.environment).toEqual({
      temperature: { kind: 'fixed', celsius: 4 },
      equipmentId: null,
    });
    expect(next[0]).toEqual(MIX);
  });

  it('will not let a patch change the id it was found by', () => {
    // The id keys the review row being typed into. A patch that re-keyed it would
    // pull the row out from under the cursor.
    const next = withStageUpdated([BULK], 'bulk', { id: 'somethingElse' } as Partial<ProcessStage>);
    expect(next[0]!.id).toBe('bulk');
  });

  it('leaves an unknown id alone', () => {
    expect(withStageUpdated([MIX], 'nope', { label: 'x' })).toEqual([MIX]);
  });

  it('carries a caller’s own extra fields through', () => {
    // The generic is what lets the review surface hold its half-typed drafts (a
    // temperature as the raw string being typed) and still reorder and patch them
    // through these producers.
    interface Draft extends ProcessStage {
      celsiusText: string;
    }
    const draft: Draft = { ...BULK, celsiusText: '2' };
    const next = withStageUpdated([draft], 'bulk', { celsiusText: '24' });
    expect(next[0]!.celsiusText).toBe('24');
  });
});

describe('withStageMoved', () => {
  it('swaps with the neighbour in each direction', () => {
    expect(withStageMoved([MIX, BULK, BAKE], 'bulk', 'up').map((s) => s.id)).toEqual([
      'bulk',
      'mix',
      'bake',
    ]);
    expect(withStageMoved([MIX, BULK, BAKE], 'bulk', 'down').map((s) => s.id)).toEqual([
      'mix',
      'bake',
      'bulk',
    ]);
  });

  it('is a no-op at either end, not an error', () => {
    expect(withStageMoved([MIX, BULK], 'mix', 'up').map((s) => s.id)).toEqual(['mix', 'bulk']);
    expect(withStageMoved([MIX, BULK], 'bulk', 'down').map((s) => s.id)).toEqual(['mix', 'bulk']);
  });

  it('is a no-op on an unknown id', () => {
    expect(withStageMoved([MIX], 'nope', 'up').map((s) => s.id)).toEqual(['mix']);
  });
});

describe('totalDurationMinutes', () => {
  it('sums fixed and ranged stages into a RANGE, never a midpoint', () => {
    // 10 + (240–300) + 40. A collapsed answer would print "about 5 h 45" for a loaf
    // whose recipe never said any such thing.
    expect(totalDurationMinutes([MIX, BULK, BAKE])).toEqual({
      minMinutes: 290,
      maxMinutes: 350,
    });
  });

  it('keeps a fixed-only process a point value', () => {
    expect(totalDurationMinutes([MIX, BAKE])).toEqual({ minMinutes: 50, maxMinutes: 50 });
  });

  it('skips a stage with no duration rather than guessing one', () => {
    // "Prove until doubled" contributes nothing to either end. The total is at
    // least the timed stages; how much more is precisely what nobody knows.
    const untimed = stage('prove', { until: 'until doubled' });
    expect(totalDurationMinutes([MIX, untimed])).toEqual({ minMinutes: 10, maxMinutes: 10 });
  });

  it('totals an empty process at nothing', () => {
    expect(totalDurationMinutes([])).toEqual({ minMinutes: 0, maxMinutes: 0 });
  });

  it('survives a range typed the wrong way round', () => {
    // The schema deliberately carries no ordering refine — one hand-edited stage
    // must not fail the whole document — so the arithmetic normalises instead.
    const backwards = stage('rest', {
      duration: { kind: 'range', minMinutes: 60, maxMinutes: 45 },
    });
    expect(totalDurationMinutes([backwards])).toEqual({ minMinutes: 45, maxMinutes: 60 });
  });
});
