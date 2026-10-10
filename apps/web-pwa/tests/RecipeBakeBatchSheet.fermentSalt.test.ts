import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { Formula, FormulaComponent } from '@salt/domain/schemas';

// A ferment's salt outside its usual range gets a note on the start sheet too (issue
// #1657, phase 3) — and Start is enabled underneath it, every time. The ranges and
// edges are the domain's (`fermentSalt.test.ts`); this pins the sheet's half: the
// note reads the formula being weighed out, names the range and what the figure is
// against, and blocks nothing.

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
  batches: readable(undefined),
  initBatchesSync: vi.fn(() => vi.fn()),
}));
vi.mock('../src/lib/equipmentService.js', () => ({ equipment: readable(null) }));

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

function recipeWith(items: ReturnType<typeof ingredient>[], kind = 'ferment') {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    kind,
    title: 'Dill pickles',
    description: null,
    ingredients: [{ id: 'grp-1', name: null, items }],
    steps: [{ id: 'step-1', text: 'Pack the jar.', timer: null, note: null }],
    metadata: { servings: null, tags: [] },
    source: null,
    notes: null,
    image: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  };
}

const PICKLE_RECIPE = recipeWith([
  ingredient('ing-cucumber', 'Cucumbers'),
  ingredient('ing-water', 'Water'),
  ingredient('ing-salt', 'Salt'),
]);

const line = (patch: Partial<FormulaComponent> & { ingredientId: string }): FormulaComponent => ({
  percent: 0,
  inBasis: false,
  stageId: null,
  statedOf: null,
  ...patch,
});

/** 1 kg cucumbers + 1 kg water, 60 g salt — 3% of the jar, 6% of the water. */
function pickle(statedOf: string | null = 'ing-water'): Formula {
  return {
    recipeId: RECIPE_ID,
    schemaVersion: 1,
    target: null,
    components: [
      line({ ingredientId: 'ing-cucumber', percent: 50, inBasis: true }),
      line({ ingredientId: 'ing-water', percent: 50, inBasis: true }),
      line({ ingredientId: 'ing-salt', percent: 3, saltProduct: 'plain', statedOf }),
    ],
    referenceYield: { kind: 'basis', grams: 2000 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStartBatch.mockResolvedValue({ kind: 'ok', value: { id: 'batch-9' } });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function renderSheet(formula: Formula, recipe: ReturnType<typeof recipeWith> = PICKLE_RECIPE) {
  return render(RecipeBakeBatchSheet, { props: { recipe, formula, open: true } as never });
}

const note = () => screen.queryByTestId('bake-batch-ferment-salt-note');

describe('RecipeBakeBatchSheet — a ferment salt outside its range', () => {
  it('notes a pickle at 6% of the Water, naming 2–5%, and Start still works', async () => {
    renderSheet(pickle());
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()!.getAttribute('data-side')).toBe('above');
    expect(note()!.textContent).toContain(
      'Salt at 6% of the Water is above the usual 2–5% for a ferment.',
    );

    const start = screen.getByTestId('bake-batch-confirm');
    expect(start.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(start);
    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
  });

  it('notes a kraut at 1% of the basis, naming 1.5–3%', async () => {
    const kraut: Formula = {
      ...pickle(null),
      components: [
        line({ ingredientId: 'ing-cucumber', percent: 100, inBasis: true }),
        line({ ingredientId: 'ing-salt', percent: 1, saltProduct: 'plain' }),
      ],
      referenceYield: { kind: 'basis', grams: 1000 },
    };
    renderSheet(kraut);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()!.getAttribute('data-side')).toBe('below');
    expect(note()!.textContent).toContain(
      'Salt at 1% of the basis is below the usual 1.5–3% for a ferment.',
    );
    expect(screen.getByTestId('bake-batch-confirm').hasAttribute('disabled')).toBe(false);
  });

  it('prints the bare figure when the member it is stated against has left the recipe', async () => {
    const recipe = recipeWith([
      ingredient('ing-cucumber', 'Cucumbers'),
      ingredient('ing-salt', 'Salt'),
    ]);
    renderSheet(pickle(), recipe);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()!.textContent).toContain('Salt at 6% is above the usual 2–5% for a ferment.');
  });
});

describe('RecipeBakeBatchSheet — where the range says nothing', () => {
  it('is silent on the same figures on a cure or a bread', async () => {
    for (const kind of ['cure', 'bread']) {
      const { unmount } = renderSheet(
        pickle(),
        recipeWith(PICKLE_RECIPE.ingredients[0]!.items, kind),
      );
      await waitFor(() => expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument());
      expect(note()).toBeNull();
      unmount();
    }
  });

  it('is silent on a ferment whose salt is not named Plain salt', async () => {
    const unnamed = pickle(null);
    renderSheet({
      ...unnamed,
      components: unnamed.components.map((c) =>
        c.ingredientId === 'ing-salt' ? line({ ingredientId: 'ing-salt', percent: 6 }) : c,
      ),
    });
    await waitFor(() => expect(screen.getByTestId('bake-batch-confirm')).toBeInTheDocument());
    expect(note()).toBeNull();
  });
});
