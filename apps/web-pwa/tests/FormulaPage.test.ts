import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { CanonItem, Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// The formula screen (issue #806, phase 1 of epic #778), against a real bread
// shape: the overnight white tin as Salt holds it, plus a two-flour variant, a
// count-based line and a range.
//
// The five things this page has to get right:
//
//   • it derives percentages against a GUESSED flour basis, so 500 g of strong
//     white flour reads 100% without anyone touching anything;
//   • moving a second flour into the basis moves EVERY other percentage, at once —
//     `deriveFormula` is the only maths, so there is one path to get wrong;
//   • "2 eggs" has no weight the machine can know: it asks, and it can be left out;
//   • a range is disclosed on screen, because saving is when the range dies;
//   • the declaration is required, and since issue #1325 it is the only place the
//     dough total is authored — the weight boxes restate to it, and the screen
//     never prints a second total beside it.
//
// Round-trip is the acceptance bar: what comes back from a stored document is the
// same basis, the same inclusions, the same percentages and the same shape — with
// the gram boxes repopulated at the STORED DECLARATION, which is where they were
// when it was saved. The restate itself is pinned in `FormulaPage.yieldWins.test.ts`.

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

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
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

import FormulaPage from '../src/routes/recipes/FormulaPage.svelte';
import { saveFormula } from '../src/lib/formulaService.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

type IngredientSpec = {
  id: string;
  rawText: string;
  canonId?: string | null;
  grams?: number;
  range?: [number, number];
  count?: number;
};

function ingredient(spec: IngredientSpec) {
  const parsed =
    spec.count !== undefined
      ? {
          // Count-based: no unit at all, which is exactly what gramsFromParsed
          // refuses to guess a weight for.
          quantity: { type: 'single' as const, value: spec.count },
          unit: null,
          item: spec.rawText,
          preparation: [],
          notes: null,
          displayText: spec.rawText,
        }
      : spec.range !== undefined
        ? {
            quantity: { type: 'range' as const, min: spec.range[0], max: spec.range[1] },
            unit: 'ml' as const,
            item: spec.rawText,
            preparation: [],
            notes: null,
            displayText: spec.rawText,
          }
        : spec.grams !== undefined
          ? {
              quantity: { type: 'single' as const, value: spec.grams },
              unit: 'g' as const,
              item: spec.rawText,
              preparation: [],
              notes: null,
              displayText: spec.rawText,
            }
          : null;
  return {
    id: spec.id,
    rawText: spec.rawText,
    parsed,
    canonId: spec.canonId ?? null,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

// The overnight white tin as it exists in Salt today.
const LOAF: IngredientSpec[] = [
  { id: 'ing-flour', rawText: '500 g strong white flour', canonId: 'canon-flour', grams: 500 },
  { id: 'ing-water', rawText: '350 g water', canonId: 'canon-water', grams: 350 },
  { id: 'ing-salt', rawText: '10 g salt', canonId: 'canon-salt', grams: 10 },
  { id: 'ing-yeast', rawText: '7 g instant yeast', canonId: 'canon-yeast', grams: 7 },
];

function makeRecipe(specs: IngredientSpec[] = LOAF, overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    componentRecipeIds: [],
    producesCanonId: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Overnight white tin',
    description: null,
    ingredients: [{ id: 'grp-1', name: null, items: specs.map(ingredient) }],
    steps: [{ id: 'step-1', text: 'Mix.', timer: null, note: null }],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    image: null,
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
    ...overrides,
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

const CANON = [
  canon('canon-flour', 'strong white flour'),
  canon('canon-wholemeal', 'wholemeal flour'),
  canon('canon-water', 'water'),
  canon('canon-salt', 'salt'),
  canon('canon-yeast', 'instant yeast'),
  canon('canon-egg', 'egg'),
  canon('canon-oil', 'olive oil'),
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([makeRecipe()]);
  mockCanonItems._set(CANON);
  mockFormula._set(undefined);
});

function renderPage() {
  return render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
}

/** The percentage shown against a row, by the row's ingredient id. */
function percentsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="formula-row-percent"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

function gramsInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll('input[data-testid="formula-row-grams"]')].map(
    (el) => el as HTMLInputElement,
  );
}

function basisBoxes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-testid="formula-row-basis"] [role="checkbox"]')].map(
    (el) => el as HTMLElement,
  );
}

