import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type {
  BatchDoc,
  BatchObservationDoc,
  BatchStageDoc,
  IngredientDoc,
  KitchenTimerDoc,
  KitchenTimersDoc,
  RecipeDoc,
} from '@salt/domain/schemas';

// Cooking a run (issue #1327) — `/batches/:id/cook`.
//
// The line this file draws is cook mode's: everything the cook can DO is exercised
// here, and everything that depends on a browser having laid something out is not.
// jsdom measures every box as 0, so the deck's probe never resolves and the pager's
// stops are always `[0]`; the peek, the fade and the swipe belong to the Playwright
// pass.
//
// What this page has to get right, and what is genuinely its own:
//
//   • the WEIGH-OUT is the batch's frozen grams, plus the recipe's own ingredients
//     that the formula has no percentage for. Neither is servings-scaled, ever;
//   • the DECK is the recipe's method — every step, in order — with the run's stages
//     as bands on the steps they cite and cards of their own where they cite none. A
//     stage-less step and a step-less stage are both first-class;
//   • a WAIT stage's step counts down to the schedule's planned end and offers no
//     timer, and marking it done marks the stage done (two writes, in that order);
//   • a step with NO stage takes an ordinary press-to-start timer (Phase 2) on the
//     member's own kitchen-timers document, carrying the origin that sends its
//     notification back here; a step WITH one still offers none;
//   • there is NO FINISH, and nothing here ends the run.

const {
  mockBatch,
  mockObservations,
  mockRecipes,
  mockIsLoadingRecipes,
  mockBreadGate,
  mockWakeLock,
  mockKitchenTimers,
  mockStartKitchenTimer,
  mockDismissKitchenTimer,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockBatch: makeStore<BatchDoc | null | undefined>(undefined),
    mockObservations: makeStore<BatchObservationDoc[] | undefined>([]),
    mockRecipes: makeStore<RecipeDoc[]>([]),
    // A real store, not the constant `false` this file used to pass: the deck's
    // deleted-versus-loading split (issue #1365) is read off this flag, so a test
    // that cannot move it cannot tell the two apart either.
    mockIsLoadingRecipes: makeStore<boolean>(false),
    mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
      enabled: true,
      settled: true,
    }),
    mockWakeLock: { enable: vi.fn(async () => true), disable: vi.fn(async () => {}) },
    mockKitchenTimers: makeStore<KitchenTimersDoc | null>(null),
    mockStartKitchenTimer: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
    mockDismissKitchenTimer: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), router: { querystring: '' } }));
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: { subscribe: (f: (v: unknown[]) => void) => (f([]), () => {}) },
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: { subscribe: (f: (v: unknown[]) => void) => (f([]), () => {}) },
}));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoadingRecipes,
}));
vi.mock('../src/lib/wakeLock.js', () => ({
  isWakeLockSupported: vi.fn(() => true),
  createWakeLock: vi.fn(() => mockWakeLock),
}));
// The write path echoes into the store exactly as the real service does (it sets the
// store optimistically before the write lands): a step only collapses once its
// completion is back in the store, so a mock that left the store alone would hide
// the whole advance path.
vi.mock('../src/lib/batchService.js', () => ({
  batch: mockBatch,
  initBatchSync: vi.fn(() => () => {}),
  // The synchronous escape hatch the page re-reads before its second write
  // (BLOCKING #1, PR #1334 review) — backed by the same store the mock write
  // functions below echo into, so it always answers with whatever the LAST
  // `mockBatch._set` call left behind, concurrent writes included.
  getBatchSnapshot: vi.fn(() => mockBatch._get()),
  advanceStage: vi.fn(async (current: BatchDoc) => ({ kind: 'ok' as const, value: current })),
  startStage: vi.fn(async (current: BatchDoc) => ({ kind: 'ok' as const, value: current })),
  setIngredientChecked: vi.fn(async (current: BatchDoc, id: string, checked: boolean) => {
    const ids = checked
      ? [...current.checkedIngredientIds, id]
      : current.checkedIngredientIds.filter((existing) => existing !== id);
    const next = { ...current, checkedIngredientIds: ids };
    mockBatch._set(next);
    return { kind: 'ok' as const, value: next };
  }),
  setStepDone: vi.fn(async (current: BatchDoc, id: string, done: boolean) => {
    const ids = done
      ? [...current.completedStepIds, id]
      : current.completedStepIds.filter((existing) => existing !== id);
    const next = { ...current, completedStepIds: ids };
    mockBatch._set(next);
    return { kind: 'ok' as const, value: next };
  }),
}));
vi.mock('../src/lib/batchObservationService.js', () => ({
  observations: mockObservations,
  initBatchObservationsSync: vi.fn(() => () => {}),
  logObservation: vi.fn(async () => ({
    kind: 'ok',
    value: { observationId: 'obs-new', photo: { kind: 'none' } },
  })),
}));
// The timers (issue #1327, Phase 2). Mocked at the COMMAND seam, where the page's
// own decisions are: which id it starts under, and what origin it attaches. The
// composition behind it — the clock, `notify`, the producer — is pinned in
// `kitchenTimerService.test.ts`.
vi.mock('../src/lib/kitchenTimerService.js', () => ({
  kitchenTimers: mockKitchenTimers,
  startKitchenTimer: mockStartKitchenTimer,
  dismissKitchenTimer: mockDismissKitchenTimer,
}));
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));

import { push } from 'svelte-spa-router';
import BatchCookPage from '../src/routes/batches/BatchCookPage.svelte';
import {
  advanceStage,
  startStage,
  getBatchSnapshot,
  setIngredientChecked,
  setStepDone,
} from '../src/lib/batchService.js';
import { addToast } from '../src/lib/toastStore.js';

const advanceMock = vi.mocked(advanceStage);
const startMock = vi.mocked(startStage);
const checkMock = vi.mocked(setIngredientChecked);
const stepMock = vi.mocked(setStepDone);
const snapshotMock = vi.mocked(getBatchSnapshot);
const toastMock = vi.mocked(addToast);
const pushMock = vi.mocked(push);

const BATCH_ID = 'batch-1';
const RECIPE_ID = 'recipe-1';
// The run started at 06:00; every planned time below is from that morning, so the
// countdown assertions run against a frozen clock rather than the machine's.
const STARTED_AT = '2026-09-11T06:00:00.000Z';
const NOW = new Date('2026-09-11T07:30:00.000Z');

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-bulk',
    label: 'Leave in a warm place',
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes: 60 },
    until: 'until doubled in size',
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

