import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// The scale sheet (issue #812, phase 1 of epic #778) — "Bake a batch".
//
// This is the ONE place a scaled quantity appears before a batch exists
// (docs/formulas-schedules-batches.md: the recipe never shows scaled numbers), so
// the bar it has to clear is high:
//
//   • the preview is #778's worked example to the gram — twelve 120 g rolls off the
//     overnight tin gives 816 g flour, 571 g water, 16 g salt, 11 g yeast, 24 g
//     olive oil, 1 440 g in the bowl. #1274 deleted the handling allowance and the
//     baked-weight figure that used to sit beside these — the dough total IS the
//     bowl figure now, always;
//   • it is the SAME arithmetic the freeze will do, so what is on screen is what
//     lands on the document;
//   • it writes nothing — not to the recipe, not to the formula. Closing it leaves
//     the weekly loaf a weekly loaf;
//   • a run that cannot be started says why, in the words the service chose, and
//     stays put instead of navigating.

const { mockStartBatch, mockProposeSchedule, mockAddToast } = vi.hoisted(() => ({
  mockStartBatch: vi.fn(),
  mockProposeSchedule: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockAddToast }));
// The sheet also reads the batches store (for the kitchen-temperature prefill) and
// the equipment store (for the place pickers) since #1286. Both are stubbed empty
// here: this suite is about the scale and the schedule, and the two new questions
// have their own file.
vi.mock('../src/lib/batchService.js', () => ({
  startBatch: mockStartBatch,
  proposeSchedule: mockProposeSchedule,
  batches: readable(undefined),
  initBatchesSync: vi.fn(() => vi.fn()),
}));
vi.mock('../src/lib/equipmentService.js', () => ({ equipment: readable(null) }));

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

// The overnight white tin as Salt holds it, plus the olive oil the worked example
// carries. The recipe's OWN quantities — nothing here is ever scaled.
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

// Reference yield: twelve 120 g rolls. count > 1 comes back as the "pieces"
// answer (`seedDoughAnswer`), so the sheet opens already saying what the last
// person declared.
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
} as Formula;

