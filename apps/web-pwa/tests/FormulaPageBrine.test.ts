import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { CanonItem, Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// A salt read and typed against one basis member (issue #1657, phase 1).
//
// The arithmetic and the three conditions `deriveFormula` keeps `statedOf` under are
// pinned in `packages/domain/tests/formula/{brine,deriveFormula}.test.ts`. What is
// pinned here is the screen's half:
//
//   1. On a two-member basis, a line named Plain salt offers "a percentage of" the
//      whole basis or of each other member, and the percent column says which —
//      "1.5%" or "3% of the Water".
//   2. A line stated against the water HOLDS when the water's weight is retyped, and
//      a line stated against the whole basis does not.
//   3. A curing salt and a one-member basis are never asked.
//   4. The choice is saved, and a reopen shows it.

const { mockRecipes, mockIsLoadingRecipes, mockFormula, mockCanonItems } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockIsLoadingRecipes: makeStore<boolean>(false),
      mockFormula: makeStore<Formula | null | undefined>(undefined),
      mockCanonItems: makeStore<readonly CanonItem[]>([]),
    };
  },
);

vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoadingRecipes,
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/formulaService.js', () => ({
  formula: mockFormula,
  initFormulaSync: vi.fn(() => vi.fn()),
  saveFormula: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import { emptyIngredientGroup, emptyRecipe, newIngredient, newStep } from '@salt/domain';
import FormulaPage from '../src/routes/recipes/FormulaPage.svelte';
import { saveFormula } from '../src/lib/formulaService.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

type IngredientSpec = { id: string; rawText: string; grams: number };

function weighed(spec: IngredientSpec) {
  return {
    ...newIngredient(spec.id, spec.rawText),
    parsed: {
      quantity: { type: 'single' as const, value: spec.grams },
      unit: 'g' as const,
      item: spec.rawText,
      preparation: [],
      notes: null,
      displayText: spec.rawText,
    },
    canonId: null,
    matchState: 'pending' as const,
  };
}

// The issue's worked example: 1 kg cucumbers and 1 kg water as the basis, 30 g salt —
// 1.5% of everything in the jar, 3% of the water.
const PICKLE: IngredientSpec[] = [
  { id: 'ing-cucumber', rawText: 'Cucumbers', grams: 1000 },
  { id: 'ing-water', rawText: 'Water', grams: 1000 },
  { id: 'ing-salt', rawText: 'Salt', grams: 30 },
];

// A dry-salted kraut: the cabbage alone is the basis.
const KRAUT: IngredientSpec[] = [
  { id: 'ing-cabbage', rawText: 'Cabbage', grams: 1000 },
  { id: 'ing-salt', rawText: 'Salt', grams: 20 },
];

function recipeOf(items: IngredientSpec[]): Recipe {
  return {
    ...emptyRecipe(RECIPE_ID, WRITTEN_AT),
    title: 'Pickle',
    ingredients: [{ ...emptyIngredientGroup('grp-1'), items: items.map(weighed) }],
    steps: [newStep('step-1', 'Pack, cover, wait.')],
    updatedAt: WRITTEN_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([recipeOf(PICKLE)]);
  mockCanonItems._set([]);
  mockFormula._set(undefined);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const all = (container: HTMLElement, testId: string): HTMLElement[] =>
  [...container.querySelectorAll(`[data-testid="${testId}"]`)].map((el) => el as HTMLElement);

const gramsInputs = (container: HTMLElement) =>
  all(container, 'formula-row-grams') as HTMLInputElement[];

const basisBoxes = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="formula-row-basis"] [role="checkbox"]')].map(
    (el) => el as HTMLElement,
  );

const percents = (container: HTMLElement) =>
  all(container, 'formula-row-percent').map((el) => (el.textContent ?? '').trim());

const statedPickers = (container: HTMLElement) => all(container, 'formula-row-stated-of');

/** Open a trigger and choose the option with this label. */
async function choose(trigger: HTMLElement, label: string): Promise<void> {
  await userEvent.click(trigger);
  await waitFor(() => screen.getByRole('option', { name: label }));
  await userEvent.click(screen.getByRole('option', { name: label }));
  await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
}

async function setGrams(container: HTMLElement, rowIndex: number, value: string): Promise<void> {
  const box = gramsInputs(container)[rowIndex]!;
  await fireEvent.input(box, { target: { value: '' } });
  await fireEvent.input(box, { target: { value } });
  await fireEvent.blur(box);
}