/** #1327's worked example, cut down: three steps, a stage on one of them. */
function makeBatch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: BATCH_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeTitle: 'East Midlands Crusty Cobs',
    state: 'running',
    abandonedAt: null,
    checkedIngredientIds: [],
    completedStepIds: [],
    quantities: [
      { ingredientId: 'ing-flour', label: '500 g strong white flour', percent: 100, grams: 597 },
      { ingredientId: 'ing-water', label: '320 g water', percent: 64, grams: 382 },
    ],
    totals: { basisGrams: 597, totalGrams: 979, usableGrams: 979, units: null },
    stages: [
      stage(),
      stage({
        id: 'stage-cool',
        label: 'Cool the cobs',
        kind: 'wait',
        duration: null,
        until: null,
        stepId: null,
        plannedStartAt: '2026-09-11T09:00:00.000Z',
        plannedEndAt: '2026-09-11T09:00:00.000Z',
      }),
    ],
    rationale: null,
    ambientCelsius: null,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    ...over,
  };
}

/** The recipe's METHOD — the one thing this page reads live. */
function recipeWith(over: Partial<RecipeDoc> = {}): RecipeDoc {
  // `emptyRecipe` is the domain's own builder (UT-C2): the fields this page never
  // touches come from there rather than from a hand-rolled copy that drifts the
  // next time the schema grows one.
  return {
    ...emptyRecipe(RECIPE_ID, STARTED_AT),
    title: 'East Midlands Crusty Cobs',
    ingredients: [
      {
        id: 'group-1',
        name: null,
        items: [
          ingredient('ing-flour', '500 g strong white flour'),
          // IN THE RECIPE AND NOT IN THE FORMULA — the crushed vitamin C tablet.
          ingredient('ing-vitc', '1 crushed Vitamin C tablet'),
        ],
      },
    ],
    steps: [
      { id: 'step-1', text: 'Mix the dough.', timer: null, note: null },
      {
        id: 'step-2',
        text: 'Knead for ten minutes.',
        timer: { durationMinutes: 10, description: null },
        note: null,
      },
      { id: 'step-3', text: 'Leave it somewhere warm.', timer: null, note: null },
    ],
    metadata: { servings: 6, phases: [], timingSummary: null, tags: [] },
    updatedAt: STARTED_AT,
    ...over,
  };
}

function ingredient(id: string, rawText: string): IngredientDoc {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: 'step-1',
  };
}

function renderPage() {
  return render(BatchCookPage, { props: { params: { id: BATCH_ID } } });
}

/** Move to the deck — the footer's one primary on the weigh-out screen. */
async function goToSteps(): Promise<void> {
  await fireEvent.click(screen.getByTestId('batch-cook-stage-toggle'));
  await waitFor(() => expect(screen.getByTestId('batch-cook-steps')).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mockBatch._set(makeBatch());
  mockObservations._set([]);
  mockRecipes._set([recipeWith()]);
  mockIsLoadingRecipes._set(false);
  mockBreadGate._set({ enabled: true, settled: true });
  mockKitchenTimers._set(null);
  advanceMock.mockImplementation(async (current) => ({ kind: 'ok', value: current }));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the three loading states', () => {
  it('says nothing while the run is still loading', () => {
    mockBatch._set(undefined);
    renderPage();
    expect(screen.queryByTestId('batch-cook-title')).toBeNull();
  });

  it('says the run is not there when it is not', () => {
    mockBatch._set(null);
    renderPage();
    expect(screen.getByText('Batch not found')).toBeTruthy();
  });

  it('is hidden entirely from someone without the bread flag', () => {
    // Exactly as `/batches/:id` is (issue #831) — no denial copy.
    mockBreadGate._set({ enabled: false, settled: true });
    renderPage();
    expect(screen.queryByTestId('batch-cook-page')).toBeNull();
  });

  it('focuses the page container once the feature gate settles', async () => {
    // BLOCKING #4 (PR #1334 review): `pageEl` binds only once `FeatureGuard`
    // actually renders this page's children, which is after the gate settles —
    // an `onMount` on this component fires before that and focuses nothing.
    renderPage();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('batch-cook-page')));
  });
});