function includeBoxes(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll('[data-testid="formula-row-include"] [role="checkbox"]'),
  ].map((el) => el as HTMLElement);
}

describe('FormulaPage — the derive', () => {
  it('shows nothing but a loader while the formula is still resolving', () => {
    // `undefined` is NOT `null`. Without the distinction a freshly-derived guess
    // flashes over the stored formula, one frame before it arrives.
    const { queryByTestId } = renderPage();
    expect(queryByTestId('formula-editor')).toBeNull();
  });

  it('reads 500 g of strong white flour as 100% once we know there is no formula', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());
    // Flour 100%, water 70%, salt 2%, yeast 1.4% — checkable by hand.
    expect(percentsOf(container)).toEqual(['100%', '70%', '2%', '1.4%']);
  });

  it('guesses the flour into the basis and leaves everything else out of it', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());
    expect(basisBoxes(container).map((b) => b.getAttribute('data-state'))).toEqual([
      'checked',
      'unchecked',
      'unchecked',
      'unchecked',
    ]);
  });
});

describe('FormulaPage — the basis toggle', () => {
  it('moves EVERY percentage when a second flour joins the basis', async () => {
    // 400 g white + 100 g wholemeal + 350 g water. Against the white alone the
    // water is 87.5%; against both flours it is 70%. Nothing else changed.
    mockRecipes._set([
      makeRecipe([
        {
          id: 'ing-white',
          rawText: '400 g strong white flour',
          canonId: 'canon-flour',
          grams: 400,
        },
        {
          id: 'ing-wholemeal',
          rawText: '100 g wholemeal flour',
          canonId: 'canon-wholemeal',
          grams: 100,
        },
        { id: 'ing-water', rawText: '350 g water', canonId: 'canon-water', grams: 350 },
      ]),
    ]);
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // Both flours are guessed in, so take the wholemeal OUT and put it back — the
    // toggle is the interaction under test in both directions.
    await fireEvent.click(basisBoxes(container)[1]!);
    await waitFor(() => expect(percentsOf(container)[2]).toBe('87.5%'));
    expect(percentsOf(container)).toEqual(['100%', '25%', '87.5%']);

    await fireEvent.click(basisBoxes(container)[1]!);
    await waitFor(() => expect(percentsOf(container)[2]).toBe('70%'));
    expect(percentsOf(container)).toEqual(['80%', '20%', '70%']);
  });
});

