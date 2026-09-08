import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { push } from 'svelte-spa-router';
import type { BatchDoc, BatchObservationDoc, BatchStageDoc } from '@salt/domain/schemas';

// The batch log (issue #1280) — `/batches/:id/log`, what actually happened to a run.
//
// What this page has to get right is almost entirely about NOT deciding things:
//
//   • the ORDER and the collapse are `buildBatchLog`'s, pinned in the domain's own
//     suite against fixed strings. Here the domain producer is REAL, not mocked, so
//     what is asserted is that the page renders the list it was handed in the order
//     it was handed it — a page that re-sorted would show up as a different order;
//   • a stage's WORD is a join against the run's own frozen stages, never a copy;
//   • the over/under is against the time the step was given, and a step given no
//     time shows nothing rather than "0 min over";
//   • not-loaded, no-such-run, and a run with nothing but a start are three
//     different screens, and the last of them is not an error.
//
// Instants are asserted through `data-at` (raw ISO) wherever the assertion is about
// which line is which, so none of that depends on the machine's timezone.

const { mockBatch, mockInitBatchSync, mockObservations, mockInitObservationsSync, mockBreadGate } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockBatch: makeStore<BatchDoc | null | undefined>(undefined),
      mockInitBatchSync: vi.fn(() => () => {}),
      mockObservations: makeStore<BatchObservationDoc[] | undefined>(undefined),
      mockInitObservationsSync: vi.fn(() => () => {}),
      mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
        enabled: true,
        settled: true,
      }),
    };
  });

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/batchService.js', () => ({
  batch: mockBatch,
  initBatchSync: mockInitBatchSync,
}));
vi.mock('../src/lib/batchObservationService.js', () => ({
  observations: mockObservations,
  initBatchObservationsSync: mockInitObservationsSync,
  logObservation: vi.fn(async () => ({
    kind: 'ok',
    value: { observationId: 'obs-new', photo: { kind: 'none' } },
  })),
}));
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));

import { logObservation } from '../src/lib/batchObservationService.js';
import BatchLogPage from '../src/routes/batches/BatchLogPage.svelte';

const BATCH_ID = 'batch-1';

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'mix',
    label: 'Mix',
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes: 60 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: '2026-09-05T20:00:00.000Z',
    plannedEndAt: '2026-09-05T21:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    place: null,
    ...over,
  };
}

function makeBatch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: BATCH_ID,
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    abandonedAt: null,
    quantities: [],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages: [
      stage({ id: 'mix', label: 'Mix' }),
      stage({
        id: 'bulk',
        label: 'Bulk ferment',
        duration: { kind: 'fixed', minutes: 180 },
        plannedStartAt: '2026-09-05T21:00:00.000Z',
        plannedEndAt: '2026-09-06T00:00:00.000Z',
      }),
    ],
    rationale: null,
    ambientCelsius: null,
    createdAt: '2026-09-05T17:12:00.000Z',
    updatedAt: '2026-09-05T17:12:00.000Z',
    ...over,
  };
}

function observation(over: Partial<BatchObservationDoc> = {}): BatchObservationDoc {
  return {
    id: 'obs-1',
    schemaVersion: 1,
    at: '2026-09-06T00:45:00.000Z',
    stageId: null,
    weightGrams: null,
    ph: null,
    temperatureC: null,
    relativeHumidityPercent: null,
    note: '',
    image: null,
    ...over,
  };
}

beforeEach(() => {
  mockBatch._set(undefined);
  mockObservations._set(undefined);
  mockBreadGate._set({ enabled: true, settled: true });
  vi.clearAllMocks();
});

afterEach(() => cleanup());

function renderPage() {
  return render(BatchLogPage, { props: { params: { id: BATCH_ID } } });
}

/** A rendered run's lines, as `[kind, at]`. */
function lines(): [string, string][] {
  return screen
    .getAllByTestId('batch-log-line')
    .map((el) => [el.getAttribute('data-kind') ?? '', el.getAttribute('data-at') ?? '']);
}

async function showRun(
  over: Partial<BatchDoc> = {},
  readings: BatchObservationDoc[] = [],
): Promise<void> {
  renderPage();
  mockBatch._set(makeBatch(over));
  mockObservations._set(readings);
  await waitFor(() => expect(screen.getByTestId('batch-log-page')).toBeInTheDocument());
}

