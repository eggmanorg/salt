import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { BatchDoc, BatchObservationDoc, BatchStageDoc } from '@salt/domain/schemas';

// One run's own screen (issue #812, phases 1 and 3 of epic #778).
//
// The batch under test is #778's worked example, frozen: twelve 120 g rolls off the
// overnight tin's formula — 816 g flour, 571 g water, 16 g salt, 11 g yeast, 24 g
// olive oil, 1 440 g in the bowl. #1274 deleted the handling allowance that used to
// separate "in the bowl" from "off the bench" (and the baked-weight figure beside
// it); the two totals are now the same number, always.
//
// What this page has to get right:
//
//   • it renders the batch's OWN numbers and joins nothing. The recipe and the
//     formula are not read here at all, which is what makes "editing the recipe
//     afterwards changes nothing on the batch" true by construction rather than by
//     a re-derivation that happens to agree;
//   • a stage with a RANGE shows both the clock and the range the recipe stated;
//   • a stage with NO duration reads as observational, never as an instant event —
//     `plannedEndAt` equals `plannedStartAt` there, and printing that as a span
//     would be a confident lie;
//   • not-loaded, no-such-run and a run are three different screens.
//
// Clock times are asserted through the `data-planned-*` attributes (raw ISO), so
// none of this depends on the machine's timezone.
//
// PHASE 3 adds the controls, and what those tests have to get right is different in
// kind: the page must never decide anything the domain already decides. So they
// assert WHICH stage carries a control and WHAT ARGUMENTS reach the service, and
// never that a schedule moved — the re-timing is `withStageAdvanced`'s and is
// pinned in the domain's own suite, against a fixed clock this page does not read.

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
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/batchService.js', () => ({
  batch: mockBatch,
  initBatchSync: mockInitBatchSync,
  advanceStage: vi.fn(),
  abandonBatch: vi.fn(),
}));
vi.mock('../src/lib/batchObservationService.js', () => ({
  observations: mockObservations,
  initBatchObservationsSync: mockInitObservationsSync,
  logObservation: vi.fn(),
}));
// The bread gate this page now sits behind (issue #831). The real module reads
// uninitialised observability and so always says "on" — which is why every
// assertion below needed no change; only the gated case has to say otherwise.
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));

import BatchDetailPage from '../src/routes/batches/BatchDetailPage.svelte';
import { push } from 'svelte-spa-router';
import { abandonBatch, advanceStage } from '../src/lib/batchService.js';
import { addToast } from '../src/lib/toastStore.js';

const pushMock = vi.mocked(push);
const advanceMock = vi.mocked(advanceStage);
const abandonMock = vi.mocked(abandonBatch);
const toastMock = vi.mocked(addToast);

const BATCH_ID = 'batch-1';

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-1',
    label: 'Mix',
    kind: 'active',
    environment: null,
    duration: { kind: 'fixed', minutes: 15 },
    until: null,
    stepId: null,
    plannedStartAt: '2026-08-14T07:00:00.000Z',
    plannedEndAt: '2026-08-14T07:15:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    ...over,
  };
}

/** #778's worked example, as `freezeBatch` would have written it. */
function makeBatch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: BATCH_ID,
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    quantities: [
      { ingredientId: 'ing-flour', label: '500 g strong white flour', percent: 100, grams: 816 },
      { ingredientId: 'ing-water', label: '350 g water', percent: 70, grams: 571 },
      { ingredientId: 'ing-salt', label: '10 g salt', percent: 2, grams: 16 },
      { ingredientId: 'ing-yeast', label: '7 g instant yeast', percent: 1.4, grams: 11 },
      { ingredientId: 'ing-oil', label: '15 g olive oil', percent: 3, grams: 24 },
    ],
    totals: {
      basisGrams: 816,
      totalGrams: 1440,
      usableGrams: 1440,
      // No label and no baked figure since #1274 — see `BatchUnitsSchema`.
      units: { count: 12, unitDoughGrams: 120 },
    },
    stages: [
      stage(),
      stage({
        id: 'stage-2',
        label: 'Bulk ferment',
        kind: 'wait',
        environment: { celsius: 20 },
        duration: { kind: 'range', minMinutes: 45, maxMinutes: 60 },
        plannedStartAt: '2026-08-14T07:15:00.000Z',
        plannedEndAt: '2026-08-14T08:15:00.000Z',
      }),
      stage({
        id: 'stage-3',
        label: 'Prove',
        kind: 'wait',
        duration: null,
        until: 'until doubled',
        plannedStartAt: '2026-08-14T08:15:00.000Z',
        plannedEndAt: '2026-08-14T08:15:00.000Z',
      }),
    ],
    rationale: null,
    createdAt: '2026-08-14T06:45:00.000Z',
    updatedAt: '2026-08-14T06:45:00.000Z',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockBreadGate._set({ enabled: true, settled: true });
  mockBatch._set(undefined);
  // Loaded and empty is the ordinary state of a run's log, and it is a DIFFERENT
  // state from not-loaded: the end-of-run invitation must not flash before the
  // subscription has said whether anything was ever written.
  mockObservations._set([]);
  // The happy path by default: every command succeeds and hands the run back, which
  // is what the write path does (`persist` returns the stamped document).
  advanceMock.mockImplementation(async (current) => ({ kind: 'ok', value: current }));
  abandonMock.mockImplementation(async (current) => ({ kind: 'ok', value: current }));
});