describe('FormulaPage — what the machine cannot know', () => {
  it('asks for grams on a count-based line and leaves it out until it gets them', async () => {
    mockRecipes._set([
      makeRecipe([...LOAF, { id: 'ing-egg', rawText: '2 eggs', canonId: 'canon-egg', count: 2 }]),
    ]);
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // Out of the formula, box empty, and told why.
    expect(getByTestId('formula-row-needs-grams')).toBeTruthy();
    expect(gramsInputs(container)[4]!.value).toBe('');
    expect(percentsOf(container)[4]).toBe('—');

    // fireEvent, never userEvent.type (issue #793).
    await fireEvent.input(gramsInputs(container)[4]!, { target: { value: '100' } });
    await waitFor(() => expect(percentsOf(container)[4]).toBe('20%'));

    // And it can be left out again by clearing the box.
    await fireEvent.input(gramsInputs(container)[4]!, { target: { value: '' } });
    await waitFor(() => expect(percentsOf(container)[4]).toBe('—'));
  });

  it('says on screen that a range was taken at the top of its range', async () => {
    // "2–3 tbsp olive oil", parsed to 30–45 ml. Taken at 45 — `quantityToNumber`,
    // the one reduction both this screen and the shopping list now run (issue
    // #917). This test used to pin the midpoint, 37.5 ml → 38 g.
    mockRecipes._set([
      makeRecipe([
        ...LOAF,
        { id: 'ing-oil', rawText: '2–3 tbsp olive oil', canonId: 'canon-oil', range: [30, 45] },
      ]),
    ]);
    const { getByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    const disclosure = getByTestId('formula-range-disclosure');
    expect(disclosure.textContent).toContain('top of the range');
    expect(disclosure.textContent).toContain('2–3 tbsp olive oil');
    // The figure itself, not just the words: this is the only moment anyone can
    // object, and objecting needs the number. 30–45 ml → 45 ml at water-like
    // density → 45 g through the one rounding authority (whole grams at or above
    // 10 — what a domestic scale can actually weigh).
    expect(disclosure.textContent).toContain('45 g');
  });

  it('excludes a weighed ingredient outright and rebases the rest', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await fireEvent.click(includeBoxes(container)[3]!); // the yeast
    await waitFor(() => expect(percentsOf(container)[3]).toBe('—'));
    // The basis did not move, so nothing else did either.
    expect(percentsOf(container).slice(0, 3)).toEqual(['100%', '70%', '2%']);
  });
});

describe('FormulaPage — the declaration', () => {
  it('will not save until something is genuinely declared', async () => {
    // Issue #1325 review (blocking-2): the anchor that lets a blank per-unit box
    // DIVIDE the dough already there is passed for `pieces` only. `tin`'s count
    // defaults to `'1'`, and passing the anchor there too made "1 tin = whatever's
    // already written" trivially true of every recipe — the page opened already
    // declared, and Save was never blocked on saying what this makes. It is
    // blocked on exactly that again: the page opens undeclared, and typing an
    // unreadable count (still, as before) has nothing to divide by either way.
    const { getByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true);
    expect(getByTestId('formula-blocked-reason').textContent).toContain('what this makes');
    expect(getByTestId('formula-dough-total').textContent).toContain('867 g');

    await fireEvent.input(getByTestId('formula-count'), { target: { value: '' } });
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true),
    );
    expect(getByTestId('formula-blocked-reason').textContent).toContain('what this makes');
  });

  it('states the sum of the weights while nothing has been declared', async () => {
    const { getByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // 500 + 350 + 10 + 7 = 867 g of dough as written — the sum of the weights
    // already on the page, and the ONLY figure the card carries while there is no
    // declaration to state instead (issue #1325). The undeclared branch, not the
    // declared one landing on the same number by luck — see
    // `FormulaPage.yieldWins.test.ts`'s "opens genuinely undeclared" case.
    expect(getByTestId('formula-dough-total').textContent).toContain('867 g');
    expect(getByTestId('formula-dough-total').textContent).toContain('As written');
    expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true);
  });

  // Characterisation net, issue #933 Phase 1.
  //
  // `asWrittenDoughGrams` is a RAW SUM of the weights on the page — nothing
  // rounds it on the way in — and this screen's private `formatGrams`
  // (`FormulaPage.svelte:596`) rounds where the two batch-screen copies do not.
  // Every existing assertion here sums to a whole number, so that local round has
  // never been exercised. Phase 3 deletes the copy and makes the round explicit
  // at the call site; this is the row that says whether it stayed the same screen.
  it('rounds a fractional dough total rather than rendering the float', async () => {
    mockRecipes._set([
      makeRecipe([
        {
          id: 'ing-flour',
          rawText: '500 g strong white flour',
          canonId: 'canon-flour',
          grams: 500,
        },
        { id: 'ing-water', rawText: '350.4 g water', canonId: 'canon-water', grams: 350.4 },
        { id: 'ing-salt', rawText: '10.2 g salt', canonId: 'canon-salt', grams: 10.2 },
      ]),
    ]);
    const { getByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // 500 + 350.4 + 10.2 is 860.5999999999999 in IEEE 754 — the exact value this
    // screen would print without the round.
    const total = getByTestId('formula-dough-total').textContent ?? '';
    expect(total).toContain('861 g');
    expect(total).not.toContain('860.5999');
  });

  it('saves the declared shape and the derived percentages', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // The tin answer leads by default. Pick the 900 g quick-fill chip; "how many
    // tins" is already 1 (`EMPTY_DOUGH_ANSWER`).
    const chip = [...container.querySelectorAll('[data-testid="formula-tin-chip"]')].find(
      (el) => el.getAttribute('data-tin-grams') === '900',
    )!;
    await fireEvent.click(chip);

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    expect(written.recipeId).toBe(RECIPE_ID);
    expect(written.schemaVersion).toBe(1);
    expect(written.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 1, unitDoughGrams: 900 },
    });
    expect(written.components).toEqual([
      { ingredientId: 'ing-flour', percent: 100, inBasis: true },
      { ingredientId: 'ing-water', percent: 70, inBasis: false },
      { ingredientId: 'ing-salt', percent: 2, inBasis: false },
      { ingredientId: 'ing-yeast', percent: 1.4, inBasis: false },
    ]);
  });
});