describe('BatchLogPage — the three screens before there is a log', () => {
  it('shows nothing but a spinner while the run is still loading', () => {
    renderPage();
    expect(screen.queryByTestId('batch-log-page')).toBeNull();
  });

  it('says the run is not there when the id resolves to nothing', async () => {
    renderPage();
    mockBatch._set(null);
    await waitFor(() => expect(screen.getByText('Batch not found')).toBeInTheDocument());
  });

  it('waits for the readings too, rather than showing a run nobody logged', async () => {
    // The stages arriving first would render a complete-looking log with no entries
    // in it, which is a claim about the readings rather than a loading state.
    renderPage();
    mockBatch._set(makeBatch());
    expect(screen.queryByTestId('batch-log-page')).toBeNull();

    mockObservations._set([]);
    await waitFor(() => expect(screen.getByTestId('batch-log-page')).toBeInTheDocument());
  });

  it('opens both subscriptions and disposes them with the page', () => {
    const { unmount } = renderPage();
    expect(mockInitBatchSync).toHaveBeenCalledWith(BATCH_ID);
    expect(mockInitObservationsSync).toHaveBeenCalledWith(BATCH_ID);
    unmount();
  });

  it('opens no listener at all when the route carries no id', () => {
    // `/batches//log` and a direct render with no params both land here. Subscribing
    // to `batches/` would be a read against a collection, not a document.
    render(BatchLogPage, { props: {} });

    expect(mockInitBatchSync).not.toHaveBeenCalled();
    expect(mockInitObservationsSync).not.toHaveBeenCalled();
  });

  it('shows a spinner in the page once the run has arrived but the readings have not', async () => {
    // Distinct from the first spinner above: the run is known, so the page's frame is
    // drawn, and the list is what is still waiting.
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByText('The log')).toBeInTheDocument());
    expect(screen.queryByTestId('batch-log-page')).toBeNull();

    mockObservations._set([]);
    await waitFor(() => expect(screen.getByTestId('batch-log-page')).toBeInTheDocument());
  });

  it('reads a run with nothing but a start as exactly that, not as an empty screen', async () => {
    await showRun();

    expect(lines()).toEqual([['batchStarted', '2026-09-05T17:12:00.000Z']]);
    expect(screen.getByTestId('batch-log-line-what')).toHaveTextContent('Batch started');
  });
});

describe('BatchLogPage — the whole of a run, in one list', () => {
  const RUN: Partial<BatchDoc> = {
    stages: [
      stage({
        id: 'mix',
        label: 'Mix',
        actualStartAt: '2026-09-05T20:00:00.000Z',
        actualEndAt: '2026-09-05T21:04:00.000Z',
      }),
      stage({
        id: 'bulk',
        label: 'Bulk ferment',
        duration: { kind: 'fixed', minutes: 180 },
        plannedStartAt: '2026-09-05T21:04:00.000Z',
        plannedEndAt: '2026-09-06T00:04:00.000Z',
        actualStartAt: '2026-09-05T21:04:00.000Z',
        skipped: { at: '2026-09-06T00:10:00.000Z', note: 'dough was already there' },
      }),
    ],
  };

  it('renders the domain producer’s list, in the order it was handed over', async () => {
    // The order and the collapse are `buildBatchLog`'s — the bulk's start is the same
    // instant as the mix's end and does not print twice. Nothing here re-sorts.
    await showRun(RUN, [observation({ id: 'obs-1', weightGrams: 1483, note: 'felt slack' })]);

    expect(lines()).toEqual([
      ['batchStarted', '2026-09-05T17:12:00.000Z'],
      ['stageStarted', '2026-09-05T20:00:00.000Z'],
      ['stageDone', '2026-09-05T21:04:00.000Z'],
      ['stageSkipped', '2026-09-06T00:10:00.000Z'],
      ['observation', '2026-09-06T00:45:00.000Z'],
    ]);
  });

  it('groups the run under date headings, oldest day first', async () => {
    await showRun(RUN, [observation()]);

    const days = screen.getAllByTestId('batch-log-day').map((el) => el.textContent?.trim());
    expect(days).toHaveLength(2);
    expect(days[0]).toBe('Sat 5 Sept');
  });

  it('says what happened to each step, in the run’s own frozen words', async () => {
    await showRun(RUN, []);

    const what = screen
      .getAllByTestId('batch-log-line-what')
      .map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
    expect(what).toEqual([
      'Batch started',
      'Mix — started',
      'Mix — done',
      'Bulk ferment — skipped',
    ]);
  });

  it('puts the skip reason beside the skip, not in a list to be joined by eye', async () => {
    await showRun(RUN, []);

    expect(screen.getByTestId('batch-log-line-note')).toHaveTextContent('dough was already there');
  });

  it('says how a finished step ran against the time it was given', async () => {
    // The mix was planned 20:00–21:00 and ended at 21:04.
    await showRun(RUN, []);

    expect(screen.getByTestId('batch-log-line-drift')).toHaveTextContent('4 min over');
  });

  it('says nothing at all for a step that was given no time', async () => {
    // An observational stage is a zero-length point on the clock, so there is no over
    // or under to report — and "0 min over" would be a claim the document cannot make.
    await showRun(
      {
        stages: [
          stage({
            id: 'prove',
            label: 'Prove until doubled',
            duration: null,
            plannedEndAt: '2026-09-05T20:00:00.000Z',
            actualEndAt: '2026-09-05T23:30:00.000Z',
          }),
        ],
      },
      [],
    );

    expect(screen.getAllByTestId('batch-log-line-what').at(-1)).toHaveTextContent('done');
    expect(screen.queryByTestId('batch-log-line-drift')).toBeNull();
  });

  it('renders a reading with its stage, weight, note and photo', async () => {
    await showRun(RUN, [
      observation({
        stageId: 'bulk',
        weightGrams: 1483,
        note: 'felt slack, dusted heavily',
        image: { url: 'https://example.test/a.jpg', source: 'upload' },
      }),
    ]);

    expect(screen.getByTestId('batch-log-entry-stage')).toHaveTextContent('Bulk ferment');
    expect(screen.getByTestId('batch-log-entry-weight')).toHaveTextContent('1483 g');
    expect(screen.getByTestId('batch-log-entry-note')).toHaveTextContent('felt slack');
    expect(screen.getByTestId('batch-log-entry-photo')).toHaveAttribute(
      'src',
      'https://example.test/a.jpg',
    );
  });
});

