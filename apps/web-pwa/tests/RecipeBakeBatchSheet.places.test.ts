import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { readable } from 'svelte/store';
import type { Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// The two questions the bake sheet gained (issue #1286): how warm the kitchen is,
// and where each stage happens.
//
// What this suite holds to, and all four are claims nothing else enforces:
//
//   • SKIPPING BOTH gives exactly today's behaviour — no kitchen figure, no place
//     on any stage, and Start unaffected;
//   • the kitchen figure is PREFILLED from the most recent run that gave one;
//   • a place that cannot reach what the stage asks for shows a note AND STILL
//     STARTS. The note informs; it never gates (Salt records, it does not police);
//   • the ids handed to `startBatch` are POSITIONAL over the stages on screen.

// The fixtures live in `vi.hoisted` because the `vi.mock` factories below read
// them, and those are hoisted above every top-level binding.
const {
  mockStartBatch,
  mockProposeSchedule,
  mockAddToast,
  mockInitBatchesSync,
  PREVIOUS_RUNS,
  MANIFEST,
} = vi.hoisted(() => ({
  mockStartBatch: vi.fn(),
  mockProposeSchedule: vi.fn(),
  mockAddToast: vi.fn(),
  mockInitBatchesSync: vi.fn(() => vi.fn()),
  // A previous run that recorded 19 °C, and an older one that recorded 25 °C.
  // The prefill takes the NEWEST by `createdAt`, not the first in the array.
  PREVIOUS_RUNS: [
    { id: 'batch-old', createdAt: '2026-08-01T09:00:00.000Z', ambientCelsius: 25 },
    { id: 'batch-recent', createdAt: '2026-08-12T09:00:00.000Z', ambientCelsius: 19 },
    { id: 'batch-newest-no-answer', createdAt: '2026-08-13T09:00:00.000Z', ambientCelsius: null },
  ],
  MANIFEST: {
    schemaVersion: 1,
    updatedAt: '2026-08-01T09:00:00.000Z',
    items: [
      {
        id: 'eq-proofer',
        schemaVersion: 1,
        name: 'Dough proofer',
        accessories: [],
        rules: [],
        environment: {
          control: 'dedicated',
          minCelsius: 20,
          maxCelsius: 40,
          humidity: null,
          standing: null,
        },
        updatedAt: '2026-08-01T09:00:00.000Z',
      },
      {
        id: 'eq-fridge',
        schemaVersion: 1,
        name: 'Fridge',
        accessories: [],
        rules: [],
        environment: {
          control: 'dedicated',
          minCelsius: 2,
          maxCelsius: 8,
          humidity: null,
          standing: null,
        },
        updatedAt: '2026-08-01T09:00:00.000Z',
      },
      {
        id: 'eq-knives',
        schemaVersion: 1,
        name: 'Knife block',
        accessories: [],
        rules: [],
        // Not a place. It must not appear in the picker: a knife block is not
        // somewhere a prove happens.
        environment: null,
        updatedAt: '2026-08-01T09:00:00.000Z',
      },
    ],
  },
}));

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: mockAddToast }));
vi.mock('../src/lib/batchService.js', () => ({
  startBatch: mockStartBatch,
  proposeSchedule: mockProposeSchedule,
  batches: readable(PREVIOUS_RUNS),
  initBatchesSync: mockInitBatchesSync,
}));
vi.mock('../src/lib/equipmentService.js', () => ({ equipment: readable(MANIFEST) }));

import RecipeBakeBatchSheet from '../src/routes/recipes/RecipeBakeBatchSheet.svelte';

const RECIPE_ID = 'recipe-1';

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
        {
          id: 'ing-flour',
          rawText: '500 g strong white flour',
          parsed: null,
          canonId: null,
          matchState: 'matched' as const,
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  steps: [{ id: 'step-1', text: 'Mix.', timer: null, note: null }],
  metadata: { servings: null, tags: [] },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
} as unknown as Recipe;

// Two stages: a warm bulk the proofer covers, and a retard the proofer cannot.
const FORMULA = {
  recipeId: RECIPE_ID,
  schemaVersion: 1,
  components: [{ ingredientId: 'ing-flour', percent: 100, inBasis: true }],
  referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
  process: [
    {
      id: 'stg-bulk',
      label: 'Bulk ferment',
      kind: 'wait',
      environment: {
        temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
        equipmentId: null,
      },
      duration: { kind: 'fixed', minutes: 180 },
      until: null,
      stepId: null,
    },
    {
      id: 'stg-retard',
      label: 'Overnight retard',
      kind: 'wait',
      environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 600 },
      until: null,
      stepId: null,
    },
  ],
} as unknown as Formula;

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
  document.body.innerHTML = '';
});

function renderSheet(formula: Formula = FORMULA) {
  return render(RecipeBakeBatchSheet, { props: { recipe: RECIPE, formula, open: true } });
}

