import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { Formula, ProposeScheduleOutput } from '@salt/domain/schemas';

// "Out of the oven at 07:30" (issue #812, phase 2 of epic #778) — the review surface.
//
// The other half of `ScheduleAnchor`, and a different KIND of question from phase 1.
// A start time is arithmetic; a finish time is a request to RESTRUCTURE, so it is
// asked of a model, waited for honestly, and reviewed as a diff before anything is
// created. What this suite holds to:
//
//   • the wait is visible and truthful — this call runs past a minute and the sheet
//     says so, rather than blinking a button spinner;
//   • the answer renders as a DIFF, not a form, and #778's restructure reads as a
//     removal plus two additions because that is honestly what it is;
//   • the leavening opinion is the model's WORDS beside the DOMAIN's number —
//     percentage and grams both computed here, never authored there — and an absurd
//     factor is refused rather than displayed;
//   • declining to restructure is a real answer and reads as one;
//   • accepting freezes the restructured schedule, back-solved to the minute asked
//     for; declining creates nothing at all.

const { mockStartBatch, mockProposeSchedule, mockAddToast } = vi.hoisted(() => ({
  mockStartBatch: vi.fn(),
  mockProposeSchedule: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockAddToast }));
vi.mock('../src/lib/batchService.js', () => ({
  startBatch: mockStartBatch,
  proposeSchedule: mockProposeSchedule,
}));

import { push } from 'svelte-spa-router';
import RecipeBakeBatchSheet from '../src/routes/recipes/RecipeBakeBatchSheet.svelte';

const RECIPE_ID = 'recipe-1';