describe('FormulaPage — the round trip', () => {
  // The acceptance bar: a stored formula comes back as the same basis, the same
  // inclusions, the same percentages and the same shape — with the gram boxes
  // repopulated in the RECIPE's own scale. The document holds no grams at all, so
  // this is the anchor recovery doing its job.
  const STORED: Formula = {
    recipeId: RECIPE_ID,
    components: [
      { ingredientId: 'ing-flour', percent: 100, inBasis: true },
      { ingredientId: 'ing-water', percent: 70, inBasis: false },
      // Salt was deliberately left out of this formula: no component, so no row.
      { ingredientId: 'ing-yeast', percent: 1.4, inBasis: false },
      // Hand-entered: the recipe says "2 eggs" and knows nothing about 100 g.
      { ingredientId: 'ing-egg', percent: 20, inBasis: false },
    ],
    referenceYield: {
      kind: 'target',
      shape: { count: 8, unitDoughGrams: 120 },
    },
    schemaVersion: 1,
  };

  beforeEach(() => {
    mockRecipes._set([
      makeRecipe([...LOAF, { id: 'ing-egg', rawText: '2 eggs', canonId: 'canon-egg', count: 2 }]),
    ]);
  });

  it('restores the percentages, the basis, the exclusions and the hand-typed grams', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(STORED);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    expect(percentsOf(container)).toEqual(['100%', '70%', '—', '1.4%', '20%']);
    expect(basisBoxes(container).map((b) => b.getAttribute('data-state'))).toEqual([
      'checked',
      'unchecked',
      'unchecked',
      'unchecked',
      'unchecked',
    ]);
    // Recovered against the recipe's own scale, then restated to the STORED
    // DECLARATION — 8 × 120 g is 960 g of dough, and a 191.4% grand total puts the
    // basis at 501.57 g (issue #1325). What a reload shows is what was saved.
    expect(gramsInputs(container).map((i) => i.value)).toEqual([
      '502',
      '351',
      // The salt is not in this formula, so nothing restated it: its box still
      // holds the recipe's own figure and the row stays out.
      '10',
      '7',
      '100', // the hand-typed egg weight, back again — 20% of the basis
    ]);
  });

  it('restores the declared shape and its count', async () => {
    const { getByTestId } = renderPage();
    mockFormula._set(STORED);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // count > 1 comes back as the "pieces" answer (`seedDoughAnswer`) — a run of
    // eight is rolls, not eight tins.
    expect(getByTestId('formula-pieces')).toBeTruthy();
    expect((getByTestId('formula-piece-count') as HTMLInputElement).value).toBe('8');
    expect((getByTestId('formula-piece-grams') as HTMLInputElement).value).toBe('120');
  });

  it('re-saves the stored formula unchanged', async () => {
    // The strongest form of the bar: reload, touch nothing, save — and the
    // document that goes back is the one that came out.
    const { getByTestId } = renderPage();
    mockFormula._set(STORED);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0]).toEqual(STORED);
  });

  it('does not blow away unsaved work when a snapshot lands', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(STORED);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await fireEvent.click(basisBoxes(container)[1]!); // water into the basis
    // Basis is now 850 g: flour 58.8%, water 41.2%.
    await waitFor(() => expect(percentsOf(container)[0]).toBe('58.8%'));

    // Another member saves the original over the top. LWW settles the document;
    // the DRAFT is not touched while it holds edits.
    mockFormula._set({ ...STORED });
    await waitFor(() => expect(percentsOf(container)[1]).toBe('41.2%'));
  });
});

