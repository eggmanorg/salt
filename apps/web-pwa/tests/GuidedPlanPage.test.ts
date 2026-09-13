import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { GuidedPlanDoc } from '@salt/domain/schemas';

// The guided-plan editor (issue #751, Phase 1). The four things this page has to
// get right, and the reasons they matter:
//
//   • the empty state offers "Write the plan" — and NEVER flashes over a plan that
//     is still a frame from arriving (the store's three states);
//   • an ingredient in no prep step is WARNED about, because in guided mode the
//     prep list is the only ingredient list the cook ever sees;
//   • a save clears "not checked yet" and re-stamps against the recipe, so a plan
//     reconciled by hand escapes the stale banner without a destructive re-run;
//   • a note whose step no longer exists renders as NOTHING — never an error, and
//     never against the wrong step.
//
// Plus, from issue #761: a container name used twice, or wanted by a step and
// filled by no job, is WARNED about and never blocked. The name is the plan's only
// join between its halves, so both faults cost a step its contents — but a plan
// carrying either still cooks, and a save that refuses would strand the hand-edits
// made alongside it. `hasCheckInError` remains the one deliberately blocking check.

const { mockRecipes, mockIsLoadingRecipes, mockPlan } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockIsLoadingRecipes: makeStore<boolean>(false),
    mockPlan: makeStore<GuidedPlanDoc | null | undefined>(undefined),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoadingRecipes,
}));
vi.mock('../src/lib/guidedPlanService.js', () => ({
  guidedPlan: mockPlan,
  initGuidedPlanSync: vi.fn(() => vi.fn()),
  generateGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  saveGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import GuidedPlanPage from '../src/routes/recipes/GuidedPlanPage.svelte';
import { generateGuidedPlan, saveGuidedPlan } from '../src/lib/guidedPlanService.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    componentRecipeIds: [],
    producesCanonId: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Ragù',
    description: null,
    ingredients: [
      {
        id: 'grp-1',
        name: null,
        items: [
          {
            id: 'ing-1',
            rawText: '1 onion',
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
          {
            id: 'ing-2',
            rawText: '2 carrots',
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ],
    steps: [
      {
        id: 'step-1',
        text: 'Soften the onion.',
        timer: { durationMinutes: 10, description: null },
        note: null,
      },
      { id: 'step-2', text: 'Add the carrots.', timer: null, note: null },
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
    ...overrides,
  };
}

function makePlan(overrides: Partial<GuidedPlanDoc> = {}): GuidedPlanDoc {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtSave: WRITTEN_AT,
    // A CORRECT plan: two bowls named apart, and the note copying one of those
    // names character for character. The container name is the plan's only join
    // between its halves (issue #761), so a fixture that shares a name or adds an
    // article would model a plan whose steps cannot show their contents.
    prep: [
      { id: 'prep-1', text: 'Dice the onion', container: 'onion bowl', ingredientIds: ['ing-1'] },
      {
        id: 'prep-2',
        text: 'Dice the carrots',
        container: 'carrot bowl',
        ingredientIds: ['ing-2'],
      },
    ],
    stepNotes: [
      {
        stepId: 'step-1',
        container: 'onion bowl',
        setup: 'small hob burner, medium-low',
        cue: 'a very gentle sizzle',
        checkIns: [],
        lookahead: null,
        getAhead: null,
      },
    ],
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoadingRecipes._set(false);
  mockRecipes._set([makeRecipe()]);
  mockPlan._set(undefined);
});

function renderPage() {
  return render(GuidedPlanPage, { props: { params: { id: RECIPE_ID } } });
}

describe('GuidedPlanPage — no plan yet', () => {
  it('shows nothing but a loader while the plan is still resolving', () => {
    // `undefined` is NOT `null`. Without the distinction the "Write the plan"
    // prompt flashes over every recipe that already has one.
    const { queryByTestId } = renderPage();
    expect(queryByTestId('guided-plan-empty')).toBeNull();
    expect(queryByTestId('guided-plan-editor')).toBeNull();
  });

  it('offers "Write the plan" once we know there is none', async () => {
    const { getByTestId } = renderPage();
    mockPlan._set(null);
    await waitFor(() => expect(getByTestId('guided-plan-empty')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-write-button'));

    await waitFor(() => expect(generateGuidedPlan).toHaveBeenCalledTimes(1));
    expect(vi.mocked(generateGuidedPlan).mock.calls[0]![0].id).toBe(RECIPE_ID);
  });
});

describe('GuidedPlanPage — the plan', () => {
  it('renders the prep list and a note row per recipe step', async () => {
    const { getAllByTestId, getByTestId } = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());
    expect(getAllByTestId('guided-plan-prep-entry')).toHaveLength(2);
    expect(getAllByTestId('guided-plan-step-note')).toHaveLength(2);
  });

  it('shows the "not checked yet" chip only while the plan is flagged', async () => {
    const { getByTestId, queryByTestId } = renderPage();
    mockPlan._set(makePlan({ needs_approval: true }));
    await waitFor(() => expect(getByTestId('guided-plan-unreviewed-chip')).toBeTruthy());

    mockPlan._set(makePlan({ updatedAt: '2026-08-02T00:00:00.000Z' }));
    await waitFor(() => expect(queryByTestId('guided-plan-unreviewed-chip')).toBeNull());
  });

  it('offers check-ins only on a step that already carries a timer', async () => {
    const { getAllByTestId } = renderPage();
    mockPlan._set(makePlan());

    // Two steps, one timer → exactly one "Add a check-in".
    await waitFor(() => expect(getAllByTestId('guided-plan-add-check-in-button')).toHaveLength(1));
  });

  it('renders a note for a step that no longer exists as NOTHING', async () => {
    // Never an error, and never attached to a neighbouring step. The step list is
    // rendered from the RECIPE and notes are looked up by id, so an orphan is
    // simply never found.
    const { getAllByTestId, queryByText } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-deleted',
            container: null,
            setup: null,
            cue: 'a cue for a step that is gone',
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );

    await waitFor(() => expect(getAllByTestId('guided-plan-step-note')).toHaveLength(2));
    expect(queryByText('a cue for a step that is gone')).toBeNull();
  });
});

describe('GuidedPlanPage — the unassigned-ingredient warning', () => {
  it('stays quiet when every ingredient is prepped somewhere', async () => {
    const { getByTestId, queryByTestId } = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());
    expect(queryByTestId('guided-plan-unassigned-warning')).toBeNull();
  });

  it('warns when an ingredient appears in no prep entry', async () => {
    // The trap this page exists to catch: the prep list REPLACES the ingredient
    // checklist in guided mode, so an unassigned ingredient is one the cook is
    // never shown at all.
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          {
            id: 'prep-1',
            text: 'Dice the onion',
            container: 'onion bowl',
            ingredientIds: ['ing-1'],
          },
        ],
      }),
    );

    const warning = await waitFor(() => getByTestId('guided-plan-unassigned-warning'));
    expect(warning.textContent).toContain('2 carrots');
  });

  it('clears the warning when the ingredient is attached to a prep entry', async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          {
            id: 'prep-1',
            text: 'Dice the onion',
            container: 'onion bowl',
            ingredientIds: ['ing-1'],
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-unassigned-warning')).toBeTruthy());

    // Removing the chip and re-adding it is the round trip; here we just prove the
    // chip removal re-opens the warning for an ingredient that WAS assigned.
    const chips = getAllByTestId('guided-plan-prep-ingredient-chip');
    expect(chips).toHaveLength(1);
    await fireEvent.click(chips[0]!);

    await waitFor(() =>
      expect(getByTestId('guided-plan-unassigned-warning').textContent).toContain('1 onion'),
    );
    expect(queryByTestId('guided-plan-prep-ingredient-chip')).toBeNull();
  });
});

