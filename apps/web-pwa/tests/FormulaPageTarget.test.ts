import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { emptyIngredientGroup, emptyRecipe, newIngredient, newStep } from '@salt/domain';
import type { CanonItem, Ingredient, Recipe } from '@salt/domain';
import type { EquipmentManifestDoc, Formula } from '@salt/domain/schemas';
import { FormulaSchema } from '@salt/domain/schemas';

// What a run of this is aiming at (issue #1407, phase 04 of epic #778) — the card
// below the stages, and the one place a `FormulaTarget` is ever constructed.
//
// A third sibling of FormulaPage.test.ts: that file is about the percentages,
// FormulaPageStages.test.ts about the process, and this about the target. They
// share the page and nothing else.
//
// THE CLAIM THIS FILE PINS (CLAUDE.md rule 12): "there is exactly one spelling of
// no target — the UI writes `null` when both boxes are empty, never an object of
// two nulls". The schema cannot enforce that on its own, because an object of two
// nulls is a perfectly valid `FormulaTarget`; the write path is the only thing that
// can hold the line, so the write path is what is tested.

const { mockRecipes, mockIsLoadingRecipes, mockFormula, mockCanonItems, mockEquipment } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockIsLoadingRecipes: makeStore<boolean>(false),
      mockFormula: makeStore<Formula | null | undefined>(undefined),
      mockCanonItems: makeStore<readonly CanonItem[]>([]),
      mockEquipment: makeStore<EquipmentManifestDoc | null>(null),
    };
  });

// FOUR MOCKS, and each is a data seam this page subscribes to (UT-B1). The router,
// the toast store and `lib/nav` are deliberately NOT mocked — nothing here clicks
// Back or reads a toast, so mocking them would be three more module paths a future
// refactor detonates for no test's benefit.
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoadingRecipes,
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/equipmentService.js', () => ({ equipment: mockEquipment }));
vi.mock('../src/lib/formulaService.js', () => ({
  formula: mockFormula,
  initFormulaSync: vi.fn(() => vi.fn()),
  saveFormula: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  extractProcessStages: vi.fn().mockResolvedValue({ kind: 'ok', value: [] }),
}));

import FormulaPage from '../src/routes/recipes/FormulaPage.svelte';
import { saveFormula } from '../src/lib/formulaService.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

/**
 * The coppa, through the REAL builders (UT-C2) with the two fields a formula screen
 * needs filled in on top: `parsed`, because the screen reads grams off it, and
 * `canonId`, because the basis guess reads a tidy name through canon.
 */
function weighed(id: string, rawText: string, grams: number, canonId: string): Ingredient {
  return {
    ...newIngredient(id, rawText),
    parsed: {
      quantity: { type: 'single', value: grams },
      unit: 'g',
      item: rawText,
      preparation: [],
      notes: null,
      displayText: rawText,
    },
    canonId,
    matchState: 'matched',
  };
}

function makeCoppa(): Recipe {
  const group = {
    ...emptyIngredientGroup('grp-1'),
    items: [
      weighed('ing-meat', '2400 g pork collar', 2400, 'canon-pork'),
      weighed('ing-salt', '66 g curing salt', 66, 'canon-salt'),
    ],
  };
  return {
    ...emptyRecipe(RECIPE_ID, WRITTEN_AT),
    title: 'Coppa',
    ingredients: [group],
    steps: [newStep('step-1', 'Salt it.')],
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
  };
}

function canon(id: string, name: string): CanonItem {
  return {
    embedding: null,
    id,
    schemaVersion: 5,
    name,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: WRITTEN_AT,
  } as CanonItem;
}

/** Already declared, so Save is reachable without touching the top half. */
function stored(target: Formula['target'] = null): Formula {
  return {
    recipeId: RECIPE_ID,
    components: [
      { ingredientId: 'ing-meat', percent: 100, inBasis: true, stageId: null },
      { ingredientId: 'ing-salt', percent: 2.75, inBasis: false, stageId: null },
    ],
    referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 2466 } },
    target,
    schemaVersion: 1,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveFormula).mockResolvedValue({ kind: 'ok', value: undefined } as never);
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([makeCoppa()]);
  mockCanonItems._set([canon('canon-pork', 'pork collar'), canon('canon-salt', 'curing salt')]);
  mockFormula._set(undefined);
  mockEquipment._set(null);
});