describe('FormulaPage — the weight answer', () => {
  // #1274 retired the preset-catalogue escape hatch this describe block used to
  // cover ("1 kg sourdough boule", a hand-typed label and bake loss): there is no
  // more preset list to escape, because every answer is now typed directly. What
  // survives of its intent is the third answer itself — a plain weight of dough,
  // with no count and no name — which nothing else in this file exercises (the
  // tin and pieces answers are covered by the declaration and round-trip groups
  // above).

  it('saves a plain weight of dough as one of itself', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    const weightOption = [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes('A weight of dough'),
    )!;
    await fireEvent.click(weightOption);
    await fireEvent.input(getByTestId('formula-total-dough'), { target: { value: '1000' } });

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0]!.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 1, unitDoughGrams: 1000 },
    });
  });
});

describe('FormulaPage — what it refuses', () => {
  it('offers nothing to weigh on an entry that takes no ingredients', async () => {
    mockRecipes._set([makeRecipe([], { kind: 'outing', title: 'Friday takeaway' })]);
    const { queryByTestId, getByText } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByText('Nothing to weigh here')).toBeTruthy());
    expect(queryByTestId('formula-editor')).toBeNull();
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

describe('FormulaPage — what counts as a count', () => {
  it.each(UNIT_COUNT_INPUTS)('takes $label ($text) as $value', async ({ text, value }) => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    const chip = [...container.querySelectorAll('[data-testid="formula-tin-chip"]')].find(
      (el) => el.getAttribute('data-tin-grams') === '900',
    )!;
    await fireEvent.click(chip);
    await fireEvent.input(getByTestId('formula-count'), { target: { value: text } });

    // No count means no shape, and no shape is what has always disabled Save —
    // a half-typed declaration is not a lenient one with a default in the gap.
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(value === null),
    );
    if (value === null) return;

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].referenceYield).toEqual({
      kind: 'target',
      shape: { count: value, unitDoughGrams: 900 },
    });
  });
});