describe('an abandoned run', () => {
  // BLOCKING #2 (PR #1334 review): the entry button on `BatchDetailPage` only
  // shows while `run.state === 'running'`, but this route is reachable by direct
  // URL or back/forward regardless, and a stopped run must offer nothing to tick
  // or advance — silently writing and marking nothing is the bug, not a feature.
  it('offers nothing — no weigh-out, no deck, no stage controls', () => {
    mockBatch._set(makeBatch({ state: 'abandoned', abandonedAt: STARTED_AT }));
    renderPage();

    expect(screen.getByText('This batch was abandoned')).toBeTruthy();
    expect(screen.queryByTestId('batch-cook-mise')).toBeNull();
    expect(screen.queryByTestId('batch-cook-stage-toggle')).toBeNull();
    expect(screen.queryByTestId('batch-cook-mise-row')).toBeNull();
  });

  it('reaching it directly ticks and advances nothing', async () => {
    mockBatch._set(makeBatch({ state: 'abandoned', abandonedAt: STARTED_AT }));
    renderPage();
    await fireEvent.click(screen.getByTestId('batch-cook-back'));

    expect(checkMock).not.toHaveBeenCalled();
    expect(stepMock).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('abandoning mid-visit removes the controls live, rather than leaving them to write and mark nothing', async () => {
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('batch-cook-step-done')).toBeTruthy();

    mockBatch._set({ ...mockBatch._get()!, state: 'abandoned', abandonedAt: STARTED_AT });

    await waitFor(() => expect(screen.getByText('This batch was abandoned')).toBeTruthy());
    expect(screen.queryByTestId('batch-cook-step-done')).toBeNull();
  });
});

describe('the weigh-out', () => {
  it('shows the batch’s grams with the percentage muted under them', () => {
    renderPage();
    const rows = screen.getAllByTestId('batch-cook-mise-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('500 g strong white flour');
    expect(rows[0]!.textContent).toContain('597 g');
    expect(rows[0]!.textContent).toContain('100%');
  });

  it('lists a recipe ingredient the formula has no percentage for, as written', () => {
    // It is as real a part of the weigh-out as the flour; dropping it would send
    // someone to the recipe page mid-bake. No grams — the freeze never gave it any.
    renderPage();
    const extra = screen.getByTestId('batch-cook-mise-extra');
    expect(extra.textContent).toContain('1 crushed Vitamin C tablet');
    expect(extra.getAttribute('data-ingredient-id')).toBe('ing-vitc');
  });

  it('ticks a row onto the BATCH, so everyone on the run sees it', async () => {
    renderPage();
    await fireEvent.click(screen.getAllByTestId('batch-cook-mise-row')[0]!);

    expect(checkMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: BATCH_ID }),
      'ing-flour',
      true,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('batch-cook-mise-row')[0]!.getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
  });

  it('unticks the same row on a second tap', async () => {
    mockBatch._set(makeBatch({ checkedIngredientIds: ['ing-flour'] }));
    renderPage();
    await fireEvent.click(screen.getAllByTestId('batch-cook-mise-row')[0]!);

    expect(checkMock).toHaveBeenCalledWith(expect.anything(), 'ing-flour', false);
  });

  it('counts over the rows on screen, never over the stored id list', () => {
    // A tick left behind by an ingredient edited out of the recipe must not inflate
    // the count — `progressOver`'s rule, and the reason it takes the ids.
    mockBatch._set(makeBatch({ checkedIngredientIds: ['ing-flour', 'ing-long-gone'] }));
    renderPage();
    expect(screen.getByTestId('batch-cook-subtitle').textContent).toContain('1/3 ready');
  });
});

describe('the deck', () => {
  it('shows every recipe step, in recipe order', async () => {
    renderPage();
    await goToSteps();
    const steps = screen.getAllByTestId('batch-cook-step');
    expect(steps.map((el) => el.getAttribute('data-step-id'))).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);
  });

  it('bands the step its stage cites, with the run’s own clock and criterion', async () => {
    renderPage();
    await goToSteps();
    const band = screen.getByTestId('batch-cook-stage-band');
    expect(band.getAttribute('data-stage-id')).toBe('stage-bulk');
    expect(band.textContent).toContain('Stage 1 of 2');
    expect(band.textContent).toContain('Leave in a warm place');
    expect(band.textContent).toContain('wait');
    expect(screen.getByTestId('batch-cook-stage-until').textContent).toContain(
      'until doubled in size',
    );
  });

  it('gives a stage that cites no step a card of its own, after the previous stage’s step', async () => {
    // `extractProcessStages` drops the CITATION and never the stage, so a null
    // `stepId` is as real a stage as any other and nothing may gate on it.
    renderPage();
    await goToSteps();
    const card = screen.getByTestId('batch-cook-stage-card');
    expect(card.getAttribute('data-stage-id')).toBe('stage-cool');
    // It follows step 3 — the step the previous stage claimed.
    const deck = screen.getByTestId('batch-cook-deck');
    const nodes = Array.from(
      deck.querySelectorAll('[data-step-id], [data-testid="batch-cook-stage-card"]'),
    );
    expect(nodes.at(-1)).toBe(card);
  });

  it('leaves a step with no stage an ordinary step', async () => {
    renderPage();
    await goToSteps();
    const step2 = screen
      .getAllByTestId('batch-cook-step')
      .find((el) => el.getAttribute('data-step-id') === 'step-2')!;
    expect(step2.querySelector('[data-testid="batch-cook-stage-band"]')).toBeNull();
    expect(step2.textContent).toContain('Knead for ten minutes.');
  });

  it('offers a press-to-start timer on a step the schedule does not time', async () => {
    // Step 2 (knead, 10 min) wears no stage band, so nothing else is counting it
    // down — which is exactly when a timer is the right answer (Phase 2).
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('cook-step-timer-start').textContent).toContain(
      'Start 10 minute timer',
    );
    // And no "the recipe says…" text beside it: the button IS the recipe's
    // duration, said once.
    expect(screen.queryByTestId('batch-cook-step-timer')).toBeNull();
  });
});