// A fixed "now" so the seeded start time is assertable without depending on when
// the suite runs. Only Date is faked — real timers keep Testing Library honest.
const NOW = new Date('2026-08-14T07:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  mockStartBatch.mockResolvedValue({ kind: 'ok', value: { id: 'batch-9' } });
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

function previewGrams(): string[] {
  return screen
    .queryAllByTestId('bake-batch-preview-grams')
    .map((el) => el.textContent?.trim() ?? '');
}

describe('RecipeBakeBatchSheet — what twelve rolls weigh out to', () => {
  it('opens on the formula reference yield, so the common answer is already typed', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    // count > 1 comes back as the "pieces" answer — a run of twelve is rolls, not
    // twelve tins.
    expect(screen.getByTestId('bake-batch-pieces')).toBeTruthy();
    expect(screen.getByTestId('bake-batch-piece-count')).toHaveValue('12');
    expect(screen.getByTestId('bake-batch-piece-grams')).toHaveValue('120');
  });

  it('previews #778 worked example to the gram', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    expect(previewGrams()).toEqual(['816 g', '571 g', '16 g', '11 g', '24 g']);
    expect(screen.getByTestId('bake-batch-preview')).toHaveTextContent('500 g strong white flour');
  });

  it('says the total in the bowl and what the dough divides into', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-totals')).toBeInTheDocument());
    // No handling allowance since #1274: what's in the bowl IS what the dough
    // divides into.
    expect(screen.getByTestId('bake-batch-total-grams')).toHaveTextContent('1440 g');
    expect(screen.getByTestId('bake-batch-yield')).toHaveTextContent(
      '12 × 120 g — 1.4 kg of dough',
    );
  });

  it('re-solves the moment the count changes', async () => {
    // Scaling is exact, instant and offline: one function, no round trip, no model.
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());

    await fireEvent.input(screen.getByTestId('bake-batch-piece-count'), { target: { value: '6' } });

    // Half the dough, half of every component. 720 g usable, and — with no
    // handling allowance — 720 g total too.
    await waitFor(() => expect(previewGrams()[0]).toBe('408 g'));
    expect(screen.getByTestId('bake-batch-total-grams')).toHaveTextContent('720 g');
  });

  it('seeds from a declared amount that is not one of the tin chips, and re-scales it', async () => {
    // A formula's declared amount is a bare number, never a preset name — the
    // sheet must seed and re-scale it whether or not it matches a quick-fill chip.
    const boule = { count: 2, unitDoughGrams: 1000 };
    renderSheet({ ...FORMULA, referenceYield: { kind: 'target', shape: boule } } as Formula);
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());

    expect(screen.getByTestId('bake-batch-pieces')).toBeTruthy();
    expect(screen.getByTestId('bake-batch-piece-count')).toHaveValue('2');
    expect(screen.getByTestId('bake-batch-piece-grams')).toHaveValue('1000');

    await fireEvent.input(screen.getByTestId('bake-batch-piece-count'), { target: { value: '4' } });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    expect(mockStartBatch.mock.calls[0]![0].atYield).toEqual({
      kind: 'target',
      shape: { count: 4, unitDoughGrams: 1000 },
    });
  });

  // ─── The bake sheet passes NO anchor (issue #1325) ───────────────────────────
  //
  // The formula screen learnt to divide: a count with a blank per-unit weight box
  // shares out the dough already there. This screen deliberately did not, and the
  // reason is principled rather than scoping — a null amount HERE already means
  // "the formula's own reference yield", which `startBatch` implements by omitting
  // `atYield` entirely. Dividing would silently change what Start Bake does.
  //
  // 12 × 120 g is 1 440 g of dough, so a screen that had quietly gained the anchor
  // would resolve a blank weight box to 120 g again and this test would still see
  // an `atYield`. Asserting the key is ABSENT is what makes the difference visible.
  it('takes a blank per-piece weight as no amount at all, and never divides', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-pieces')).toBeInTheDocument());

    await fireEvent.input(screen.getByTestId('bake-batch-piece-grams'), { target: { value: '' } });
    await fireEvent.input(screen.getByTestId('bake-batch-piece-count'), { target: { value: '6' } });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    // No `atYield` — the formula's own 12 × 120 g stands. Not six of anything, and
    // certainly not six of 240 g.
    expect('atYield' in mockStartBatch.mock.calls[0]![0]).toBe(false);
  });

  it('falls back to the formula as written when the count is not a count', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());

    await fireEvent.input(screen.getByTestId('bake-batch-piece-count'), { target: { value: '' } });

    // No shape means the formula's own reference yield — the same twelve rolls, not
    // an invented one and not an error.
    await waitFor(() => expect(previewGrams()[0]).toBe('816 g'));
  });
});

describe('RecipeBakeBatchSheet — starting the run', () => {
  it('freezes at the yield asked for, anchored forward from the start chosen', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument());

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    expect(input.recipe).toBe(RECIPE);
    expect(input.formula).toBe(FORMULA);
    expect(input.atYield).toEqual({
      kind: 'target',
      shape: { count: 12, unitDoughGrams: 120 },
    });
    // The sheet opens on `startAt`: you say when you are mixing and everything is
    // timed forward from it, by arithmetic, with no model anywhere near it. The
    // other half of the anchor is opt-in and is covered in the phase-2 suite.
    expect(input.anchor.kind).toBe('startAt');
    expect(mockProposeSchedule).not.toHaveBeenCalled();
    // Seeded from now, to the minute the picker offers.
    expect(Math.abs(Date.parse(input.anchor.at) - NOW.getTime())).toBeLessThan(60_000);
  });

  it('opens the run it just started', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument());

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/batches/batch-9'));
    expect(mockAddToast).toHaveBeenCalledWith('Batch started.', 'success');
  });

  it('renders why a run could not be started, and stays where it is', async () => {
    // BATCH_NOT_STARTABLE carries a sentence that says what to do next, so it is
    // shown on the sheet rather than thrown at a toast that vanishes — and it is
    // deliberately never reported to PostHog.
    mockStartBatch.mockResolvedValue({
      kind: 'err',
      error: {
        kind: 'ValidationError',
        code: 'BATCH_NOT_STARTABLE',
        message:
          'This recipe has no stages yet, so there is nothing to schedule. Add its process on the formula screen first.',
      },
    });
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument());

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(screen.getByTestId('bake-batch-error')).toBeInTheDocument());
    expect(screen.getByTestId('bake-batch-error')).toHaveTextContent(
      'Add its process on the formula screen first.',
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument();
  });

  it('will not start a formula that does not resolve into weights', async () => {
    renderSheet({ ...FORMULA, components: [] } as Formula);
    await waitFor(() => expect(screen.getByTestId('bake-batch-unsolvable')).toBeInTheDocument());

    expect(screen.queryByTestId('bake-batch-preview')).toBeNull();
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
  });
});