// ─── A formula never stores a vessel (issue #1274, rule-12 claim 4) ─────────────
//
// The vessel is a fact about TONIGHT and is recorded on the batch, never on the
// formula. The reason is not tidiness: a formula's grams stay editable, so a
// vessel stored beside them is a second number free to drift into a lie the next
// time somebody corrects the weight. A batch's are stamped once and never move
// (`tests/batch/transitions.test.ts` in `@salt/domain` pins that half).
//
// This is the mechanical half. It walks the WHOLE saved document rather than
// checking the two keys we happen to have thought of, so a vessel added anywhere
// — on `referenceYield`, inside `shape`, at the top level — fails it.
describe('FormulaPage — the tin never reaches the document', () => {
  function keysDeep(value: unknown, into: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const entry of value) keysDeep(entry, into);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        into.push(key);
        keysDeep(child, into);
      }
    }
    return into;
  }

  it('saves the dough figures and nothing about the tin they came from', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    // Answer it the way that DOES name a vessel on the bake sheet — a 900 g loaf
    // tin. If a vessel were ever going to leak onto a formula, this is the path.
    const chip = [...container.querySelectorAll('[data-testid="formula-tin-chip"]')].find(
      (el) => el.getAttribute('data-tin-grams') === '900',
    )!;
    await fireEvent.click(chip);
    await fireEvent.input(getByTestId('formula-count'), { target: { value: '2' } });

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));

    const written = vi.mocked(saveFormula).mock.calls[0]![0]!;
    expect(written.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 2, unitDoughGrams: 900 },
    });
    // No key ANYWHERE in the document names a vessel or a tin.
    const keys = keysDeep(written).map((key) => key.toLowerCase());
    expect(keys.filter((key) => key.includes('vessel') || key.includes('tin'))).toEqual([]);
    // And the grams the tin filled in are still an ordinary editable box, not a
    // locked answer derived from it.
    expect(getByTestId('formula-grams-each').hasAttribute('readonly')).toBe(false);
    expect(getByTestId('formula-grams-each').hasAttribute('disabled')).toBe(false);
  });
});

// ─── The same three answers, on the recipe's own screen (issue #1274) ───────────
//
// The formula screen asks the same question as the bake sheet and stores a
// DIFFERENT thing: dough figures alone, no vessel. What makes it a recipe edit
// rather than a run is that answering here restates the weights above to the
// declaration (issue #1325) instead of recording a vessel for tonight, and that
// must keep working whichever answer is used.
describe('FormulaPage — what are you filling?', () => {
  async function pickAnswer(container: Element, label: string): Promise<void> {
    const option = [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes(label),
    );
    if (option === undefined) throw new Error(`no answer labelled ${label}`);
    await fireEvent.click(option);
  }

  it('saves a count of pieces as itself', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await pickAnswer(container, 'A number of pieces');
    await fireEvent.input(getByTestId('formula-piece-count'), { target: { value: '8' } });
    await fireEvent.input(getByTestId('formula-piece-grams'), { target: { value: '120' } });

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0]!.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 8, unitDoughGrams: 120 },
    });
  });

  it('reads the declaration back as dough, and states it as the only total', async () => {
    const { getByTestId, container, queryByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    const chip = [...container.querySelectorAll('[data-testid="formula-tin-chip"]')].find(
      (el) => el.getAttribute('data-tin-grams') === '900',
    )!;
    await fireEvent.click(chip);
    await fireEvent.input(getByTestId('formula-count'), { target: { value: '2' } });
    await fireEvent.blur(getByTestId('formula-count'));

    await waitFor(() =>
      expect(getByTestId('formula-dough-total')).toHaveTextContent('2 × 900 g — 1.8 kg of dough'),
    );
    // WHAT MAKES THIS A RECIPE EDIT, after issue #1325: the weights above have
    // already moved to the declaration, and the card says so instead of printing a
    // second figure and a note reconciling the two.
    expect(getByTestId('formula-restate-note')).toHaveTextContent('Change what it makes');
    expect(queryByTestId('formula-declaration-drift')).toBeNull();
    expect(getByTestId('formula-dough-total').textContent).not.toContain('867');
  });

  it('mentions no bake loss, no baked weight and no named shape, on any answer', async () => {
    const { getByTestId, container, queryByTestId } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    for (const label of ['A loaf tin', 'A number of pieces', 'A weight of dough']) {
      await pickAnswer(container, label);
      expect(container.textContent).not.toMatch(/bake loss/i);
      expect(container.textContent).not.toMatch(/each baked/i);
      expect(queryByTestId('formula-shape-select')).toBeNull();
      expect(queryByTestId('formula-custom-label')).toBeNull();
    }
  });
});