describe('the schedule owns the clock', () => {
  it('counts down to the wait stage’s planned end, and offers no timer', async () => {
    // Planned end 08:00, now 07:30.
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('batch-cook-stage-countdown').textContent).toContain('30 min left');
  });

  it('says how far past a stage already is, rather than going quiet', async () => {
    vi.setSystemTime(new Date('2026-09-11T08:45:00.000Z'));
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('batch-cook-stage-countdown').textContent).toContain('45 min over');
  });

  it('spells an hour-plus span the app’s one way, not the retired fork', async () => {
    // SHOULD-FIX #5 (PR #1334 review): `countdown` used to hand-roll `1 h 30
    // min` beside `formatStatedDuration`'s `1 hr 30 min` in the very same block
    // — issue #933's fork, reintroduced. Planned start 07:00, now 05:00: two
    // hours to go.
    vi.setSystemTime(new Date('2026-09-11T05:00:00.000Z'));
    mockBatch._set(
      makeBatch({
        stages: [
          stage({
            plannedStartAt: '2026-09-11T07:00:00.000Z',
            plannedEndAt: '2026-09-11T08:30:00.000Z',
          }),
          stage({
            id: 'stage-cool',
            label: 'Cool the cobs',
            kind: 'wait',
            duration: null,
            until: null,
            stepId: null,
            plannedStartAt: '2026-09-11T09:00:00.000Z',
            plannedEndAt: '2026-09-11T09:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('batch-cook-stage-countdown').textContent).toContain(
      '3 hr 30 min left',
    );
  });

  it('marking the step done marks its stage done — the tick first, then the advance', async () => {
    // Two writes, in that order and never concurrently: both rewrite the whole
    // document (LWW), so overlapping them is one silently overwriting the other.
    // The deck lands on the first incomplete step, which here is step 3 — the one
    // the wait stage cites.
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalled());
    expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-3', true);
    const advancedWith = advanceMock.mock.calls.at(-1)!;
    expect(advancedWith[1]).toBe('stage-bulk');
    expect(advancedWith[0].completedStepIds).toContain('step-3');
  });

  it('re-reads the freshest batch before the advance, so a concurrent write is not clobbered', async () => {
    // BLOCKING #1 (PR #1334 review): the advance used to be handed `ticked.value`
    // — the document as it stood when the TICK's own write started — rather than
    // a fresh read. The round trip between the tick and the advance is exactly
    // the window another phone's write can land in, and this pins that the page
    // re-reads `getBatchSnapshot()` rather than reusing its stale local copy.
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    stepMock.mockImplementationOnce(async (current: BatchDoc, id: string) => {
      const ticked = { ...current, completedStepIds: [...current.completedStepIds, id] };
      mockBatch._set(ticked);
      // A concurrent write from another phone lands here, BEFORE this call
      // returns and BEFORE the advance is dispatched — the tick's own promise
      // has not yet resolved back into `markStep`.
      mockBatch._set({ ...ticked, checkedIngredientIds: ['ing-flour'] });
      return { kind: 'ok' as const, value: ticked };
    });
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalled());
    const advancedWith = advanceMock.mock.calls.at(-1)!;
    expect(advancedWith[0].completedStepIds).toContain('step-3');
    // Proof it came from the FRESH snapshot rather than the tick's own stamped
    // copy, which never saw the concurrent flour tick.
    expect(advancedWith[0].checkedIngredientIds).toEqual(['ing-flour']);
  });

  it('falls back to the tick’s own copy when there is no fresher snapshot to read', async () => {
    // `getBatchSnapshot()` can answer `null`/`undefined` (not loaded, or the run
    // vanished mid-write) — the advance still has to go out on SOMETHING rather
    // than silently doing nothing.
    snapshotMock.mockReturnValueOnce(undefined);
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalled());
    const advancedWith = advanceMock.mock.calls.at(-1)!;
    expect(advancedWith[0].completedStepIds).toContain('step-3');
  });

  it('does not advance a stage for a step that has none', async () => {
    // Step 2 is stage-less. Ticking it is a checklist tick and nothing more.
    mockBatch._set(makeBatch({ completedStepIds: ['step-1'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-2', true));
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('does not re-advance a stage that is already done', async () => {
    mockBatch._set(
      makeBatch({
        completedStepIds: ['step-1', 'step-2'],
        stages: [
          stage({ actualEndAt: '2026-09-11T07:55:00.000Z' }),
          stage({ id: 'stage-cool', stepId: null, duration: null }),
        ],
      }),
    );
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-3', true));
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('unticking a step does NOT un-mark its stage', async () => {
    // There is no inverse of `withStageAdvanced` and deliberately none: the tail has
    // already been re-timed against the instant the stage ended. A done step is
    // collapsed, so it is peeked open first — which is also the only way to reach
    // the untick control.
    mockBatch._set(
      makeBatch({
        completedStepIds: ['step-3'],
        stages: [stage({ actualEndAt: '2026-09-11T07:55:00.000Z' })],
      }),
    );
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('cook-step-collapsed'));
    await fireEvent.click(await screen.findByTestId('cook-step-untick'));

    await waitFor(() => expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-3', false));
    expect(advanceMock).not.toHaveBeenCalled();
  });
});

describe('no control waits for a write', () => {
  // Renamed from "the writing lock covers only the stage-transition family"
  // (issue #1365, fault 4): there is no lock left to scope. The three tests below
  // it are untouched — what changed is that the claim in the name is now the one
  // the whole block actually pins.
  //
  // BLOCKING #3 (PR #1334 review): the lock used to be one boolean shared by
  // every write on the page, so it silently dropped taps on the weigh-out rows
  // and the untick control (neither was even visually disabled), and — because
  // Firestore's `setDoc` does not resolve while offline — a stage write begun
  // offline would latch it forever, killing the rest of the page for the whole
  // session. A weigh-out tick and an untick are each a single write built from
  // the freshest local snapshot, so neither needs to wait its turn behind an
  // unrelated stage write that may never come back.
  function stuckAdvance(): { release: (batch: BatchDoc) => void } {
    let release!: (batch: BatchDoc) => void;
    advanceMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (batch: BatchDoc) => resolve({ kind: 'ok', value: batch });
        }),
    );
    return {
      release: (batch: BatchDoc) => release(batch),
    };
  }

  it('a weigh-out tick still lands while a stage advance is stuck in flight', async () => {
    const stuck = stuckAdvance();
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));
    await waitFor(() => expect(advanceMock).toHaveBeenCalled());

    await fireEvent.click(screen.getByTestId('batch-cook-stage-back'));
    await fireEvent.click(screen.getAllByTestId('batch-cook-mise-row')[0]!);

    expect(checkMock).toHaveBeenCalledWith(expect.anything(), 'ing-flour', true);
    stuck.release(mockBatch._get()!); // don't leak the pending promise
  });

  it('an untick still lands while a stage advance is stuck in flight', async () => {
    const stuck = stuckAdvance();
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));
    await waitFor(() => expect(advanceMock).toHaveBeenCalled());

    // Step 1 was already done before this test's own advance got stuck — peek it
    // open and untick it, an entirely unrelated write to the one in flight.
    await fireEvent.click(screen.getAllByTestId('cook-step-collapsed')[0]!);
    await fireEvent.click(await screen.findByTestId('cook-step-untick'));

    expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-1', false);
    stuck.release(mockBatch._get()!);
  });

  // ─── Issue #1365, fault 4 ───────────────────────────────────────────────────
  //
  // The two tests above only ever asserted that the controls TAKEN OFF the lock
  // survived a write that never comes back. The two that kept it did not, and the
  // comment in the page asserting the hazard had been dealt with was half true.
  // These pin the other half.
  //
  // `stuckAdvance` above is `setDoc` offline exactly: durably queued, never
  // resolving. `stuckStepDone` below is the same for the tick, and echoes into the
  // store first — which is what the REAL `persist` does (`batchService.ts:163-175`
  // sets the store before it awaits) and the whole reason the page can carry on
  // without the promise.
  function stuckStepDone(): { release: (batch: BatchDoc) => void } {
    let release!: (batch: BatchDoc) => void;
    stepMock.mockImplementationOnce((current: BatchDoc, id: string, done: boolean) => {
      const ids = done
        ? [...current.completedStepIds, id]
        : current.completedStepIds.filter((existing) => existing !== id);
      mockBatch._set({ ...current, completedStepIds: ids });
      return new Promise((resolve) => {
        release = (batch: BatchDoc) => resolve({ kind: 'ok', value: batch });
      });
    });
    return { release: (batch: BatchDoc) => release(batch) };
  }

  it('the stage card’s Done control stays live while a stage write is stuck in flight', async () => {
    // THE FAULT ITSELF. `writing` was set true, the `setDoc` never resolved, and
    // both controls gated on it greyed out for the rest of the visit — a screen
    // that reads as broken rather than merely slow, in the one room where signal
    // drops.
    const stuck = stuckAdvance();
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));
    await waitFor(() => expect(advanceMock).toHaveBeenCalled());

    // The card's Done is for the step-less stage, which nothing in this gesture
    // touched, and stays live. The fixture's three steps are all complete after
    // this tick, so the footer has already moved on to `batch-cook-to-batch` —
    // there is no footer stage control left to assert live here; the next test
    // covers a second stage control staying live and actually writing while this
    // one is stuck.
    expect(screen.getByTestId('batch-cook-stage-done')).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId('batch-cook-stage-back'));
    await fireEvent.click(screen.getByTestId('batch-cook-stage-toggle'));
    expect(screen.queryByTestId('batch-cook-step-done')).toBeNull();

    stuck.release(mockBatch._get()!);
  });

  it('another stage can still be marked done while one write is stuck in flight', async () => {
    // Not merely "the button is pressable" — the write it dispatches actually goes
    // out. A lock that only LOOKED released would pass the assertion above.
    const stuck = stuckAdvance();
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    // The step-less stage first, which is the one that gets stuck.
    await fireEvent.click(screen.getByTestId('batch-cook-stage-done'));
    await waitFor(() => expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'stage-cool'));

    // Now the OTHER stage, through its step, with the first write still pending.
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(stepMock).toHaveBeenCalledWith(expect.anything(), 'step-3', true));
    await waitFor(() => expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'stage-bulk'));
    stuck.release(mockBatch._get()!);
  });

  it('a step ticked with no signal still marks its stage done', async () => {
    // THE WORSE HALF of fault 4, and the one a reload could not recover. `markStep`
    // is two writes; the advance used to hang off the tick's network promise, so
    // offline the second write never went out AT ALL — the step was ticked locally
    // and its stage silently left open, with no `actualEndAt` and no re-timed tail.
    const stuck = stuckStepDone();
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'stage-bulk'));
    // And on the ticked document, not the one from before the tick.
    expect(advanceMock.mock.calls.at(-1)![0].completedStepIds).toContain('step-3');
    stuck.release(mockBatch._get()!);
  });
});

