import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { CanonItem, Recipe, RecipeKind } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// A ferment's salt outside its usual range gets a note (issue #1657, phase 3).
//
// The ranges, the edges and the silences are pinned in
// `packages/domain/tests/formula/fermentSalt.test.ts`. What is pinned here is the
// screen's half: the note appears live on a ferment, names the range, says what the
// figure is against — and Save is enabled underneath it. A note is never a stop.

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

// A kraut salted at 1% of the cabbage — below 1.5–3%.
const KRAUT: IngredientSpec[] = [
  { id: 'ing-cabbage', rawText: 'Cabbage', grams: 1000 },
  { id: 'ing-salt', rawText: 'Salt', grams: 10 },
];

// A pickle at 6% of the water — 1 kg cucumbers, 1 kg water, 60 g salt — above 2–5%.
const PICKLE: IngredientSpec[] = [
  { id: 'ing-cucumber', rawText: 'Cucumbers', grams: 1000 },
  { id: 'ing-water', rawText: 'Water', grams: 1000 },
  { id: 'ing-salt', rawText: 'Salt', grams: 60 },
];

function recipeOf(items: IngredientSpec[], kind: RecipeKind = 'ferment'): Recipe {
  return {
    ...emptyRecipe(RECIPE_ID, WRITTEN_AT),
    kind,
    title: 'Jar',
    ingredients: [{ ...emptyIngredientGroup('grp-1'), items: items.map(weighed) }],
    steps: [newStep('step-1', 'Pack, cover, wait.')],
    updatedAt: WRITTEN_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockCanonItems._set([]);
  mockFormula._set(undefined);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const all = (container: HTMLElement, testId: string): HTMLElement[] =>
  [...container.querySelectorAll(`[data-testid="${testId}"]`)].map((el) => el as HTMLElement);

const note = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="formula-ferment-salt-note"]');

async function choose(trigger: HTMLElement, label: string): Promise<void> {
  await userEvent.click(trigger);
  await waitFor(() => screen.getByRole('option', { name: label }));
  await userEvent.click(screen.getByRole('option', { name: label }));
  await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
}

/** First visit, the first `basisCount` rows ticked as the basis. */
async function open(items: IngredientSpec[], basisCount: number, kind?: RecipeKind) {
  mockRecipes._set([recipeOf(items, kind)]);
  const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
  mockFormula._set(null);
  await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
  const boxes = [
    ...rendered.container.querySelectorAll('[data-testid="formula-row-basis"] [role="checkbox"]'),
  ] as HTMLElement[];
  for (let index = 0; index < boxes.length; index += 1) {
    const ticked = boxes[index]!.getAttribute('aria-checked') === 'true';
    if (ticked !== index < basisCount) await fireEvent.click(boxes[index]!);
  }
  return rendered;
}

const nameSalt = (container: HTMLElement, row: number, label = 'Plain salt') =>
  choose(all(container, 'formula-row-salt-product')[row]!, label);

/** Declare "a weight of what goes in" at the recipe's own total, so Save has a shape. */
async function declareBasis(rendered: Awaited<ReturnType<typeof open>>, grams: string) {
  const option = [...rendered.container.querySelectorAll('[role="radio"]')].find((el) =>
    el.textContent?.includes('A weight of what goes in'),
  );
  if (option === undefined) throw new Error('no basis answer');
  await fireEvent.click(option);
  await fireEvent.input(rendered.getByTestId('formula-basis-grams'), { target: { value: grams } });
  await fireEvent.blur(rendered.getByTestId('formula-basis-grams'));
}

describe('FormulaPage — a ferment salt outside its range', () => {
  it('notes a kraut at 1% of the cabbage, naming 1.5–3%, and Save still works', async () => {
    const rendered = await open(KRAUT, 1);
    const { container } = rendered;
    expect(note(container)).toBeNull();
    await nameSalt(container, 1);

    await waitFor(() => expect(note(container)).not.toBeNull());
    expect(note(container)!.getAttribute('data-side')).toBe('below');
    expect(note(container)!.textContent).toContain(
      'Salt at 1% of the basis is below the usual 1.5–3% for a ferment.',
    );

    await declareBasis(rendered, '1000');
    const save = rendered.getByTestId('formula-save-button');
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    expect(note(container)).not.toBeNull();
    await fireEvent.click(save);
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
  });

  it('notes a pickle at 6% of the Water, naming 2–5%', async () => {
    const { container } = await open(PICKLE, 2);
    await nameSalt(container, 2);
    // Stated against the whole basis, 60 g on 2 kg is 3%: inside 1.5–3%.
    expect(note(container)).toBeNull();

    await choose(all(container, 'formula-row-stated-of')[0]!, 'Of the Water');
    await waitFor(() => expect(note(container)).not.toBeNull());
    expect(note(container)!.getAttribute('data-side')).toBe('above');
    expect(note(container)!.textContent).toContain(
      'Salt at 6% of the Water is above the usual 2–5% for a ferment.',
    );
  });

  it('goes as the salt is brought into range, live and unsaved', async () => {
    const { container } = await open(KRAUT, 1);
    await nameSalt(container, 1);
    await waitFor(() => expect(note(container)).not.toBeNull());

    const salt = all(container, 'formula-row-grams')[1] as HTMLInputElement;
    await fireEvent.input(salt, { target: { value: '20' } });
    await fireEvent.blur(salt);
    await waitFor(() => expect(note(container)).toBeNull());
    expect(saveFormula).not.toHaveBeenCalled();
  });
});

describe('FormulaPage — where the range says nothing', () => {
  it('is silent on the same figures on a cure or a bread', async () => {
    for (const kind of ['cure', 'bread'] as const) {
      const { container, unmount } = await open(KRAUT, 1, kind);
      await nameSalt(container, 1);
      expect(note(container)).toBeNull();
      unmount();
    }
  });

  it('is silent on a ferment whose salt is not named Plain salt', async () => {
    const { container } = await open(KRAUT, 1);
    expect(all(container, 'formula-row-grams')).toHaveLength(2);
    expect(note(container)).toBeNull();
  });
});