describe('GuidedPlanPage — the duplicate-container warning', () => {
  // The container name is the plan's only join between its two halves (issue #761),
  // and Phase 1 made it load-bearing: a step reaching for a name two jobs used gets
  // the FIRST one's contents, silently and possibly wrongly. Warned about, never
  // blocked — the plan still cooks.
  it('stays quiet when every bowl is named apart', async () => {
    const { getByTestId, queryByTestId } = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());
    expect(queryByTestId('guided-plan-duplicate-container-warning')).toBeNull();
  });

  it('warns when two prep steps set aside into the same-named bowl', async () => {
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          {
            id: 'prep-1',
            text: 'Dice the onion',
            container: 'small bowl',
            ingredientIds: ['ing-1'],
          },
          {
            id: 'prep-2',
            text: 'Dice the carrots',
            container: 'small bowl',
            ingredientIds: ['ing-2'],
          },
        ],
        stepNotes: [],
      }),
    );

    const warning = await waitFor(() => getByTestId('guided-plan-duplicate-container-warning'));
    // Actionable: it names the clash and points at the rows holding it.
    expect(warning.textContent).toContain('small bowl');
    expect(warning.textContent).toContain('1, 2');
  });

  it('clears once one of the two bowls is renamed', async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          {
            id: 'prep-1',
            text: 'Dice the onion',
            container: 'small bowl',
            ingredientIds: ['ing-1'],
          },
          {
            id: 'prep-2',
            text: 'Dice the carrots',
            container: 'small bowl',
            ingredientIds: ['ing-2'],
          },
        ],
        stepNotes: [],
      }),
    );
    await waitFor(() =>
      expect(getByTestId('guided-plan-duplicate-container-warning')).toBeTruthy(),
    );

    // Off the LIVE draft, so it clears as the name is typed — no save needed.
    const containers = getAllByTestId('guided-plan-prep-container') as HTMLInputElement[];
    await fireEvent.input(containers[1]!, { target: { value: 'carrot bowl' } });

    await waitFor(() =>
      expect(queryByTestId('guided-plan-duplicate-container-warning')).toBeNull(),
    );
  });

  it('still lets the plan be saved while the warning shows', async () => {
    // A warning is a warning. Unlike an unfirable check-in, a shared bowl name costs
    // one line of guidance from a plan that is otherwise correct — refusing the save
    // would strand every hand-edit made alongside it.
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          {
            id: 'prep-1',
            text: 'Dice the onion',
            container: 'small bowl',
            ingredientIds: ['ing-1'],
          },
          {
            id: 'prep-2',
            text: 'Dice the carrots',
            container: 'small bowl',
            ingredientIds: ['ing-2'],
          },
        ],
        stepNotes: [],
      }),
    );
    await waitFor(() =>
      expect(getByTestId('guided-plan-duplicate-container-warning')).toBeTruthy(),
    );

    const save = getByTestId('guided-plan-save-button') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
  });
});