describe('the weigh-out, when the recipe has moved on', () => {
  it('says so, rather than printing an id, for a row whose ingredient has gone', () => {
    // `freezeBatch` writes an empty label when the ingredient had already left the
    // recipe. A blank reads as "we no longer know what this was", which is true.
    mockBatch._set(
      makeBatch({
        quantities: [{ ingredientId: 'ing-gone', label: '', percent: 2, grams: 12 }],
      }),
    );
    renderPage();

    const row = screen.getAllByTestId('batch-cook-mise-row')[0]!;
    expect(row.textContent).toContain('no longer in the recipe');
    expect(row.textContent).toContain('12 g');
    expect(row.textContent).not.toContain('ing-gone');
  });
});

describe('a stage that cites no step', () => {
  it('carries its own Mark done, because the footer acts on steps', async () => {
    // Same producer the batch page's Done uses, reached from here — there is no
    // step to tick for it.
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-stage-done'));

    await waitFor(() => expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'stage-cool'));
    expect(stepMock).not.toHaveBeenCalled();
  });

  it('offers nothing once the stage is over', async () => {
    mockBatch._set(
      makeBatch({
        stages: [
          stage(),
          stage({
            id: 'stage-cool',
            stepId: null,
            duration: null,
            skipped: { at: '2026-09-11T09:05:00.000Z', note: '' },
          }),
        ],
      }),
    );
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('batch-cook-stage-card').getAttribute('data-status')).toBe('skipped');
    expect(screen.queryByTestId('batch-cook-stage-done')).toBeNull();
  });
});

describe('a skipped stage, on both surfaces', () => {
  // Issue #1365, fault 1. `stageFacts` renders from two places — the step-less
  // stage's own card and the band on the step a stage cites — so the window was
  // stale on both. One guard covers both, and this test is the thing that says so:
  // it skips one stage of each shape in a single run.
  it('shows when it was skipped and why, never the window it was planned for', async () => {
    mockBatch._set(
      makeBatch({
        stages: [
          // On step 3, so it renders as a BAND.
          stage({ skipped: { at: '2026-09-11T07:05:00.000Z', note: 'proved overnight instead' } }),
          // No step, so it renders as a CARD — and it keeps a duration, so it would
          // print a window rather than falling into the observational branch.
          stage({
            id: 'stage-cool',
            label: 'Cool the cobs',
            stepId: null,
            skipped: { at: '2026-09-11T09:05:00.000Z', note: '' },
          }),
        ],
      }),
    );
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('batch-cook-stage-band').getAttribute('data-status')).toBe('skipped');
    expect(screen.getByTestId('batch-cook-stage-card').getAttribute('data-status')).toBe('skipped');
    expect(screen.queryAllByTestId('batch-cook-stage-window')).toHaveLength(0);
    // And no countdown either: there is no end to count to for a stage that will
    // never run, which is the same fact the window was asserting.
    expect(screen.queryAllByTestId('batch-cook-stage-countdown')).toHaveLength(0);

    const skipped = screen.getAllByTestId('batch-cook-stage-skipped');
    expect(skipped).toHaveLength(2);
    for (const line of skipped) expect(line.textContent).toContain('Skipped');
    // The reason, where one was given — and nothing at all where it was not.
    const notes = screen.getAllByTestId('batch-cook-stage-skipped-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain('proved overnight instead');
  });
});

