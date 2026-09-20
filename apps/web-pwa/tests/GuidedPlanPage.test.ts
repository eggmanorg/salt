import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { GuidedPlanDoc } from '@salt/domain/schemas';

// THE PLAN, READ THE WAY IT WILL BE COOKED (issue #1453). What this screen has to
// get right, and why each one matters:
//
//   • the empty state offers "Write the plan" — and NEVER flashes over a plan that
//     is still a frame from arriving (the store's three states);
//   • the bench comes first, drawn from `guidedPrepBoard` — the same shape the
//     guided cook screen's prep stage is drawn from, so the bowls the reader sees
//     are the bowls the cook will fetch;
//   • an ingredient in no bowl is a tray of things to file, not a banner: in
//     guided mode the prep list is the only ingredient list the cook ever sees;
//   • EVERY CHANGE IS WRITTEN AT ONCE, and an edit is not a review — the plan stays
//     "not checked yet" until Approve, which is the one thing that clears it;
//   • Approve is NEVER disabled, including on a reminder that could never fire. A
//     warning is information, never permission;
//   • a half-made line is written nowhere. Opening "+ cue" and thinking better of
//     it leaves no empty field in the document;
//   • a note whose step no longer exists renders as NOTHING — never an error, and
//     never against the wrong step;
//   • the step screens draw the plan's lines through the SAME components the cook
//     deck draws them through, which is what makes "exactly as the cook will see
//     it" mechanical rather than a sentence in a PR body (CLAUDE.md rule 12).

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
  editGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import GuidedPlanPage from '../src/routes/recipes/GuidedPlanPage.svelte';
import { addToast } from '../src/lib/toastStore.js';
import GuidedStepNotes from '../src/routes/recipes/GuidedStepNotes.svelte';
import {
  generateGuidedPlan,
  saveGuidedPlan,
  editGuidedPlan,
} from '../src/lib/guidedPlanService.js';

const RECIPE_ID = 'recipe-1';
const WRITTEN_AT = '2026-08-01T09:00:00.000Z';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    cureCategory: null,
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
            firstUsedInStepId: 'step-1',
          },
          {
            id: 'ing-2',
            rawText: '2 carrots',
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: 'step-2',
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
    metadata: { servings: null, tags: [] },
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
    // between its halves (issue #761).
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

/** The plan as the page last handed it to the service. */
function written(): GuidedPlanDoc {
  const calls = vi.mocked(editGuidedPlan).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

/** Tap a line, type into it, and tap away — the whole editing gesture. */
async function rewrite(
  queries: ReturnType<typeof renderPage>,
  ariaLabel: string,
  next: string,
): Promise<void> {
  // The FIRST line with this label. A bench with two jobs has two "this job's
  // words", and the tests that care which one always mean the first.
  await fireEvent.click(queries.getAllByLabelText(`Change ${ariaLabel}`)[0]!);
  const field = await waitFor(() => queries.getAllByLabelText(ariaLabel)[0]!);
  await fireEvent.input(field, { target: { value: next } });
  await fireEvent.blur(field);
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

  it('says so when the flow could not write one', async () => {
    vi.mocked(generateGuidedPlan).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'SyncError', reason: 'push-failed' },
    });
    const { getByTestId } = renderPage();
    mockPlan._set(null);
    await waitFor(() => expect(getByTestId('guided-plan-empty')).toBeTruthy());

    await fireEvent.click(getByTestId('guided-plan-write-button'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Couldn't write the plan. Try again.", 'destructive'),
    );
  });

  it('says so when the recipe itself is gone', async () => {
    mockRecipes._set([]);
    const { getByText } = renderPage();
    mockPlan._set(null);
    await waitFor(() => expect(getByText('Recipe not found')).toBeTruthy());
  });

  it('offers nothing to plan for an entry with no method', async () => {
    // Capability-gated, never kind-gated: a plan explains a METHOD, so an entry
    // that has none has nothing to explain. Reachable only by typing the URL.
    mockRecipes._set([makeRecipe({ kind: 'special', steps: [] })]);
    const { getByText } = renderPage();
    mockPlan._set(null);
    await waitFor(() => expect(getByText('Nothing to plan here')).toBeTruthy());
  });
});

