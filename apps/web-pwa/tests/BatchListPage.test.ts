import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { BatchDoc, BatchStageDoc } from '@salt/domain/schemas';

// The in-flight surface (issue #812, phase 1 of epic #778).
//
// Four things this screen has to get right, and they are all one thing said four
// ways — a card says the NEXT ACTION and WHEN:
//
//   • the stage it names is the first one not yet marked done, which is what
//     `currentStage` answers and what nothing here re-derives;
//   • the order is by that action's clock, not by when the run was started — a
//     surface you check in the morning is a queue, not a history;
//   • a run with nothing left to do says so, in its own words, rather than showing
//     an empty "next" that reads as a bug;
//   • loaded-and-empty is a different sentence from still-loading.
//
// Times are asserted through `data-next-at`, which carries the raw ISO instant, so
// the ordering assertions say nothing about the machine's timezone. The rendered
// wording is checked separately and loosely, for the same reason.

const { mockBatches, mockInitBatchesSync, mockBreadGate } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockBatches: makeStore<BatchDoc[] | undefined>(undefined),
    mockInitBatchesSync: vi.fn(() => () => {}),
    mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
      enabled: true,
      settled: true,
    }),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/batchService.js', () => ({
  batches: mockBatches,
  initBatchesSync: mockInitBatchesSync,
}));
// The bread gate this page now sits behind (issue #831). The real module reads
// uninitialised observability and so always says "on" — which is why every
// assertion below needed no change; only the gated case has to say otherwise.
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));

import { push } from 'svelte-spa-router';
import BatchListPage from '../src/routes/batches/BatchListPage.svelte';

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-1',
    label: 'Bulk ferment',
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes: 180 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: '2026-08-14T09:00:00.000Z',
    plannedEndAt: '2026-08-14T12:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    ...over,
  };
}

function makeBatch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    quantities: [],
    totals: {
      basisGrams: 816,
      totalGrams: 1440,
      usableGrams: 1440,
      // No label and no baked figure since #1274 — see `BatchUnitsSchema`.
      units: { count: 12, unitDoughGrams: 120 },
    },
    stages: [stage()],
    rationale: null,
    createdAt: '2026-08-14T08:00:00.000Z',
    updatedAt: '2026-08-14T08:00:00.000Z',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockBatches._set(undefined);
  mockBreadGate._set({ enabled: true, settled: true });
});

function cards(): HTMLElement[] {
  return screen.queryAllByTestId('batch-card');
}