describe('when the recipe behind the run has gone', () => {
  // Issue #1365, fault 2. `recipe` is `null` both while the library loads and once
  // the dish is deleted, and the deck used to say "Loading the method…" for both —
  // forever, in the second case, because there is nothing left to load.
  it('says the recipe was deleted, in the run’s words, with the way back to the batch', async () => {
    mockRecipes._set([]);
    renderPage();
    await goToSteps();

    expect(screen.queryByText(/Loading/)).toBeNull();
    const orphan = screen.getByTestId('cook-mode-orphan');
    expect(orphan.textContent).toContain('This recipe was deleted');
    // NOT the recipe-cook copy. There is no cook session on this page to close, and
    // saying there is would contradict the feature's own design.
    expect(orphan.textContent).not.toContain('cook session');

    await fireEvent.click(screen.getByTestId('cook-mode-orphan-back'));
    expect(pushMock).toHaveBeenCalledWith(`/batches/${BATCH_ID}`);
  });

  it('shows the spinner instead while the library is genuinely still loading', async () => {
    mockRecipes._set([]);
    mockIsLoadingRecipes._set(true);
    renderPage();
    await goToSteps();

    expect(screen.queryByTestId('cook-mode-orphan')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});

describe('a stage you have begun', () => {
  // Issue #1365, fault 3. Started-without-done is a first-class state
  // (`docs/formulas-schedules-batches.md`:237-239), and the deck could only say
  // "finished" about a stage you had merely begun.
  it('can be recorded as begun from the deck, on the same producer the batch page uses', async () => {
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-stage-mark-started'));

    await waitFor(() => expect(startMock).toHaveBeenCalledWith(expect.anything(), 'stage-cool'));
    // Start is not a quiet Done: nothing is advanced and nothing is re-timed.
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('offers no Start once the stage is already under way — only the end is left to record', async () => {
    mockBatch._set(
      makeBatch({
        stages: [
          stage(),
          stage({
            id: 'stage-cool',
            stepId: null,
            duration: null,
            actualStartAt: '2026-09-11T09:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('batch-cook-stage-card').getAttribute('data-status')).toBe(
      'inProgress',
    );
    expect(screen.queryByTestId('batch-cook-stage-mark-started')).toBeNull();
    expect(screen.getByTestId('batch-cook-stage-done')).toBeTruthy();
  });

  it('says so when the start does not land, and leaves the cook where they were', async () => {
    startMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-stage-mark-started'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), 'destructive'));
  });
});

describe('when a write fails', () => {
  // The service returns `Failure` and never throws (CLAUDE.md rule 10), so the page
  // says something true and leaves the cook where they were. A silent failure on a
  // shared document is the worst outcome available here: the other phone would show
  // a tick this one never recorded.
  it('says so when a weigh-out tick does not land', async () => {
    checkMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);
    renderPage();
    await fireEvent.click(screen.getAllByTestId('batch-cook-mise-row')[0]!);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), 'destructive'));
  });

  it('says so when the step tick does not land, and never advances the stage on top', async () => {
    // WHAT MAKES THIS TRUE, stated because issue #1365 changed the mechanism: the
    // advance is no longer gated on the tick's promise resolving ok (offline it
    // never resolves at all), it is gated on the LOCAL DOCUMENT saying the step is
    // now done. This mock replaces the implementation outright and so never echoes
    // into the store — which is the same thing a tick that refused before
    // persisting does. That is the boundary of the claim: a tick that DID reach the
    // store and only then failed its network write will advance, and the advance's
    // own whole-document write carries the tick with it.
    stepMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), 'destructive'));
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('says so when the stage advance does not land', async () => {
    advanceMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('batch-cook-step-done'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), 'destructive'));
  });

  it('says so when an untick does not land', async () => {
    stepMock.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as never);
    mockBatch._set(makeBatch({ completedStepIds: ['step-3'] }));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('cook-step-collapsed'));
    await fireEvent.click(await screen.findByTestId('cook-step-untick'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), 'destructive'));
  });
});