describe('GuidedPlanPage — the bench', () => {
  it('opens on the bowls, each with the jobs that fill it and the amounts that go in', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(queries.getAllByTestId('guided-plan-bench-card')).toHaveLength(2));
    const names = queries
      .getAllByTestId('guided-plan-bench-card-name')
      .map((el) => el.textContent?.trim());
    expect(names).toEqual(['onion bowl', 'carrot bowl']);
    expect(queries.getAllByTestId('guided-plan-job')).toHaveLength(2);
    expect(queries.getByTestId('guided-plan-bench').textContent).toContain('Dice the onion');
    expect(queries.getAllByTestId('guided-plan-job-ingredient')).toHaveLength(2);
  });

  it('puts a job that sets nothing aside in a "Just get out" group', async () => {
    const queries = renderPage();
    mockPlan._set(
      makePlan({
        prep: [
          { id: 'prep-1', text: 'Open the tin', container: null, ingredientIds: ['ing-1'] },
          {
            id: 'prep-2',
            text: 'Dice the carrots',
            container: 'carrot bowl',
            ingredientIds: ['ing-2'],
          },
        ],
      }),
    );

    await waitFor(() =>
      expect(
        queries.getAllByTestId('guided-plan-bench-card-name').map((el) => el.textContent?.trim()),
      ).toEqual(['Just get out', 'carrot bowl']),
    );
  });

  it('files a stray ingredient into a bowl in one tap, and out of every other job', async () => {
    // The whole reason the tray exists: in guided mode the prep list REPLACES the
    // ingredient checklist, so an ingredient in no job is one the cook never sees.
    const queries = renderPage();
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

    const tray = await waitFor(() => queries.getByTestId('guided-plan-unassigned-warning'));
    expect(tray.textContent).toContain('2 carrots');

    await fireEvent.click(queries.getByTestId('guided-plan-file-button'));

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().prep[0]!.ingredientIds).toEqual(['ing-1', 'ing-2']);
  });

  it('stays quiet when every ingredient is prepped somewhere', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() => expect(queries.getByTestId('guided-plan-bench')).toBeTruthy());
    expect(queries.queryByTestId('guided-plan-unassigned-warning')).toBeNull();
  });

  it('takes an ingredient out of its job when the amount is tapped', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() =>
      expect(queries.getAllByTestId('guided-plan-job-ingredient')).toHaveLength(2),
    );

    await fireEvent.click(queries.getAllByTestId('guided-plan-job-ingredient')[0]!);

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().prep[0]!.ingredientIds).toEqual([]);
  });

  it("changes a job's words in place", async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() => expect(queries.getAllByTestId('guided-plan-job')).toHaveLength(2));

    await rewrite(queries, "this job's words", 'Finely dice the onion');

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().prep[0]!.text).toBe('Finely dice the onion');
  });

  it('deletes a job', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() => expect(queries.getAllByTestId('guided-plan-job')).toHaveLength(2));

    await fireEvent.click(queries.getAllByTestId('guided-plan-job-delete')[0]!);

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().prep.map((p) => p.id)).toEqual(['prep-2']);
  });

  it('writes a new job only once it has words', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() => expect(queries.getAllByTestId('guided-plan-add-job')).toHaveLength(2));

    // Opened and abandoned: nothing reaches the document.
    await fireEvent.click(queries.getAllByTestId('guided-plan-add-job')[0]!);
    await fireEvent.blur(await waitFor(() => queries.getByLabelText("the new job's words")));
    expect(editGuidedPlan).not.toHaveBeenCalled();

    await fireEvent.click(queries.getAllByTestId('guided-plan-add-job')[0]!);
    const field = await waitFor(() => queries.getByLabelText("the new job's words"));
    await fireEvent.input(field, { target: { value: 'Grate the parmesan' } });
    await fireEvent.blur(field);

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    const added = written().prep[2]!;
    expect(added.text).toBe('Grate the parmesan');
    // Into the bowl whose card the button sat on, and holding nothing yet.
    expect(added.container).toBe('onion bowl');
    expect(added.ingredientIds).toEqual([]);
  });
});

