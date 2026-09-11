import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyRecipe } from '@salt/domain';
import type {
  BatchDoc,
  BatchObservationDoc,
  BatchStageDoc,
  IngredientDoc,
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
//   • there is NO FINISH, and nothing here ends the run.

const { mockBatch, mockObservations, mockRecipes, mockBreadGate, mockWakeLock } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockBatch: makeStore<BatchDoc | null | undefined>(undefined),
      mockObservations: makeStore<BatchObservationDoc[] | undefined>([]),
      mockRecipes: makeStore<RecipeDoc[]>([]),
      mockBreadGate: makeStore<{ enabled: boolean; settled: boolean }>({
        enabled: true,
        settled: true,
      }),
      mockWakeLock: { enable: vi.fn(async () => true), disable: vi.fn(async () => {}) },
    };
  },
);

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
  isLoadingRecipes: { subscribe: (f: (v: boolean) => void) => (f(false), () => {}) },
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
  advanceStage: vi.fn(async (current: BatchDoc) => ({ kind: 'ok' as const, value: current })),
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
vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: mockBreadGate,
  featureGate: () => mockBreadGate,
  isFeatureEnabled: () => true,
}));

import BatchCookPage from '../src/routes/batches/BatchCookPage.svelte';
import { advanceStage, setIngredientChecked, setStepDone } from '../src/lib/batchService.js';
import { addToast } from '../src/lib/toastStore.js';

const advanceMock = vi.mocked(advanceStage);
const checkMock = vi.mocked(setIngredientChecked);
const stepMock = vi.mocked(setStepDone);
const toastMock = vi.mocked(addToast);

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
  mockBreadGate._set({ enabled: true, settled: true });
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

  it('shows the recipe’s own timer as words, and arms nothing', async () => {
    // Phase 1 ships with the schedule's clock only (decision 9). A press-to-start
    // control on a non-stage step is Phase 2's, in a home that is not a cook session.
    renderPage();
    await goToSteps();
    expect(screen.getByTestId('batch-cook-step-timer').textContent).toContain('10 min');
    expect(screen.queryByTestId('cook-step-timer')).toBeNull();
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
    // The advance is handed the document the TICK returned, not the stale one.
    const advancedWith = advanceMock.mock.calls.at(-1)!;
    expect(advancedWith[1]).toBe('stage-bulk');
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
