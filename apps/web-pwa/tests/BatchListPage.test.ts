import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { BatchDoc, BatchObservationDoc, BatchStageDoc } from '@salt/domain/schemas';

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

const { mockBatches, mockInitBatchesSync, mockBreadGate, mockLogs, mockInitLogsSync } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockBatches: makeStore<BatchDoc[] | undefined>(undefined),
      mockInitBatchesSync: vi.fn(() => () => {}),
      mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
        enabled: true,
        settled: true,
      }),
      mockLogs: makeStore<ReadonlyMap<string, readonly BatchObservationDoc[]>>(new Map()),
      mockInitLogsSync: vi.fn(() => () => {}),
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
// The per-run logs the meter reads (issue #1407). A data seam like `batchService`
// beside it, and the fourth mock in this file — still inside UT-B1's cap of five.
vi.mock('../src/lib/batchObservationService.js', () => ({
  observationLogs: mockLogs,
  initBatchObservationLogsSync: mockInitLogsSync,
}));
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
    place: null,
    ...over,
  };
}

function makeBatch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    cureCategory: null,
    recipeKind: 'recipe',
    target: null,
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    abandonedAt: null,
    checkedIngredientIds: [],
    completedStepIds: [],
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
    ambientCelsius: null,
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
  mockLogs._set(new Map());
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