describe('keep awake', () => {
  it('holds the screen on, and lets it sleep again', async () => {
    renderPage();
    const toggle = screen.getByTestId('batch-cook-wakelock');

    await fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));
    expect(mockWakeLock.enable).toHaveBeenCalled();

    await fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'));
    expect(mockWakeLock.disable).toHaveBeenCalled();
  });

  it('does not claim a lock the browser refused', async () => {
    mockWakeLock.enable.mockResolvedValueOnce(false);
    renderPage();
    await fireEvent.click(screen.getByTestId('batch-cook-wakelock'));

    await waitFor(() => expect(mockWakeLock.enable).toHaveBeenCalled());
    expect(screen.getByTestId('batch-cook-wakelock').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('an observational stage', () => {
  it('says it has no fixed time, and shows the latest reading logged against it', async () => {
    mockObservations._set([
      {
        id: 'obs-1',
        schemaVersion: 1,
        at: '2026-09-11T09:10:00.000Z',
        stageId: 'stage-cool',
        weightGrams: 108,
        ph: null,
        temperatureC: null,
        relativeHumidityPercent: null,
        note: 'good crumb',
        image: null,
      },
    ]);
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('batch-cook-stage-observational').textContent).toContain(
      'No fixed time',
    );
    expect(screen.getByTestId('batch-cook-stage-reading').textContent).toContain('108 g');
    // No countdown ON THAT CARD — a stage with no length has an UNKNOWN one, not a
    // zero-length one, so there is no planned end to count to. Scoped to the card:
    // the bulk stage above it is still counting down, correctly.
    const card = screen.getByTestId('batch-cook-stage-card');
    expect(card.querySelector('[data-testid="batch-cook-stage-countdown"]')).toBeNull();
  });

  // SKIPPING THE STAGE DOES NOT UNOBSERVE THE READING (issue #1370). The skipped
  // branch leads `stageFacts` and deliberately suppresses the window, the countdown
  // and the "no fixed time" line — all statements about a plan that will not happen.
  // A reading is not one of those: it is what the cook actually saw, and the deck is
  // the only surface that shows it ON its stage.
  it('still shows the reading once the stage has been skipped', async () => {
    mockBatch._set(
      makeBatch({
        stages: [
          stage(),
          stage({
            id: 'stage-cool',
            stepId: null,
            duration: null,
            skipped: { at: '2026-09-11T09:30:00.000Z', note: 'pulled it early' },
          }),
        ],
      }),
    );
    mockObservations._set([
      {
        id: 'obs-1',
        schemaVersion: 1,
        at: '2026-09-11T09:10:00.000Z',
        stageId: 'stage-cool',
        weightGrams: 108,
        ph: null,
        temperatureC: null,
        relativeHumidityPercent: null,
        note: 'good crumb',
        image: null,
      },
    ]);
    renderPage();
    await goToSteps();

    const card = screen.getByTestId('batch-cook-stage-card');
    expect(card.getAttribute('data-status')).toBe('skipped');
    expect(screen.getByTestId('batch-cook-stage-skipped').textContent).toContain('Skipped');
    expect(screen.getByTestId('batch-cook-stage-reading').textContent).toContain('108 g');
    // The plan-shaped lines are still gone: this restores the reading, it does not
    // reopen the branch. Scoped to the card — the bulk stage above it is unskipped
    // and still prints its window, correctly.
    expect(screen.queryByTestId('batch-cook-stage-observational')).toBeNull();
    expect(card.querySelector('[data-testid="batch-cook-stage-window"]')).toBeNull();
  });
});

// ─── Timers (issue #1327, Phase 2) ───────────────────────────────────────────
//
// The deck's fourth clock question, after "which stage times this step" — what
// times the steps NO stage covers. They take an ordinary press-to-start timer on
// the member's OWN `kitchenTimers/{uid}` document (never on the family batch), and
// the `origin` it carries is what makes the rest of it work: the deck shows a timer
// on its step from an id rather than by matching label text, and the finished-timer
// push lands back here instead of on Mine.
describe('timers on the steps the schedule does not cover', () => {
  const STEP_2_TIMER_ID = `${BATCH_ID}::step-2`;

  function kitchenTimer(over: Partial<KitchenTimerDoc> = {}): KitchenTimerDoc {
    return {
      id: STEP_2_TIMER_ID,
      label: 'Knead',
      endsAt: new Date(NOW.getTime() + 6 * 60_000).toISOString(),
      durationMinutes: 10,
      notify: true,
      origin: { batchId: BATCH_ID, stepId: 'step-2' },
      ...over,
    };
  }

  function kitchen(timers: KitchenTimerDoc[]): KitchenTimersDoc {
    return { ownerUid: 'uid-1', timers };
  }

  it('starts one under an id derived from the batch AND the step', async () => {
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('cook-step-timer-start'));

    expect(mockStartKitchenTimer).toHaveBeenCalledWith({
      // Deterministic, so tapping again re-times the one that is running. The
      // batch id in front is what stops two runs of one recipe sharing a timer —
      // they share one array, unlike cook mode's per-session `activeTimers`.
      id: STEP_2_TIMER_ID,
      // Not `Salt Timer`. A kitchen timer's label is required and has no step to
      // fall back to at read time, and that default means "from nowhere in
      // particular" — which is what this is not. It is what the lock screen reads.
      label: 'Step 2',
      durationMinutes: 10,
      origin: { batchId: BATCH_ID, stepId: 'step-2' },
    });
  });

  // The point of the origin, stated as a test: without it the deck could only
  // guess which step a timer belongs to by matching its label text.
  it('shows a running timer ON its step, from the origin and not from its name', async () => {
    mockKitchenTimers._set(kitchen([kitchenTimer({ label: 'nothing like the step' })]));
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('cook-step-timer-countdown').textContent).toContain('6:00');
    expect(screen.queryByTestId('cook-step-timer-start')).toBeNull();
  });

  it('keeps it out of the step when the origin points at another batch', async () => {
    mockKitchenTimers._set(
      kitchen([kitchenTimer({ origin: { batchId: 'another-batch', stepId: 'step-2' } })]),
    );
    renderPage();
    await goToSteps();

    // Still unstarted here, and nowhere in this run's bar: it is the owner's
    // timer, but it is not this page's business to draw.
    expect(screen.getByTestId('cook-step-timer-start')).toBeTruthy();
    expect(screen.queryByTestId('cook-timers-bar')).toBeNull();
  });

  // A My Kitchen timer has no origin at all. It lists and dismisses on Mine, and
  // must not turn up here.
  it('keeps a timer from My Kitchen off the page entirely', async () => {
    mockKitchenTimers._set(kitchen([kitchenTimer({ origin: null })]));
    renderPage();
    await goToSteps();

    expect(screen.queryByTestId('cook-timers-bar')).toBeNull();
    expect(screen.getByTestId('cook-step-timer-start')).toBeTruthy();
  });

  it('keeps every timer of this run in the persistent bar, whatever the deck shows', () => {
    mockKitchenTimers._set(kitchen([kitchenTimer()]));
    // Rendered on the WEIGH-OUT, which has no steps on it at all.
    renderPage();

    expect(screen.getByTestId('cook-timers-bar')).toBeTruthy();
    expect(screen.getByTestId('cook-timer-chip-label').textContent).toContain('Knead');
  });

  it('dismisses one from the bar', async () => {
    mockKitchenTimers._set(kitchen([kitchenTimer()]));
    renderPage();
    await fireEvent.click(screen.getByTestId('cook-timer-chip-dismiss'));

    expect(mockDismissKitchenTimer).toHaveBeenCalledWith(STEP_2_TIMER_ID);
  });

  it('cancels a running one from the step it is sitting on', async () => {
    mockKitchenTimers._set(kitchen([kitchenTimer()]));
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('cook-step-timer-dismiss'));

    expect(mockDismissKitchenTimer).toHaveBeenCalledWith(STEP_2_TIMER_ID);
  });

  // Tapping a running chip re-times it: the same id, a fresh length, through the
  // same start — and the origin has to be handed over AGAIN, because the entry is
  // replaced whole rather than merged (pinned in the producers' suite).
  it('re-times a running one from the bar, keeping its id and its origin', async () => {
    mockKitchenTimers._set(kitchen([kitchenTimer()]));
    renderPage();
    await fireEvent.click(screen.getByTestId('cook-timer-chip-edit'));
    await waitFor(() => expect(screen.getByTestId('cook-timer-sheet-confirm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    expect(mockStartKitchenTimer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: STEP_2_TIMER_ID,
        origin: { batchId: BATCH_ID, stepId: 'step-2' },
      }),
    );
  });

  it('starts an ad-hoc one pinned to the batch and to no step', async () => {
    renderPage();
    await fireEvent.click(screen.getByTestId('batch-cook-timer-add'));
    await waitFor(() => expect(screen.getByTestId('cook-timer-sheet-confirm')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    expect(mockStartKitchenTimer).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Salt Timer',
        durationMinutes: 10,
        // Pinned to the batch so its push comes back here, and to no step so it
        // stays out of every step's inline slot.
        origin: { batchId: BATCH_ID, stepId: null },
      }),
    );
  });

  // An ad-hoc batch timer — pinned to the run, on no step. It belongs in the bar
  // and nowhere near a step's inline slot, which is what `stepId: null` inside a
  // non-null origin buys.
  it('keeps an ad-hoc batch timer in the bar and out of every step', async () => {
    mockKitchenTimers._set(
      kitchen([
        kitchenTimer({
          id: 'ad-hoc-1',
          label: 'Salt Timer',
          origin: { batchId: BATCH_ID, stepId: null },
        }),
      ]),
    );
    renderPage();
    await goToSteps();

    expect(screen.getByTestId('cook-timer-chip-label').textContent).toContain('Salt Timer');
    // Step 2's control is still unstarted: no timer claims it.
    expect(screen.getByTestId('cook-step-timer-start')).toBeTruthy();
  });

  it('falls back to the default name when the sheet’s name is emptied', async () => {
    renderPage();
    await fireEvent.click(screen.getByTestId('batch-cook-timer-add'));
    await waitFor(() => expect(screen.getByTestId('cook-timer-sheet-name')).toBeTruthy());
    await fireEvent.input(screen.getByTestId('cook-timer-sheet-name'), {
      target: { value: '  ' },
    });
    await fireEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    // A kitchen timer's label is required and has no step to fall back to, so an
    // emptied one falls back to what the sheet offered in the first place.
    expect(mockStartKitchenTimer).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Salt Timer' }),
    );
  });

  it('adjusts a step timer before starting it, through cook mode’s own sheet', async () => {
    renderPage();
    await goToSteps();
    await fireEvent.click(screen.getByTestId('cook-step-timer-adjust'));
    await waitFor(() => expect(screen.getByTestId('cook-timer-sheet-minutes')).toBeTruthy());

    // Prefilled from the LIVE step, which is what makes "reset to the recipe's
    // duration" a thing you already have.
    expect(screen.getByTestId('cook-timer-sheet-minutes')).toHaveValue('10');
    await fireEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    expect(mockStartKitchenTimer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: STEP_2_TIMER_ID,
        origin: { batchId: BATCH_ID, stepId: 'step-2' },
      }),
    );
  });

  // The other half of the clock rule, and the one a regression would break
  // silently: a step the schedule already times must never grow a second alarm.
  it('still offers NO timer on a step a stage is timing, even when the recipe has one', async () => {
    mockRecipes._set([
      recipeWith({
        steps: [
          { id: 'step-1', text: 'Mix the dough.', timer: null, note: null },
          { id: 'step-2', text: 'Knead for ten minutes.', timer: null, note: null },
          {
            id: 'step-3',
            text: 'Leave it somewhere warm.',
            // The recipe's own hour for the bulk rise — which stage `stage-bulk`
            // is already counting down to `plannedEndAt` for.
            timer: { durationMinutes: 60, description: null },
            note: null,
          },
        ],
      }),
    ]);
    renderPage();
    await goToSteps();

    expect(screen.queryByTestId('cook-step-timer-start')).toBeNull();
    // Shown as the recipe's opinion instead, never armed.
    expect(screen.getByTestId('batch-cook-step-timer').textContent).toContain('60 min');
    expect(screen.getByTestId('batch-cook-stage-countdown').textContent).toContain('30 min left');
  });

  // ─── …and a band is NOT a clock ─────────────────────────────────────────────
  //
  // The rule is "a wait stage is counting this step down", never "this step wears a
  // band". THE BAKE IS `active` (`STAGE_KIND_RULES`, pinned verbatim), an active
  // stage draws its planned window and no countdown, and `remindableStages` fires at
  // a stage's START. So a rule that read "any stage" would leave the one step where
  // burning is the failure mode with no clock and no alarm at all.
  it.each([
    [
      'an active stage — the bake',
      { id: 'stage-bake', label: 'Bake the cobs', kind: 'active' as const },
    ],
    [
      'an observational stage, which has no end to count to',
      { id: 'stage-cool-here', label: 'Cool the cobs', kind: 'wait' as const, duration: null },
    ],
  ])('offers a timer on a step carrying %s', async (_case, over) => {
    mockBatch._set(makeBatch({ stages: [stage({ ...over, until: null, stepId: 'step-3' })] }));
    mockRecipes._set([
      recipeWith({
        steps: [
          { id: 'step-1', text: 'Mix the dough.', timer: null, note: null },
          { id: 'step-2', text: 'Knead for ten minutes.', timer: null, note: null },
          {
            id: 'step-3',
            text: 'Bake until deep golden.',
            timer: { durationMinutes: 20, description: null },
            note: null,
          },
        ],
      }),
    ]);
    renderPage();
    await goToSteps();

    // The band is there and says its piece; what it does not do is tick.
    expect(screen.queryByTestId('batch-cook-stage-countdown')).toBeNull();
    expect(screen.getByTestId('cook-step-timer-start').textContent).toContain(
      'Start 20 minute timer',
    );
  });
});

