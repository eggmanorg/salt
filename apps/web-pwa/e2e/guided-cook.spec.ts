/**
 * Guided cook E2E (issue #994, Phase 2) — the first time `/recipes/:id/cook/guided`
 * has ever been driven by a real browser.
 *
 * ONE journey, deliberately. Cold start dominates this suite's flake (#734: ~47%
 * failure from a cold emulator stack against ~0.6% warm), so every spec added
 * grows the surface that actually breaks. What this one is for is not feature
 * coverage — `GuidedCookPage.test.ts` has 89 cases in milliseconds — it is the
 * proof that the route survives #994's de-fork at all: real Firestore, real
 * security rules, a real layout engine, and a real reload in between.
 *
 * What lives HERE because nowhere else can reach it:
 * - **The entry.** The split Cook control's guided half is rendered on what the
 *   single-document `guidedPlans` listener reports, and it routes by the member's
 *   own preference. jsdom mounts the page directly and never sees either.
 *   `RecipeViewPage` and `GuidedCookPage` have no unit test in common.
 * - **Which step the footer acts on once the deck has moved.** The footer's target
 *   comes from a geometric probe; in jsdom it never resolves and the footer falls
 *   back to "first incomplete", which happens to be the right answer either way.
 * - **The guided-only ready-guard, against a real round-trip.** Settling the
 *   opening stage waits for the PLAN as well as the session, so a resumed guided
 *   cook reopens on the steps only once both documents are back from Firestore.
 *   Two listeners racing is exactly what a mocked store cannot stage honestly.
 * - **Resume across a real reload** — the session document and BOTH tick lists
 *   rehydrated through the real adapter.
 *
 * Deliberately NOT here (the unit suite covers them in milliseconds): the prep
 * board's grouping and folding, the "Also get out" remainder, check-in arming,
 * the look-ahead panel, timers, the recipe-changed banner, restart, and the
 * deleted-recipe orphan. The deck is driven by the footer and the keyboard and
 * never by synthesised pointer physics — `cook-mode.spec.ts:24-27` records why.
 *
 * The plan is SEEDED, never generated: `guidedPlans` is greenfield, the flow that
 * writes one is a live model call, and no test may depend on a model (NF-E4). The
 * `FUNCTIONS_AI_FAKE` seam stays sealed — nothing here fires an AI flow.
 */
import type { Locator, Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import type { GuidedPlanDoc } from '@salt/domain/schemas';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedGuidedPlan, seedRecipe } from './helpers/seed';
import { HYDRATE_TIMEOUT, SYNC_TIMEOUT } from './helpers/timeouts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RECIPE_ID = 'e2e-guided-recipe';
const SEED_TIME = '2026-01-01T00:00:00.000Z'; // persistRecipe re-stamps updatedAt

const STEP_ONE_TEXT = 'Soften the onion and garlic in the oil over a low flame.';
const STEP_TWO_TEXT = 'Add the tomatoes and simmer until the sauce turns glossy.';

// `parsed: null` on every ingredient, so `IngredientText` renders `rawText`
// verbatim and the strings below are exactly what is on screen.
const ONION_LINE = '1 onion, finely diced';
const GARLIC_LINE = '2 cloves garlic, crushed';
const TOMATOES_LINE = '400g tinned plum tomatoes';

// The bowl the prep fills and the step then reaches for. Typed identically in
// both places here — the plan-drift cases (a renamed bowl, an ingredient the plan
// accounts for nowhere) are the unit suite's, not a real browser's.
const BOWL = 'Small bowl';
const SETUP_LINE = 'Small hob burner, medium-low';
const CUE_LINE = 'A very gentle sizzle, not a crackle';

/** One ingredient line. `parsed: null` keeps `IngredientText` verbatim, and
 *  `firstUsedInStepId` — stamped by the AI author flow and left null by the
 *  editor — is why this recipe is seeded rather than typed: without it no step
 *  shows the ingredients it is the first to call for, in either mode. */
function ingredient(id: string, rawText: string, firstUsedInStepId: string) {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'pending' as const,
    isOptional: false,
    firstUsedInStepId,
  };
}

