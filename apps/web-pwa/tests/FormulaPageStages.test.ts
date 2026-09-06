import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { CanonItem, Recipe } from '@salt/domain';
import type { Formula, ProcessStage } from '@salt/domain/schemas';

// The stage review surface on the formula screen (issue #806, phase 2 of epic
// #778). A sibling of FormulaPage.test.ts rather than an extension of it: that file
// is about the percentages, this one is about the process, and they share nothing
// but the page.
//
// The four things the review has to get right, all of them things the spike got
// wrong or would have:
//
//   • extraction fills the surface and marks the page dirty — it does NOT save, so
//     the stages are seen before they are stored;
//   • a stage the model missed can be ADDED BY HAND, a wrong temperature corrected,
//     a spurious stage deleted, and all of it survives to the saved document;
//   • re-running SAYS SO FIRST, because it replaces outright and hand corrections
//     go with it;
//   • a recipe with no waits comes back with nothing, and the screen says so rather
//     than showing an invented proof.

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
  extractProcessStages: vi.fn().mockResolvedValue({ kind: 'ok', value: [] }),
}));

import FormulaPage from '../src/routes/recipes/FormulaPage.svelte';
import { saveFormula, extractProcessStages } from '../src/lib/formulaService.js';
import { addToast } from '../src/lib/toastStore.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

function ingredient(id: string, rawText: string, grams: number, canonId: string) {
  return {
    id,
    rawText,
    parsed: {
      quantity: { type: 'single' as const, value: grams },
      unit: 'g' as const,
      item: rawText,
      preparation: [],
      notes: null,
      displayText: rawText,
    },
    canonId,
    matchState: 'matched' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function makeRecipe(): Recipe {
  return {
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
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
          ingredient('ing-flour', '500 g strong white flour', 500, 'canon-flour'),
          ingredient('ing-water', '350 g water', 350, 'canon-water'),
        ],
      },
    ],
    steps: [
      { id: 'step-1', text: 'Mix.', timer: null, note: null },
      { id: 'step-2', text: 'Bulk ferment.', timer: null, note: null },
    ],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    image: null,
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

// A formula already declared, so Save is reachable without touching the top half.
const SHAPE = {
  kind: 'target' as const,
  shape: { count: 1, unitDoughGrams: 900 },
};

const STORED: Formula = {
  recipeId: RECIPE_ID,
  components: [
    { ingredientId: 'ing-flour', percent: 100, inBasis: true },
    { ingredientId: 'ing-water', percent: 70, inBasis: false },
  ],
  referenceYield: SHAPE,
  schemaVersion: 1,
};

const BULK: ProcessStage = {
  id: 'stage-bulk',
  label: 'Bulk ferment',
  kind: 'wait',
  environment: { celsius: 20 },
  duration: { kind: 'range', minMinutes: 240, maxMinutes: 300 },
  until: 'until risen by half',
  stepId: 'step-2',
};

const BAKE: ProcessStage = {
  id: 'stage-bake',
  label: 'Bake',
  kind: 'active',
  environment: { celsius: 230 },
  duration: { kind: 'fixed', minutes: 40 },
  until: null,
  stepId: null,
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveFormula).mockResolvedValue({ kind: 'ok', value: undefined } as never);
  vi.mocked(extractProcessStages).mockResolvedValue({ kind: 'ok', value: [] } as never);
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([makeRecipe()]);
  mockCanonItems._set([canon('canon-flour', 'strong white flour'), canon('canon-water', 'water')]);
  mockFormula._set(undefined);
});

function renderPage() {
  return render(FormulaPage, { props: { params: { id: RECIPE_ID } } });
}

async function openWith(stored: Formula | null) {
  const rendered = renderPage();
  mockFormula._set(stored);
  await waitFor(() => expect(rendered.getByTestId('formula-editor')).toBeTruthy());
  return rendered;
}

function stageRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[data-testid="formula-stage-row"]')] as HTMLElement[];
}

function inputsIn(container: HTMLElement, testid: string): HTMLInputElement[] {
  return [...container.querySelectorAll(`input[data-testid="${testid}"]`)] as HTMLInputElement[];
}

