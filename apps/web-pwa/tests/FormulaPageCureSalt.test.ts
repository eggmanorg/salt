import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { CanonItem, Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// The cure-salt rail on the formula screen (issue #1402, phase 2).
//
// The arithmetic and every claim about the WINDOWS live in
// `packages/domain/tests/formula/cureSalt.test.ts`. What is pinned here is the
// screen's half, which the domain suite cannot see:
//
//   1. THE PRODUCT IS PROPOSED AND CONFIRMED IN ONE TAP, and the answer — including
//      the answer "none" — survives a save and a reopen. Clearing it is what an
//      ingredient that is not a curing salt looks like, so a re-guess on reload
//      would make clearing impossible to keep.
//   2. THE CONTROL IS ON EVERY INCLUDED ROW, not only the rows the recogniser knows
//      by name. That is what keeps the keyword list off the safety path: gate the
//      control on recognition and a missing guess costs a BOUND rather than a tap.
//   3. A REFUSED WINDOW STOPS THE SAVE, named, with its percentage and its window —
//      and it is the solve's refusal being read out, not a second check. Naming the
//      other product flips which figure is refused.
//   4. A SAFE CURE FORMULA IS UNCHANGED. Nothing new appears, no dialog, no
//      dismissible warning, no box for the bound, and a re-save keeps both the
//      product and the window it dictates.

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

// A coppa: 1 000 g of trimmed shoulder as the 100%, 2.5% salt, 0.25% cure #1 — the
// standard dose, and the worked example the issue uses. No flour anywhere, so the
// basis is a tap rather than a guess, which is the honest shape for every craft but
// bread.
const COPPA: IngredientSpec[] = [
  { id: 'ing-meat', rawText: '1000 g pork shoulder, trimmed', grams: 1000 },
  { id: 'ing-salt', rawText: '25 g sea salt', grams: 25 },
  { id: 'ing-cure', rawText: '2.5 g cure #1', grams: 2.5 },
];

function coppa(): Recipe {
  return {
    ...emptyRecipe(RECIPE_ID, WRITTEN_AT),
    title: 'Coppa',
    ingredients: [{ ...emptyIngredientGroup('grp-1'), items: COPPA.map(weighed) }],
    steps: [newStep('step-1', 'Rub, bag, hang.')],
    updatedAt: WRITTEN_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([coppa()]);
  mockCanonItems._set([]);
  mockFormula._set(undefined);
});

afterEach(() => {
  cleanup();
  // `tests/setup.ts` already resets `document.body.style.pointerEvents` globally
  // (UT-C3) — this only clears the portal nodes bits-ui leaves behind, which the
  // per-row pickers here create.
  document.body.innerHTML = '';
});

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

/** Each row's product picker, in row order. */
function productTriggers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-testid="formula-row-salt-product"]')].map(
    (el) => el as HTMLElement,
  );
}

/** What each row's picker currently says it is, as the stored value. */
function products(container: HTMLElement): string[] {
  return productTriggers(container).map((el) => el.getAttribute('data-salt-product') ?? '');
}

/** Open the given row's picker and choose the option with this label. */
async function pickProduct(container: HTMLElement, rowIndex: number, label: string): Promise<void> {
  await userEvent.click(productTriggers(container)[rowIndex]!);
  await waitFor(() => screen.getByRole('option', { name: label }));
  await userEvent.click(screen.getByRole('option', { name: label }));
  await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
}

/** Open a coppa with its shoulder in the basis and a weight declared. */
async function openCoppa() {
  const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
  mockFormula._set(null);
  await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
  await fireEvent.click(basisBoxes(rendered.container)[0]!);
  const option = [...rendered.container.querySelectorAll('[role="radio"]')].find((el) =>
    el.textContent?.includes('A weight of what goes in'),
  );
  if (option === undefined) throw new Error('no basis answer');
  await fireEvent.click(option);
  await fireEvent.input(rendered.getByTestId('formula-basis-grams'), {
    target: { value: '1000' },
  });
  await fireEvent.blur(rendered.getByTestId('formula-basis-grams'));
  return rendered;
}