/** Three ingredients across two steps, both steps un-timed. */
function guidedRecipe(): Recipe {
  return {
    cureCategory: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Emulator Guided Ragù',
    description: null,
    ingredients: [
      {
        id: 'group-1',
        name: null,
        items: [
          ingredient('ing-1', ONION_LINE, 'step-1'),
          ingredient('ing-2', TOMATOES_LINE, 'step-2'),
          ingredient('ing-3', GARLIC_LINE, 'step-1'),
        ],
      },
    ],
    steps: [
      { id: 'step-1', text: STEP_ONE_TEXT, timer: null, note: null },
      { id: 'step-2', text: STEP_TWO_TEXT, timer: null, note: null },
    ],
    metadata: {
      servings: 4,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    image: null,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: '',
    lastEditedBy: '',
  };
}

/**
 * A plan that accounts for every ingredient — two jobs, one of which fills the
 * bowl step 1 then names. Three tick rows come out of it: the two ingredients in
 * the bowl, and the tin that is opened into nothing.
 */
function guidedPlanDoc(): GuidedPlanDoc {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtSave: SEED_TIME,
    prep: [
      {
        id: 'prep-1',
        text: 'Dice the onion and crush the garlic',
        container: BOWL,
        ingredientIds: ['ing-1', 'ing-3'],
      },
      { id: 'prep-2', text: 'Open the tin of tomatoes', container: null, ingredientIds: ['ing-2'] },
    ],
    stepNotes: [
      {
        stepId: 'step-1',
        container: BOWL,
        setup: SETUP_LINE,
        cue: CUE_LINE,
        checkIns: [],
        lookahead: null,
        getAhead: null,
      },
    ],
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };
}

// ─── Locators ─────────────────────────────────────────────────────────────────

/** The prep counter in the header, live only on the prep stage. */
function prepCounter(page: Page): Locator {
  return page.getByText(/Prep · \d+\/\d+ done/);
}

/** A timeline segment, addressed by its accessible name — which gains ", done"
 *  the moment the step is ticked, so the locator IS the completion assertion. */
function timelineStep(page: Page, n: number, done = false): Locator {
  return page.getByRole('button', { name: `Step ${n} of 2${done ? ', done' : ''}`, exact: true });
}

// ─── The cook ─────────────────────────────────────────────────────────────────