describe('RecipeBakeBatchSheet — how warm the kitchen is', () => {
  it('asks, prefilled from the most recent run that answered', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-ambient')).toHaveValue('19'));
  });

  it('hands the figure to startBatch', async () => {
    renderSheet();
    const field = await screen.findByTestId('bake-batch-ambient');
    await fireInput(field, '23');
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(expect.objectContaining({ ambientCelsius: 23 }));
  });

  it('sends null when the box is cleared — the question is always skippable', async () => {
    renderSheet();
    const field = await screen.findByTestId('bake-batch-ambient');
    await fireInput(field, '');
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(expect.objectContaining({ ambientCelsius: null }));
  });
});

describe('RecipeBakeBatchSheet — where each stage happens', () => {
  it('offers one picker per stage, and only for things that are places', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    const pickers = screen.getAllByTestId('bake-batch-stage-place');
    expect(pickers).toHaveLength(2);
    // The knife block is not offered anywhere on the sheet.
    expect(screen.getByTestId('bake-batch-places').textContent).not.toContain('Knife block');
  });

  it('opens on "Kitchen temperature" and starts a run with no place at all', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    for (const picker of screen.getAllByTestId('bake-batch-stage-place')) {
      expect(picker.textContent).toContain('Kitchen temperature');
    }
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: [null, null] }),
    );
  });

  it('opens on the place the recipe itself suggested', async () => {
    const suggested = {
      ...FORMULA,
      process: [
        {
          ...(FORMULA.process ?? [])[0],
          environment: {
            temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
            equipmentId: 'eq-proofer',
          },
        },
        (FORMULA.process ?? [])[1],
      ],
    } as unknown as Formula;
    renderSheet(suggested);
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    expect(screen.getAllByTestId('bake-batch-stage-place')[0]?.textContent).toContain(
      'Dough proofer',
    );
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: ['eq-proofer', null] }),
    );
  });

  it('notes a place that cannot reach the stage, and STILL STARTS', async () => {
    // The proofer runs 20–40 °C; the overnight retard asks for 4 °C. That is a
    // sentence beside the picker and nothing else — Start is untouched, because
    // Salt records what happened in the kitchen rather than policing it.
    const suggested = {
      ...FORMULA,
      process: [
        (FORMULA.process ?? [])[0],
        {
          ...(FORMULA.process ?? [])[1],
          environment: {
            temperature: { kind: 'fixed', celsius: 4 },
            equipmentId: 'eq-proofer',
          },
        },
      ],
    } as unknown as Formula;
    renderSheet(suggested);
    const note = await screen.findByTestId('bake-batch-place-note');
    expect(note.textContent).toContain('Dough proofer runs 20–40 °C');
    expect(note.textContent).toContain('asks for 4 °C');
    const start = screen.getByTestId('bake-batch-confirm');
    expect(start).not.toBeDisabled();
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: [null, 'eq-proofer'] }),
    );
  });

  it('says nothing when the place covers what the stage asks for', async () => {
    const suggested = {
      ...FORMULA,
      process: [
        {
          ...(FORMULA.process ?? [])[0],
          environment: {
            temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
            equipmentId: 'eq-proofer',
          },
        },
        (FORMULA.process ?? [])[1],
      ],
    } as unknown as Formula;
    renderSheet(suggested);
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-place-note')).toBeNull();
  });

  it('picks a place, and hands that id over positionally', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getAllByTestId('bake-batch-stage-place')[1]!);
    await user.click(await screen.findByRole('option', { name: 'Fridge' }));

    expect(screen.getAllByTestId('bake-batch-stage-place')[1]!.textContent).toContain('Fridge');
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: [null, 'eq-fridge'] }),
    );
  });

  it('raises the note the moment an unreachable place is picked, and drops it again', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-place-note')).toBeNull();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The overnight retard asks for 4 °C; the proofer runs 20–40.
    await user.click(screen.getAllByTestId('bake-batch-stage-place')[1]!);
    await user.click(await screen.findByRole('option', { name: 'Dough proofer' }));
    expect(await screen.findByTestId('bake-batch-place-note')).toHaveTextContent(
      'Dough proofer runs 20–40 °C',
    );

    // Back to nowhere in particular: the note goes with the choice, and so does
    // the id.
    await user.click(screen.getAllByTestId('bake-batch-stage-place')[1]!);
    await user.click(await screen.findByRole('option', { name: 'Kitchen temperature' }));
    await waitFor(() => expect(screen.queryByTestId('bake-batch-place-note')).toBeNull());
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: [null, null] }),
    );
  });

  it("follows the PROPOSAL's stages once one is accepted, and forgets choices made against the old ones", async () => {
    // A choice made against the formula's own process must never be carried onto a
    // restructured one by position — that is exactly how a place ends up frozen
    // onto a stage nobody picked it for.
    mockProposeSchedule.mockResolvedValue({
      kind: 'ok',
      value: {
        rationale: 'Retard the bulk overnight.',
        adjustment: null,
        stages: [
          {
            label: 'Counter bulk',
            kind: 'wait',
            environment: {
              temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
              equipmentId: null,
            },
            duration: { kind: 'fixed', minutes: 20 },
            until: null,
            stepId: null,
            optional: false,
            sourceStageId: 'stg-bulk',
          },
          {
            label: 'Fridge retard',
            kind: 'wait',
            environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: 'eq-fridge' },
            duration: { kind: 'fixed', minutes: 600 },
            until: null,
            stepId: null,
            optional: false,
            sourceStageId: 'stg-bulk',
          },
          {
            label: 'Bake',
            kind: 'active',
            environment: { temperature: { kind: 'fixed', celsius: 240 }, equipmentId: null },
            duration: { kind: 'fixed', minutes: 45 },
            until: null,
            stepId: null,
            optional: false,
            sourceStageId: null,
          },
        ],
      },
    });

    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getAllByTestId('bake-batch-stage-place')[0]!);
    await user.click(await screen.findByRole('option', { name: 'Dough proofer' }));

    // Switch to "out of the oven at", ask, and accept.
    await fireEvent.click(screen.getByRole('radio', { name: /Out of the oven/ }));
    await fireEvent.click(await screen.findByTestId('bake-batch-propose'));
    await waitFor(() => expect(screen.getByTestId('bake-batch-proposal')).toBeInTheDocument());

    // Three pickers now, one per proposed stage — and the proofer choice is gone,
    // replaced by what each proposed stage itself names.
    const pickers = screen.getAllByTestId('bake-batch-stage-place');
    expect(pickers).toHaveLength(3);
    expect(pickers[0]!.textContent).toContain('Kitchen temperature');
    expect(pickers[1]!.textContent).toContain('Fridge');

    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stagePlaceIds: [null, 'eq-fridge', null] }),
    );
  });

  it('hands the manifest over so the service can resolve the ids', async () => {
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    await clickStart();
    expect(mockStartBatch).toHaveBeenCalledWith(
      expect.objectContaining({ equipment: MANIFEST.items }),
    );
  });
});

