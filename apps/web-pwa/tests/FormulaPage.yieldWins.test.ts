import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { CanonItem, Recipe } from '@salt/domain';
import type { Formula } from '@salt/domain/schemas';

// THE DECLARED YIELD WINS (issue #1325) — the rule-12 pin.
//
// The formula screen used to print the sum of its weight boxes AND the declared
// yield, and a note reconciling the two. This file holds the claims that replaced
// it, each stated with the boundary it actually has rather than as an absolute:
//
//   1. SUM. Once a yield is declared, the included weight boxes sum to the
//      declared dough weight — to within the per-row rounding `roundGrams`
//      already permits, which is at most N × 0.5 g across N rows. That residual
//      is `rounding.ts`'s stated policy (rounded parts are never reconciled to a
//      rounded total) and it is invisible rather than fixed: the card prints the
//      declaration and no box sum, so there are never two totals to disagree.
//   2. PROPORTIONS. A restate does not move the percentages. Exactly, not merely
//      within rounding — `Row.exactGrams` carries `solveFormula`'s unrounded
//      figure beside the rounded one the box shows, so the next derive sees what
//      the solve produced rather than what a scale could read off it.
//   3. IDEMPOTENCE. Committing again at an unchanged declaration moves nothing,
//      which is what stops repeated commits creeping the figures. It follows from
//      (2): identical percentages at an identical yield solve to identical grams.
//   4. ONE TOTAL. No box sum renders beside a declaration, and the re-anchoring
//      note is gone from the screen.
//
// And the rule that makes the screen explicable, pinned alongside them: A WEIGHT
// BOX AUTHORS RATIOS, THE DECLARATION AUTHORS THE TOTAL. Typing 600 into the flour
// under a declared 900 g tin asks for more flour relative to everything else, so
// the list restates back to 900 g at the ratio that was asked for.

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

// Five seams, which is UT-B1's cap: the two stores the page reads, the two it
// writes through, and the back button. `svelte-spa-router` needs none — the page
// reaches it only through `lib/nav.js`, which is mocked here.
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

type IngredientSpec = { id: string; rawText: string; canonId: string; grams: number };

/** A weighed, already-matched line — the real builder, then the two later phases. */
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
    canonId: spec.canonId,
    matchState: 'matched' as const,
  };
}

// The overnight white tin as Salt holds it: 500 + 350 + 10 + 7 = 867 g of dough
// as written, against a 900 g tin. Small, real, and checkable by hand.
const LOAF: IngredientSpec[] = [
  { id: 'ing-flour', rawText: '500 g strong white flour', canonId: 'canon-flour', grams: 500 },
  { id: 'ing-water', rawText: '350 g water', canonId: 'canon-water', grams: 350 },
  { id: 'ing-salt', rawText: '10 g salt', canonId: 'canon-salt', grams: 10 },
  { id: 'ing-yeast', rawText: '7 g instant yeast', canonId: 'canon-yeast', grams: 7 },
];
const AS_WRITTEN_GRAMS = 867;

function overnightTin(): Recipe {
  return {
    ...emptyRecipe(RECIPE_ID, WRITTEN_AT),
    title: 'Overnight white tin',
    ingredients: [{ ...emptyIngredientGroup('grp-1'), items: LOAF.map(weighed) }],
    steps: [newStep('step-1', 'Mix.')],
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

const CANON = [
  canon('canon-flour', 'strong white flour'),
  canon('canon-water', 'water'),
  canon('canon-salt', 'salt'),
  canon('canon-yeast', 'instant yeast'),
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([overnightTin()]);
  mockCanonItems._set(CANON);
  mockFormula._set(undefined);
});

function renderPage() {
  return render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
}

function gramsInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll('input[data-testid="formula-row-grams"]')].map(
    (el) => el as HTMLInputElement,
  );
}

function weights(container: HTMLElement): string[] {
  return gramsInputs(container).map((input) => input.value);
}

function weightSum(container: HTMLElement): number {
  return weights(container).reduce((sum, text) => sum + Number(text), 0);
}

function basisBoxes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-testid="formula-row-basis"] [role="checkbox"]')].map(
    (el) => el as HTMLElement,
  );
}

