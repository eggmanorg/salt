import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { BatchDoc, BatchStageDoc } from '@salt/domain/schemas';

// The three stage commands on `batchService` (issue #1275, extending #812 phase 3).
//
// What this file exists to pin is the ONE thing the service decides and the domain
// cannot: WHEN. Every producer in `@salt/domain` takes its instant as an argument
// (CLAUDE.md Rule 1), so the clock is read here and here only — which is what makes
// the re-timing a pure function with a fixed answer. A command that forgot to stamp
// would still write a document, and the run would silently record a skip at whatever
// time the producer defaulted to.
//
// The write path itself is `saveBatch` in `firebase-sync`, mocked: this is a test of
// the service's own arithmetic-free half, not of Firestore.

const { mockSaveBatch } = vi.hoisted(() => ({
  mockSaveBatch: vi.fn(
    async (_doc: unknown) => ({ kind: 'ok' }) as { kind: 'ok'; value: undefined } | { kind: 'err' },
  ),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeBatches: vi.fn(() => () => {}),
  subscribeBatch: vi.fn(() => () => {}),
  saveBatch: mockSaveBatch,
  callProposeSchedule: vi.fn(),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
}));

import {
  advanceStage,
  batch,
  setIngredientChecked,
  setStepDone,
  skipStage,
  startStage,
} from '../src/lib/batchService.js';
import { get } from 'svelte/store';

const NOW = '2026-08-15T05:10:00.000Z';

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-1',
    label: 'Shape',
    kind: 'active',
    environment: null,
    duration: { kind: 'fixed', minutes: 15 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: '2026-08-15T05:10:00.000Z',
    plannedEndAt: '2026-08-15T05:25:00.000Z',
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
    recipeTitle: 'Overnight white tin',
    state: 'running',
    abandonedAt: null,
    quantities: [],
    checkedIngredientIds: [],
    completedStepIds: [],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages: [
      stage(),
      stage({
        id: 'stage-2',
        label: 'Prove',
        kind: 'wait',
        duration: { kind: 'fixed', minutes: 60 },
        plannedStartAt: '2026-08-15T05:25:00.000Z',
        plannedEndAt: '2026-08-15T06:25:00.000Z',
      }),
    ],
    rationale: null,
    ambientCelsius: null,
    createdAt: '2026-08-14T21:00:00.000Z',
    updatedAt: '2026-08-14T21:00:00.000Z',
    ...over,
  };
}

/** The document handed to the writer by the last command. */
function written(): BatchDoc {
  return mockSaveBatch.mock.calls.at(-1)![0] as BatchDoc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockSaveBatch.mockResolvedValue({ kind: 'ok', value: undefined });
});

// The fake clock is per-test. Left installed it breaks the shared `afterAll` in
// tests/setup.ts, which waits on a real timer.
afterEach(() => {
  vi.useRealTimers();
});

describe('startStage', () => {
  it('stamps the stage started at NOW, and finishes nothing', async () => {
    await startStage(running(), 'stage-1');

    const stage1 = written().stages[0]!;
    expect(stage1.actualStartAt).toBe(NOW);
    expect(stage1.actualEndAt).toBeNull();
  });

  it('re-times nothing — the plan stays a strict queue', async () => {
    const before = running();
    await startStage(before, 'stage-2');

    expect(written().stages.map((s) => [s.plannedStartAt, s.plannedEndAt])).toEqual(
      before.stages.map((s) => [s.plannedStartAt, s.plannedEndAt]),
    );
  });

  it('returns the failure when the write fails', async () => {
    mockSaveBatch.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);

    const result = await startStage(running(), 'stage-1');

    expect(result.kind).toBe('err');
  });
});

describe('skipStage', () => {
  it('stamps the skip at NOW, with the empty string when no reason was given', async () => {
    await skipStage(running(), 'stage-1');

    expect(written().stages[0]!.skipped).toEqual({ at: NOW, note: '' });
  });

  it('carries the reason when there is one', async () => {
    await skipStage(running(), 'stage-1', 'out of milk');

    expect(written().stages[0]!.skipped).toEqual({ at: NOW, note: 'out of milk' });
  });

  it('pulls the rest of the schedule forward, as marking it done would', async () => {
    await skipStage(running(), 'stage-1');

    expect(written().stages[1]!.plannedStartAt).toBe(NOW);
  });

  it('returns the failure when the write fails', async () => {
    mockSaveBatch.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);

    const result = await skipStage(running(), 'stage-1');

    expect(result.kind).toBe('err');
  });
});

describe('the tick commands (issue #1327)', () => {
  // THE RULE-12 PIN for "a tick touches no stage". The batch cook page's weigh-out
  // and step check-offs write the WHOLE batch document, so the thing that must be
  // true is not that they leave the stages "equal" — it is that they do not rebuild
  // them at all, because `onBatchWritten` diffs `${stage.id}@${plannedStartAt}` off
  // exactly that array. Break the producer and this goes red here; break the trigger
  // and it goes red in the cloud-functions suite.

  it('leaves `stages` byte-equal, and stamps `updatedAt`', async () => {
    const before = running();
    await setIngredientChecked(before, 'ing-flour', true);

    expect(written().checkedIngredientIds).toEqual(['ing-flour']);
    expect(written().stages).toEqual(before.stages);
    expect(written().updatedAt).toBe(NOW);
  });

  it('marks a step done without touching a stage', async () => {
    const before = running();
    await setStepDone(before, 'step-3', true);

    expect(written().completedStepIds).toEqual(['step-3']);
    expect(written().stages).toEqual(before.stages);
  });

  it('writes NOTHING when the row is already in that state', async () => {
    // Identity from the producer short-circuits the write, so a Firestore echo
    // re-rendering the page cannot write the document it has just received back.
    const already = running({ checkedIngredientIds: ['ing-flour'], completedStepIds: ['step-3'] });

    const a = await setIngredientChecked(already, 'ing-flour', true);
    const b = await setStepDone(already, 'step-3', true);

    expect(mockSaveBatch).not.toHaveBeenCalled();
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
  });

  it('returns the failure when the write fails', async () => {
    mockSaveBatch.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);

    expect((await setStepDone(running(), 'step-3', true)).kind).toBe('err');
  });
});

describe('the three commands share one write path', () => {
  it('each stamps `updatedAt` and publishes the run to the store', async () => {
    // `persist` is the one place `updatedAt` is set — the domain deliberately does
    // not touch it, so exactly one place can disagree with itself about when the
    // document was last written.
    for (const command of [advanceStage, startStage, skipStage]) {
      await command(running(), 'stage-1');
      expect(written().updatedAt).toBe(NOW);
      expect(get(batch)?.updatedAt).toBe(NOW);
    }
  });
});
