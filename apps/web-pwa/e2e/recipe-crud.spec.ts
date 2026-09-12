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
import { settleRecipeWrites } from './helpers/settle';
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
    // racing a debounce. The reload further down needs `settleRecipeWrites` to
    // say the same thing, because an in-place edit is coalesced and this one is
    // not — see the note there.
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

    // ── The rename is on the SERVER, not just in the store ───────────────────
    // This reload used to be declined: an in-place edit is COALESCED, the store
    // moves synchronously, and nothing the page renders says the round trip
    // finished — so a refresh taken straight after Done raced the flush and the
    // rename came back gone. Issue #1304 gave the bridge the missing signal.
    // `settleRecipeWrites` resolves only once Firestore has acked the write Done
    // issued, so what the heading says after the reload below can only have come
    // from the server. (It is the flush being AWAITABLE that is new, not the
    // flush: Done always issued the write, but its promise was not one any spec
    // could reach, and a flush that only drained the queue found nothing left to
    // wait for. See `writeCoalescer.ts`'s `flushAll`.)
    await settleRecipeWrites(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Test Dahl (revised)' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── …and in the list, which is a different component over it ─────────────
    // Kept for the list surface itself, not for the remount it used to be doing
    // double duty as: editing in place is not a navigation, so before #1304 this
    // leg was also what remounted the page before the delete below (without it the
    // ⋮ menu's click waited out the test budget). The reload above now does that,
    // and does it against Firestore.
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