describe('GuidedPlanPage — one step per screen', () => {
  async function startReading(queries: ReturnType<typeof renderPage>): Promise<void> {
    await waitFor(() => expect(queries.getByTestId('guided-plan-start-reading')).toBeTruthy());
    await fireEvent.click(queries.getByTestId('guided-plan-start-reading'));
    await waitFor(() => expect(queries.getByTestId('guided-plan-step')).toBeTruthy());
  }

  it("draws the step's own words and the plan's lines under them", async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await startReading(queries);

    expect(queries.getByTestId('guided-plan-step-text').textContent).toContain('Soften the onion.');
    const notes = queries.getByTestId('guided-step-notes');
    expect(notes.textContent).toContain('onion bowl');
    expect(notes.textContent).toContain('small hob burner, medium-low');
    expect(notes.textContent).toContain('a very gentle sizzle');
    // The bowl's contents, from the job that fills it — the amounts the sentence
    // itself deliberately never carries.
    expect(queries.getAllByTestId('guided-step-container-contents')).toHaveLength(1);
  });

  it('pages forward, back, and by the dots', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await startReading(queries);
    expect(queries.getAllByTestId('guided-plan-dot')).toHaveLength(2);

    await fireEvent.click(queries.getByTestId('guided-plan-looks-right'));
    await waitFor(() =>
      expect(queries.getByTestId('guided-plan-step-text').textContent).toContain(
        'Add the carrots.',
      ),
    );

    await fireEvent.click(queries.getByTestId('guided-plan-back'));
    await waitFor(() =>
      expect(queries.getByTestId('guided-plan-step-text').textContent).toContain(
        'Soften the onion.',
      ),
    );

    // Back from the first step is the bench, not a dead end.
    await fireEvent.click(queries.getByTestId('guided-plan-back'));
    await waitFor(() => expect(queries.getByTestId('guided-plan-bench')).toBeTruthy());
  });

  it('writes a changed cue at once, and leaves the plan not checked', async () => {
    // The contract this page turns on: an EDIT is not a REVIEW. Neither the flag
    // nor the recipe stamp moves until Approve.
    const queries = renderPage();
    mockPlan._set(makePlan({ needs_approval: true }));
    await startReading(queries);

    await rewrite(queries, 'what to listen or look for', 'a lazy bubble, never a boil');

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    const plan = written();
    expect(plan.stepNotes[0]!.cue).toBe('a lazy bubble, never a boil');
    expect(plan.needs_approval).toBe(true);
    expect(plan.recipeUpdatedAtAtSave).toBe(WRITTEN_AT);
    expect(saveGuidedPlan).not.toHaveBeenCalled();
  });

  it('writes nothing when a "+" line is opened and abandoned', async () => {
    // A blank labelled box with an example in it reads as advice the plan is
    // giving. A "+" that writes only when something is said does not.
    const queries = renderPage();
    mockPlan._set(makePlan());
    await startReading(queries);

    await fireEvent.click(queries.getByTestId('guided-plan-add-get-ahead'));
    const field = await waitFor(() => queries.getByLabelText('what to start during this step'));
    await fireEvent.blur(field);

    expect(editGuidedPlan).not.toHaveBeenCalled();
  });

  it('adds a reminder only once it says something, and only where there is a timer', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await startReading(queries);

    // Step 1 has a 10-minute timer; the reminder defaults to halfway through it.
    await fireEvent.click(queries.getByTestId('guided-plan-add-check-in'));
    const field = await waitFor(() => queries.getByLabelText('what the reminder says'));
    await fireEvent.input(field, { target: { value: 'give it a stir' } });
    await fireEvent.blur(field);

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().stepNotes[0]!.checkIns).toEqual([{ atMinutes: 5, text: 'give it a stir' }]);

    // Step 2 has no timer, so it is never offered one.
    await fireEvent.click(queries.getByTestId('guided-plan-looks-right'));
    await waitFor(() =>
      expect(queries.getByTestId('guided-plan-step-text').textContent).toContain(
        'Add the carrots.',
      ),
    );
    expect(queries.queryByTestId('guided-plan-add-check-in')).toBeNull();
  });

  it('renders a note whose step no longer exists as NOTHING', async () => {
    // Never an error, and never attached to a neighbouring step. The screens are
    // paged from the RECIPE and notes are looked up by id, so an orphan is simply
    // never found.
    const queries = renderPage();
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
    await startReading(queries);

    expect(queries.queryByText('a cue for a step that is gone')).toBeNull();
    await fireEvent.click(queries.getByTestId('guided-plan-looks-right'));
    expect(queries.queryByText('a cue for a step that is gone')).toBeNull();
  });

  it('drops a note that has been emptied rather than keeping a husk', async () => {
    const queries = renderPage();
    mockPlan._set(
      makePlan({
        stepNotes: [
          {
            stepId: 'step-1',
            container: null,
            setup: null,
            cue: 'a very gentle sizzle',
            checkIns: [],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );
    await startReading(queries);

    await rewrite(queries, 'what to listen or look for', '   ');

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().stepNotes).toEqual([]);
  });
});

describe('GuidedPlanPage — Approve, the stale banner and the summary', () => {
  it('approves the plan as it stands, and is never disabled', async () => {
    // A reminder past the end of its timer used to BLOCK the save. With per-line
    // writes there is no save to block, the runtime already ignores a reminder it
    // cannot fire, and a warning is information rather than permission.
    const queries = renderPage();
    mockPlan._set(
      makePlan({
        needs_approval: true,
        stepNotes: [
          {
            stepId: 'step-1',
            container: 'onion bowl',
            setup: null,
            cue: null,
            checkIns: [{ atMinutes: 99, text: 'far past the end of a 10 minute timer' }],
            lookahead: null,
            getAhead: null,
          },
        ],
      }),
    );

    const approve = await waitFor(() => queries.getByTestId('guided-plan-approve-button'));
    expect(approve.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(approve);

    await waitFor(() => expect(saveGuidedPlan).toHaveBeenCalledTimes(1));
    const [plan, recipe] = vi.mocked(saveGuidedPlan).mock.calls[0]!;
    expect(plan.id).toBe(RECIPE_ID);
    expect(recipe.id).toBe(RECIPE_ID);
  });

  it('shows the "not checked yet" chip only while the plan is flagged', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan({ needs_approval: true }));
    await waitFor(() => expect(queries.getByTestId('guided-plan-unreviewed-chip')).toBeTruthy());

    mockPlan._set(makePlan({ updatedAt: '2026-08-02T00:00:00.000Z' }));
    await waitFor(() => expect(queries.queryByTestId('guided-plan-unreviewed-chip')).toBeNull());
  });

  it('raises the stale banner when the recipe moved under the plan, and offers a re-run', async () => {
    const queries = renderPage();
    mockRecipes._set([makeRecipe({ updatedAt: '2026-09-01T00:00:00.000Z' })]);
    mockPlan._set(makePlan());

    await waitFor(() => expect(queries.getByTestId('guided-plan-stale-banner')).toBeTruthy());
    await fireEvent.click(queries.getByTestId('guided-plan-stale-rerun-button'));
    await waitFor(() => expect(generateGuidedPlan).toHaveBeenCalledTimes(1));
  });

  it('says so when a change could not be written, and keeps it on screen', async () => {
    vi.mocked(editGuidedPlan).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    const queries = renderPage();
    mockPlan._set(makePlan());
    await waitFor(() => expect(queries.getAllByTestId('guided-plan-job')).toHaveLength(2));

    await fireEvent.click(queries.getAllByTestId('guided-plan-job-delete')[0]!);

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Couldn't save that change.", 'destructive'),
    );
  });

  it('says so when Approve could not be written', async () => {
    vi.mocked(saveGuidedPlan).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    const queries = renderPage();
    mockPlan._set(makePlan());
    await fireEvent.click(await waitFor(() => queries.getByTestId('guided-plan-approve-button')));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Couldn't approve the plan.", 'destructive'),
    );
  });

  it('adds a job to a plan whose bench has been emptied', async () => {
    // The flow always writes jobs, so an empty bench is hand-made — and without
    // this it would be a dead end with nothing on it to tap.
    const queries = renderPage();
    mockPlan._set(makePlan({ prep: [] }));
    await fireEvent.click(await waitFor(() => queries.getByTestId('guided-plan-add-job')));

    const field = await waitFor(() => queries.getByLabelText("the new job's words"));
    await fireEvent.input(field, { target: { value: 'Open the tin' } });
    await fireEvent.blur(field);

    await waitFor(() => expect(editGuidedPlan).toHaveBeenCalledTimes(1));
    expect(written().prep[0]!.text).toBe('Open the tin');
    expect(written().prep[0]!.container).toBeNull();
  });

  it('comes back to the bench from the last step, and offers no reading with no steps', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());
    await fireEvent.click(await waitFor(() => queries.getByTestId('guided-plan-start-reading')));
    await fireEvent.click(await waitFor(() => queries.getByTestId('guided-plan-looks-right')));

    // The last step's button says what it does, and leads back to the bench.
    const last = await waitFor(() => queries.getByTestId('guided-plan-looks-right'));
    expect(last.textContent).toContain('Done reading');
    await fireEvent.click(last);
    await waitFor(() => expect(queries.getByTestId('guided-plan-bench')).toBeTruthy());

    mockRecipes._set([makeRecipe({ steps: [] })]);
    await waitFor(() =>
      expect(queries.getByTestId('guided-plan-start-reading').hasAttribute('disabled')).toBe(true),
    );
  });

  it('summarises what the plan actually contains', async () => {
    const queries = renderPage();
    mockPlan._set(makePlan());

    await waitFor(() =>
      expect(queries.getByTestId('guided-plan-summary').textContent).toBe(
        '2 bowls · 2 steps · 1 cue · 0 reminders',
      ),
    );
  });
});