describe('FormulaPage — extraction', () => {
  it('starts with no stages, and does not invent any', async () => {
    const { getByTestId } = await openWith(STORED);
    expect(getByTestId('formula-stages-empty')).toBeTruthy();
    expect(extractProcessStages).not.toHaveBeenCalled();
  });

  it('fills the review surface from the flow, without asking first', async () => {
    vi.mocked(extractProcessStages).mockResolvedValue({
      kind: 'ok',
      value: [BULK, BAKE],
    } as never);
    const { getByTestId, container } = await openWith(STORED);

    await fireEvent.click(getByTestId('formula-stages-extract'));

    await waitFor(() => expect(stageRows(container)).toHaveLength(2));
    expect(extractProcessStages).toHaveBeenCalledWith(RECIPE_ID);
    expect(inputsIn(container, 'formula-stage-label').map((i) => i.value)).toEqual([
      'Bulk ferment',
      'Bake',
    ]);
  });

  it('does NOT save what it found — the user sees the stages first', async () => {
    vi.mocked(extractProcessStages).mockResolvedValue({ kind: 'ok', value: [BULK] } as never);
    const { getByTestId, container } = await openWith(STORED);

    await fireEvent.click(getByTestId('formula-stages-extract'));
    await waitFor(() => expect(stageRows(container)).toHaveLength(1));

    expect(saveFormula).not.toHaveBeenCalled();
  });

  it('shows a wait as a wait and the bake as active — the same way every time', async () => {
    // The spike's headline defect: the bake was labelled differently on each of
    // three bread recipes. The flow decides; the screen must show what it decided
    // rather than re-deriving anything of its own.
    vi.mocked(extractProcessStages).mockResolvedValue({
      kind: 'ok',
      value: [BULK, BAKE],
    } as never);
    const { getByTestId, container } = await openWith(STORED);

    await fireEvent.click(getByTestId('formula-stages-extract'));
    await waitFor(() => expect(stageRows(container)).toHaveLength(2));

    const kinds = [...container.querySelectorAll('[data-testid="formula-stage-kind"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(kinds).toEqual(['Wait', 'Active']);
  });

  it('says so, and stays empty, when the recipe has nothing to wait for', async () => {
    vi.mocked(extractProcessStages).mockResolvedValue({ kind: 'ok', value: [] } as never);
    const { getByTestId, container } = await openWith(STORED);

    await fireEvent.click(getByTestId('formula-stages-extract'));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(stageRows(container)).toHaveLength(0);
    expect(getByTestId('formula-stages-empty')).toBeTruthy();
    expect(vi.mocked(addToast).mock.calls[0]![0]).toContain('Nothing to wait for');
  });

  it('leaves the stages alone and says so when the call fails', async () => {
    vi.mocked(extractProcessStages).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    } as never);
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.click(getByTestId('formula-stages-extract'));
    await fireEvent.click(getByTestId('formula-stages-replace-confirm'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'destructive'));
    expect(stageRows(container)).toHaveLength(1);
  });
});

describe('FormulaPage — re-running replaces, and says so first', () => {
  it('asks before throwing away stages that are already there', async () => {
    vi.mocked(extractProcessStages).mockResolvedValue({ kind: 'ok', value: [BAKE] } as never);
    const { getByTestId } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.click(getByTestId('formula-stages-extract'));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    // Nothing has run yet — the confirmation is a gate, not a notification.
    expect(extractProcessStages).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('corrected by hand');
  });

  it('replaces outright once confirmed — no merge', async () => {
    // Whole-document LWW. Half of a fresh reading mixed into hand-corrected stages
    // is a process neither the model nor the human wrote.
    vi.mocked(extractProcessStages).mockResolvedValue({ kind: 'ok', value: [BAKE] } as never);
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.click(getByTestId('formula-stages-extract'));
    await waitFor(() => expect(getByTestId('formula-stages-replace-confirm')).toBeTruthy());
    await fireEvent.click(getByTestId('formula-stages-replace-confirm'));

    await waitFor(() =>
      expect(inputsIn(container, 'formula-stage-label').map((i) => i.value)).toEqual(['Bake']),
    );
  });
});