async function setGrams(container: HTMLElement, rowIndex: number, value: string): Promise<void> {
  const box = gramsInputs(container)[rowIndex]!;
  await fireEvent.input(box, { target: { value } });
  await fireEvent.blur(box);
}

function blockedText(): string {
  const el = screen.queryByTestId('formula-blocked-reason');
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('FormulaPage — which curing salt is in the jar', () => {
  // ─── Claim 1: proposed, confirmed in one tap, and it sticks ──────────────────

  it('proposes the product from the ingredient’s own words', async () => {
    const { container } = await openCoppa();
    // Only the cure line is recognised; the meat and the salt are not curing salts
    // and "salt" alone must not reach either family.
    expect(products(container)).toEqual(['', '', 'cure1']);
  });

  it('keeps a picked product across a save and a reopen, with its window', async () => {
    const { container, getByTestId } = await openCoppa();
    // 0.25% is a safe dose for either concentrated product, so naming cure #2 is a
    // change of fact and not of arithmetic.
    await pickProduct(container, 2, 'Cure #2 (Prague powder #2)');
    expect(products(container)).toEqual(['', '', 'cure2']);

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    const cure = written.components.find((c) => c.ingredientId === 'ing-cure');
    // THE PRODUCT IS CARRIED; THE WINDOW IS RECOMPUTED FROM IT. Both land on the
    // document, and the bound is the table's rather than anything the screen held.
    expect(cure).toMatchObject({ saltProduct: 'cure2', minPercent: 0.15, maxPercent: 0.3 });

    mockFormula._set(written);
    await waitFor(() => expect(products(container)).toEqual(['', '', 'cure2']));
  });

  it('proposes a product for an ingredient added after the formula was first mapped', async () => {
    // Should-fix 4 from the #1402 review: the recogniser used to key on whether a
    // FORMULA existed rather than whether THIS component did, so an ingredient
    // added to the recipe after the formula was first saved got no proposal and no
    // bound — silently, since a missing product announces nothing the way an
    // unchecked basis box does.
    const existing: Formula = {
      recipeId: RECIPE_ID,
      components: [
        { ingredientId: 'ing-meat', percent: 100, inBasis: true },
        { ingredientId: 'ing-salt', percent: 2.5, inBasis: false },
        // ing-cure has no stored component: it is new since this formula was saved.
      ],
      referenceYield: { kind: 'basis', grams: 1000 },
      target: null,
      schemaVersion: 1,
    };
    const rendered = render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
    mockFormula._set(existing);
    await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());

    const includeBoxes = [
      ...rendered.container.querySelectorAll(
        '[data-testid="formula-row-include"] [role="checkbox"]',
      ),
    ] as HTMLElement[];
    // Bringing the new row into the formula reveals its picker — pre-filled with
    // the recogniser's guess, not empty the way it silently was before the fix.
    await fireEvent.click(includeBoxes[2]!);
    await waitFor(() => expect(products(rendered.container)).toEqual(['', '', 'cure1']));
  });

  it('keeps a CLEARED product cleared across a reopen', async () => {
    // THE HALF A RE-GUESS WOULD BREAK. "Not a curing salt" is a real answer, and if
    // the recogniser fired again on reload it would come back as cure #1 — so
    // clearing it would be impossible to keep and the bound impossible to remove
    // from a line that was recognised by mistake.
    const { container, getByTestId } = await openCoppa();
    await pickProduct(container, 2, 'Not a curing salt');
    expect(products(container)).toEqual(['', '', '']);

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    const cure = written.components.find((c) => c.ingredientId === 'ing-cure')!;
    expect(cure.saltProduct).toBeUndefined();
    // No product, no window — the rail is on the dose of a NAMED product.
    expect(cure.minPercent).toBeUndefined();
    expect(cure.maxPercent).toBeUndefined();

    mockFormula._set(written);
    await waitFor(() => expect(products(container)).toEqual(['', '', '']));
  });

  // ─── Claim 2: the control is on every included row ───────────────────────────

  it('offers the product on every included row, not only the recognised ones', async () => {
    // GATE THIS ON RECOGNITION AND A MISSING GUESS COSTS A BOUND rather than a tap:
    // a curing salt the keyword list does not know — "Sel Rose", a shop's own brand
    // — could never be named, and therefore never bounded.
    const { container } = await openCoppa();
    expect(productTriggers(container)).toHaveLength(3);

    // And a row with no weight is not a component, so it can carry no bound: that
    // is the only gate.
    await setGrams(container, 1, '');
    await waitFor(() => expect(productTriggers(container)).toHaveLength(2));
  });

  it('bounds an unrecognised line once somebody names its product', async () => {
    const { container, getByTestId } = await openCoppa();
    // The sea salt, named as a dilute curing salt at 2.5% — which is its window.
    await pickProduct(container, 1, 'Nitrited curing salt');
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    expect(written.components.find((c) => c.ingredientId === 'ing-salt')).toMatchObject({
      saltProduct: 'nitritedCuringSalt',
      minPercent: 2,
      maxPercent: 3.15,
    });
  });

  // ─── Claim 3: a refused window stops the save, named ─────────────────────────

  it('refuses to save an out-of-window dose, naming the line, the figure and the window', async () => {
    const { container, getByTestId } = await openCoppa();
    await setGrams(container, 2, '12');

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true),
    );
    expect(blockedText()).toContain(
      'That would put “2.5 g cure #1” at 1.2% of the basis, outside the 0.15%–0.3% window it has to sit in.',
    );
    // And it says what there is to do, which on this screen is not "go to the
    // formula screen".
    expect(blockedText()).toContain('Name the product that is actually in the jar');
  });

  it('flips which figure is refused when the named product changes', async () => {
    // 3% is right for a dilute product and a twelvefold overdose of a concentrated
    // one. The same number, two products, opposite answers — which a single
    // cure-salt window could not produce.
    const { container, getByTestId } = await openCoppa();
    await setGrams(container, 2, '30');
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true),
    );
    expect(blockedText()).toContain('outside the 0.15%–0.3% window');

    await pickProduct(container, 2, 'Nitrited curing salt');
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    expect(screen.queryByTestId('formula-blocked-reason')).toBeNull();
  });

  it('refuses a basis mapped to the wrong ingredient, which does the same thing', async () => {
    // The second thing the rail earns its place catching. Put the SALT in the basis
    // instead of the meat and the cure's percentage moves by a factor of forty.
    const { container, getByTestId } = await openCoppa();
    await fireEvent.click(basisBoxes(container)[0]!);
    await fireEvent.click(basisBoxes(container)[1]!);

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true),
    );
    expect(blockedText()).toContain('outside the 0.15%–0.3% window it has to sit in');
  });

  // ─── Claim 4: a safe formula is unchanged ────────────────────────────────────

  it('changes nothing about a safe cure formula, and offers no way past the refusal', async () => {
    const { container, getByTestId } = await openCoppa();

    // Safe: nothing appears.
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    expect(screen.queryByTestId('formula-blocked-reason')).toBeNull();

    // Refused: still nothing to dismiss and nothing to confirm. Salt records rather
    // than polices everywhere else; this is the one place it says no, and a refusal
    // you can tap past is not one.
    await setGrams(container, 2, '12');
    await waitFor(() => expect(blockedText()).toContain('outside the'));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).not.toMatch(/are you sure/i);
    expect(container.textContent).not.toMatch(/proceed anyway/i);
    expect(container.textContent).not.toMatch(/dismiss/i);
  });

  it('offers no box for the window itself, on any row', async () => {
    // The bound is recomputed from the product on every derive, so there is nothing
    // to edit — and a hand-editable window would be a way to widen one without
    // changing what the ingredient is.
    const { container } = await openCoppa();
    const labels = [...container.querySelectorAll('label')].map((el) => el.textContent ?? '');
    expect(labels.some((label) => /min|max|window|bound/i.test(label))).toBe(false);
  });
});