function renderPage() {
  return render(BatchDetailPage, { props: { params: { id: BATCH_ID } } });
}

function gramsColumn(): string[] {
  return screen.queryAllByTestId('batch-quantity-grams').map((el) => el.textContent?.trim() ?? '');
}

describe('BatchDetailPage — the three states', () => {
  it('shows nothing but a loader while the run is still resolving', () => {
    renderPage();
    expect(screen.queryByTestId('batch-detail')).toBeNull();
  });

  it('says the run is not there once it knows it is not', async () => {
    renderPage();
    mockBatch._set(null);
    await waitFor(() => expect(screen.getByText('Batch not found')).toBeInTheDocument());
  });

  it('subscribes to the one run and disposes on teardown', () => {
    const unsub = vi.fn();
    mockInitBatchSync.mockReturnValue(unsub);
    const { unmount } = renderPage();
    expect(mockInitBatchSync).toHaveBeenCalledWith(BATCH_ID);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe('BatchDetailPage — the scaled ingredient list', () => {
  it('shows the frozen grams, in the formula order', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-quantities')).toBeInTheDocument());
    expect(gramsColumn()).toEqual(['816 g', '571 g', '16 g', '11 g', '24 g']);
  });

  it('carries the recipe line each figure came from, frozen at the start', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-quantities')).toBeInTheDocument());
    expect(screen.getByTestId('batch-quantities')).toHaveTextContent('500 g strong white flour');
    // …and the percentage the baker reasons in.
    expect(screen.getByTestId('batch-quantities')).toHaveTextContent('70%');
  });

  it('shows the totals — in the bowl and off the bench are the same figure since #1274', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-totals')).toBeInTheDocument());
    expect(screen.getByTestId('batch-total-grams')).toHaveTextContent('1440 g');
    expect(screen.getByTestId('batch-usable-grams')).toHaveTextContent('1440 g');
  });

  it('names what the run was baked in, when it recorded one (issue #1274)', async () => {
    // "What did I bake it in last time?" is what a log of runs is for. It is a
    // note on a finished record — nothing parses it and nothing computes from it.
    renderPage();
    mockBatch._set(makeBatch({ vessel: '900 g loaf tin' }));

    await waitFor(() => expect(screen.getByTestId('batch-totals')).toBeInTheDocument());
    expect(screen.getByTestId('batch-vessel')).toHaveTextContent('900 g loaf tin');
  });

  it('says nothing about a vessel for a run that named none', async () => {
    // "1.4 kg of dough" is a complete answer. An empty row would read as a vessel
    // nobody described.
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-totals')).toBeInTheDocument());
    expect(screen.queryByTestId('batch-vessel')).toBeNull();
  });

  it('shows no baked weight anywhere — the readout went with bake loss (issue #1274)', async () => {
    const { container } = renderPage();
    mockBatch._set(makeBatch({ vessel: '900 g loaf tin' }));

    await waitFor(() => expect(screen.getByTestId('batch-totals')).toBeInTheDocument());
    expect(screen.queryByTestId('batch-baked-each')).toBeNull();
    expect(container.textContent).not.toMatch(/once baked|each baked|bake loss/i);
  });

  it('says an ingredient that has left the recipe is unknown rather than inventing it', async () => {
    // An empty label is honest; an id is gibberish and a guess is a fact nobody
    // established.
    renderPage();
    mockBatch._set(
      makeBatch({
        quantities: [{ ingredientId: 'ing-gone', label: '', percent: 2, grams: 17 }],
      }),
    );

    await waitFor(() => expect(screen.getByTestId('batch-quantities')).toBeInTheDocument());
    expect(screen.getByTestId('batch-quantities')).toHaveTextContent('no longer in the recipe');
  });

  it('says out loud that these numbers do not move when the recipe does', async () => {
    renderPage();
    mockBatch._set(makeBatch());
    await waitFor(() => expect(screen.getByTestId('batch-frozen-note')).toBeInTheDocument());
  });

  it('renders the same numbers whatever the recipe now says, because it never reads one', async () => {
    // The strongest form of the freeze assertion available to a unit test: the page
    // is rendered with no recipe store and no formula store mocked at all. If it
    // ever reached for either, this test would not run.
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-quantities')).toBeInTheDocument());
    expect(gramsColumn()).toEqual(['816 g', '571 g', '16 g', '11 g', '24 g']);
  });
});

describe('BatchDetailPage — the schedule', () => {
  it('lists the stages in order, timed forward from the start that was chosen', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-stages')).toBeInTheDocument());
    const stages = screen.getAllByTestId('batch-stage');
    expect(stages.map((el) => el.getAttribute('data-stage-id'))).toEqual([
      'stage-1',
      'stage-2',
      'stage-3',
    ]);
    // Each stage begins where the previous one ended — the forward anchor.
    expect(stages[0]).toHaveAttribute('data-planned-start', '2026-08-14T07:00:00.000Z');
    expect(stages[0]).toHaveAttribute('data-planned-end', '2026-08-14T07:15:00.000Z');
    expect(stages[1]).toHaveAttribute('data-planned-start', '2026-08-14T07:15:00.000Z');
  });

  it('shows a range as a range beside the single time the schedule committed to', async () => {
    // `resolveSchedule` plans a range at its LONG end and the frozen stage keeps the
    // whole span, precisely so this screen can say both. Collapsing either would
    // throw away what the schema went out of its way to preserve.
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-stages')).toBeInTheDocument());
    const bulk = screen.getAllByTestId('batch-stage')[1]!;
    expect(bulk.querySelector('[data-testid="batch-stage-stated"]')).toHaveTextContent(
      '45 min – 1 hr',
    );
    expect(bulk.querySelector('[data-testid="batch-stage-stated"]')).toHaveTextContent(
      'planned at the long end',
    );
    // 07:15 → 08:15 is the long end, an hour.
    expect(bulk).toHaveAttribute('data-planned-end', '2026-08-14T08:15:00.000Z');
  });

  it('reads a stage with no duration as observational, not as an instant', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-stages')).toBeInTheDocument());
    const prove = screen.getAllByTestId('batch-stage')[2]!;
    // Same instant either side — the length is not zero, it is unknown.
    expect(prove.getAttribute('data-planned-start')).toEqual(
      prove.getAttribute('data-planned-end'),
    );
    expect(prove.querySelector('[data-testid="batch-stage-observational"]')).not.toBeNull();
    expect(prove.querySelector('[data-testid="batch-stage-end"]')).toBeNull();
    expect(prove.querySelector('[data-testid="batch-stage-until"]')).toHaveTextContent(
      'until doubled',
    );
  });

  it('shows the environment where the stage has one, and nothing where it does not', async () => {
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(screen.getByTestId('batch-stages')).toBeInTheDocument());
    const stages = screen.getAllByTestId('batch-stage');
    expect(stages[1]!.querySelector('[data-testid="batch-stage-environment"]')).toHaveTextContent(
      '20 °C',
    );
    // A mix has no meaningful temperature and is not given an invented one.
    expect(stages[0]!.querySelector('[data-testid="batch-stage-environment"]')).toBeNull();
  });
});