/** First visit, both basis members ticked, the salt named Plain salt. */
async function openPickle() {
  const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
  mockFormula._set(null);
  await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
  const boxes = basisBoxes(rendered.container);
  for (const index of [0, 1]) {
    if (boxes[index]!.getAttribute('aria-checked') !== 'true') await fireEvent.click(boxes[index]!);
  }
  await choose(all(rendered.container, 'formula-row-salt-product')[2]!, 'Plain salt');
  return rendered;
}

/** Declare "a weight of what goes in" at this many grams. */
async function declareBasis(rendered: Awaited<ReturnType<typeof openPickle>>, grams: string) {
  const option = [...rendered.container.querySelectorAll('[role="radio"]')].find((el) =>
    el.textContent?.includes('A weight of what goes in'),
  );
  if (option === undefined) throw new Error('no basis answer');
  await fireEvent.click(option);
  await fireEvent.input(rendered.getByTestId('formula-basis-grams'), { target: { value: grams } });
  await fireEvent.blur(rendered.getByTestId('formula-basis-grams'));
}

describe('FormulaPage — a salt stated against the water', () => {
  it('reads 1.5% against the whole basis and 3% of the Water against the water', async () => {
    const { container } = await openPickle();
    expect(percents(container)[2]).toBe('1.5%');

    const picker = statedPickers(container)[0]!;
    expect(picker.getAttribute('data-stated-of')).toBe('');
    await choose(picker, 'Of the Water');
    await waitFor(() => expect(percents(container)[2]).toBe('3% of the Water'));
    expect(statedPickers(container)[0]!.getAttribute('data-stated-of')).toBe('ing-water');

    await choose(statedPickers(container)[0]!, 'Of the whole basis');
    await waitFor(() => expect(percents(container)[2]).toBe('1.5%'));
  });

  it('offers each other basis member, and never the salt itself', async () => {
    const { container } = await openPickle();
    await userEvent.click(statedPickers(container)[0]!);
    await waitFor(() => screen.getByRole('option', { name: 'Of the Water' }));
    const options = screen.getAllByRole('option').map((el) => el.textContent?.trim());
    expect(options).toEqual(['Of the whole basis', 'Of the Cucumbers', 'Of the Water']);
  });

  it('moves the salt to 45 g when the water it is stated against goes to 1500 g', async () => {
    const { container } = await openPickle();
    await choose(statedPickers(container)[0]!, 'Of the Water');

    await setGrams(container, 1, '1500');
    await waitFor(() => expect(gramsInputs(container)[2]!.value).toBe('45'));
    expect(percents(container)[2]).toBe('3% of the Water');
  });

  it('leaves a whole-basis salt where it was when the water changes — as every line does', async () => {
    const { container } = await openPickle();
    await setGrams(container, 1, '1500');
    await waitFor(() => expect(percents(container)[2]).toBe('1.2%'));
    expect(gramsInputs(container)[2]!.value).toBe('30');
  });

  it('treats a water box left empty as the water taken out, and the hold with it', async () => {
    const { container } = await openPickle();
    await choose(statedPickers(container)[0]!, 'Of the Water');

    const water = gramsInputs(container)[1]!;
    await fireEvent.input(water, { target: { value: '' } });
    await fireEvent.blur(water);
    // Nothing moves, and with the water out the salt reads against what is left.
    expect(gramsInputs(container)[2]!.value).toBe('30');
    await waitFor(() => expect(percents(container)[2]).toBe('3%'));

    // Back in as a fresh line: stated against it at what the figures now say, and
    // the column says so rather than claiming the old 3%.
    await setGrams(container, 1, '2000');
    await waitFor(() => expect(percents(container)[2]).toBe('1.5% of the Water'));
    expect(gramsInputs(container)[2]!.value).toBe('30');
  });

  it('holds the strength through a declared total, which rescales every line by one factor', async () => {
    const rendered = await openPickle();
    const { container } = rendered;
    await choose(statedPickers(container)[0]!, 'Of the Water');
    await declareBasis(rendered, '2000');

    // 1000 g cucumbers and 1500 g water is 2500 g, restated to the declared 2000 g:
    // 800 g and 1200 g — and 3% of 1200 g is 36 g.
    await setGrams(container, 1, '1500');
    await waitFor(() => expect(gramsInputs(container)[1]!.value).toBe('1200'));
    expect(gramsInputs(container)[0]!.value).toBe('800');
    expect(gramsInputs(container)[2]!.value).toBe('36');
    expect(percents(container)[2]).toBe('3% of the Water');
  });

  it('keeps the salt where it is when a basis member it is not stated against changes', async () => {
    const { container } = await openPickle();
    await choose(statedPickers(container)[0]!, 'Of the Water');
    await setGrams(container, 0, '1200');
    await waitFor(() => expect(percents(container)[2]).toBe('3% of the Water'));
    expect(gramsInputs(container)[2]!.value).toBe('30');
  });

  it('holds a salt the cook retypes at its new strength', async () => {
    const { container } = await openPickle();
    await choose(statedPickers(container)[0]!, 'Of the Water');
    await setGrams(container, 2, '40');
    await waitFor(() => expect(percents(container)[2]).toBe('4% of the Water'));

    await setGrams(container, 1, '1500');
    await waitFor(() => expect(gramsInputs(container)[2]!.value).toBe('60'));
  });

  it('reads as a percentage of the basis again once the water leaves the basis', async () => {
    const { container } = await openPickle();
    await choose(statedPickers(container)[0]!, 'Of the Water');
    await fireEvent.click(basisBoxes(container)[1]!);
    // A one-member basis: the question no longer arises, and the line reads as what
    // is stored — salt against the cucumbers alone.
    await waitFor(() => expect(statedPickers(container)).toHaveLength(0));
    expect(percents(container)[2]).toBe('3%');
  });
});