function percents(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="formula-row-percent"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

/** The one commit every case starts from: declare a single tin of `grams`. */
async function declareTin(container: HTMLElement, grams: number): Promise<void> {
  const chip = [...container.querySelectorAll('[data-testid="formula-tin-chip"]')].find(
    (el) => el.getAttribute('data-tin-grams') === String(grams),
  );
  if (chip === undefined) throw new Error(`no ${grams} g chip`);
  await fireEvent.click(chip);
}

async function ready(getByTestId: (id: string) => HTMLElement): Promise<void> {
  mockFormula._set(null);
  await waitFor(() => expect(getByTestId('formula-editor')).toBeTruthy());
}

describe('FormulaPage — the declared yield wins', () => {
  it('restates every weight to the declared tin, and says what the recipe said', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    expect(weights(container)).toEqual(['500', '350', '10', '7']);

    await declareTin(container, 900);

    // 867 g of ingredients at a 173.4% grand total: a 900 g tin puts the basis at
    // 900 ÷ 1.734 = 519.03 g, and every row follows through `roundGrams`.
    await waitFor(() => expect(weights(container)).toEqual(['519', '363', '10', '7.3']));

    // Every weight that moved says what the recipe itself had — beside the figure,
    // and it persists rather than vanishing.
    const said = [...container.querySelectorAll('[data-testid="formula-row-restated"]')].map(
      (el) => el.textContent?.trim() ?? '',
    );
    expect(said).toEqual([
      'The recipe says 500 g.',
      'The recipe says 350 g.',
      'The recipe says 7 g.',
    ]);
    // Three lines, not four: the salt rounded straight back onto its own 10 g, and
    // a difference too small to read off a scale is not announced as a change.
  });

  it('asks nothing before it does it — no dialog, no confirmation, no gate', async () => {
    // Salt records, never polices. The weights move on the press.
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  // ─── Claim 1: the sum, with its boundary ────────────────────────────────────
  //
  // N rows rounded independently can miss the declared weight by up to N × 0.5 g,
  // and that residual is `rounding.ts`'s stated, defended policy. Anything beyond
  // it is the defect this issue removed coming back.
  describe('the weights sum to the declaration, to within the per-row rounding', () => {
    const DECLARATIONS: readonly { readonly label: string; readonly grams: number }[] = [
      { label: 'a 450 g tin — smaller than the recipe', grams: 450 },
      { label: 'a 900 g tin — larger than the recipe', grams: 900 },
    ];

    it.each(DECLARATIONS)('holds for $label', async ({ grams }) => {
      const { getByTestId, container } = renderPage();
      await ready(getByTestId);

      await declareTin(container, grams);
      await waitFor(() => expect(weightSum(container)).not.toBe(AS_WRITTEN_GRAMS));

      const rows = gramsInputs(container).length;
      expect(Math.abs(weightSum(container) - grams)).toBeLessThanOrEqual(rows * 0.5);
    });

    it('holds again after an ingredient weight is edited and committed', async () => {
      const { getByTestId, container } = renderPage();
      await ready(getByTestId);
      await declareTin(container, 900);
      await waitFor(() => expect(weights(container)[0]).toBe('519'));

      // A WEIGHT BOX AUTHORS RATIOS. "More flour relative to everything else" —
      // not "make more dough", which is the declaration's job alone.
      await fireEvent.input(gramsInputs(container)[0]!, { target: { value: '600' } });
      await fireEvent.blur(gramsInputs(container)[0]!);

      await waitFor(() => expect(weights(container)[0]).toBe('550'));
      expect(Math.abs(weightSum(container) - 900)).toBeLessThanOrEqual(
        gramsInputs(container).length * 0.5,
      );
      // And the ratio that was asked for is the one that survived: 600 g of flour
      // to 363 g of water is 60.6% hydration, where it was 70%.
      expect(percents(container)[1]).toBe('60.6%');
    });

    it('holds when an ingredient is left out of the formula', async () => {
      // Leaving the salt out does not shrink the tin. The declaration is still the
      // total; it is now 900 g of the rest.
      const { getByTestId, container } = renderPage();
      await ready(getByTestId);
      await declareTin(container, 900);
      await waitFor(() => expect(weights(container)[0]).toBe('519'));

      const includeBoxes = [
        ...container.querySelectorAll('[data-testid="formula-row-include"] [role="checkbox"]'),
      ];
      await fireEvent.click(includeBoxes[2]!); // the salt

      await waitFor(() => expect(percents(container)[2]).toBe('—'));
      const stillIn = weights(container)
        .filter((_, index) => index !== 2)
        .reduce((sum, text) => sum + Number(text), 0);
      expect(Math.abs(stillIn - 900)).toBeLessThanOrEqual(3 * 0.5);
    });
  });

  it('leaves the weights alone when there is no formula to re-solve', async () => {
    // Nothing in the basis is nothing at 100%, so there is no formula to solve at
    // any yield. A declaration then changes nothing rather than blanking the boxes
    // — the same `blockedReason` that already stops Save covers it, and the
    // restate simply has no answer to write.
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);
    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));

    await fireEvent.click(basisBoxes(container)[0]!); // the flour, out of the basis
    await waitFor(() =>
      expect(getByTestId('formula-blocked-reason').textContent).toContain('basis'),
    );

    // Every commit route, and none of them writes anything.
    await declareTin(container, 450);
    await fireEvent.blur(getByTestId('formula-grams-each'));
    expect(weights(container)).toEqual(['519', '363', '10', '7.3']);
  });

  // ─── Claim 2: the proportions do not move ───────────────────────────────────

  it('leaves every percentage exactly where it was', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    const before = percents(container);
    expect(before).toEqual(['100%', '70%', '2%', '1.4%']);

    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    expect(percents(container)).toEqual(before);

    // And in the saved document, which is what a batch is solved from — not just
    // in the one-decimal figure on screen.
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].components).toEqual([
      { ingredientId: 'ing-flour', percent: 100, inBasis: true },
      { ingredientId: 'ing-water', percent: 70, inBasis: false },
      { ingredientId: 'ing-salt', percent: 2, inBasis: false },
      { ingredientId: 'ing-yeast', percent: 1.4, inBasis: false },
    ]);
  });

  // ─── Claim 3: idempotence ───────────────────────────────────────────────────

  it('moves nothing when the same declaration is committed again', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    const settled = weights(container);

    // Three more commits, by three different routes — the chip, the tin box's
    // blur, and the answer-mode radio. A creeping restate fails here on the
    // second or third pass, where the first pass alone would look fine.
    await declareTin(container, 900);
    await fireEvent.blur(getByTestId('formula-grams-each'));
    await fireEvent.blur(getByTestId('formula-count'));

    expect(weights(container)).toEqual(settled);
    expect(percents(container)).toEqual(['100%', '70%', '2%', '1.4%']);
  });

  // ─── Claim 4: one total on screen ───────────────────────────────────────────

  it('prints the declaration and no second total', async () => {
    const { getByTestId, container, queryByTestId } = renderPage();
    await ready(getByTestId);

    // Nothing declared yet: the sum of the boxes is the only figure there is.
    expect(getByTestId('formula-dough-total').textContent).toContain('867 g');

    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));

    const card = getByTestId('formula-dough-total').textContent ?? '';
    expect(card).toContain('900 g of dough');
    // Neither the recipe's old sum nor the restated boxes' sum appears beside it.
    expect(card).not.toContain('867');
    expect(card).not.toContain('899');
    // The note that asked the reader to reconcile two figures is gone from the
    // code as well as the screen.
    expect(queryByTestId('formula-declaration-drift')).toBeNull();
    expect(card).not.toMatch(/re-anchor/i);
    // What stands in its place says where the weights came from.
    expect(getByTestId('formula-restate-note').textContent).toMatch(/change what it makes/i);
  });

  // ─── The opening state is genuinely undeclared (issue #1325 review, blocking-2) ─
  //
  // `tinCountText` defaults to `'1'`, and the anchor used to be the box sum for
  // `tin` too — so "1 tin = whatever's already written" was true of every
  // weighable recipe before anyone touched the page, `shape` was never null, and
  // Save was never blocked on saying what this makes. Every case above reaches its
  // declared state through the explicit 900 g chip first, so none of them would
  // have caught this: the rule-12 pin needs a case that never touches the chip.
  it('does not silently declare a total just because a weight box is typed into', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    // Nothing declared yet, and Save knows it.
    expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true);
    expect(getByTestId('formula-dough-total').textContent).toContain('As written');
    expect(getByTestId('formula-dough-total').textContent).toContain('867 g');

    // A WEIGHT BOX AUTHORS RATIOS, NEVER THE TOTAL — but with nothing declared
    // there is no ratio to author either: the box sum simply follows what was
    // typed, and the screen still states only the one figure.
    await fireEvent.input(gramsInputs(container)[0]!, { target: { value: '600' } });
    await fireEvent.blur(gramsInputs(container)[0]!);

    expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true);
    expect(getByTestId('formula-dough-total').textContent).toContain('As written');
    expect(getByTestId('formula-dough-total').textContent).toContain('967 g');
    // Nothing restated — the box holds exactly what was typed, not a figure
    // re-solved at some total nobody declared.
    expect(weights(container)).toEqual(['600', '350', '10', '7']);
  });

  // ─── Divide what's already there (issue #1325, phase 2) ─────────────────────
  //
  // The composition case the two phases have to get right together: a blank
  // per-unit weight box declares `boxSum ÷ count`, which multiplies back to exactly
  // the box sum — so the restate factor is 1 and phase 1 moves nothing. The two
  // features meet here rather than fighting.
  //
  // PIECES ONLY (issue #1325 review, blocking-2). `pieces` is reached only by an
  // explicit mode choice — itself the declaring act — so its default count carries
  // no trap the way `tin`'s does. `tin` never receives the anchor, at any point in
  // its lifetime, even once a declaration already exists: see the regression case
  // below.

  async function pickAnswer(container: HTMLElement, label: string): Promise<void> {
    const option = [...container.querySelectorAll('[role="radio"]')].find((el) =>
      el.textContent?.includes(label),
    );
    if (option === undefined) throw new Error(`no answer labelled ${label}`);
    await fireEvent.click(option);
  }

  it('divides the dough already there, and rescales nothing doing it', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);
    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    const settled = weights(container);

    await pickAnswer(container, 'A number of pieces');
    await fireEvent.input(getByTestId('formula-piece-count'), { target: { value: '5' } });
    await fireEvent.blur(getByTestId('formula-piece-count'));

    // It is the SAME DOUGH, so nothing moves — that is the whole claim.
    expect(weights(container)).toEqual(settled);
    // The resolved per-unit figure is the box's hint, never its value: a number
    // nobody typed sitting in a box gives no way back to "divide it for me".
    const each = getByTestId('formula-piece-grams') as HTMLInputElement;
    expect(each.value).toBe('');
    expect(each.getAttribute('placeholder')).toBe('180');
    // And the card reads the resolved declaration back.
    expect(getByTestId('formula-dough-total').textContent).toContain('5 × 180 g — 900 g of dough');
    expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false);
  });

  it('does not divide a count of tins — the anchor is for pieces only', async () => {
    // A count of tins looks like the same gesture as a count of pieces, and the
    // issue that introduced this named it explicitly ("the same applies to a
    // count of tins"). It is retracted here (issue #1325 review, blocking-2):
    // `tin`'s count defaults to `'1'`, so giving `tin` the anchor at all made a
    // default reading as a declaration on every recipe, even before this specific
    // gesture was reached. Clearing the size box falls back to NO declaration,
    // not a divided one — even though a real 900 g declaration already stands.
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);
    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    const settled = weights(container);

    // Clear the tin size and ask for two of them out of the dough there is.
    await fireEvent.input(getByTestId('formula-grams-each'), { target: { value: '' } });
    await fireEvent.input(getByTestId('formula-count'), { target: { value: '2' } });
    await fireEvent.blur(getByTestId('formula-count'));

    // The restate has nothing to solve at (`shape` is null), so it no-ops rather
    // than blanking the boxes — the same rule the basis-emptied case already pins.
    expect(weights(container)).toEqual(settled);
    expect(getByTestId('formula-grams-each').getAttribute('placeholder')).toBe('');
    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(true),
    );
    expect(getByTestId('formula-blocked-reason').textContent).toContain('what this makes');
  });

  it('takes a figure typed over the hint, and restates to it', async () => {
    // Phase 1's behaviour, reached from the common gesture: 5 × 100 g is a 500 g
    // dough, so the weights come down to it.
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);
    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));

    await pickAnswer(container, 'A number of pieces');
    await fireEvent.input(getByTestId('formula-piece-count'), { target: { value: '5' } });
    await fireEvent.input(getByTestId('formula-piece-grams'), { target: { value: '100' } });
    await fireEvent.blur(getByTestId('formula-piece-grams'));

    await waitFor(() => expect(weights(container)[0]).toBe('288'));
    expect(Math.abs(weightSum(container) - 500)).toBeLessThanOrEqual(
      gramsInputs(container).length * 0.5,
    );
    expect(getByTestId('formula-dough-total').textContent).toContain('5 × 100 g — 500 g of dough');
  });

  // ─── The saved declaration is rounded (issue #1325 review, blocking-1) ──────

  it('rounds the declaration before it reaches the document', async () => {
    // The divided amount is deliberately UNROUNDED on `shape` itself — that is
    // what makes "N rolls out of this dough" restate nothing (`doughAnswer.ts`).
    // But nothing downstream of a division is guaranteed to land on a whole
    // number, and what reaches Firestore must: 867 ÷ 7 is
    // 123.85714285714286, never a figure a scale can weigh and never what a
    // batch should be handed as `referenceYield.shape.unitDoughGrams`.
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    await pickAnswer(container, 'A number of pieces');
    await fireEvent.input(getByTestId('formula-piece-count'), { target: { value: '7' } });
    await fireEvent.blur(getByTestId('formula-piece-count'));

    await waitFor(() =>
      expect(getByTestId('formula-save-button').hasAttribute('disabled')).toBe(false),
    );
    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));

    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    expect(written.referenceYield).toEqual({
      kind: 'target',
      shape: { count: 7, unitDoughGrams: 124 },
    });
  });

  // ─── The round trip ─────────────────────────────────────────────────────────

  it('shows the same weights when the saved formula is reopened', async () => {
    const { getByTestId, container } = renderPage();
    await ready(getByTestId);

    await declareTin(container, 900);
    await waitFor(() => expect(weights(container)[0]).toBe('519'));
    const saved = weights(container);

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];

    // The document holds percentages and a declaration and no grams at all, so
    // this exercises the whole recovery path: anchor back to the recipe's scale,
    // then restate to the stored declaration.
    mockFormula._set(written);
    await waitFor(() => expect(weights(container)).toEqual(saved));
  });
});