describe('FormulaPage — correcting by hand', () => {
  it('adds a stage the model missed, with a minted id and no step', async () => {
    // The spike's second defect: extraction swallowed one of four 20-minute rests
    // buried in a single sentence. A screen that can only accept or reject what the
    // model found leaves that recipe permanently wrong.
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.click(getByTestId('formula-stages-add'));
    await waitFor(() => expect(stageRows(container)).toHaveLength(2));

    const labels = inputsIn(container, 'formula-stage-label');
    await fireEvent.input(labels[1]!, { target: { value: 'Rest' } });
    await fireEvent.input(inputsIn(container, 'formula-stage-minutes')[1]!, {
      target: { value: '20' },
    });
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    const written = vi.mocked(saveFormula).mock.calls[0]![0];
    expect(written.process).toHaveLength(2);
    const added = written.process![1]!;
    expect(added.label).toBe('Rest');
    expect(added.duration).toEqual({ kind: 'fixed', minutes: 20 });
    expect(added.stepId).toBeNull();
    expect(added.id).toEqual(expect.any(String));
    expect(added.id).not.toBe(BULK.id);
  });

  it('corrects a wrong temperature', async () => {
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK] });

    // fireEvent, never userEvent.type (issue #793).
    await fireEvent.input(inputsIn(container, 'formula-stage-celsius')[0]!, {
      target: { value: '24' },
    });
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].process![0]!.environment).toEqual({
      celsius: 24,
    });
  });

  it('clears the temperature to nothing rather than to zero', async () => {
    // An emptied box means "there is no meaningful temperature here", which is a
    // mix. Zero degrees is a different and much more confident claim.
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.input(inputsIn(container, 'formula-stage-celsius')[0]!, {
      target: { value: '' },
    });
    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].process![0]!.environment).toBeNull();
  });

  it('deletes a spurious stage', async () => {
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK, BAKE] });

    const removes = [...container.querySelectorAll('[data-testid="formula-stage-remove"]')];
    await fireEvent.click(removes[0]!);
    await waitFor(() => expect(stageRows(container)).toHaveLength(1));

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].process!.map((s) => s.label)).toEqual(['Bake']);
  });

  it('reorders a stage, and does nothing at the ends', async () => {
    const { getByTestId, container } = await openWith({ ...STORED, process: [BULK, BAKE] });

    const downs = [...container.querySelectorAll('[data-testid="formula-stage-down"]')];
    // The last stage's Down is disabled — a move off the end is not an action.
    expect(downs[1]!.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(downs[0]!);

    await waitFor(() =>
      expect(inputsIn(container, 'formula-stage-label').map((i) => i.value)).toEqual([
        'Bake',
        'Bulk ferment',
      ]),
    );

    await fireEvent.click(getByTestId('formula-save-button'));
    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].process!.map((s) => s.label)).toEqual([
      'Bake',
      'Bulk ferment',
    ]);
  });
});

describe('FormulaPage — stages and the document', () => {
  it('round-trips a stored process unchanged, range and all', async () => {
    // The acceptance bar, and the range is the load-bearing half: 240–300 minutes
    // must still be 240–300 after a reload and a save, never a 270 nobody typed.
    const { getByTestId } = await openWith({ ...STORED, process: [BULK, BAKE] });

    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0].process).toEqual([BULK, BAKE]);
  });

  it('states the total as a range, and admits what it cannot count', async () => {
    const untimed: ProcessStage = { ...BAKE, id: 'stage-prove', duration: null };
    const { getByTestId } = await openWith({ ...STORED, process: [BULK, untimed] });

    const total = getByTestId('formula-stages-total').textContent ?? '';
    expect(total).toContain('4 hr');
    expect(total).toContain('5 hr');
    expect(total).toContain('no time on it');
  });

  it('omits `process` entirely from a formula that has none', async () => {
    // Not an empty array: a formula with no process carries no empty scaffolding,
    // and `setDoc` writes the whole document, so an absent key is also how a
    // process is cleared.
    const { getByTestId } = await openWith(STORED);

    await fireEvent.click(getByTestId('formula-save-button'));

    await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveFormula).mock.calls[0]![0]).not.toHaveProperty('process');
  });

  it('does not let an incoming snapshot wipe stage edits in progress', async () => {
    const { container } = await openWith({ ...STORED, process: [BULK] });

    await fireEvent.input(inputsIn(container, 'formula-stage-label')[0]!, {
      target: { value: 'Bulk ferment (cool room)' },
    });
    await waitFor(() =>
      expect(inputsIn(container, 'formula-stage-label')[0]!.value).toBe('Bulk ferment (cool room)'),
    );

    // Another member saves the original over the top. LWW settles the document; the
    // draft is not touched while it holds edits.
    mockFormula._set({ ...STORED, process: [BULK] });
    await waitFor(() =>
      expect(inputsIn(container, 'formula-stage-label')[0]!.value).toBe('Bulk ferment (cool room)'),
    );
  });
});

