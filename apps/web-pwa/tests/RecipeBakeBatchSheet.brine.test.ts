import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { Formula, FormulaComponent } from '@salt/domain/schemas';

// Weighing each part of the basis (issue #1657, phase 2) — a run declared by weight
// in, on a basis of more than one member, asks for each member: the cucumbers, and
// the water it took to cover them.
//
// What this suite holds to:
//
//   • one box per basis member IN PLACE OF the single total, and only then — a
//     coppa's one-member basis and a loaf declared by dough are untouched;
//   • every box opens EMPTY, on a placeholder at the recipe's own ratio, and an
//     empty box follows the typed ones;
//   • the salt follows from what actually went in, by the issue's own table;
//   • Start freezes the re-split formula at the weighed total — and nothing at all
//     when nothing was typed, which is the recipe as written.

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

function recipeWith(items: ReturnType<typeof ingredient>[]) {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
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

/** 1 kg cucumbers + 1 kg water, 30 g salt — 1.5% of the jar, 3% of the water. */
function pickle(statedOf: string | null = 'ing-water'): Formula {
  return {
    recipeId: RECIPE_ID,
    schemaVersion: 1,
    target: null,
    components: [
      line({ ingredientId: 'ing-cucumber', percent: 50, inBasis: true }),
      line({ ingredientId: 'ing-water', percent: 50, inBasis: true }),
      line({ ingredientId: 'ing-salt', percent: 1.5, saltProduct: 'plain', statedOf }),
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

function renderSheet(formula: Formula, recipe = PICKLE_RECIPE) {
  return render(RecipeBakeBatchSheet, { props: { recipe, formula, open: true } as never });
}

function memberBox(ingredientId: string): HTMLInputElement {
  const box = screen
    .queryAllByTestId('bake-batch-basis-member-grams')
    .find((el) => el.getAttribute('data-ingredient-id') === ingredientId);
  if (box === undefined) throw new Error(`no box for ${ingredientId}`);
  return box as HTMLInputElement;
}

async function weigh(ingredientId: string, value: string): Promise<void> {
  await fireEvent.input(memberBox(ingredientId), { target: { value } });
}

function gramsOf(ingredientId: string): string | undefined {
  const row = screen
    .queryAllByTestId('bake-batch-preview-row')
    .find((el) => el.getAttribute('data-ingredient-id') === ingredientId);
  return row?.querySelector('[data-testid="bake-batch-preview-grams"]')?.textContent?.trim();
}

async function clickStart(): Promise<Record<string, unknown>> {
  await fireEvent.click(screen.getByTestId('bake-batch-confirm'));
  await waitFor(() => expect(mockStartBatch).toHaveBeenCalled());
  return mockStartBatch.mock.calls[0]![0] as Record<string, unknown>;
}

describe('RecipeBakeBatchSheet — one box per part of the basis', () => {
  it('asks for each member in place of the single total, every box empty on a placeholder', async () => {
    renderSheet(pickle());
    await waitFor(() => expect(screen.getByTestId('bake-batch-basis-members')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-basis-grams')).toBeNull();

    // PLACEHOLDERS, NEVER VALUES: the recipe's own 1 kg each, shown and not typed.
    for (const id of ['ing-cucumber', 'ing-water']) {
      expect(memberBox(id).value).toBe('');
      expect(memberBox(id).placeholder).toBe('1000');
    }
    // Labelled by the recipe's own words, and only basis members get a box.
    expect(screen.getByLabelText('Cucumbers')).toBe(memberBox('ing-cucumber'));
    expect(screen.queryAllByTestId('bake-batch-basis-member-grams')).toHaveLength(2);
  });

  it('1.2 kg cucumbers, water left blank: the water follows to 1.2 kg and the salt is 36 g', async () => {
    renderSheet(pickle());
    await weigh('ing-cucumber', '1200');
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('36 g'));
    expect(gramsOf('ing-water')).toBe('1200 g');
    // The blank box now shows the figure it follows — and is still blank.
    expect(memberBox('ing-water').placeholder).toBe('1200');
    expect(memberBox('ing-water').value).toBe('');
  });

  it('typing 1.5 kg of water holds the salt at 3% of the Water: 45 g', async () => {
    renderSheet(pickle());
    await weigh('ing-cucumber', '1200');
    await weigh('ing-water', '1500');
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('45 g'));
    expect(screen.getByTestId('bake-batch-preview-stated').textContent?.trim()).toBe(
      '3% of the Water',
    );
  });

  it('2% of the basis — 1 kg cabbage and 0.8 kg water — is 36 g', async () => {
    const recipe = recipeWith([
      ingredient('ing-cucumber', 'Cabbage'),
      ingredient('ing-water', 'Water'),
      ingredient('ing-salt', 'Salt'),
    ]);
    const kraut = pickle(null);
    renderSheet(
      {
        ...kraut,
        components: kraut.components.map((c) =>
          c.ingredientId === 'ing-salt' ? { ...c, percent: 2 } : c,
        ),
      },
      recipe,
    );
    await weigh('ing-cucumber', '1000');
    await weigh('ing-water', '800');
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('36 g'));
  });

  it('starts the run from the re-split formula at the weighed total', async () => {
    renderSheet(pickle());
    await weigh('ing-cucumber', '1200');
    await weigh('ing-water', '1500');
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('45 g'));
    const input = await clickStart();

    expect(input.atYield).toEqual({ kind: 'basis', grams: 2700 });
    const formula = input.formula as Formula;
    const percentById = Object.fromEntries(
      formula.components.map((c) => [c.ingredientId, c.percent]),
    );
    expect(percentById).toEqual({
      'ing-cucumber': 44.4444,
      'ing-water': 55.5556,
      'ing-salt': 1.6667,
    });
  });

  it('starts the recipe as written when nothing was weighed — no yield passed at all', async () => {
    renderSheet(pickle());
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('30 g'));
    const input = await clickStart();
    expect('atYield' in input).toBe(false);
    expect(input.formula).toEqual(pickle());
  });

  it('re-splits BEFORE a cure-salt swap, so the swap rebalances the run being weighed', async () => {
    // A salami: pork and back fat, plain salt 2.5%, Cure #1 0.25% of the meat.
    const recipe = recipeWith([
      ingredient('ing-pork', 'Pork shoulder'),
      ingredient('ing-fat', 'Back fat'),
      ingredient('ing-salt', 'Salt'),
      ingredient('ing-cure', 'Prague powder #1'),
    ]);
    const salami: Formula = {
      recipeId: RECIPE_ID,
      schemaVersion: 1,
      target: null,
      components: [
        line({ ingredientId: 'ing-pork', percent: 80, inBasis: true }),
        line({ ingredientId: 'ing-fat', percent: 20, inBasis: true }),
        line({ ingredientId: 'ing-salt', percent: 2.5, saltProduct: 'plain' }),
        line({
          ingredientId: 'ing-cure',
          percent: 0.25,
          saltProduct: 'cure1',
          minPercent: 0.15,
          maxPercent: 0.3,
        }),
      ],
      referenceYield: { kind: 'basis', grams: 1000 },
    };
    renderSheet(salami, recipe);
    await weigh('ing-pork', '900');
    await weigh('ing-fat', '300');
    const swap = screen
      .getAllByTestId('bake-batch-substitute-option')
      .find((el) => el.getAttribute('data-salt-product') === 'nitritedCuringSalt');
    if (swap === undefined) throw new Error('no swap offered');
    await fireEvent.click(swap);

    // 0.25% of 1.2 kg of meat is 3 g of Cure #1's nitrite, carried by 31 g of the
    // nitrited salt (0.25 × 6.25 ÷ 0.6 = 2.6042% of 1200 g).
    await waitFor(() => expect(gramsOf('ing-cure')).toBe('31 g'));
    expect(gramsOf('ing-pork')).toBe('900 g');
    expect(gramsOf('ing-fat')).toBe('300 g');
    const input = await clickStart();
    expect(input.atYield).toEqual({ kind: 'basis', grams: 1200 });
  });
});

describe('RecipeBakeBatchSheet — boxes emptied, and a formula that will not solve', () => {
  it('a box cleared back to empty follows the others again', async () => {
    renderSheet(pickle());
    await weigh('ing-cucumber', '1200');
    await weigh('ing-water', '1500');
    await waitFor(() => expect(gramsOf('ing-salt')).toBe('45 g'));
    await weigh('ing-water', '');
    await waitFor(() => expect(gramsOf('ing-water')).toBe('1200 g'));
    expect(gramsOf('ing-salt')).toBe('36 g');
    expect(memberBox('ing-water').placeholder).toBe('1200');
  });

  it('still asks for each part when the formula will not solve, suggesting no figure', async () => {
    // Cure #1 above its window: the solve refuses, the preview says so, and there is
    // no weight for an empty box to stand for.
    const recipe = recipeWith([
      ingredient('ing-cucumber', 'Pork shoulder'),
      ingredient('ing-water', 'Back fat'),
      ingredient('ing-salt', 'Prague powder #1'),
    ]);
    renderSheet(
      {
        ...pickle(null),
        components: pickle(null).components.map((c) =>
          c.ingredientId === 'ing-salt'
            ? { ...c, percent: 1, saltProduct: 'cure1', minPercent: 0.15, maxPercent: 0.3 }
            : c,
        ),
      },
      recipe,
    );
    await waitFor(() => expect(screen.getByTestId('bake-batch-unsolvable')).toBeInTheDocument());
    expect(memberBox('ing-cucumber').placeholder).toBe('');
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
  });
});

describe('RecipeBakeBatchSheet — where the boxes do not appear', () => {
  it('a coppa’s one-member basis keeps the single box, seeded as it always was', async () => {
    renderSheet(
      {
        recipeId: RECIPE_ID,
        schemaVersion: 1,
        target: null,
        components: [
          line({ ingredientId: 'ing-cucumber', percent: 100, inBasis: true }),
          line({ ingredientId: 'ing-salt', percent: 2.5, saltProduct: 'plain' }),
        ],
        referenceYield: { kind: 'basis', grams: 1000 },
      },
      recipeWith([ingredient('ing-cucumber', 'Pork collar'), ingredient('ing-salt', 'Salt')]),
    );
    await waitFor(() => expect(screen.getByTestId('bake-batch-basis-grams')).toBeInTheDocument());
    expect((screen.getByTestId('bake-batch-basis-grams') as HTMLInputElement).value).toBe('1000');
    expect(screen.queryByTestId('bake-batch-basis-members')).toBeNull();
  });

  it('a loaf declared by its dough never sees them, however many flours its basis holds', async () => {
    renderSheet({
      ...pickle(null),
      referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
    });
    await waitFor(() => expect(screen.getByTestId('bake-batch-tin')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-basis-members')).toBeNull();
  });
});