// ─── The unit-count derivation (issue #1055 characterisation) ──────────────────
// `FormulaPage` and `RecipeBakeBatchSheet` each derive `count` from their own
// count box with a byte-identical three-line body:
//
//   const value = Number(countText.trim());
//   return Number.isInteger(value) && value > 0 ? value : null;
//
// Both surfaces were covered for `''` and nothing else, so the integer test in
// particular was held by nothing. The table below is shared by the two suites —
// same inputs, same verdict — which is the machine-checked form of the claim
// that one of the two copies can be deleted.
//
// The integer test is not decoration: `DoughAmountSchema.count` is
// `z.number().int().positive()`, so a fractional count would build a document the
// schema refuses. That is why this parser is stricter than the page's own grams
// parser, which takes `2.5` happily.
const UNIT_COUNT_INPUTS: readonly {
  readonly label: string;
  readonly text: string;
  readonly value: number | null;
}[] = [
  { label: 'an empty box', text: '', value: null },
  { label: 'zero', text: '0', value: null },
  { label: 'a negative number', text: '-1', value: null },
  { label: 'a fraction of a loaf', text: '2.5', value: null },
  { label: 'letters', text: 'abc', value: null },
  { label: 'a whole number of loaves', text: '3', value: 3 },
];

describe('RecipeBakeBatchSheet — what counts as a count', () => {
  it.each(UNIT_COUNT_INPUTS)('takes $label ($text) as $value', async ({ text, value }) => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());

    await fireEvent.input(screen.getByTestId('bake-batch-piece-count'), {
      target: { value: text },
    });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    // No count means no shape, and no shape means the key is left OFF the input
    // entirely — `startBatch` then uses the formula's own reference yield.
    // Omitted, never invented, and never a null the schema would have to allow.
    expect('atYield' in input).toBe(value !== null);
    if (value !== null) {
      expect(input.atYield).toEqual({
        kind: 'target',
        shape: { count: value, unitDoughGrams: 120 },
      });
    }
  });
});