async function openWith(formula: Formula | null) {
  const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
  mockFormula._set(formula);
  await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
  return rendered;
}

function inputIn(container: HTMLElement, testid: string): HTMLInputElement {
  const found = container.querySelector(`input[data-testid="${testid}"]`);
  if (found === null) throw new Error(`no input ${testid}`);
  return found as HTMLInputElement;
}

async function saveWith(
  weightLoss: string,
  ph: string,
  formula: Formula | null = stored(),
): Promise<Formula> {
  const { getByTestId, container } = await openWith(formula);
  if (weightLoss !== '')
    await fireEvent.input(inputIn(container, 'formula-target-weight-loss'), {
      target: { value: weightLoss },
    });
  if (ph !== '')
    await fireEvent.input(inputIn(container, 'formula-target-ph'), { target: { value: ph } });
  await fireEvent.click(getByTestId('formula-save-button'));
  await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
  return vi.mocked(saveFormula).mock.calls[0]![0] as Formula;
}

describe('FormulaPage — the target card', () => {
  it('is on every formula screen, both boxes empty, whatever the recipe is', async () => {
    // Not gated on a cure category: that would be behaviour branching on kind,
    // which CLAUDE.md forbids outside `packages/domain`. A bread formula gets the
    // same card and walks past it.
    const { getByTestId, container } = await openWith(stored());

    expect(getByTestId('formula-target')).toBeTruthy();
    expect(inputIn(container, 'formula-target-weight-loss').value).toBe('');
    expect(inputIn(container, 'formula-target-ph').value).toBe('');
  });

  it('writes null when both boxes are empty — never an object of two nulls', async () => {
    // THE PIN. An object of two nulls is a valid `FormulaTarget`, so nothing but
    // this stops a second spelling of "no target" reaching the collection.
    const written = await saveWith('', '');

    expect(written.target).toBeNull();
    expect(written.target).not.toEqual({ weightLossPercent: null, phAtMost: null });
  });

  it('writes a weight loss alone, with the pH half null', async () => {
    expect(await saveWith('35', '')).toMatchObject({
      target: { weightLossPercent: 35, phAtMost: null },
    });
  });

  it('writes both halves for a fermented salami', async () => {
    expect(await saveWith('35', '5.3')).toMatchObject({
      target: { weightLossPercent: 35, phAtMost: 5.3 },
    });
  });

  it('writes what the schema will accept', async () => {
    // The boxes are a rail on top of `FormulaTargetSchema`, not instead of it.
    const written = await saveWith('35', '5.3');
    expect(FormulaSchema.safeParse(written).success).toBe(true);
  });

  it('comes back in its boxes on reopen', async () => {
    const { container } = await openWith(stored({ weightLossPercent: 35, phAtMost: 5.3 }));

    expect(inputIn(container, 'formula-target-weight-loss').value).toBe('35');
    expect(inputIn(container, 'formula-target-ph').value).toBe('5.3');
  });

  it('clears the target when the boxes are emptied', async () => {
    // `setDoc` writes the whole document, so clearing the boxes is how a target is
    // removed — there is no separate gesture and no tombstone.
    const { getByTestId, container } = await openWith(
      stored({ weightLossPercent: 35, phAtMost: null }),
    );
    await fireEvent.input(inputIn(container, 'formula-target-weight-loss'), {
      target: { value: '' },
    });
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect((vi.mocked(saveFormula).mock.calls[0]![0] as Formula).target).toBeNull();
  });

  it('says a figure the schema would refuse on the field, and will not save it', async () => {
    const { getByTestId, container } = await openWith(stored());
    await fireEvent.input(inputIn(container, 'formula-target-weight-loss'), {
      target: { value: '120' },
    });

    await waitFor(() => expect(screen.getByTestId('formula-blocked-reason')).toBeTruthy());
    await fireEvent.click(getByTestId('formula-save-button'));
    expect(saveFormula).not.toHaveBeenCalled();
  });
});
