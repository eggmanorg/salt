/**
 * Building a meal out of dishes (issue #752 Phase 3; rewritten for issue #1319
 * Phase 7).
 *
 * A meal is an ordinary `recipes/{id}` carrying `componentRecipeIds`. What this
 * spec drives is the AI-free way a dish joins one, end to end in a real browser.
 *
 * WHAT CHANGED, AND WHY THE JOURNEY IT USED TO DRIVE IS GONE. It used to take the
 * BY-HAND route: the meal's New menu -> Manual -> the editor at
 * `/recipes/new?meal=<id>` -> save -> back on the meal with the dish attached. Two
 * halves of that no longer exist. Hand-authoring a recipe was retired with the
 * editor (#1319 Phase 6), so there is no Manual entry to press; and for the two
 * IMPORT routes the attach no longer waits for a save at all — their callable has
 * already persisted the dish, so it is attached the moment the dialog hands it
 * back and nothing needs to ride the URL. `?meal=` survives for exactly one path,
 * chat, whose dish does not exist until the conversation produces one.
 *
 * So the journey here is the one that is both AI-free and still real: adding a dish
 * to a meal THROUGH THE MEAL'S OWN PAGE, in place, with the page's own picker
 * (#1319 Phase 3). Plus the negative that the old route is genuinely closed rather
 * than merely unused. The import-path attach is pinned by
 * `RecipeViewPage.mealComponents.test.ts`, which drives the URL-import dialog to
 * completion — a browser cannot, because that path fetches a real page.
 *
 * Both dishes are bridge-seeded (NF-C4): authoring them is two round trips before
 * the thing under test begins, and their only job is to be pickable. No AI stub is
 * needed — nothing here calls a flow, and the `onRecipeWritten` hero trigger
 * short-circuits under `FUNCTIONS_AI_FAKE` regardless.
 */
import type { Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly (#696, Phase 4): the recipe page docks its chat
// column from 700x480 up, and this spec would otherwise inherit the project's
// 1280x720 desktop default. Same numbers as `recipe-crud.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const MEAL_ID = 'meal-roast';
const CHICKEN_ID = 'meal-chicken';
const GRAVY_ID = 'meal-gravy';
const NEW_DISH = 'Onion gravy';

function recipe(id: string, title: string, componentRecipeIds: string[] = []): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 4,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds,
    kit: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

/** The meal's component ids, read from the store rather than the DOM (NF-D3). */
function readComponents(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const meal = window.__e2e!.getRecipes().find((r) => r.id === id);
    return [...(meal?.componentRecipeIds ?? [])];
  }, MEAL_ID);
}

test.describe('meals — a dish joins a meal on the meal’s own page', () => {
  test('in place: the picker attaches it, twice is once, and the old by-hand route is gone', async ({
    page,
  }, testInfo) => {
    // Three bridge-seeded writes plus one in-place attach — the create-and-edit
    // tier (NF-F2), not the trigger/AI one.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // A meal: an ordinary recipe that already has one dish hanging off it. The
    // component is what makes the "Made from" card — and so the New menu inside
    // it — exist at all; a recipe with nothing attached is not a meal yet.
    await seedRecipe(page, recipe(CHICKEN_ID, 'Roast chicken'));
    await seedRecipe(page, recipe(GRAVY_ID, NEW_DISH));
    await seedRecipe(page, recipe(MEAL_ID, 'Sunday roast', [CHICKEN_ID]));

    await page.goto(`/#/recipes/${MEAL_ID}`);
    await expect(page.getByRole('heading', { name: 'Sunday roast' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('recipe-component-card')).toHaveCount(1);

    // ── The by-hand route is genuinely closed ────────────────────────────────
    // The menu and its items are action affordances with no stable accessible
    // name of their own (NF-B2), so they are reached by testid.
    //
    // POSITIVES FIRST (PR #1340 review, should-fix 5): this menu is a lazily
    // mounted bits-ui `PopoverContent`, so a `toHaveCount(0)` negative asserted as
    // the FIRST thing after the trigger click can pass on its very first poll
    // simply because nothing has mounted yet — a regression that brought back
    // "Manual" need not turn it red. The three `toBeVisible()` waits establish
    // that the menu has actually opened before the negative is asked to mean
    // anything.
    await page.getByTestId('meal-component-new-btn').click();
    // The three ways a recipe actually arrives are all still offered here.
    await expect(page.getByTestId('meal-component-new-import')).toBeVisible();
    await expect(page.getByTestId('meal-component-new-import-photo')).toBeVisible();
    await expect(page.getByTestId('meal-component-new-chat')).toBeVisible();
    await expect(page.getByTestId('meal-component-new-manual')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ── Add a dish where the dishes are read ─────────────────────────────────
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-components').click();
    await page.getByTestId('recipe-edit-component-picker').click();
    const option = page.getByRole('option', { name: NEW_DISH });
    await expect(option).toBeVisible({ timeout: SYNC_TIMEOUT });
    await option.click();

    // The attach is a whole-document write settling asynchronously, so poll the
    // store (NF-A3/NF-D3). The chicken keeps its place — attaching adds, it never
    // re-sorts what was already arranged.
    await expect.poll(() => readComponents(page), { timeout: SYNC_TIMEOUT }).toHaveLength(2);
    const components = await readComponents(page);
    expect(components).toContain(CHICKEN_ID);
    expect(components).toContain(GRAVY_ID);

    // ── Adding the same dish twice attaches it once ──────────────────────────
    // The picker drops what is already attached, so the second tap is not there to
    // be made — which is the honest place that outcome is enforced.
    //
    // REOPENED rather than asserted against what `addComponent` left on screen
    // (PR #1340 review, blocking 3): `addComponent` bumps `pickerKey` first thing,
    // remounting the `{#key}`-wrapped Combobox, which CLOSES the listbox — so an
    // assertion made immediately after the click sees zero `option` nodes
    // regardless of what the filter does, and passes even with the filter
    // deleted. Reopening first is what `RecipeMadeFromCard.test.ts` ("drops an
    // attached dish out of the picker...") and `RecipeNewSheet.test.ts` ("drops a
    // chosen dish out of the picker...") both do for the same claim; this mirrors
    // them so the assertion can actually go red.
    //
    // POSITIVE FIRST (#1341), for the same reason as the three above: `toHaveCount(0)`
    // was still the first query made against the reopened listbox, and
    // `ComboboxContent` renders nothing at all until `ctx.open` — so the count was
    // mitigated only by the click happening to open the popup synchronously, which
    // is an implementation detail and not something this spec should rest on.
    // Waiting on the listbox itself is fixture-independent (it does not assume how
    // many candidates the seed leaves) and it is exactly the precondition the
    // negative needs: the box is open, and `NEW_DISH` is not in it.
    await page.getByTestId('recipe-edit-component-picker').click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option', { name: NEW_DISH })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByTestId('recipe-edit-components-done').click();
    await page.getByTestId('recipe-done-button').click();

    // …and the card the user actually sees.
    await expect(page.getByTestId('recipe-component-card')).toHaveCount(2);
    await expect(
      page.getByTestId('recipe-component-card').filter({ hasText: NEW_DISH }),
    ).toBeVisible();

    // ── It is committed, not merely optimistic ───────────────────────────────
    await page.reload();
    await expect(
      page.getByTestId('recipe-component-card').filter({ hasText: NEW_DISH }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });
  });
});