describe('GuidedPlanPage — the dangling-container warning', () => {
  it('stays quiet when the step copies a prep step-s container name', async () => {
    const { getByTestId, queryByTestId } = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());
    expect(queryByTestId('guided-plan-dangling-container-warning')).toBeNull();
  });

  it('warns when a step wants a container no prep step fills', async () => {
    // Including the near-miss the old prompt example taught: "the onion bowl" is a
    // word away from "onion bowl" and the matcher deliberately will not bridge it.
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-2',
            container: 'the onion bowl',
            setup: null,
            cue: null,
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );

    const warning = await waitFor(() => getByTestId('guided-plan-dangling-container-warning'));
    expect(warning.textContent).toContain('the onion bowl');
    expect(warning.textContent).toContain('Step 2');
  });

  it('clears when the name is corrected to one a prep step fills', async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-2',
            container: 'the onion bowl',
            setup: null,
            cue: null,
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-dangling-container-warning')).toBeTruthy());

    const wants = getAllByTestId('guided-plan-note-container') as HTMLInputElement[];
    await fireEvent.input(wants[1]!, { target: { value: 'onion bowl' } });

    await waitFor(() => expect(queryByTestId('guided-plan-dangling-container-warning')).toBeNull());
  });

  it('says nothing about a note whose step is gone — it cannot be fixed here', async () => {
    // Same reasoning as the check-in gate: a row the editor does not render is a row
    // nobody can act on, so warning about it would be a dead end.
    const { getByTestId, queryByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-deleted',
            container: 'the tureen',
            setup: null,
            cue: null,
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );

    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());
    expect(queryByTestId('guided-plan-dangling-container-warning')).toBeNull();
  });

  it('still lets the plan be saved while the warning shows', async () => {
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-2',
            container: 'the tureen',
            setup: null,
            cue: null,
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-dangling-container-warning')).toBeTruthy());

    const save = getByTestId('guided-plan-save-button') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
  });
});