function ingredient(id: string, rawText: string) {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

const RECIPE = {
  id: RECIPE_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Overnight white tin',
  description: null,
  ingredients: [
    {
      id: 'grp-1',
      name: null,
      items: [
        ingredient('ing-flour', '500 g strong white flour'),
        ingredient('ing-water', '350 g water'),
        ingredient('ing-salt', '10 g salt'),
        ingredient('ing-yeast', '7 g instant yeast'),
        ingredient('ing-oil', '15 g olive oil'),
      ],
    },
  ],
  steps: [{ id: 'step-1', text: 'Mix.', timer: null, note: null }],
  metadata: {
    servings: null,
    tags: [],
  },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

// The REFERENCE process — the loaf as the formula holds it, ninety counter minutes
// and all. Nothing in this suite ever writes to it.
const FORMULA: Formula = {
  recipeId: RECIPE_ID,
  schemaVersion: 1,
  components: [
    { ingredientId: 'ing-flour', percent: 100, inBasis: true },
    { ingredientId: 'ing-water', percent: 70, inBasis: false },
    { ingredientId: 'ing-salt', percent: 2, inBasis: false },
    { ingredientId: 'ing-yeast', percent: 1.4, inBasis: false },
    { ingredientId: 'ing-oil', percent: 3, inBasis: false },
  ],
  referenceYield: {
    kind: 'target',
    shape: { count: 12, unitDoughGrams: 120 },
  },
  process: [
    {
      id: 'st-mix',
      label: 'Mix',
      kind: 'active',
      environment: null,
      duration: { kind: 'fixed', minutes: 10 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
    {
      id: 'st-bulk',
      label: 'Bulk ferment',
      kind: 'wait',
      environment: { celsius: 20 },
      duration: { kind: 'fixed', minutes: 90 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
    {
      id: 'st-bake',
      label: 'Bake',
      kind: 'active',
      environment: { celsius: 230 },
      duration: { kind: 'fixed', minutes: 35 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
  ],
} as Formula;

// #778's worked restructure: the ninety-minute bulk becomes twenty on the counter
// and eight hours in the fridge, and the leavening comes down to suit.
const RESTRUCTURE: ProposeScheduleOutput = {
  stages: [
    {
      sourceStageId: 'st-mix',
      label: 'Mix',
      kind: 'active',
      environment: null,
      duration: { kind: 'fixed', minutes: 10 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
    {
      sourceStageId: 'st-bulk',
      label: 'Bulk ferment, counter',
      kind: 'wait',
      environment: { celsius: 20 },
      duration: { kind: 'fixed', minutes: 20 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
    {
      sourceStageId: 'st-bulk',
      label: 'Cold retard',
      kind: 'wait',
      environment: { celsius: 4 },
      duration: { kind: 'fixed', minutes: 480 },
      until: null,
      stepId: null,
      optional: false,
    },
    {
      sourceStageId: 'st-bake',
      label: 'Bake',
      kind: 'active',
      environment: { celsius: 230 },
      duration: { kind: 'fixed', minutes: 35 },
      until: null,
      stepId: 'step-1',
      optional: false,
    },
  ],
  rationale: 'Twenty minutes on the counter, then overnight in the fridge, so you sleep.',
  adjustment: {
    ingredientId: 'ing-yeast',
    factor: 0.5,
    reason: "Longer and colder, so I'd take the yeast down to half.",
  },
};

// The model declining to restructure: it read the method, looked at the time and
// said the process already lands there. A valid answer, and the restraint matters.
const NO_CHANGE: ProposeScheduleOutput = {
  stages: (FORMULA.process ?? []).map((stage) => ({
    sourceStageId: stage.id,
    label: stage.label,
    kind: stage.kind,
    environment: stage.environment,
    duration: stage.duration,
    until: stage.until,
    stepId: stage.stepId,
    optional: stage.optional,
  })),
  rationale: 'It already finishes when you asked — nothing needed moving.',
  adjustment: null,
};

const TARGET_LOCAL = '2026-08-15T07:30';
const NOW = new Date('2026-08-14T07:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mockStartBatch.mockResolvedValue({ kind: 'ok', value: { id: 'batch-9' } });
  mockProposeSchedule.mockResolvedValue({ kind: 'ok', value: RESTRUCTURE });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

function renderSheet(formula: Formula = FORMULA) {
  return render(RecipeBakeBatchSheet, { props: { recipe: RECIPE, formula, open: true } });
}

/** Switch to "Out of the oven at…" and say when. */
async function askFor(target = TARGET_LOCAL): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
  await fireEvent.click(screen.getByRole('radio', { name: /Out of the oven/ }));
  await fireEvent.input(screen.getByTestId('bake-batch-when'), { target: { value: target } });
  await waitFor(() => expect(screen.getByTestId('bake-batch-propose')).toBeInTheDocument());
}

async function proposeAndSettle(): Promise<void> {
  await askFor();
  await fireEvent.click(screen.getByTestId('bake-batch-propose'));
  await waitFor(() => expect(screen.getByTestId('bake-batch-proposal')).toBeInTheDocument());
}

function rowsOfKind(kind: string): string[] {
  return screen
    .queryAllByTestId('bake-batch-diff-row')
    .filter((el) => el.getAttribute('data-diff-kind') === kind)
    .map((el) => el.textContent?.trim() ?? '');
}

describe('RecipeBakeBatchSheet — asking for a finish time', () => {
  it('offers the other half of the anchor, and asks nothing until you ask', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());

    // Phase 1's Start is what an unanswered sheet offers; a finish time is opt-in.
    expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('radio', { name: /Out of the oven/ }));

    await waitFor(() => expect(screen.getByTestId('bake-batch-propose')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-confirm')).toBeNull();
    expect(mockProposeSchedule).not.toHaveBeenCalled();
  });

  it('sends the wall clock the wire wants, and no quiet hours it was never told', async () => {
    // A local `YYYY-MM-DDTHH:mm`, never an ISO instant: the model reasons in "half
    // seven on Saturday" and the instant stays on this side for `resolveSchedule`.
    // Quiet hours default to 23:00–06:00 in the flow, and there is no settings
    // surface for them — sending nothing sends the truth.
    renderSheet();
    await askFor();

    await fireEvent.click(screen.getByTestId('bake-batch-propose'));

    await waitFor(() => expect(mockProposeSchedule).toHaveBeenCalledTimes(1));
    expect(mockProposeSchedule).toHaveBeenCalledWith({
      recipeId: RECIPE_ID,
      targetEndAtLocal: TARGET_LOCAL,
    });
  });

  it('shows a real waiting state, because this call legitimately runs past a minute', async () => {
    let settle: (value: unknown) => void = () => {};
    mockProposeSchedule.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    renderSheet();
    await askFor();

    await fireEvent.click(screen.getByTestId('bake-batch-propose'));

    // A panel with honest copy, not a fake percentage of progress nobody can measure.
    await waitFor(() => expect(screen.getByTestId('bake-batch-proposing')).toBeInTheDocument());
    expect(screen.getByTestId('bake-batch-proposing')).toHaveTextContent(
      'Nothing is started until you',
    );
    expect(screen.getByTestId('bake-batch-propose')).toBeDisabled();

    settle({ kind: 'ok', value: RESTRUCTURE });

    await waitFor(() => expect(screen.queryByTestId('bake-batch-proposing')).toBeNull());
  });

  it('says so in friendly words when the call cannot be made', async () => {
    // NetworkError is deliberately not reported to PostHog (§7.6); what it earns
    // here is a sentence and a retry.
    mockProposeSchedule.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    renderSheet();
    await askFor();

    await fireEvent.click(screen.getByTestId('bake-batch-propose'));

    await waitFor(() => expect(screen.getByTestId('bake-batch-propose-error')).toBeInTheDocument());
    expect(screen.getByTestId('bake-batch-propose-error')).toHaveTextContent('try again');
    expect(mockStartBatch).not.toHaveBeenCalled();
  });

  it('retires a proposal the moment the question changes', async () => {
    // A proposal is an answer to ONE ask. Leaving it on screen beside a target
    // nobody asked for would be a diff describing a schedule that was never planned.
    renderSheet();
    await proposeAndSettle();

    await fireEvent.input(screen.getByTestId('bake-batch-when'), {
      target: { value: '2026-08-15T09:00' },
    });

    await waitFor(() => expect(screen.queryByTestId('bake-batch-proposal')).toBeNull());
    expect(screen.getByTestId('bake-batch-propose')).toBeInTheDocument();
  });
});

describe('RecipeBakeBatchSheet — the proposal reads as a diff', () => {
  it('renders the restructure as a removal plus two additions, with what each was', async () => {
    renderSheet();
    await proposeAndSettle();

    expect(screen.getByTestId('bake-batch-rationale')).toHaveTextContent('so you sleep');
    // The ninety-minute bulk is genuinely gone; there is no honest way to say which
    // half inherited it, so nothing pretends one did.
    expect(rowsOfKind('removed')).toEqual(['Bulk ferment — 1 hr 30 min · 20 °C']);
    expect(rowsOfKind('added')).toEqual([
      'Bulk ferment, counter — 20 min · 20 °C',
      'Cold retard — 8 hr · 4 °C',
    ]);
    // Mix and Bake were untouched and say nothing, which is what keeps the two rows
    // that matter readable.
    expect(rowsOfKind('changed')).toEqual([]);
  });

  it('renders a proposal that changes nothing as a calm answer, not an empty state', async () => {
    mockProposeSchedule.mockResolvedValue({ kind: 'ok', value: NO_CHANGE });
    renderSheet();
    await proposeAndSettle();

    expect(screen.getByTestId('bake-batch-no-changes')).toHaveTextContent(
      'already land where you asked',
    );
    expect(screen.getByTestId('bake-batch-rationale')).toHaveTextContent('nothing needed moving');
    expect(screen.queryAllByTestId('bake-batch-diff-row')).toHaveLength(0);
    // And it is still startable — declining to restructure is a result, not a refusal.
    expect(screen.getByTestId('bake-batch-confirm')).toBeEnabled();
  });
});

describe('RecipeBakeBatchSheet — the leavening is words plus a number domain computed', () => {
  it('shows the reason it gave and the figures the domain worked out', async () => {
    renderSheet();
    await proposeAndSettle();

    expect(screen.getByTestId('bake-batch-leavening')).toHaveTextContent(
      "Longer and colder, so I'd take the yeast down to half.",
    );
    // 1.4% halved is 0.7% through `roundPercent`, and 0.7% of 816 g of flour is
    // 5.7 g through the same `solveFormula` rounding every other weight on the sheet
    // gets — a tenth of a gram, because at that size a whole gram is 17% of the
    // yeast. Nothing in this string came off the wire.
    expect(screen.getByTestId('bake-batch-leavening-figure')).toHaveTextContent(
      '1.4% → 0.7%, 11 g → 5.7 g',
    );
  });

  it('moves the preview with it, so what is on screen is what the freeze will do', async () => {
    renderSheet();
    await proposeAndSettle();

    const yeast = screen
      .getAllByTestId('bake-batch-preview-row')
      .find((row) => row.getAttribute('data-ingredient-id') === 'ing-yeast');
    expect(yeast).toHaveTextContent('5.7 g');
  });

  it('refuses an absurd factor instead of displaying it, and keeps the schedule', async () => {
    // The rail is `solveFormula`'s, declared by `withComponentPercentScaled` —
    // 1.4% × 40 is 56% of the flour, which is a bready panic, not an opinion.
    mockProposeSchedule.mockResolvedValue({
      kind: 'ok',
      value: { ...RESTRUCTURE, adjustment: { ...RESTRUCTURE.adjustment!, factor: 40 } },
    });
    renderSheet();
    await proposeAndSettle();

    expect(screen.queryByTestId('bake-batch-leavening')).toBeNull();
    expect(screen.getByTestId('bake-batch-leavening-refused')).toHaveTextContent('0.2%–2.5%');
    // The restructure is untouched by it — an opinion that cannot be honoured is
    // dropped, never fatal.
    expect(rowsOfKind('added')).toHaveLength(2);
    const yeast = screen
      .getAllByTestId('bake-batch-preview-row')
      .find((row) => row.getAttribute('data-ingredient-id') === 'ing-yeast');
    expect(yeast).toHaveTextContent('11 g');
  });
});

describe('RecipeBakeBatchSheet — accepting and declining', () => {
  it('freezes the restructured process, back-solved from the minute asked for', async () => {
    renderSheet();
    await proposeAndSettle();

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    // `endAt`: the last stage ENDS on the anchor, by construction, however many
    // stages precede it.
    expect(input.anchor).toEqual({
      kind: 'endAt',
      at: new Date(TARGET_LOCAL).toISOString(),
    });
    // Content only and id-less — `batchService` is the sole id-minter.
    expect(input.proposedStages).toEqual(RESTRUCTURE.stages);
    expect(input.rationale).toBe(RESTRUCTURE.rationale);
    // The adjusted formula, not the stored one: the opinion is applied on the way to
    // the freeze and never written back to `formulas/{recipeId}`.
    expect(
      input.formula.components.find(
        (c: { ingredientId: string }) => c.ingredientId === 'ing-yeast',
      ),
    ).toEqual({
      ingredientId: 'ing-yeast',
      percent: 0.7,
      inBasis: false,
      minPercent: 0.2,
      maxPercent: 2.5,
    });
    expect(FORMULA.components.find((c) => c.ingredientId === 'ing-yeast')?.percent).toBe(1.4);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/batches/batch-9'));
  });

  it('creates nothing at all when the proposal is declined', async () => {
    renderSheet();
    await proposeAndSettle();

    await fireEvent.click(screen.getByTestId('bake-batch-decline'));

    // Back to the ask, exactly as phase 1 left it: no batch, no navigation, no
    // write, and the yeast back where the formula has it.
    await waitFor(() => expect(screen.queryByTestId('bake-batch-proposal')).toBeNull());
    expect(mockStartBatch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('bake-batch-propose')).toBeInTheDocument();
    const yeast = screen
      .getAllByTestId('bake-batch-preview-row')
      .find((row) => row.getAttribute('data-ingredient-id') === 'ing-yeast');
    expect(yeast).toHaveTextContent('11 g');
  });

  it('renders the bound refusal in the service words when the freeze declines', async () => {
    // Now reachable by a route a user can take, so it says which window was missed
    // rather than "(boundViolation)".
    mockStartBatch.mockResolvedValue({
      kind: 'err',
      error: {
        kind: 'ValidationError',
        code: 'BATCH_NOT_STARTABLE',
        message:
          'That would put “7 g instant yeast” at 56% of the basis, outside the 0.2%–2.5% window it has to sit in. Ask for a different time, or set the percentages yourself on the formula screen.',
      },
    });
    renderSheet();
    await proposeAndSettle();

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(screen.getByTestId('bake-batch-error')).toBeInTheDocument());
    expect(screen.getByTestId('bake-batch-error')).toHaveTextContent(
      'outside the 0.2%–2.5% window it has to sit in',
    );
    expect(push).not.toHaveBeenCalled();
  });
});