describe('the cook deck and the review screen draw the same lines', () => {
  // The claim "exactly as the cook will see it" is pinned HERE, and its boundary
  // is exactly what these assertions say: the plan's own note rows and look-ahead
  // lines come from one component that both pages render. The step chrome, the
  // timer and the deck geometry around them are each page's own, and this says
  // nothing about those.
  const RECIPES = join(dirname(fileURLToPath(import.meta.url)), '../src/routes/recipes');
  function source(file: string): string {
    return readFileSync(join(RECIPES, file), 'utf8');
  }

  it('has exactly one component declaring the note rows, and both pages render it', () => {
    expect(source('GuidedStepNotes.svelte')).toContain('data-testid="guided-step-notes"');
    for (const page of ['GuidedCookPage.svelte', 'GuidedPlanPage.svelte']) {
      expect(source(page)).toContain('<GuidedStepNotes');
      expect(source(page)).toContain('<GuidedStepLookahead');
      // A second copy of the markup is the failure this guards against — it is how
      // the two screens would start disagreeing without anybody noticing.
      expect(source(page)).not.toContain('data-testid="guided-step-notes"');
      expect(source(page)).not.toContain('data-testid="guided-step-note-cue"');
    }
  });

  it('draws the same rows for the same note whether or not it can be edited', () => {
    const note = {
      stepId: 'step-1',
      container: 'onion bowl',
      setup: 'small hob burner, medium-low',
      cue: 'a very gentle sizzle',
      checkIns: [{ atMinutes: 5, text: 'give it a stir' }],
      lookahead: null,
      getAhead: null,
    };
    const rows = (edit: boolean): string[] => {
      const { container, unmount } = render(GuidedStepNotes, {
        props: {
          note,
          containerContents: [],
          loose: [],
          checkIns: note.checkIns,
          ...(edit
            ? {
                edit: {
                  timerMinutes: 10,
                  onSetContainer: () => {},
                  onSetSetup: () => {},
                  onSetCue: () => {},
                  onSetCheckIn: () => {},
                  onAddCheckIn: () => {},
                  onRemoveCheckIn: () => {},
                },
              }
            : {}),
        },
      });
      const found = [...container.querySelectorAll('[data-testid^="guided-step-"]')].map((el) =>
        el.getAttribute('data-testid'),
      );
      const text = container.textContent ?? '';
      unmount();
      return [...found, text.includes('a very gentle sizzle') ? 'cue-text' : '', `5 min in`].filter(
        (s): s is string => s !== '',
      );
    };

    expect(rows(true)).toEqual(rows(false));
  });
});
