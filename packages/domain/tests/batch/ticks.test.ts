import { describe, it, expect } from 'vitest';
import type { BatchDoc, BatchStageDoc } from '../../src/schemas/index.js';
import { withBatchIngredientChecked, withBatchStepDone } from '../../src/index.js';

// The batch cook page's check-off producers (issue #1327).
//
// Two properties carry the weight here and both are relied on elsewhere:
//
//   • IDENTITY when nothing changes — `batchService` skips the Firestore write on
//     it, so a re-tap costs nothing;
//   • `stages` IS NEVER TOUCHED. A tick must not look like a stage transition to
//     `onBatchWritten`, whose reminder diff is keyed on the stages alone. The
//     trigger side of that claim is pinned in the cloud-functions suite; this is
//     the producer side.

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-1',
    label: 'Bulk',
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes: 60 },
    until: null,
    stepId: 'step-3',
    optional: false,
    plannedStartAt: '2026-09-11T07:00:00.000Z',
    plannedEndAt: '2026-09-11T08:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...over,
  };
}

function running(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'East Midlands Crusty Cobs',
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 500, totalGrams: 852, usableGrams: 852, units: null },
    stages: [stage(), stage({ id: 'stage-2', label: 'Bake', kind: 'active', stepId: 'step-9' })],
    rationale: null,
    ambientCelsius: null,
    checkedIngredientIds: [],
    completedStepIds: [],
    createdAt: '2026-09-11T06:00:00.000Z',
    updatedAt: '2026-09-11T06:00:00.000Z',
    ...over,
  };
}

describe('withBatchIngredientChecked', () => {
  it('ticks a row, and unticks it again', () => {
    const ticked = withBatchIngredientChecked(running(), 'ing-flour', true);
    expect(ticked.checkedIngredientIds).toEqual(['ing-flour']);
    expect(withBatchIngredientChecked(ticked, 'ing-flour', false).checkedIngredientIds).toEqual([]);
  });

  it('returns the SAME document when the row is already in that state', () => {
    const batch = running({ checkedIngredientIds: ['ing-flour'] });
    expect(withBatchIngredientChecked(batch, 'ing-flour', true)).toBe(batch);
    expect(withBatchIngredientChecked(batch, 'ing-water', false)).toBe(batch);
  });

  it('never mutates the document it was given', () => {
    const batch = running();
    withBatchIngredientChecked(batch, 'ing-flour', true);
    expect(batch.checkedIngredientIds).toEqual([]);
  });

  it('stores an id that names nothing, rather than refusing it', () => {
    // Nothing here knows what the run's ingredients are, and a tick left behind by
    // an edited-away ingredient is harmless: counts are taken over the rows on
    // screen (`progressOver`), never over this list.
    expect(withBatchIngredientChecked(running(), 'gone', true).checkedIngredientIds).toEqual([
      'gone',
    ]);
  });
});

describe('withBatchStepDone', () => {
  it('marks a step done, and unmarks it', () => {
    const done = withBatchStepDone(running(), 'step-3', true);
    expect(done.completedStepIds).toEqual(['step-3']);
    expect(withBatchStepDone(done, 'step-3', false).completedStepIds).toEqual([]);
  });

  it('returns the SAME document when the step is already in that state', () => {
    const batch = running({ completedStepIds: ['step-3'] });
    expect(withBatchStepDone(batch, 'step-3', true)).toBe(batch);
    expect(withBatchStepDone(batch, 'step-9', false)).toBe(batch);
  });
});

describe('neither producer touches the stages', () => {
  it('leaves `stages` referentially identical, so no reminder key can move', () => {
    // Referential identity, not deep equality: `onBatchWritten` diffs
    // `${stage.id}@${plannedStartAt}`, so what matters is that nothing in the array
    // was rebuilt at all. A rebuilt-but-equal array would pass a deep check and
    // still be a signal that something re-timed the run.
    const batch = running();
    const ticked = withBatchIngredientChecked(batch, 'ing-flour', true);
    const stepped = withBatchStepDone(ticked, 'step-3', true);

    expect(ticked.stages).toBe(batch.stages);
    expect(stepped.stages).toBe(batch.stages);
    expect(stepped.state).toBe('running');
    expect(stepped.updatedAt).toBe(batch.updatedAt);
  });

  it('works on an abandoned run too — a tick is a memory aid, not a transition', () => {
    // The stage producers all refuse a batch that is not running, because they
    // record what happened to the run. These do not: the cook page is only reachable
    // while a run is running, and a producer that silently no-op'd would be a gate
    // nobody asked for (Salt records, it does not police).
    const stopped = running({ state: 'abandoned', abandonedAt: '2026-09-11T09:00:00.000Z' });
    expect(withBatchStepDone(stopped, 'step-3', true).completedStepIds).toEqual(['step-3']);
  });
});
