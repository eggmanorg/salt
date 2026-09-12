/**
 * Recipe manual CRUD E2E tests (issue #179, Phase 2).
 *
 * Runs against the Firestore + Auth emulators and exercises the full lifecycle
 * with no AI: a recipe with two ingredient groups and several steps reaches the
 * page, survives a reload, is edited in place, and is deleted. This is the schema
 * stress-test the phase is designed around.
 *
 * The EDIT half moved onto the recipe's own page in issue #1319 Phase 7 — Edit is
 * an icon button in the action row and Done replaces it; there is no Save and no
 * route change. Phase 8 then deleted the editor and its three routes, so the C of
 * CRUD is no longer a journey a person can take by hand: the document is
 * BRIDGE-SEEDED (NF-C4) and what this spec pins from there is unchanged — the
 * two-group, two-step shape renders, round-trips through Firestore, and can be
 * renamed and deleted.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';

// A phone, pinned explicitly (#696, Phase 4). The recipe page docks its chat column
// from 700x480 up, and this spec inherits the project's 1280x720 desktop default —
// which would put it on the two-column layout the assertions below were never
// written for. Same numbers as `recipe-alternatives.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const RECIPE_ID = 'test-dahl';
const LENTILS = '1 ½ cups red lentils, rinsed';
const GHEE = '2 tbsp ghee';

// The schema stress-test itself: two groups, one of them named, and two steps.
// Stated as a document rather than typed into a form — the shape is what the
// assertions below read back, and it is the same shape either way.
const RECIPE: Recipe = {
  id: RECIPE_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Test Dahl',
  description: null,
  ingredients: [
    {
      id: `${RECIPE_ID}-g1`,
      name: 'For the dahl',
      items: [
        {
          id: `${RECIPE_ID}-i1`,
          rawText: LENTILS,
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
    {
      id: `${RECIPE_ID}-g2`,
      name: 'For the tarka',
      items: [
        {
          id: `${RECIPE_ID}-i2`,
          rawText: GHEE,
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
    { id: `${RECIPE_ID}-s1`, text: 'Simmer the lentils until soft.', timer: null, note: null },
    { id: `${RECIPE_ID}-s2`, text: 'Pour over the sizzling tarka.', timer: null, note: null },
  ],
  metadata: { servings: null, phases: [], timingSummary: null, tags: [] },
  source: null,
  notes: null,
  producesCanonId: null,
  componentRecipeIds: [],
  kit: [],
  image: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: '',
  lastEditedBy: '',
};

test.describe('recipes — manual CRUD', () => {
  test('two groups + steps render, reload, edit, delete', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Seed ───────────────────────────────────────────────────────────────
    await seedRecipe(page, RECIPE);
    await page.goto(`/#/recipes/${RECIPE_ID}`);

    // ── The page renders the whole shape ─────────────────────────────────────
    // `recipe-view` is the arrival: the page renders nothing under it until the
    // seeded document has reached the store. The URL is not — it is whatever
    // `goto` was handed, true before the write could possibly have landed.
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByRole('heading', { name: 'Test Dahl' })).toBeVisible();
    await expect(page.getByTestId('recipe-view-group-name')).toContainText([
      'For the dahl',
      'For the tarka',
    ]);
    // .nth(0) = the first rendered ingredient of this test's own recipe (group
    // one's lentils) — indexing the test's own data, not a global ordering.
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText(LENTILS);
    await expect(page.getByTestId('recipe-view-step')).toHaveCount(2);

    const recipeUrl = page.url();

    // ── Reload → persisted ─────────────────────────────────────────────────
    // The seed went through the real `persistRecipe` path and resolved before
    // `seedRecipe` returned, so this reload is reading Firestore rather than
    // racing a debounce — unlike one taken straight after an in-place Done, which
    // is the race the note further down explains.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Test Dahl' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    // .nth(0) = the first ingredient of this test's own recipe, re-rendered from
    // Firestore after reload — still the test's self-created set, not a global index.
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText(LENTILS);

    // ── Edit → change title, in place ─────────────────────────────────────────
    // Since issue #1319 editing happens on THIS page: an icon-only Edit button in
    // the action row, at every width, and no item in the ⋮ menu. There is no Save
    // and no route change — which is the whole point, so the URL is asserted to be
    // the one it already was rather than navigated back to.
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-title').click();
    await page.getByTestId('recipe-title-input').fill('Test Dahl (revised)');
    await page.getByTestId('recipe-done-button').click();

    await expect(page).toHaveURL(new RegExp(`${recipeUrl.split('#')[1]}$`));
    await expect(page.getByRole('heading', { name: 'Test Dahl (revised)' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // NO RELOAD HERE, deliberately, and the boundary is worth stating. An in-place
    // edit is COALESCED: the store is updated synchronously and the `setDoc` lands
    // at the end of the debounce window or on the flush `Done` issues — and nothing
    // the page renders says the round trip finished. So a reload immediately after
    // Done races that flush, which is what it did on the first run of this spec:
    // the rename showed in the heading and was gone after the refresh. What this
    // spec can honestly pin is the rename being applied where it was made; the
    // write path itself is pinned by `recipeService.coalescedEdit.test.ts` and the
    // flush by `RecipeViewPage.reviewFlag.test.ts`. The Firestore round trip is
    // still exercised below — the delete asserts across a reload.
    //
    // `recipe-notes-markdown.spec.ts` has the sibling case (PR #1340 review,
    // should-fix 8): it asserts an in-place edit survived a `page.goto` back to
    // the URL it never left. Read that comment alongside this one — it is NOT
    // the reload this one avoids (a `page.goto` to the current URL is a
    // same-document hash navigation, proven nowhere near Firestore, not a
    // network round trip), so there is no real asymmetry to reconcile between
    // the two specs today. If either spec starts asserting an ACTUAL
    // `page.reload()` immediately after Done, it needs a settled-flush signal
    // first, or it inherits this exact race.

    // ── Out and back in ──────────────────────────────────────────────────────
    // The retired editor's save was a ROUTE CHANGE, so the recipe page remounted
    // for free before the delete below. Editing in place is not a navigation, and
    // without that remount the ⋮ menu's own click was left waiting out the test
    // budget — so the round trip is made explicitly. It is also the honest place to
    // read the rename back: the list is a different component over the same store.
    await page.goto('/#/recipes');
    await expect(
      page.getByTestId('recipe-list-item').filter({ hasText: 'Test Dahl (revised)' }),
    ).toHaveCount(1, { timeout: SYNC_TIMEOUT });
    await page.goto(`/#${recipeUrl.split('#')[1]}`);
    await expect(page.getByRole('heading', { name: 'Test Dahl (revised)' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── Delete ───────────────────────────────────────────────────────────────
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-delete-menu-item').click();
    await expect(page.getByTestId('recipe-delete-dialog')).toBeVisible();
    await page.getByTestId('recipe-delete-confirm').click();

    await expect(page).toHaveURL(/#\/recipes$/, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId('recipe-list-item').filter({ hasText: 'Test Dahl' })).toHaveCount(
      0,
      { timeout: SYNC_TIMEOUT },
    );

    // Survives reload (delete committed to Firestore).
    await page.reload();
    await expect(page.getByTestId('recipe-list-item').filter({ hasText: 'Test Dahl' })).toHaveCount(
      0,
      { timeout: SYNC_TIMEOUT },
    );
  });
});