test.describe('guided cook', () => {
  test('a guided cook preps, reads the plan under a step, resumes after a reload, and finishing clears it', async ({
    page,
  }, testInfo) => {
    // Single tab, no AI, no CF trigger under assertion — but one full reload and
    // rehydrate, which is the slowest leg here (NF-F2).
    test.setTimeout(90_000);

    // The deck settles with an UNDER-DAMPED spring and the footer re-probes which
    // step is on top for every frame of the overshoot, so a web-first assertion
    // can go green on a frame the deck was only passing through. Under reduced
    // motion `animateDeckTo` assigns the target offset directly — one settled
    // state per move, and every deck move deterministic without a sleep (NF-A1).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/');
    await seedRecipe(page, guidedRecipe());
    // BEFORE the recipe view mounts, because that is where the plan's listener
    // attaches — see `seedGuidedPlan`'s note (NF-C4).
    await seedGuidedPlan(guidedPlanDoc());

    // ── Entry: the guided half of the split Cook control ──────────────────────
    await page.goto(`/#/recipes/${RECIPE_ID}`);
    // Nobody has set a cook-mode preference, so standard leads and guided is the
    // icon half — named in full by its accessible name, which is the only thing
    // an icon-only button has to be addressed by (NF-B1/NF-B2). Waiting for it to
    // be visible is waiting on the plan listener's first snapshot: with no plan
    // there is no second half at all.
    const guidedHalf = page.getByRole('button', { name: 'Cook, guided', exact: true });
    await expect(guidedHalf).toBeVisible({ timeout: SYNC_TIMEOUT });
    await guidedHalf.click();
    await expect(page).toHaveURL(new RegExp(`#/recipes/${RECIPE_ID}/cook/guided$`));
    await expect(page.getByTestId('guided-cook-page')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // ── Stage 1: the prep board ───────────────────────────────────────────────
    // Three tick rows out of two jobs: the board ticks INGREDIENTS, not jobs.
    const prepRows = page.getByTestId('guided-prep-row');
    await expect(prepRows).toHaveCount(3);
    await expect(prepCounter(page)).toHaveText('Prep · 0/3 done');
    // The board replaces the ingredient checklist outright — plain cook mode's
    // rows and its bulk tick must not be here.
    await expect(page.getByTestId('cook-mise-row')).toHaveCount(0);

    const onion = prepRows.filter({ hasText: ONION_LINE });
    await onion.click();
    await expect(onion).toHaveAttribute('aria-pressed', 'true');
    // The counter moves on the round-trip through the session document, not on
    // the click (NF-A3/NF-A5).
    await expect(prepCounter(page)).toHaveText('Prep · 1/3 done', { timeout: SYNC_TIMEOUT });

    // ── Stage 2: the steps, with the plan underneath them ─────────────────────
    await page.getByTestId('cook-stage-toggle').click();
    const deck = page.getByTestId('cook-steps-view');
    await expect(deck).toBeVisible();
    await expect(timelineStep(page, 1)).toHaveAttribute('aria-current', 'step');

    // The recipe's own words are untouched, and what the plan added sits under
    // them: the bowl this step reaches for, WITH what the prep put in it, how the
    // hob is set, and the sensory test. Scoped to step 1's own section so the
    // assertion cannot be satisfied by another step's rows (NF-B3).
    const stepOne = page.getByTestId('cook-step').filter({ hasText: STEP_ONE_TEXT });
    const stepOneNotes = stepOne.getByTestId('guided-step-notes');
    await expect(stepOneNotes).toContainText(BOWL);
    await expect(stepOneNotes).toContainText(SETUP_LINE);
    await expect(stepOneNotes).toContainText(CUE_LINE);
    // #761's rule in one assertion: guided mode never shows LESS than plain cook
    // mode. Both ingredients this step is the first to call for are printed —
    // inside the bowl the plan named them into, rather than loose.
    await expect(stepOneNotes).toContainText(ONION_LINE);
    await expect(stepOneNotes).toContainText(GARLIC_LINE);

    // ── Complete a step ───────────────────────────────────────────────────────
    await page.getByTestId('cook-step-done').click();
    await expect(timelineStep(page, 1, true)).toBeVisible();
    await expect(timelineStep(page, 2)).toHaveAttribute('aria-current', 'step');

    // ── Reload mid-cook ───────────────────────────────────────────────────────
    await page.reload();
    // Straight back into the steps rather than onto the prep board — and, unlike
    // plain cook mode, only once the PLAN is back too. That guard is guided
    // cook's one lifecycle difference and this is the only place both documents
    // really race.
    await expect(page.getByTestId('cook-steps-view')).toBeVisible({ timeout: HYDRATE_TIMEOUT });
    await expect(timelineStep(page, 1, true)).toBeVisible();
    await expect(timelineStep(page, 2)).toHaveAttribute('aria-current', 'step');

    // Both tick lists came back, and they are separate facts: the prep tick is
    // this mode's own list, and the entry label reads the cook back as one
    // already under way.
    await page.getByTestId('cook-stage-back').click();
    await expect(prepCounter(page)).toHaveText('Prep · 1/3 done');
    await expect(prepRows.filter({ hasText: ONION_LINE })).toHaveAttribute('aria-pressed', 'true');
    await expect(prepRows.filter({ hasText: TOMATOES_LINE })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('cook-stage-toggle')).toHaveText(/Continue cooking/);

    // ── Finish ────────────────────────────────────────────────────────────────
    await page.getByTestId('cook-stage-toggle').click();
    await expect(page.getByTestId('cook-steps-view')).toBeVisible();
    await page.getByTestId('cook-step-done').click();
    const finish = page.getByTestId('cook-mode-complete');
    await expect(finish).toBeVisible();
    await finish.click();
    await expect(page).toHaveURL(new RegExp(`#/recipes/${RECIPE_ID}$`), { timeout: SYNC_TIMEOUT });

    // Finishing DELETED the session document — the same one plain cook mode uses
    // — so re-entering guided cook starts a clean cook with nothing ticked.
    await guidedHalf.click();
    await expect(prepCounter(page)).toHaveText('Prep · 0/3 done', { timeout: SYNC_TIMEOUT });
  });
});