// ─── "What are you filling?" (issue #1274) ─────────────────────────────────────
//
// The three answers, and the one rule that separates them: THE TIN NAMES A VESSEL
// ON THE RUN AND THE OTHER TWO DO NOT. A vessel is a note on a finished record —
// "what did I bake it in last time?" — so inventing one for an answer that named
// none would be recording a fact nobody stated.
describe('RecipeBakeBatchSheet — what are you filling?', () => {
  async function pickAnswer(label: string): Promise<void> {
    const option = screen.getAllByRole('radio').find((el) => el.textContent?.includes(label));
    if (option === undefined) throw new Error(`no answer labelled ${label}`);
    await fireEvent.click(option);
  }

  it('fills the tin size from a quick-fill chip, and scales to it', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickAnswer('A loaf tin');

    const chip = screen
      .getAllByTestId('bake-batch-tin-chip')
      .find((el) => el.getAttribute('data-tin-grams') === '900');
    if (chip === undefined) throw new Error('no 900 g chip');
    await fireEvent.click(chip);
    await fireEvent.input(screen.getByTestId('bake-batch-tin-count'), { target: { value: '2' } });

    // A UK tin is sold by the dough it takes, so 900 g of tin is 900 g of dough
    // with no coefficient in between.
    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-yield')).toHaveTextContent(
        '2 × 900 g — 1.8 kg of dough',
      ),
    );
    expect(screen.getByTestId('bake-batch-total-grams')).toHaveTextContent('1800 g');
  });

  it('records the tin on the run, naming the vessel and not how many of them', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickAnswer('A loaf tin');
    await fireEvent.input(screen.getByTestId('bake-batch-tin-grams'), { target: { value: '900' } });
    await fireEvent.input(screen.getByTestId('bake-batch-tin-count'), { target: { value: '2' } });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    expect(input.atYield).toEqual({ kind: 'target', shape: { count: 2, unitDoughGrams: 900 } });
    // Singular, and carrying no count: how many is already on the batch at
    // `totals.units.count`, and a second copy is the drift a snapshot must avoid.
    expect(input.vessel).toBe('900 g loaf tin');
  });

  it('names no vessel when the sheet was only shown an answer, never given one', async () => {
    // THE SEEDED DEFAULT, which is the path most runs take and the one the three
    // tests around it miss by picking an answer first. `seedDoughAnswer` leads with
    // the tin for a one-unit formula, so a focaccia declaring 1 × 1400 g of dough
    // opens on "A loaf tin, 1400 g" with nothing touched. Recording a vessel from
    // that would be exactly the invented fact this describe block forbids, and it
    // would falsify `BatchSchema.vessel`'s "as the person starting it described it".
    renderSheet({
      ...FORMULA,
      referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 1400 } },
    } as Formula);
    await waitFor(() => expect(screen.getByTestId('bake-batch-tin')).toBeInTheDocument());
    // The tin boxes really are filled in — the point is that nobody filled them.
    expect(screen.getByTestId('bake-batch-tin-grams')).toHaveValue('1400');

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    expect('vessel' in mockStartBatch.mock.calls[0]![0]).toBe(false);
  });

  it('records the tin once the seeded answer is confirmed by touching it', async () => {
    // The other side of the flag: the seed is not an answer, but re-typing the
    // figure it offered is. Otherwise a genuine 900 g tin could never be recorded
    // without changing a number the person agrees with.
    renderSheet({
      ...FORMULA,
      referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
    } as Formula);
    await waitFor(() => expect(screen.getByTestId('bake-batch-tin')).toBeInTheDocument());

    const chip = screen
      .getAllByTestId('bake-batch-tin-chip')
      .find((el) => el.getAttribute('data-tin-grams') === '900');
    if (chip === undefined) throw new Error('no 900 g chip');
    await fireEvent.click(chip);
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    expect(mockStartBatch.mock.calls[0]![0].vessel).toBe('900 g loaf tin');
  });

  it('takes a plain weight of dough as one of itself, and names no vessel', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickAnswer('A weight of dough');
    await fireEvent.input(screen.getByTestId('bake-batch-total-dough'), {
      target: { value: '1400' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-yield')).toHaveTextContent('1.4 kg of dough'),
    );
    // "1 × 1400 g — 1.4 kg" would say the same thing twice.
    expect(screen.getByTestId('bake-batch-yield')).not.toHaveTextContent('1 ×');

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));
    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    expect(input.atYield).toEqual({ kind: 'target', shape: { count: 1, unitDoughGrams: 1400 } });
    // Absent, not empty: the key is left OFF, so the document simply has none.
    expect('vessel' in input).toBe(false);
  });

  it('names no vessel for a count of pieces either', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-pieces')).toBeInTheDocument());
    await fireEvent.input(screen.getByTestId('bake-batch-piece-grams'), {
      target: { value: '150' },
    });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    expect('vessel' in mockStartBatch.mock.calls[0]![0]).toBe(false);
  });

  it('offers no picker of named shapes and no bake loss, on any answer', async () => {
    const { container } = renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    for (const label of ['A loaf tin', 'A number of pieces', 'A weight of dough']) {
      await pickAnswer(label);
      expect(container.textContent).not.toMatch(/bake loss/i);
      expect(container.textContent).not.toMatch(/once baked/i);
      expect(container.textContent).not.toMatch(/stays in it/i);
      expect(screen.queryByTestId('bake-batch-shape')).toBeNull();
    }
  });
});