describe('GuidedPlanPage — drift and save', () => {
  it('says the recipe has changed since the plan was written', async () => {
    const { getByTestId } = renderPage();
    mockRecipes._set([makeRecipe({ updatedAt: '2026-08-09T12:00:00.000Z' })]);
    mockPlan._set(makePlan({ recipeUpdatedAtAtSave: WRITTEN_AT }));

    await waitFor(() => expect(getByTestId('guided-plan-stale-banner')).toBeTruthy());
  });

  it('does NOT auto-regenerate or delete the plan when the recipe drifts', async () => {
    // The plan may be several hand-corrections deep; throwing that away to chase
    // an edit to one step would be a bad trade. Both ways out are the user's call.
    const { getByTestId, getAllByTestId } = renderPage();
    mockRecipes._set([makeRecipe({ updatedAt: '2026-08-09T12:00:00.000Z' })]);
    mockPlan._set(makePlan());

    await waitFor(() => expect(getByTestId('guided-plan-stale-banner')).toBeTruthy());
    expect(getAllByTestId('guided-plan-prep-entry')).toHaveLength(2);
    expect(generateGuidedPlan).not.toHaveBeenCalled();
    expect(saveGuidedPlan).not.toHaveBeenCalled();
  });

  it('saves the edited plan against the CURRENT recipe, so a hand fix clears the banner', async () => {
    const drifted = makeRecipe({ updatedAt: '2026-08-09T12:00:00.000Z' });
    const { getByTestId } = renderPage();
    mockRecipes._set([drifted]);
    mockPlan._set(makePlan({ needs_approval: true }));
    await waitFor(() => expect(getByTestId('guided-plan-stale-banner')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-save-button'));

    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
    // The service is handed the LIVE recipe; it is what re-stamps the plan.
    const [, recipeArg] = vi.mocked(saveGuidedPlan).mock.calls[0]!;
    expect(recipeArg.updatedAt).toBe('2026-08-09T12:00:00.000Z');
  });

  it('maps empty text fields back to null and drops a note that says nothing', async () => {
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        prep: [{ id: 'prep-1', text: 'Open the tin', container: '', ingredientIds: [] }],
        stepNotes: [
          {
            stepId: 'step-1',
            container: '',
            setup: '',
            cue: '',
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
          {
            stepId: 'step-2',
            container: '',
            setup: '',
            cue: 'looks glossy',
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-save-button'));

    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
    const [saved] = vi.mocked(saveGuidedPlan).mock.calls[0]!;
    expect(saved.prep[0]!.container).toBeNull();
    // The all-empty note is a husk; only the one that actually says something survives.
    expect(saved.stepNotes).toHaveLength(1);
    expect(saved.stepNotes[0]!.stepId).toBe('step-2');
  });

  it('round-trips the two look-ahead lines through the editor', async () => {
    // Issue #769. They are edited against the step they DESCRIBE and shown to the
    // cook on the step before, so what has to be true here is only that a plan
    // carrying them arrives in the fields and leaves through the save unchanged.
    const { getByTestId, getAllByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-1',
            container: null,
            setup: null,
            cue: null,
            checkIns: [],
            lookahead: 'the sauce reduces by half',
            getAhead: 'preheat the oven to 200°C',
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());

    // One pair of fields per step in the recipe; the plan annotates the first.
    expect((getAllByTestId('guided-plan-note-lookahead')[0] as HTMLInputElement).value).toBe(
      'the sauce reduces by half',
    );
    await fireEvent.input(getAllByTestId('guided-plan-note-get-ahead')[0]!, {
      target: { value: 'take the steak out of the fridge' },
    });
    await fireEvent.click(getByTestId('guided-plan-save-button'));

    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
    const [saved] = vi.mocked(saveGuidedPlan).mock.calls[0]!;
    expect(saved.stepNotes[0]!.lookahead).toBe('the sauce reduces by half');
    expect(saved.stepNotes[0]!.getAhead).toBe('take the steak out of the fridge');
  });

  it('keeps a note whose ONLY content is a look-ahead', async () => {
    // The husk filter drops a note that says nothing, and after #769 most notes say
    // nothing except this. A filter that had not learned the new fields would throw
    // away almost every look-ahead on the first save, silently.
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-1',
            container: '',
            setup: '',
            cue: '',
            checkIns: [],
            lookahead: 'the onions soften',
            getAhead: null,
          },
          {
            stepId: 'step-2',
            container: '',
            setup: '',
            cue: '',
            checkIns: [],
            lookahead: null,
            getAhead: 'put the oven on',
          },
        ],
      }),
    );
    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-save-button'));

    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
    const [saved] = vi.mocked(saveGuidedPlan).mock.calls[0]!;
    expect(saved.stepNotes).toHaveLength(2);
    expect(saved.stepNotes[0]!.lookahead).toBe('the onions soften');
    expect(saved.stepNotes[1]!.getAhead).toBe('put the oven on');
  });

  it('blocks the save while a check-in cannot fire inside its timer', async () => {
    // The schema cannot see the timer — it holds no recipe — so this cross-check
    // lives here, and it blocks rather than warns: a reminder set at or past the
    // end of the timer can never fire.
    const { getByTestId } = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-1',
            container: null,
            setup: null,
            cue: null,
            checkIns: [{ atMinutes: 20, text: 'stir' }],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );

    const save = await waitFor(() => getByTestId('guided-plan-save-button') as HTMLButtonElement);
    expect(save.disabled).toBe(true);

    // Bring it inside the 10-minute timer and the save opens up again.
    const minutes = getByTestId('guided-plan-check-in-minutes') as HTMLInputElement;
    await fireEvent.input(minutes, { target: { value: '5' } });
    await waitFor(() =>
      expect((getByTestId('guided-plan-save-button') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('re-runs over an existing plan', async () => {
    const { getByTestId } = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() => expect(getByTestId('guided-plan-editor')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-rerun-button'));

    await waitFor(() => expect(generateGuidedPlan).toHaveBeenCalledTimes(1));
  });
});

describe('GuidedPlanPage — capability gate', () => {
  it('has nothing to plan for an entry with no method', async () => {
    // Gated on the capability predicate, never on `kind`.
    mockRecipes._set([makeRecipe({ kind: 'special', ingredients: [], steps: [] })]);
    mockPlan._set(null);
    const { queryByTestId, getByText } = renderPage();

    expect(getByText('Nothing to plan here')).toBeTruthy();
    expect(queryByTestId('guided-plan-empty')).toBeNull();
  });
});