// ─── The two positive-number parsers (issue #1055 characterisation) ────────────
// `FormulaPage` declares `parseGrams` and `parseMinutes` ten lines apart, and
// their bodies are byte-identical but for the name:
//
//   const trimmed = text.trim();
//   if (trimmed === '') return null;
//   const value = Number(trimmed);
//   return Number.isFinite(value) && value > 0 ? value : null;
//
// Neither was exercised beyond the happy path and `''`, so swapping `> 0` for
// `>= 0`, dropping `Number.isFinite`, or accepting `'1e3'` on one of them and not
// the other would have failed nothing.
//
// ONE table, driven through BOTH boxes. That is the point: the rows below are the
// machine-checked form of the claim "these two are the same function", which is
// what makes deleting one of them a legal move. If they ever diverge, one of the
// two tables goes red and names the input that split them.
//
// Deliberately NOT the same table as `cookTimerDuration.test.ts:50-61`. That
// parser is stricter — `/^\d+$/` and `>= 1`, so it rejects `'2.5'` and `'1e3'`
// which both of these accept — because a cook timer's field is the one the −/+
// chips write into. A process stage's duration is `z.number().positive()`, where
// non-integers are schema-legal, so these two must NOT converge on it.
const POSITIVE_NUMBER_INPUTS: readonly {
  readonly label: string;
  readonly text: string;
  readonly value: number | null;
}[] = [
  { label: 'an empty box', text: '', value: null },
  { label: 'zero', text: '0', value: null },
  { label: 'a negative number', text: '-5', value: null },
  { label: 'a non-integer', text: '2.5', value: 2.5 },
  { label: 'letters', text: 'abc', value: null },
  { label: 'exponent notation', text: '1e3', value: 1000 },
  { label: 'a number padded with spaces', text: ' 500 ', value: 500 },
];

function percentsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="formula-row-percent"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

describe('FormulaPage — the grams box and the minutes box parse identically', () => {
  it.each(POSITIVE_NUMBER_INPUTS)(
    'the grams box takes $label ($text) as $value',
    async ({ text, value }) => {
      // The water row, which is not in the basis — so its inclusion moves without
      // dragging every other percentage with it. A rejected figure leaves the row
      // OUT of the formula, which reads as '—' rather than a number.
      const { container } = await openWith(STORED);
      const grams = inputsIn(container, 'formula-row-grams');

      await fireEvent.input(grams[1]!, { target: { value: text } });
      await waitFor(() => expect(percentsIn(container)[1] === '—').toBe(value === null));
    },
  );

  it.each(POSITIVE_NUMBER_INPUTS)(
    'the stage minutes box takes $label ($text) as $value',
    async ({ text, value }) => {
      // Read off the SAVED document rather than the box: a rejected figure is no
      // duration at all (a legitimate observational stage — "until doubled"),
      // and an accepted one is a fixed duration carrying the parsed number.
      const { getByTestId, container } = await openWith({ ...STORED, process: [BAKE] });

      await fireEvent.input(inputsIn(container, 'formula-stage-minutes')[0]!, {
        target: { value: text },
      });
      await fireEvent.click(getByTestId('formula-save-button'));

      await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
      const written = vi.mocked(saveFormula).mock.calls[0]![0];
      expect(written.process![0]!.duration).toEqual(
        value === null ? null : { kind: 'fixed', minutes: value },
      );
    },
  );

  it.each(POSITIVE_NUMBER_INPUTS)(
    'the stage max-minutes box takes $label ($text) as $value',
    async ({ text, value }) => {
      // The third call site, driven by nothing until now. A filled second box that
      // differs makes the duration a RANGE; anything the parser rejects leaves the
      // fixed duration the first box already established.
      const { getByTestId, container } = await openWith({ ...STORED, process: [BAKE] });

      await fireEvent.input(inputsIn(container, 'formula-stage-max-minutes')[0]!, {
        target: { value: text },
      });
      await fireEvent.click(getByTestId('formula-save-button'));

      await waitFor(() => expect(saveFormula).toHaveBeenCalledTimes(1));
      const written = vi.mocked(saveFormula).mock.calls[0]![0];
      expect(written.process![0]!.duration).toEqual(
        value === null || value === 40
          ? { kind: 'fixed', minutes: 40 }
          : { kind: 'range', minMinutes: 40, maxMinutes: value },
      );
    },
  );
});