// ─── Narrowing to one kind of cure (issue #1404) ─────────────────────────────
//
// The question the freeze on the run exists to answer: "show me all my dry-cured
// whole muscle", over finished and abandoned runs as well as in-flight ones.
//
// Every assertion reads the run's OWN frozen `cureCategory` — the page holds no
// recipes and could not read through to one if it tried, which is the property
// being demonstrated rather than merely stated.
describe('BatchListPage — cure type', () => {
  const coppa = makeBatch({
    id: 'b-coppa',
    recipeTitle: 'Coppa',
    recipeKind: 'cure',
    cureCategory: 'dry_cured_whole_muscle',
  });
  const bresaola = makeBatch({
    id: 'b-bresaola',
    recipeTitle: 'Bresaola',
    recipeKind: 'cure',
    cureCategory: 'dry_cured_whole_muscle',
    state: 'abandoned',
    abandonedAt: '2026-08-14T10:00:00.000Z',
  });
  const bacon = makeBatch({
    id: 'b-bacon',
    recipeTitle: 'Streaky bacon',
    recipeKind: 'cure',
    cureCategory: 'cooked_whole_muscle',
  });
  const loaf = makeBatch({ id: 'b-loaf' });

  function categoryChips(): HTMLElement[] {
    return screen.queryAllByTestId('batch-category-filter');
  }

  function titles(): string[] {
    return screen.queryAllByTestId('batch-card-title').map((el) => (el.textContent ?? '').trim());
  }

  it('says what each run was, on the card', () => {
    mockBatches._set([coppa, loaf]);
    render(BatchListPage);

    const labels = screen
      .queryAllByTestId('batch-card-category')
      .map((el) => el.textContent?.trim());
    // One line, on the one run that has something to say. A loaf shows nothing
    // rather than a dash — every card on this screen says one thing.
    expect(labels).toEqual(['Dry-cured whole muscle']);
  });

  it('offers no filter row at all to a household that has only ever baked', () => {
    // The chrome appears on the day there is something to filter, and never
    // before — which is every household in production today.
    mockBatches._set([loaf, makeBatch({ id: 'b-loaf-2' })]);
    render(BatchListPage);

    expect(screen.queryByTestId('batch-category-filters')).toBeNull();
    expect(categoryChips()).toHaveLength(0);
  });

  it('offers one chip per category the runs actually carry, in the enum’s order', () => {
    mockBatches._set([bacon, coppa, loaf]);
    render(BatchListPage);

    // "All" leads and is not a category — a filter row with two ways to say
    // "everything" is a row that can contradict itself. The rest follow the
    // stored enum's order rather than the order the runs happened to arrive in,
    // so the row does not reshuffle as runs start and end.
    expect(categoryChips().map((el) => el.getAttribute('data-category'))).toEqual([
      '',
      'dry_cured_whole_muscle',
      'cooked_whole_muscle',
    ]);
    expect(categoryChips()[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('narrows to one category in a tap, over ended runs as well as running ones', async () => {
    mockBatches._set([coppa, bresaola, bacon, loaf]);
    render(BatchListPage);

    expect(titles()).toHaveLength(4);

    await fireEvent.click(
      categoryChips().find((el) => el.getAttribute('data-category') === 'dry_cured_whole_muscle')!,
    );

    // The abandoned bresaola is in the answer. "The last three bresaola" is a
    // question about history, so a filter that quietly dropped ended runs would
    // answer a different question from the one asked.
    await waitFor(() => expect(titles().sort()).toEqual(['Bresaola', 'Coppa']));
  });

  it('folds back to everything when All is tapped again', async () => {
    mockBatches._set([coppa, bacon, loaf]);
    render(BatchListPage);

    await fireEvent.click(
      categoryChips().find((el) => el.getAttribute('data-category') === 'cooked_whole_muscle')!,
    );
    await waitFor(() => expect(titles()).toEqual(['Streaky bacon']));

    await fireEvent.click(categoryChips()[0]!);

    await waitFor(() => expect(titles()).toHaveLength(3));
  });

  it('keeps the whole row offered while a category is selected', async () => {
    // The row is derived from ALL runs, not from the shown ones. Derived from the
    // shown set it would collapse to the one chip already pressed the moment it
    // was used, stranding the person in a filter with no way back.
    mockBatches._set([coppa, bacon, loaf]);
    render(BatchListPage);

    await fireEvent.click(
      categoryChips().find((el) => el.getAttribute('data-category') === 'cooked_whole_muscle')!,
    );

    await waitFor(() => expect(categoryChips()).toHaveLength(3));
  });
});

describe('BatchListPage — how far along each run is (issue #1407)', () => {
  // A 2 400 g green weight aiming at 35% lost. 1 656 g is the issue's own 31%
  // exemplar; 1 686 g is exactly the nearing threshold (85% of the way there);
  // 2 200 g is a long way off; 1 488 g is past it.
  const CURING: BatchDoc = makeBatch({
    id: 'coppa-1',
    recipeTitle: 'Coppa',
    target: { weightLossPercent: 35, phAtMost: null },
    totals: { basisGrams: 2400, totalGrams: 2466, usableGrams: 2466, units: null },
  });

  function reading(batchId: string, weightGrams: number): [string, BatchObservationDoc[]] {
    return [
      batchId,
      [
        {
          id: `obs-${batchId}`,
          schemaVersion: 1,
          at: '2026-08-20T09:00:00.000Z',
          stageId: null,
          weightGrams,
          ph: null,
          temperatureC: null,
          relativeHumidityPercent: null,
          note: '',
          image: null,
        },
      ],
    ];
  }

  function card(): HTMLElement {
    const found = screen.queryByTestId('batch-card-target');
    if (found === null) throw new Error('no target figure on the card');
    return found;
  }

  it('carries the same figure the run’s own page shows', async () => {
    mockBatches._set([CURING]);
    mockLogs._set(new Map([reading('coppa-1', 1780)]));
    render(BatchListPage);

    await waitFor(() => expect(card()).toBeInTheDocument());
    expect(card()).toHaveTextContent('1780 g — 26% lost of 35%');
  });

  it('looks different at a glance at 31% of a 35% target than at 12%', async () => {
    // THE OUTCOME, stated as the issue states it: without reading the numbers.
    // Two runs, two stances, and the stance is what the appearance is chosen
    // from. 1 656 g is 31% lost EXACTLY — the issue's own figure, not a value
    // borrowed from `NEARING_FRACTION`'s boundary (#1426 review, blocking 2: the
    // boundary-derived 1 644 g used to sit here, which happened to be exactly
    // where the OLD constant's boundary fell and so never went red when the
    // constant put the real 31% figure in the wrong band).
    mockBatches._set([CURING, makeBatch({ ...CURING, id: 'coppa-2' })]);
    mockLogs._set(new Map([reading('coppa-1', 1656), reading('coppa-2', 2112)]));
    render(BatchListPage);

    await waitFor(() => expect(screen.getAllByTestId('batch-card-target')).toHaveLength(2));
    const stances = screen
      .getAllByTestId('batch-card-target')
      .map((el) => el.getAttribute('data-stance'));
    expect(stances).toEqual(['nearing', 'tracking']);
  });

  it('pins the nearing boundary itself, separately from the exemplar above', async () => {
    // The boundary case the exemplar test must not collapse into: exactly
    // `NEARING_FRACTION` (0.85) of the 35% target is nearing, and one gram short
    // of it is tracking.
    mockBatches._set([CURING, makeBatch({ ...CURING, id: 'coppa-2' })]);
    mockLogs._set(new Map([reading('coppa-1', 1686), reading('coppa-2', 1687)]));
    render(BatchListPage);

    await waitFor(() => expect(screen.getAllByTestId('batch-card-target')).toHaveLength(2));
    const stances = screen
      .getAllByTestId('batch-card-target')
      .map((el) => el.getAttribute('data-stance'));
    expect(stances).toEqual(['nearing', 'tracking']);
  });

  it('stays full past the target, and says nothing judgemental', async () => {
    mockBatches._set([CURING]);
    mockLogs._set(new Map([reading('coppa-1', 1488)]));
    render(BatchListPage);

    await waitFor(() => expect(card()).toBeInTheDocument());
    expect(card().getAttribute('data-stance')).toBe('atOrPast');
    expect(card()).toHaveTextContent('38% lost of 35%');
    const words = (card().textContent ?? '').toLowerCase();
    for (const verdict of ['ready', 'done', 'overdue', 'failed', 'finished']) {
      expect(words).not.toContain(verdict);
    }
  });

  it('shows no meter and no gap on a run with no target', async () => {
    mockBatches._set([makeBatch()]);
    render(BatchListPage);

    await waitFor(() => expect(screen.getAllByTestId('batch-card')).toHaveLength(1));
    expect(screen.queryByTestId('batch-card-target')).toBeNull();
  });

  it('opens a log subscription for the runs with a target, and no others', async () => {
    // A household with nothing but bread opens not a single extra listener — which
    // is what keeps this dark, and is the whole reason the subscription is
    // per-run rather than a collection-group query.
    mockBatches._set([CURING, makeBatch({ id: 'loaf-1' })]);
    render(BatchListPage);

    await waitFor(() => expect(mockInitLogsSync).toHaveBeenCalled());
    expect(mockInitLogsSync).toHaveBeenLastCalledWith(['coppa-1']);
  });

  it('subscribes to nothing at all when no run carries a target', async () => {
    mockBatches._set([makeBatch({ id: 'loaf-1' }), makeBatch({ id: 'loaf-2' })]);
    render(BatchListPage);

    await waitFor(() => expect(mockInitLogsSync).toHaveBeenCalled());
    expect(mockInitLogsSync).toHaveBeenLastCalledWith([]);
  });

  // THE BOUND ITSELF (#1426 review, blocking 1 and should-fix 3). `all` is every
  // batch this household has ever written — done and abandoned runs included,
  // since `subscribeBatches` carries no `where`/`limit` and `orderBatches` keeps
  // ended runs — so a target alone is not enough to earn a listener. These pin
  // the narrower gate directly: a run that is not waiting on anything, or that
  // names no weight-loss figure, must never open one, however long it carries a
  // target.
  it('opens no listener for a run that carries a target but has nothing left to do', async () => {
    const done = makeBatch({
      ...CURING,
      id: 'coppa-done',
      stages: [stage({ actualEndAt: '2026-08-14T12:00:00.000Z' })],
    });
    mockBatches._set([done]);
    render(BatchListPage);

    await waitFor(() => expect(mockInitLogsSync).toHaveBeenCalled());
    expect(mockInitLogsSync).toHaveBeenLastCalledWith([]);
  });

  it('opens no listener for an abandoned run, however long its target', async () => {
    mockBatches._set([makeBatch({ ...CURING, id: 'coppa-abandoned', state: 'abandoned' })]);
    render(BatchListPage);

    await waitFor(() => expect(mockInitLogsSync).toHaveBeenCalled());
    expect(mockInitLogsSync).toHaveBeenLastCalledWith([]);
  });

  it('opens no listener for a run whose target is pH-only — the card never reads it', async () => {
    mockBatches._set([
      makeBatch({ ...CURING, id: 'salami-ph', target: { weightLossPercent: null, phAtMost: 5.3 } }),
    ]);
    render(BatchListPage);

    await waitFor(() => expect(mockInitLogsSync).toHaveBeenCalled());
    expect(mockInitLogsSync).toHaveBeenLastCalledWith([]);
  });

  it('moves when a new weighing lands, without the card being reopened', async () => {
    // The figure is LIVE — the first thing on a batch screen that is not frozen —
    // so the appearance has to follow the log rather than whatever it was on first
    // render.
    mockBatches._set([CURING]);
    mockLogs._set(new Map([reading('coppa-1', 2200)]));
    render(BatchListPage);

    await waitFor(() => expect(card().getAttribute('data-stance')).toBe('tracking'));

    mockLogs._set(new Map([reading('coppa-1', 1644)]));

    await waitFor(() => expect(card().getAttribute('data-stance')).toBe('nearing'));
    expect(card()).toHaveTextContent('1644 g — 32% lost of 35%');
  });

  it('shows nothing for a run whose log has arrived empty', async () => {
    // Loaded and nothing weighed yet is a different state from not loaded, and both
    // render the same: no meter at zero for a run nobody has put on the scales.
    mockBatches._set([CURING]);
    mockLogs._set(new Map([['coppa-1', []]]));
    render(BatchListPage);

    await waitFor(() => expect(screen.getAllByTestId('batch-card')).toHaveLength(1));
    expect(screen.queryByTestId('batch-card-target')).toBeNull();
  });

  it('shows nothing for a run whose log has not arrived yet', async () => {
    mockBatches._set([CURING]);
    mockLogs._set(new Map());
    render(BatchListPage);

    await waitFor(() => expect(screen.getAllByTestId('batch-card')).toHaveLength(1));
    expect(screen.queryByTestId('batch-card-target')).toBeNull();
  });
});