describe('BatchLogPage — a run that was stopped', () => {
  it('says when it was abandoned, as the last thing that happened', async () => {
    await showRun({ state: 'abandoned', abandonedAt: '2026-09-06T08:10:00.000Z' }, []);

    expect(lines().at(-1)).toEqual(['batchAbandoned', '2026-09-06T08:10:00.000Z']);
    const what = screen.getAllByTestId('batch-log-line-what').at(-1);
    expect(what).toHaveTextContent('Batch abandoned');
  });

  it('claims no time for a run abandoned before the field existed', async () => {
    // `abandonedAt` is a read default, and `updatedAt` is a later write's stamp rather
    // than the moment the cook gave up — so the log says nothing rather than a lie.
    await showRun({ state: 'abandoned' }, []);

    expect(lines()).toEqual([['batchStarted', '2026-09-05T17:12:00.000Z']]);
  });

  it('still offers Log a reading — an abandoned run keeps what it recorded', async () => {
    await showRun({ state: 'abandoned' }, []);

    expect(screen.getByTestId('batch-log-add')).toBeInTheDocument();
  });
});

describe('BatchLogPage — the two ways off the page', () => {
  it('goes back to the run, not to the batch list', async () => {
    // The log is a page ABOUT one run, so Back is the run — a list would lose the
    // place of anyone who came here from the batch they are standing over.
    await showRun();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the run' }));

    expect(push).toHaveBeenCalledWith(`/batches/${BATCH_ID}`);
  });

  it('opens the same Log a reading sheet the run page opens', async () => {
    // The log is a door as well as a record: a cure weighed on day 12 is logged from
    // where you are standing.
    await showRun();
    await userEvent.click(screen.getByTestId('batch-log-add'));

    await waitFor(() => expect(screen.getByTestId('batch-log-sheet')).toBeInTheDocument());
  });

  it('files the reading against this run, and closes the sheet once it lands', async () => {
    // The sheet is `BatchDetailPage`'s, reused unmodified — so what is asserted here
    // is the wiring, not the sheet: the id it writes against is the run whose log is
    // open, and `bind:open` is a real two-way bind rather than a one-way flag the
    // page would have to close itself.
    await showRun();
    await userEvent.click(screen.getByTestId('batch-log-add'));
    await waitFor(() => expect(screen.getByTestId('batch-log-sheet')).toBeInTheDocument());

    // `fireEvent`, not `userEvent`: the sheet's focus trap eats keystrokes typed into
    // a field it has just moved focus to, which is why `BatchDetailPage.test.ts` types
    // this same box the same way.
    await fireEvent.input(screen.getByTestId('batch-log-weight'), { target: { value: '1240' } });
    await userEvent.click(screen.getByTestId('batch-log-save'));

    await waitFor(() => expect(logObservation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(logObservation).mock.calls[0]?.[0]).toMatchObject({
      batchId: BATCH_ID,
      weightGrams: 1240,
    });
    await waitFor(() => expect(screen.queryByTestId('batch-log-sheet')).toBeNull());
  });

  it('does not tear the open sheet out when the run disappears under it', async () => {
    // Why the sheet sits OUTSIDE the `{#if}` (the same reason `BatchDetailPage` puts
    // it there): the subscription is live, so a run deleted on another device while
    // someone is mid-reading would otherwise unmount the sheet and lose what they had
    // typed. The page behind it becomes "Batch not found"; the sheet stays.
    await showRun();
    await userEvent.click(screen.getByTestId('batch-log-add'));
    await waitFor(() => expect(screen.getByTestId('batch-log-sheet')).toBeInTheDocument());

    mockBatch._set(null);

    await waitFor(() => expect(screen.getByText('Batch not found')).toBeInTheDocument());
    expect(screen.getByTestId('batch-log-sheet')).toBeInTheDocument();
  });
});

describe('BatchLogPage — gated (issue #831)', () => {
  it('renders nothing at all for anyone outside the test group', async () => {
    mockBreadGate._set({ enabled: false, settled: true });
    renderPage();
    mockBatch._set(makeBatch());
    mockObservations._set([]);

    await waitFor(() => expect(screen.queryByTestId('batch-log-page')).toBeNull());
  });
});