describe('FormulaPage — where the question is never asked', () => {
  it('offers no picker on a curing salt', async () => {
    const { container } = await openPickle();
    expect(statedPickers(container)).toHaveLength(1);
    await choose(all(container, 'formula-row-salt-product')[2]!, 'Cure #1 (Prague powder #1)');
    await waitFor(() => expect(statedPickers(container)).toHaveLength(0));
  });

  it('offers no picker on a salt that names no product', async () => {
    const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
    mockFormula._set(null);
    await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
    const boxes = basisBoxes(rendered.container);
    for (const index of [0, 1]) {
      if (boxes[index]!.getAttribute('aria-checked') !== 'true')
        await fireEvent.click(boxes[index]!);
    }
    expect(statedPickers(rendered.container)).toHaveLength(0);
  });

  it('offers no picker on a one-member basis — a kraut', async () => {
    mockRecipes._set([recipeOf(KRAUT)]);
    const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
    mockFormula._set(null);
    await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
    const box = basisBoxes(rendered.container)[0]!;
    if (box.getAttribute('aria-checked') !== 'true') await fireEvent.click(box);
    await choose(all(rendered.container, 'formula-row-salt-product')[1]!, 'Plain salt');
    expect(statedPickers(rendered.container)).toHaveLength(0);
    expect(percents(rendered.container)[1]).toBe('2%');
  });
});

describe('FormulaPage — the choice is saved and reopened', () => {
  it('writes the member onto the salt and nothing onto anything else', async () => {
    const rendered = await openPickle();
    await choose(statedPickers(rendered.container)[0]!, 'Of the Water');
    await declareBasis(rendered, '2000');

    await waitFor(() =>
      expect(rendered.getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(rendered.getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    expect(written.components.map((c) => [c.ingredientId, c.statedOf, c.percent])).toEqual([
      ['ing-cucumber', null, 50],
      ['ing-water', null, 50],
      // Still percent of the basis: the view moved no stored number.
      ['ing-salt', 'ing-water', 1.5],
    ]);
  });

  it('reopens a stored choice as it was saved', async () => {
    const stored: Formula = {
      recipeId: RECIPE_ID,
      components: [
        { ingredientId: 'ing-cucumber', percent: 50, inBasis: true, stageId: null, statedOf: null },
        { ingredientId: 'ing-water', percent: 50, inBasis: true, stageId: null, statedOf: null },
        {
          ingredientId: 'ing-salt',
          percent: 1.5,
          inBasis: false,
          stageId: null,
          saltProduct: 'plain',
          statedOf: 'ing-water',
        },
      ],
      referenceYield: { kind: 'basis', grams: 2000 },
      target: null,
      schemaVersion: 1,
    };
    const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
    mockFormula._set(stored);
    await waitFor(() => expect(percents(rendered.container)[2]).toBe('3% of the Water'));
    expect(statedPickers(rendered.container)[0]!.getAttribute('data-stated-of')).toBe('ing-water');
  });
});