// ─── A tray or dish (issue #1274, phase 2) ─────────────────────────────────────
//
// The one answer that needs an estimate, and the two rules that keep the estimate
// harmless: it lands in an ORDINARY EDITABLE BOX (never a locked figure), and the
// DESCRIPTOR NAMES THE VESSEL rather than the number — so typing over the
// suggestion changes what the bake weighs and not what it was baked in.
describe('RecipeBakeBatchSheet — a tray or dish', () => {
  async function pickTray(): Promise<void> {
    const option = screen
      .getAllByRole('radio')
      .find((el) => el.textContent?.includes('A tray or dish'));
    if (option === undefined) throw new Error('no tray answer');
    await fireEvent.click(option);
  }

  it('suggests a weight for a measured tray, into a box that can be typed over', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickTray();

    await fireEvent.input(screen.getByTestId('bake-batch-tray-length'), {
      target: { value: '30' },
    });
    await fireEvent.input(screen.getByTestId('bake-batch-tray-width'), { target: { value: '40' } });
    await fireEvent.click(screen.getByTestId('bake-batch-tray-suggest'));

    // ~0.45 g per ml over 30 × 40 × 2 cm. A domestic starting point, not a fact —
    // and the screen says so.
    await waitFor(() => expect(screen.getByTestId('bake-batch-tray-grams')).toHaveValue('1080'));
    expect(screen.getByTestId('bake-batch-tray-note')).toHaveTextContent('starting point');

    // The box is ordinary: no readonly, no disabled, and typing wins.
    const box = screen.getByTestId('bake-batch-tray-grams');
    expect(box.hasAttribute('readonly')).toBe(false);
    expect(box.hasAttribute('disabled')).toBe(false);
    await fireEvent.input(box, { target: { value: '950' } });
    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-yield')).toHaveTextContent('950 g of dough'),
    );
  });

  it('records the tray even when the suggested weight was typed over', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickTray();

    await fireEvent.input(screen.getByTestId('bake-batch-tray-length'), {
      target: { value: '30' },
    });
    await fireEvent.input(screen.getByTestId('bake-batch-tray-width'), { target: { value: '40' } });
    await fireEvent.click(screen.getByTestId('bake-batch-tray-suggest'));
    await fireEvent.input(screen.getByTestId('bake-batch-tray-grams'), {
      target: { value: '950' },
    });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    // The DESCRIPTOR names the vessel; the WEIGHT is what was typed. They answer
    // different questions and neither overrules the other.
    expect(input.vessel).toBe('30 × 40 cm tray');
    expect(input.atYield).toEqual({ kind: 'target', shape: { count: 1, unitDoughGrams: 950 } });
  });

  it('takes a dish by volume, and names it that way', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickTray();

    const byVolume = screen
      .getAllByRole('radio')
      .find((el) => el.textContent?.includes('A volume'));
    if (byVolume === undefined) throw new Error('no volume option');
    await fireEvent.click(byVolume);
    await fireEvent.input(screen.getByTestId('bake-batch-tray-volume'), {
      target: { value: '2000' },
    });
    await fireEvent.click(screen.getByTestId('bake-batch-tray-suggest'));

    // A 2 litre dish takes about 900 g of dough.
    await waitFor(() => expect(screen.getByTestId('bake-batch-tray-grams')).toHaveValue('900'));

    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));
    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    expect(mockStartBatch.mock.calls[0]![0].vessel).toBe('2000 ml dish');
  });

  it('cannot be started on a measurement alone — the grams box is what scales it', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickTray();
    await fireEvent.input(screen.getByTestId('bake-batch-tray-length'), {
      target: { value: '30' },
    });
    await fireEvent.input(screen.getByTestId('bake-batch-tray-width'), { target: { value: '40' } });
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    // No amount resolves, so `atYield` is omitted and the formula's own reference
    // yield stands — the coefficient never silently becomes the answer.
    expect('atYield' in mockStartBatch.mock.calls[0]![0]).toBe(false);
  });

  it('shows no coefficient anywhere on screen', async () => {
    const { container } = renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    await pickTray();
    // The guessed number is never presented as a fact to reason from.
    expect(container.textContent).not.toMatch(/0\.45|g per ml|g\/ml/i);
  });
});
