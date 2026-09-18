import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { Formula } from '@salt/domain/schemas';

// The jar you actually have (issue #1402, phase 3) — swapping the curing salt a
// recipe calls for at the point of starting a run.
//
// What this suite holds to, and none of it is enforced anywhere else:
//
//   • ONLY THE PAIR MEMBER IS OFFERED. Crossing the pairs swaps a nitrate-bearing
//     product for a nitrite-only one, which changes what the cure is FIT FOR rather
//     than merely its concentration — a suitability question Salt does not ask, and
//     a picker offering all four would answer one by accident;
//   • the weights convert at a CONSTANT NITRITE DOSE and the plain salt absorbs the
//     difference, both ways, to the gram;
//   • a salt total too low to carry the dose REFUSES WITH BOTH FIGURES and Start
//     stays disabled — the choice was the person's own, so unlike a refused
//     leavening opinion it is surfaced rather than dropped;
//   • the run RECORDS WHICH PRODUCT WENT ON, and records nothing when the recipe's
//     own was used.

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

// A coppa: a pork shoulder, ordinary salt, cure #1. The recipe's own words — the
// ones the preview joins against, and the one the substitution replaces.
const RECIPE = {
  id: RECIPE_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Coppa',
  description: null,
  ingredients: [
    {
      id: 'grp-1',
      name: null,
      items: [
        ingredient('ing-meat', '2.4 kg pork shoulder'),
        ingredient('ing-salt', '25 g fine sea salt'),
        ingredient('ing-cure', '2.5 g Prague powder #1'),
      ],
    },
  ],
  steps: [{ id: 'step-1', text: 'Rub and bag.', timer: null, note: null }],
  metadata: { servings: null, tags: [] },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

/**
 * The coppa's formula as it is stored after a derive: 1 kg of shoulder as the 100%,
 * 2.5% plain salt, 0.25% cure #1 with the window its product dictates already
 * stamped on.
 */
function coppaFormula(saltPercent = 2.5): Formula {
  return {
    recipeId: RECIPE_ID,
    schemaVersion: 1,
    components: [
      { ingredientId: 'ing-meat', percent: 100, inBasis: true },
      { ingredientId: 'ing-salt', percent: saltPercent, inBasis: false, saltProduct: 'plain' },
      {
        ingredientId: 'ing-cure',
        percent: 0.25,
        inBasis: false,
        saltProduct: 'cure1',
        minPercent: 0.15,
        maxPercent: 0.3,
      },
    ],
    referenceYield: { kind: 'basis', grams: 1000 },
  } as Formula;
}

/** A loaf: nothing here names a curing salt, so there is nothing to offer. */
const BREAD_FORMULA: Formula = {
  recipeId: RECIPE_ID,
  schemaVersion: 1,
  components: [
    { ingredientId: 'ing-meat', percent: 100, inBasis: true },
    { ingredientId: 'ing-salt', percent: 2, inBasis: false },
  ],
  referenceYield: { kind: 'target', shape: { count: 1, unitDoughGrams: 900 } },
} as Formula;

beforeEach(() => {
  vi.clearAllMocks();
  mockStartBatch.mockResolvedValue({ kind: 'ok', value: { id: 'batch-9' } });
});

afterEach(() => {
  cleanup();
  // `tests/setup.ts` already resets `document.body.style.pointerEvents` globally
  // (UT-C3). This only clears the portal nodes bits-ui leaves behind for the
  // product picker.
  document.body.innerHTML = '';
});

function renderSheet(formula: Formula) {
  return render(RecipeBakeBatchSheet, { props: { recipe: RECIPE, formula, open: true } });
}

function previewGrams(): string[] {
  return screen
    .queryAllByTestId('bake-batch-preview-grams')
    .map((el) => el.textContent?.trim() ?? '');
}

/** The two answers on offer, in the order they are rendered. */
function options(): HTMLElement[] {
  return screen.queryAllByTestId('bake-batch-substitute-option');
}

/** Which product each button offers, and which one is currently chosen. */
function offered(): string[] {
  return options().map((el) => el.getAttribute('data-salt-product') ?? '');
}

function chosen(): string | null {
  const picked = options().find((el) => el.getAttribute('data-chosen') === 'true');
  return picked?.getAttribute('data-salt-product') ?? null;
}

/** Tap the button offering this product. */
async function pick(product: string): Promise<void> {
  const button = options().find((el) => el.getAttribute('data-salt-product') === product);
  if (button === undefined) throw new Error(`no option for ${product}`);
  await fireEvent.click(button);
  await waitFor(() => expect(chosen()).toBe(product));
}

describe('RecipeBakeBatchSheet — which jar are you using', () => {
  it('offers the pair member and nothing else', async () => {
    renderSheet(coppaFormula());
    await waitFor(() => expect(screen.getByTestId('bake-batch-substitute')).toBeInTheDocument());

    // TWO ANSWERS AND NEVER MORE: what the recipe says, and the other member of its
    // pair. Cure #2 and Salvianda are nitrate-bearing and are NOT offered — crossing
    // changes what the cure is fit for. Nor is plain salt, which is not a cure.
    expect(offered()).toEqual(['cure1', 'nitritedCuringSalt']);
    // And it opens on what the recipe says.
    expect(chosen()).toBe('cure1');
  });

  it('is not offered at all for a formula that names no curing salt', async () => {
    renderSheet(BREAD_FORMULA);
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-substitute')).toBeNull();
  });

  it('converts every weight in the preview, and back again exactly', async () => {
    renderSheet(coppaFormula());
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    expect(previewGrams()).toEqual(['1000 g', '25 g', '2.5 g']);

    await pick('nitritedCuringSalt');

    // 2.5 g of cure #1 is 0.156 g of nitrite; ÷ 0.006 is 26 g of the substitute,
    // leaving 27.5 − 26 = 1.5 g of plain salt. The meat does not move.
    await waitFor(() => expect(previewGrams()).toEqual(['1000 g', '1.5 g', '26 g']));

    await pick('cure1');
    await waitFor(() => expect(previewGrams()).toEqual(['1000 g', '25 g', '2.5 g']));
  });

  it('records which product actually went on the meat', async () => {
    renderSheet(coppaFormula());
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await pick('nitritedCuringSalt');
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    const input = mockStartBatch.mock.calls[0]![0];
    expect(input.cureSaltSubstitution).toEqual({ from: 'cure1', to: 'nitritedCuringSalt' });
    // THE SUBSTITUTED FORMULA IS WHAT IS FROZEN, not the recipe's own — the preview
    // and the document are the same arithmetic.
    const cure = input.formula.components.find(
      (c: { ingredientId: string }) => c.ingredientId === 'ing-cure',
    );
    expect(cure).toMatchObject({ saltProduct: 'nitritedCuringSalt', percent: 2.6042 });
  });

  it('records nothing when the recipe’s own product was used', async () => {
    renderSheet(coppaFormula());
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await fireEvent.click(screen.getByTestId('bake-batch-confirm'));

    await waitFor(() => expect(mockStartBatch).toHaveBeenCalledTimes(1));
    // Absent, not an empty object: a run that used what the recipe named has
    // nothing to say (see `BatchSchema.cureSaltSubstitution`).
    expect('cureSaltSubstitution' in mockStartBatch.mock.calls[0]![0]).toBe(false);
  });

  it('refuses a salt total too low to carry the dose, with both figures', async () => {
    // 0.1% of plain salt beside 0.25% of cure #1: the diluted form would need 2.6%
    // of the meat and there is 0.35% of salt-bearing weight to find it in. Neither
    // number is fudged — clamping the substitute under-cures, clamping the residual
    // over-salts.
    renderSheet(coppaFormula(0.1));
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await pick('nitritedCuringSalt');

    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-substitute-refused')).toBeInTheDocument(),
    );
    const said = (screen.getByTestId('bake-batch-substitute-refused').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(said).toContain('2.6042%');
    expect(said).toContain('0.35%');

    // START STAYS DISABLED until the choice is changed back, and the recipe's own
    // numbers are not left on screen underneath the refusal — they are not what was
    // asked for.
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
    expect(screen.queryByTestId('bake-batch-preview')).toBeNull();

    await pick('cure1');
    await waitFor(() => expect(screen.queryByTestId('bake-batch-substitute-refused')).toBeNull());
    expect(screen.getByTestId('bake-batch-confirm')).not.toBeDisabled();
  });

  it('refuses when the freed-up weight has no plain salt to go into', async () => {
    // The other direction: the dilute product IS the salt, and swapping to the
    // concentrated one frees up most of that weight. With no ordinary-salt row to
    // put it in there is nowhere for it to go, and dropping it would quietly make a
    // less salty cure.
    const noPlain = {
      recipeId: RECIPE_ID,
      schemaVersion: 1,
      components: [
        { ingredientId: 'ing-meat', percent: 100, inBasis: true },
        {
          ingredientId: 'ing-cure',
          percent: 2.6,
          inBasis: false,
          saltProduct: 'nitritedCuringSalt',
          minPercent: 2,
          maxPercent: 3.15,
        },
      ],
      referenceYield: { kind: 'basis', grams: 1000 },
    } as Formula;
    renderSheet(noPlain);
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await pick('cure1');

    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-substitute-refused')).toBeInTheDocument(),
    );
    const said = screen.getByTestId('bake-batch-substitute-refused').textContent ?? '';
    // 2.6% of the dilute product carries the nitrite of 0.2496% of cure #1, so
    // 2.3504% of the basis has nowhere to go. Both numbers, no fudge.
    expect(said).toContain('2.3504%');
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
  });

  it('says so when the formula stops offering the swap under an open sheet', async () => {
    // Not reachable by tapping — the two buttons are the formula's own product and
    // its pair member — but reachable when the FORMULA changes while the sheet is
    // open. Saying so beats previewing the recipe's untouched numbers as though they
    // were the swap that was asked for.
    const rendered = renderSheet(coppaFormula());
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await pick('nitritedCuringSalt');
    await waitFor(() => expect(previewGrams()).toEqual(['1000 g', '1.5 g', '26 g']));

    await rendered.rerender({ recipe: RECIPE, formula: BREAD_FORMULA, open: true });

    await waitFor(() =>
      expect(screen.getByTestId('bake-batch-substitute-refused')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('bake-batch-substitute-refused')).toHaveTextContent(
      'cannot be swapped in for this formula',
    );
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
  });

  it('offers nothing when the formula names more than one curing salt', async () => {
    // No single answer to "which one is being swapped", so there is nothing to
    // offer rather than a guess at which row the person meant.
    const twoCures = {
      ...coppaFormula(),
      components: [
        { ingredientId: 'ing-meat', percent: 100, inBasis: true },
        {
          ingredientId: 'ing-salt',
          percent: 0.25,
          inBasis: false,
          saltProduct: 'cure2',
          minPercent: 0.15,
          maxPercent: 0.3,
        },
        {
          ingredientId: 'ing-cure',
          percent: 0.25,
          inBasis: false,
          saltProduct: 'cure1',
          minPercent: 0.15,
          maxPercent: 0.3,
        },
      ],
    } as Formula;
    renderSheet(twoCures);
    await waitFor(() => expect(screen.getByTestId('bake-batch-sheet')).toBeInTheDocument());
    expect(screen.queryByTestId('bake-batch-substitute')).toBeNull();
  });

  it('lets the solve refuse a converted dose outside the substitute’s own window', async () => {
    // Cure #1 at 0.16% is inside ITS window; the same nitrite as nitrited curing
    // salt is 1.667%, below that product's 2% floor. The substitution returns it and
    // `solveFormula` refuses it in the shared wording — there is no second check
    // anywhere, and the substitution does not grow one.
    const formula = coppaFormula();
    const low = {
      ...formula,
      components: formula.components.map((component) =>
        component.ingredientId === 'ing-cure' ? { ...component, percent: 0.16 } : component,
      ),
    } as Formula;
    renderSheet(low);
    await waitFor(() => expect(screen.getByTestId('bake-batch-preview')).toBeInTheDocument());
    await pick('nitritedCuringSalt');

    await waitFor(() => expect(screen.getByTestId('bake-batch-unsolvable')).toBeInTheDocument());
    const said = (screen.getByTestId('bake-batch-unsolvable').textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(said).toContain('outside the 2%–3.15% window it has to sit in');
    expect(screen.getByTestId('bake-batch-confirm')).toBeDisabled();
  });
});