describe('RecipeBakeBatchSheet — the proposal sees the kitchen (issue #1286)', () => {
  const PROPOSAL = {
    kind: 'ok' as const,
    value: {
      rationale: 'Your kitchen is warm today, so the bulk is short.',
      adjustment: null,
      stages: [
        {
          label: 'Bulk ferment',
          kind: 'wait' as const,
          environment: {
            temperature: { kind: 'fixed' as const, celsius: 24 },
            equipmentId: 'eq-proofer',
          },
          duration: { kind: 'fixed' as const, minutes: 60 },
          until: null,
          stepId: null,
          optional: false,
          sourceStageId: 'stg-bulk',
        },
        {
          label: 'Overnight retard',
          kind: 'wait' as const,
          environment: { temperature: { kind: 'fixed' as const, celsius: 4 }, equipmentId: null },
          duration: { kind: 'fixed' as const, minutes: 600 },
          until: null,
          stepId: null,
          optional: false,
          sourceStageId: 'stg-retard',
        },
      ],
    },
  };

  async function propose(): Promise<void> {
    await fireEvent.click(screen.getByRole('radio', { name: /Out of the oven/ }));
    await fireEvent.click(await screen.findByTestId('bake-batch-propose'));
    await waitFor(() => expect(screen.getByTestId('bake-batch-proposal')).toBeInTheDocument());
  }

  it('hands the kitchen figure to the flow', async () => {
    mockProposeSchedule.mockResolvedValue(PROPOSAL);
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-ambient')).toHaveValue('19'));
    await propose();

    expect(mockProposeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId: RECIPE_ID, ambientCelsius: 19 }),
    );
  });

  it('names the place a stage moved to, not just the temperature', async () => {
    mockProposeSchedule.mockResolvedValue(PROPOSAL);
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-places')).toBeInTheDocument());
    await propose();

    const rows = screen.getAllByTestId('bake-batch-diff-row').map((r) => r.textContent ?? '');
    expect(rows.join(' | ')).toContain('Dough proofer');
  });

  it('retires the proposal when the kitchen figure changes — it answered the old question', async () => {
    mockProposeSchedule.mockResolvedValue(PROPOSAL);
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('bake-batch-ambient')).toBeInTheDocument());
    await propose();

    await fireInput(screen.getByTestId('bake-batch-ambient'), '9');
    await waitFor(() => expect(screen.queryByTestId('bake-batch-proposal')).toBeNull());
    // And the ask is offered again rather than Start being left enabled on a
    // schedule written for a different room.
    expect(await screen.findByTestId('bake-batch-propose')).toBeInTheDocument();
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────────

async function fireInput(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

async function clickStart(): Promise<void> {
  await fireEvent.click(screen.getByTestId('bake-batch-confirm'));
  await waitFor(() => expect(mockStartBatch).toHaveBeenCalled());
}