describe('BatchListPage — loading and empty', () => {
  it('shows neither a list nor an empty state while the collection is loading', () => {
    render(BatchListPage);
    expect(screen.queryByTestId('batch-list')).toBeNull();
    expect(screen.queryByTestId('batch-list-empty')).toBeNull();
  });

  it('says nothing is on the go once it knows there is nothing', async () => {
    // An empty array IS the loaded state — the distinction is the whole reason the
    // store has two states and not one.
    render(BatchListPage);
    mockBatches._set([]);
    await waitFor(() => expect(screen.getByTestId('batch-list-empty')).toBeInTheDocument());
  });

  it('subscribes for as long as the surface is open, and disposes on teardown', () => {
    const unsub = vi.fn();
    mockInitBatchesSync.mockReturnValue(unsub);
    const { unmount } = render(BatchListPage);
    expect(mockInitBatchesSync).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe('BatchListPage — the next action and when', () => {
  it('names the first unfinished stage, not the first stage', async () => {
    render(BatchListPage);
    mockBatches._set([
      makeBatch({
        stages: [
          stage({ id: 's1', label: 'Mix', actualEndAt: '2026-08-14T09:10:00.000Z' }),
          stage({
            id: 's2',
            label: 'Bulk ferment',
            plannedStartAt: '2026-08-14T09:10:00.000Z',
            plannedEndAt: '2026-08-14T12:10:00.000Z',
          }),
        ],
      }),
    ]);

    await waitFor(() => expect(screen.getByTestId('batch-card-next')).toBeInTheDocument());
    expect(screen.getByTestId('batch-card-next')).toHaveTextContent('Bulk ferment');
    expect(cards()[0]).toHaveAttribute('data-next-at', '2026-08-14T09:10:00.000Z');
    // And a clock time, whatever the machine's timezone renders it as.
    expect(screen.getByTestId('batch-card-next').textContent).toMatch(/\d{2}:\d{2}/);
  });

  it('orders by what needs doing soonest, not by what was started last', async () => {
    render(BatchListPage);
    mockBatches._set([
      makeBatch({
        id: 'later',
        recipeTitle: 'Sourdough',
        createdAt: '2026-08-14T08:30:00.000Z',
        stages: [stage({ plannedStartAt: '2026-08-14T18:00:00.000Z' })],
      }),
      makeBatch({
        id: 'sooner',
        recipeTitle: 'Rolls',
        createdAt: '2026-08-14T07:00:00.000Z',
        stages: [stage({ plannedStartAt: '2026-08-14T09:30:00.000Z' })],
      }),
    ]);

    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().map((c) => c.getAttribute('data-batch-id'))).toEqual(['sooner', 'later']);
  });

  it('drops a run with nothing left to do to the bottom, and says so', async () => {
    render(BatchListPage);
    mockBatches._set([
      makeBatch({
        id: 'done',
        stages: [stage({ actualEndAt: '2026-08-14T12:00:00.000Z' })],
      }),
      makeBatch({ id: 'running' }),
    ]);

    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().map((c) => c.getAttribute('data-batch-id'))).toEqual(['running', 'done']);
    // There is deliberately no `finished` STATE — "every stage done" is derived.
    expect(cards()[1]).toHaveTextContent('Every stage done or skipped.');
  });

  it('shows an abandoned run as abandoned rather than as waiting on you', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch({ state: 'abandoned' })]);

    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveTextContent('Abandoned.');
    expect(cards()[0]).toHaveAttribute('data-next-at', '');
  });

  it('says what the run makes and what it weighs, from the frozen totals', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch()]);

    await waitFor(() => expect(screen.getByTestId('batch-card-yield')).toBeInTheDocument());
    // Since #1274 `yieldSummary` reads no label off the units — "2 × 900 g — 1.8 kg
    // of dough" is the whole vocabulary now.
    expect(screen.getByTestId('batch-card-yield')).toHaveTextContent(
      '12 × 120 g — 1.4 kg of dough',
    );
    expect(cards()[0]).toHaveTextContent('1440 g in total');
  });

  it('shows the frozen title even for a recipe that has since been renamed', async () => {
    // Nothing on this screen reads `recipes`. The title is the run's own copy.
    render(BatchListPage);
    mockBatches._set([makeBatch({ recipeTitle: 'Overnight white tin' })]);

    await waitFor(() => expect(screen.getByTestId('batch-card-title')).toBeInTheDocument());
    expect(screen.getByTestId('batch-card-title')).toHaveTextContent('Overnight white tin');
  });

  it('opens the run when its card is pressed', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch({ id: 'batch-9' })]);

    await waitFor(() => expect(cards()).toHaveLength(1));
    await fireEvent.click(cards()[0]!);

    expect(push).toHaveBeenCalledWith('/batches/batch-9');
  });
});

describe('BatchListPage — gated (issue #831)', () => {
  // Bread is still being built, so /batches must not exist for anyone outside the
  // test group — including for someone who types the URL. Nothing renders and no
  // message explains why: a "you don't have access" would announce the feature.
  it('renders nothing and sends a gated visitor home', async () => {
    mockBreadGate._set({ enabled: false, settled: true });
    render(BatchListPage);
    mockBatches._set([makeBatch()]);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(screen.queryByTestId('batch-list-page')).toBeNull();
    expect(screen.queryByTestId('batch-list-empty')).toBeNull();
    expect(cards()).toHaveLength(0);
  });

  it('waits for the flag payload before bouncing anyone', async () => {
    // The window that matters: "in flight" must not read as "off", or the flagged
    // user is thrown off their own page a beat before PostHog says they may have it.
    mockBreadGate._set({ enabled: false, settled: false });
    render(BatchListPage);

    expect(screen.getByTestId('feature-guard-loading')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('BatchListPage — what each run was baked in (issue #1274)', () => {
  it('names the vessel beside the total, when the run recorded one', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch({ vessel: '900 g loaf tin' })]);

    await waitFor(() => expect(screen.getByTestId('batch-card')).toBeInTheDocument());
    expect(cards()[0]).toHaveTextContent('1440 g in total');
    expect(cards()[0]).toHaveTextContent('900 g loaf tin');
  });

  it('says only the total for a run that named no vessel', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch()]);

    await waitFor(() => expect(screen.getByTestId('batch-card')).toBeInTheDocument());
    expect(cards()[0]).toHaveTextContent('1440 g in total');
    expect(cards()[0]).not.toHaveTextContent('loaf tin');
  });

  it('reads the yield as dough, with no named shape in it', async () => {
    render(BatchListPage);
    mockBatches._set([makeBatch()]);

    await waitFor(() => expect(screen.getByTestId('batch-card-yield')).toBeInTheDocument());
    expect(screen.getByTestId('batch-card-yield')).toHaveTextContent(
      '12 × 120 g — 1.4 kg of dough',
    );
  });
});