describe('what this page does not do', () => {
  it('offers no Finish, at any point', async () => {
    // A batch ends when its stages do, on the batch page. For a cure the hands-on
    // part is one day of a weeks-long run.
    mockBatch._set(makeBatch({ completedStepIds: ['step-1', 'step-2', 'step-3'] }));
    renderPage();
    await goToSteps();

    expect(screen.queryByTestId('cook-mode-complete')).toBeNull();
    expect(screen.queryByText(/finish/i)).toBeNull();
    expect(screen.getByTestId('batch-cook-to-batch')).toBeTruthy();
  });

  it('shows the recipe-updated banner with no Restart', () => {
    mockRecipes._set([recipeWith({ updatedAt: '2026-09-11T08:00:00.000Z' })]);
    renderPage();

    expect(screen.getByTestId('cook-mode-recipe-changed')).toBeTruthy();
    expect(screen.queryByTestId('cook-mode-restart')).toBeNull();
  });

  it('shows no banner for a recipe last written before the run started', () => {
    renderPage();
    expect(screen.queryByTestId('cook-mode-recipe-changed')).toBeNull();
  });

  it('opens the observation sheet from the header, without leaving', async () => {
    renderPage();
    await fireEvent.click(screen.getByTestId('batch-cook-log'));

    await waitFor(() => expect(screen.getByTestId('batch-log-sheet')).toBeTruthy());
    expect(screen.getByTestId('batch-cook-page')).toBeTruthy();
  });
});