// ─── Phase 3 ──────────────────────────────────────────────────────────────────

/** Render, hand the store a run, and wait for the stage list. */
async function showRun(over: Partial<BatchDoc> = {}): Promise<BatchDoc> {
  const run = makeBatch(over);
  renderPage();
  mockBatch._set(run);
  await waitFor(() => expect(screen.getByTestId('batch-stages')).toBeInTheDocument());
  return run;
}

/** The stage ids carrying a control block, in the order they render. */
function stagesWithControls(): string[] {
  return screen
    .getAllByTestId('batch-stage')
    .filter((el) => el.querySelector('[data-testid="batch-stage-controls"]') !== null)
    .map((el) => el.getAttribute('data-stage-id') ?? '');
}

// The ⋮ renders its contents only once open (bits-ui mounts PopoverContent
// lazily), so an assertion about what is inside it has to open it first.
async function openOverflowMenu(): Promise<void> {
  await fireEvent.click(screen.getByTestId('batch-actions-overflow'));
  await waitFor(() => expect(screen.getByTestId('batch-abandon-menu-item')).toBeInTheDocument());
}

describe('BatchDetailPage — marking a stage done', () => {
  it('offers the control on the current stage and on no other', async () => {
    // Earlier stages are done and later ones have not happened; neither is a thing
    // you can finish. `currentStage` — through `nextAction` — is the only decision.
    await showRun();

    expect(stagesWithControls()).toEqual(['stage-1']);
  });

  it('moves the control on when the stage before it has been marked done', async () => {
    await showRun({
      stages: [
        stage({ actualEndAt: '2026-08-14T07:12:00.000Z' }),
        stage({ id: 'stage-2', label: 'Bulk ferment', kind: 'wait' }),
        stage({ id: 'stage-3', label: 'Prove', kind: 'wait' }),
      ],
    });

    expect(stagesWithControls()).toEqual(['stage-2']);
  });

  it('marks THAT stage done, and reads no clock of its own doing it', async () => {
    // Two arguments and no third: the instant is the service's to read
    // (`advanceStage` stamps `new Date()`), which is what keeps the re-timing a pure
    // function with a fixed answer.
    const run = await showRun();

    await fireEvent.click(screen.getByTestId('batch-stage-advance'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalledTimes(1));
    expect(advanceMock).toHaveBeenCalledWith(run, 'stage-1');
  });

  it('says so when the write fails, and says nothing when it works', async () => {
    // A stage list that re-times itself in front of you is a better acknowledgement
    // than a sentence covering it up, so success is silent.
    await showRun();
    await fireEvent.click(screen.getByTestId('batch-stage-advance'));
    await waitFor(() => expect(advanceMock).toHaveBeenCalledTimes(1));
    expect(toastMock).not.toHaveBeenCalled();

    advanceMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
    await fireEvent.click(screen.getByTestId('batch-stage-advance'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock.mock.calls[0]?.[1]).toBe('destructive');
  });

  it('offers nothing to advance once every stage is done', async () => {
    // There is deliberately no `finished` STATE — "nothing left" is answered by the
    // stages themselves, so it has to be answered here the same way.
    await showRun({
      stages: [
        stage({ actualEndAt: '2026-08-14T07:12:00.000Z' }),
        stage({ id: 'stage-2', actualEndAt: '2026-08-14T08:10:00.000Z' }),
      ],
    });

    expect(screen.queryByTestId('batch-stage-advance')).toBeNull();
  });

  it('offers nothing to advance on an abandoned run', async () => {
    await showRun({ state: 'abandoned' });

    expect(screen.queryByTestId('batch-stage-advance')).toBeNull();
  });
});

describe('BatchDetailPage — the hand-off to cook mode', () => {
  it('links an active stage to cook mode, by recipe id alone', async () => {
    // Cook mode takes only a recipe id — the link lands at the top of it, with its
    // own timers, which is the whole hand-off.
    await showRun();

    await fireEvent.click(screen.getByTestId('batch-stage-cook'));
    expect(pushMock).toHaveBeenCalledWith('/recipes/recipe-1/cook');
  });

  it('does not offer it on a wait, which is the stage you leave the room for', async () => {
    await showRun({
      stages: [
        stage({ actualEndAt: '2026-08-14T07:12:00.000Z' }),
        stage({ id: 'stage-2', label: 'Bulk ferment', kind: 'wait' }),
      ],
    });

    expect(stagesWithControls()).toEqual(['stage-2']);
    expect(screen.queryByTestId('batch-stage-cook')).toBeNull();
  });

  it('links off the batch and never through it — the recipe is not read here', async () => {
    // `recipeId` is the batch's own frozen FK. A run whose dish was retitled or
    // deleted still links, because nothing on this page joins to a recipe.
    await showRun({ recipeId: 'recipe-since-renamed' });

    await fireEvent.click(screen.getByTestId('batch-stage-cook'));
    expect(pushMock).toHaveBeenCalledWith('/recipes/recipe-since-renamed/cook');
  });
});

describe('BatchDetailPage — abandoning', () => {
  it('keeps it behind the ⋮ and behind a confirm', async () => {
    // Two gates for one irreversible action, on a page whose thumb is reaching for
    // "Mark done".
    await showRun();

    expect(screen.queryByTestId('batch-abandon-menu-item')).toBeNull();
    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('batch-abandon-menu-item'));

    await waitFor(() => expect(screen.getByTestId('batch-abandon-dialog')).toBeInTheDocument());
    expect(abandonMock).not.toHaveBeenCalled();
  });

  it('stops the run once confirmed', async () => {
    const run = await showRun();

    await openOverflowMenu();
    await fireEvent.click(screen.getByTestId('batch-abandon-menu-item'));
    await waitFor(() => expect(screen.getByTestId('batch-abandon-confirm')).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId('batch-abandon-confirm'));

    await waitFor(() => expect(abandonMock).toHaveBeenCalledTimes(1));
    expect(abandonMock).toHaveBeenCalledWith(run);
  });

  it('is not offered on a run that is already stopped', async () => {
    await showRun({ state: 'abandoned' });

    expect(screen.queryByTestId('batch-actions-overflow')).toBeNull();
  });

  it('is not offered on a run with every stage done — there is nothing left to stop', async () => {
    await showRun({
      stages: [stage({ actualEndAt: '2026-08-14T07:12:00.000Z' })],
    });

    // Still `running`, so the menu stands: the reminders for a run that finished
    // early are gone with its last stage, but the state is what abandoning changes.
    expect(screen.getByTestId('batch-actions-overflow')).toBeInTheDocument();
  });
});

describe('BatchDetailPage — what the controls still refuse to do', () => {
  it('offers no way to re-scale or re-schedule a running batch', async () => {
    // Freezing exists to prevent versions: what a batch records is what happened.
    // There is no route back to `proposeSchedule` from here, and no control that
    // moves a number.
    await showRun();
    await openOverflowMenu();

    expect(screen.queryByText(/re-?schedule|re-?scale|change the (plan|time)/i)).toBeNull();
  });
});

// ─── Phase 4 — the observation log ────────────────────────────────────────────
//
// What these have to get right is, again, different in kind. The subcollection is
// what makes two people logging on the same day safe, so the page's whole job is
// not to defeat it: it renders the list the adapter delivered, in the order the
// adapter delivered it (reversed for reading), and it never gathers entries back
// into one value it could overwrite. And "finished" is still not a state — the
// invitation is driven by `nextAction`, exactly as the controls above are.

const OBSERVED_AT = '2026-08-14T09:00:00.000Z';

function observation(over: Partial<BatchObservationDoc> = {}): BatchObservationDoc {
  return {
    id: 'obs-1',
    schemaVersion: 1,
    at: OBSERVED_AT,
    weightGrams: null,
    ph: null,
    temperatureC: null,
    note: '',
    image: null,
    ...over,
  };
}

/** A run with every stage behind it — `nextAction` reads `'done'`. */
const DONE_STAGES = [
  stage({ actualEndAt: '2026-08-14T07:12:00.000Z' }),
  stage({ id: 'stage-2', actualEndAt: '2026-08-14T08:10:00.000Z' }),
];

function loggedIds(): string[] {
  return screen
    .queryAllByTestId('batch-log-entry')
    .map((el) => el.getAttribute('data-observation-id') ?? '');
}

describe('BatchDetailPage — the log on the batch', () => {
  it('subscribes to the run’s own log and disposes it on teardown', () => {
    const unsub = vi.fn();
    mockInitObservationsSync.mockReturnValue(unsub);
    const { unmount } = renderPage();

    expect(mockInitObservationsSync).toHaveBeenCalledWith(BATCH_ID);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('says the log is empty rather than hiding it, so the door is always visible', async () => {
    await showRun();

    expect(screen.getByTestId('batch-log-empty')).toBeInTheDocument();
    expect(screen.getByTestId('batch-log-add')).toBeInTheDocument();
  });

  it('renders every entry as its own row — two people, one day, both kept', async () => {
    // The subcollection guarantees this; the page's job is not to defeat it by
    // collapsing the log into one value. Same instant, two documents, two rows.
    await showRun();
    mockObservations._set([
      observation({ id: 'obs-hers', weightGrams: 1440, note: 'weighed after shaping' }),
      observation({ id: 'obs-his', weightGrams: 1438, note: 'weighed it again' }),
    ]);

    await waitFor(() => expect(loggedIds()).toHaveLength(2));
    expect(loggedIds().sort()).toEqual(['obs-hers', 'obs-his']);
    expect(screen.getByTestId('batch-log')).toHaveTextContent('weighed after shaping');
    expect(screen.getByTestId('batch-log')).toHaveTextContent('weighed it again');
  });

  it('reads newest first, by reversing the adapter’s order and never re-sorting', async () => {
    // The adapter orders by `at` ASCENDING — when the reading was TAKEN. A
    // back-filled Tuesday entry therefore arrives before Thursday's however late it
    // was typed, and this page must show it as the older of the two.
    await showRun();
    mockObservations._set([
      observation({ id: 'obs-tuesday', at: '2026-08-11T08:00:00.000Z' }),
      observation({ id: 'obs-thursday', at: '2026-08-13T08:00:00.000Z' }),
    ]);

    await waitFor(() => expect(loggedIds()).toHaveLength(2));
    expect(loggedIds()).toEqual(['obs-thursday', 'obs-tuesday']);
  });

  it('shows a weight, a note and a photo, and prints nothing it does not have', async () => {
    await showRun();
    mockObservations._set([
      observation({
        weightGrams: 1440,
        note: 'open crumb',
        image: { url: 'https://storage.example/batch-images/batch-1/obs-1.webp', source: 'upload' },
      }),
    ]);

    await waitFor(() => expect(screen.getByTestId('batch-log-entry')).toBeInTheDocument());
    expect(screen.getByTestId('batch-log-entry-weight')).toHaveTextContent('1440 g');
    expect(screen.getByTestId('batch-log-entry-note')).toHaveTextContent('open crumb');
    // The Storage URL the callable stamped on — the bytes never went through
    // Firestore, and no client-writable Storage path exists in this feature.
    expect(screen.getByTestId('batch-log-entry-photo')).toHaveAttribute(
      'src',
      'https://storage.example/batch-images/batch-1/obs-1.webp',
    );
    // An entry with no pH and no temperature invents neither.
    expect(screen.queryByTestId('batch-log-entry-ph')).toBeNull();
    expect(screen.queryByTestId('batch-log-entry-temp')).toBeNull();
  });

  it('shows a reading it did not collect, when the document carries one', async () => {
    // No screen writes `ph` or `temperatureC` yet; rendering one that exists costs
    // nothing and is the honest thing to do with a document that has it.
    await showRun();
    mockObservations._set([observation({ ph: 4.2, temperatureC: 12 })]);

    await waitFor(() => expect(screen.getByTestId('batch-log-entry')).toBeInTheDocument());
    expect(screen.getByTestId('batch-log-entry-ph')).toHaveTextContent('4.2');
    expect(screen.getByTestId('batch-log-entry-temp')).toHaveTextContent('12');
  });

  it('keeps the log readable on a run that was abandoned months ago', async () => {
    // What it got to is the entire reason abandoning is a state and not a delete.
    await showRun({ state: 'abandoned', stages: DONE_STAGES });
    mockObservations._set([observation({ note: 'stopped, mould on the casing' })]);

    await waitFor(() => expect(screen.getByTestId('batch-log-entry')).toBeInTheDocument());
    expect(screen.getByTestId('batch-quantities')).toBeInTheDocument();
    expect(screen.getByTestId('batch-stages')).toBeInTheDocument();
  });
});

describe('BatchDetailPage — the invitation at the end of a run', () => {
  it('offers it once every stage is done, without adding a state to say so', async () => {
    await showRun({ stages: DONE_STAGES });

    expect(screen.getByTestId('batch-log-prompt')).toBeInTheDocument();
  });

  it('does not offer it while there is still a stage in hand', async () => {
    await showRun();

    expect(screen.queryByTestId('batch-log-prompt')).toBeNull();
    // …but logging is still possible, because a cure is weighed on day 12.
    expect(screen.getByTestId('batch-log-add')).toBeInTheDocument();
  });

  it('takes one tap to skip, and does not block anything on the way past', async () => {
    await showRun({ stages: DONE_STAGES });

    await fireEvent.click(screen.getByTestId('batch-log-prompt-skip'));

    await waitFor(() => expect(screen.queryByTestId('batch-log-prompt')).toBeNull());
    // Skipping costs nothing: the page is intact and the log is still reachable.
    expect(screen.getByTestId('batch-log-add')).toBeInTheDocument();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('stops asking once the log has an answer', async () => {
    await showRun({ stages: DONE_STAGES });
    expect(screen.getByTestId('batch-log-prompt')).toBeInTheDocument();

    mockObservations._set([observation({ weightGrams: 1440 })]);

    await waitFor(() => expect(screen.queryByTestId('batch-log-prompt')).toBeNull());
  });

  it('does not offer it before the log has loaded', async () => {
    // Not-loaded is not "nothing was ever written". Flashing the invitation at a run
    // that has six weeks of readings would be a confident lie.
    mockObservations._set(undefined);
    await showRun({ stages: DONE_STAGES });

    expect(screen.queryByTestId('batch-log-prompt')).toBeNull();
  });

  it('offers the screen the moment the last stage is marked done', async () => {
    // The invitation arrives at the moment it is worth asking, read off the document
    // the write returned — `nextAction` again, never a second guess at "finished".
    await showRun({
      stages: [stage({ actualEndAt: '2026-08-14T07:12:00.000Z' }), stage({ id: 'stage-2' })],
    });
    advanceMock.mockResolvedValueOnce({
      kind: 'ok',
      value: makeBatch({ stages: DONE_STAGES }),
    });

    await fireEvent.click(screen.getByTestId('batch-stage-advance'));

    await waitFor(() => expect(screen.getByTestId('batch-log-sheet')).toBeInTheDocument());
  });

  it('does not open the screen when a mid-run stage is marked done', async () => {
    await showRun();

    await fireEvent.click(screen.getByTestId('batch-stage-advance'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('batch-log-sheet')).toBeNull();
  });
});

describe('BatchDetailPage — where the log affordance lives', () => {
  it('keeps it out of the ⋮, so a stopped run can still be written on', async () => {
    // Phase 3 gates the WHOLE menu on `canAbandon` so its trigger can never open on
    // an empty popover. An always-available item inside that gate would vanish on an
    // abandoned run — the one surface whose point is that it keeps what it recorded.
    await showRun({ state: 'abandoned' });

    expect(screen.queryByTestId('batch-actions-overflow')).toBeNull();
    expect(screen.getByTestId('batch-log-add')).toBeInTheDocument();
  });

  it('offers no way to delete an entry — the log is append-only', async () => {
    await showRun();
    mockObservations._set([observation({ note: 'open crumb' })]);

    await waitFor(() => expect(screen.getByTestId('batch-log-entry')).toBeInTheDocument());
    const entry = screen.getByTestId('batch-log-entry');
    expect(entry.querySelector('button')).toBeNull();
  });
});

describe('BatchDetailPage — gated (issue #831)', () => {
  // A typed `#/batches/:id` must not render for anyone outside the test group while
  // bread is being built. Nothing is shown and nothing explains the absence — a
  // denial message would announce the very feature the gate is hiding.
  it('renders nothing and sends a gated visitor home', async () => {
    mockBreadGate._set({ enabled: false, settled: true });
    renderPage();
    mockBatch._set(makeBatch());

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'));
    expect(screen.queryByTestId('batch-stages')).toBeNull();
    expect(screen.queryByTestId('batch-actions-overflow')).toBeNull();
  });

  it('waits for the flag payload before bouncing anyone', async () => {
    mockBreadGate._set({ enabled: false, settled: false });
    renderPage();

    expect(screen.getByTestId('feature-guard-loading')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