// ─── A tray on the FORMULA screen (issue #1274 phase 2, rule-12 claim 4) ────────
//
// Same fourth answer, and the difference that matters: the formula screen fills
// NOTHING from it. A vessel is a fact about tonight; a recipe is written for a
// quantity of dough. The grams the tray suggested are stored; the tray is not.
describe('FormulaPage — a tray fills the grams box and nothing else', () => {
  async function pickTray(container: Element): Promise<void> {
    const option = [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes('A tray or dish'),
    );
    if (option === undefined) throw new Error('no tray answer');
    await fireEvent.click(option);
  }

  it('leaves the grams editable after the vessel fills it, and stores no vessel', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await pickTray(container);
    await fireEvent.input(getByTestId('formula-tray-length'), { target: { value: '30' } });
    await fireEvent.input(getByTestId('formula-tray-width'), { target: { value: '40' } });
    await fireEvent.click(getByTestId('formula-tray-suggest'));

    await waitFor(() => expect(getByTestId('formula-tray-grams')).toHaveValue('1080'));
    // AN ORDINARY BOX, and typing wins over the suggestion. A locked figure would
    // make an invented number load-bearing on the scaling — strictly worse than
    // the bake loss this issue deleted, which was merely decorative.
    const box = getByTestId('formula-tray-grams');
    expect(box.hasAttribute('readonly')).toBe(false);
    expect(box.hasAttribute('disabled')).toBe(false);
    await fireEvent.input(box, { target: { value: '950' } });

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));

    const written = vi.mocked(saveFormula).mock.calls[0]![0]!;
    // Only `{ count, unitDoughGrams }` under `referenceYield.shape` — the typed
    // figure, not the suggested one, and no trace of the tray it came from.
    expect(written.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 1, unitDoughGrams: 950 },
    });
    const keys = JSON.stringify(written).toLowerCase();
    expect(keys).not.toContain('vessel');
    expect(keys).not.toContain('tray');
    expect(keys).not.toContain('cm');
  });

  it('takes a dish by volume, and a hand-set dough depth', async () => {
    const { getByTestId, container } = renderPage();
    mockFormula._set(null);
    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());

    await pickTray(container);
    // A deeper dough in a smaller footprint — the depth box is what a focaccia and
    // a deep-dish differ by, and it is the one measurement that may be left blank.
    await fireEvent.input(getByTestId('formula-tray-length'), { target: { value: '20' } });
    await fireEvent.input(getByTestId('formula-tray-width'), { target: { value: '25' } });
    await fireEvent.input(getByTestId('formula-tray-depth'), { target: { value: '4' } });
    await fireEvent.click(getByTestId('formula-tray-suggest'));
    await waitFor(() => expect(getByTestId('formula-tray-grams')).toHaveValue('900'));

    // The same 2 litres, described the other way, suggests the same weight — there
    // is one coefficient and it works over volume.
    const byVolume = [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes('A volume'),
    )!;
    await fireEvent.click(byVolume);
    await fireEvent.input(getByTestId('formula-tray-volume'), { target: { value: '2' } });
    const litres = [...container.querySelectorAll('[role="radio"]')].find(
      (el) => el.textContent?.trim() === 'litres',
    )!;
    await fireEvent.click(litres);
    await fireEvent.click(getByTestId('formula-tray-suggest'));
    await waitFor(() => expect(getByTestId('formula-tray-grams')).toHaveValue('900'));
  });

  it('re-opens showing the dough weight and no vessel', async () => {
    // The round trip: a formula saved from a tray comes back as a plain amount,
    // because a plain amount is all it ever held.
    const { getByTestId, queryByTestId } = renderPage();
    mockFormula._set({
      recipeId: RECIPE_ID,
      schemaVersion: 1,
      components: [{ ingredientId: 'ing-flour', percent: 100, inBasis: true }],
      referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 950 } },
    } as Formula);

    await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());
    // count === 1 seeds the tin answer, carrying the weight — there is no tray to
    // come back to, and nothing on screen claims there was one.
    expect(getByTestId('formula-dough-total')).toHaveTextContent('950 g of dough');
    expect(queryByTestId('formula-tray-grams')).toBeNull();
  });
});
