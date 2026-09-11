/**
 * The New sheet — starting a meal by hand (issue #1319 Phase 6).
 *
 * Hand-authoring a recipe is gone: a recipe arrives by URL, by photo or by chat.
 * Three entries cannot arrive any of those ways, and "a meal" is the one that has
 * never had a door at all — #752 deliberately refused to offer one, on the grounds
 * that minting an empty meal is offering a recipe under another name. This spec is
 * that objection's answer in a browser: the sheet will not write anything until the
 * meal has a dish, so the document IS a meal the instant it exists.
 *
 * The "When you CBA" half of the sheet is driven end to end by
 * `recipe-alternatives.spec.ts`, which owns the section assertions that go with it.
 * What needs its own journey here is the PART THAT IS NEW: the at-least-one-dish
 * rule, and landing on the meal's own page already editing it.
 *
 * The two dishes are bridge-seeded (NF-C4): authoring them is two round trips
 * before the thing under test begins, and their only job is to be pickable. No AI
 * stub is needed — nothing here calls a flow.
 */
import type { Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly (#696, Phase 4): the recipe page docks its chat
// column from 700x480 up. Same numbers as `recipe-crud.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const CHICKEN_ID = 'new-sheet-chicken';
const GRAVY_ID = 'new-sheet-gravy';
const MEAL_TITLE = 'Sunday roast';

function dish(id: string, title: string, handsOffMinutes: number): Recipe {
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
      // A strip, because the picker's ORDER is the domain's longest-cooking-first
      // rule and these two numbers are what it reads (issue #1213).
      phases: [{ label: 'Cook', handsOnMinutes: 0, handsOffMinutes }],
      tags: [],
    },
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
}

/** The new meal's stored component ids, read from the store rather than the DOM (NF-D3). */
function componentsOf(page: Page, title: string): Promise<string[]> {
  return page.evaluate((t) => {
    const meal = window.__e2e!.getRecipes().find((r) => r.title === t);
    return [...(meal?.componentRecipeIds ?? [])];
  }, title);
}

test.describe('recipes — New → a meal', () => {
  test('refuses a meal without a dish, then lands on it already editing', async ({
    page,
  }, testInfo) => {
    // Two bridge-seeded writes plus one create and one route change — the
    // create-and-edit tier (NF-F2), not the trigger/AI one.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    await seedRecipe(page, dish(CHICKEN_ID, 'Roast chicken', 90));
    await seedRecipe(page, dish(GRAVY_ID, 'Onion gravy', 20));

    await page.goto('/#/recipes');
    await expect(page.getByTestId('recipe-new-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // ── There is no way to type a recipe or a cocktail from scratch ───────────
    await page.getByTestId('recipe-new-btn').click();
    await expect(page.getByTestId('recipe-new-manual')).toHaveCount(0);
    await expect(page.getByTestId('recipe-new-cocktail')).toHaveCount(0);

    // ── A name alone is not a meal ───────────────────────────────────────────
    await page.getByTestId('recipe-new-meal').click();
    await expect(page.getByTestId('recipe-new-name')).toBeVisible();
    await page.getByTestId('recipe-new-name').fill(MEAL_TITLE);
    // THE rule: nothing is written until it has a dish, so no empty meal exists
    // to be tidied up later.
    await expect(page.getByTestId('recipe-new-create')).toBeDisabled();

    // ── Give it two dishes, picked shortest-first ────────────────────────────
    // The picker input is an unlabelled action affordance (NF-B2); the OPTION is
    // resolved accessibly.
    await page.getByTestId('recipe-new-dish-picker').click();
    const gravy = page.getByRole('option', { name: 'Onion gravy' });
    await expect(gravy).toBeVisible({ timeout: SYNC_TIMEOUT });
    await gravy.click();
    await expect(page.getByTestId('recipe-new-create')).toBeEnabled();

    await page.getByTestId('recipe-new-dish-picker').click();
    const chicken = page.getByRole('option', { name: 'Roast chicken' });
    await expect(chicken).toBeVisible({ timeout: SYNC_TIMEOUT });
    await chicken.click();
    await expect(page.getByTestId('recipe-new-dish-row')).toHaveCount(2);

    await page.getByTestId('recipe-new-create').click();

    // ── It lands on the meal's own page, already editing ─────────────────────
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId('recipe-done-button')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByRole('heading', { name: MEAL_TITLE })).toBeVisible();

    // The dishes are already attached, in the cook's order — the 90-minute
    // chicken leads the 20-minute gravy despite being picked second, because
    // ordering is `insertComponentByElapsedTime` and not the order of the taps.
    await expect
      .poll(() => componentsOf(page, MEAL_TITLE), { timeout: SYNC_TIMEOUT })
      .toEqual([CHICKEN_ID, GRAVY_ID]);

    await page.getByTestId('recipe-done-button').click();
    await expect(page.getByTestId('recipe-edit-mode-button')).toBeVisible();
    await expect(page.getByTestId('recipe-component-card')).toHaveCount(2);

    // ── And it is on the Meals shelf, not among the recipes ──────────────────
    await page.goto('/#/recipes');
    const cards = page.getByTestId('recipe-list-item');
    await expect(cards.filter({ hasText: 'Roast chicken' })).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    // A meal leaves the section its KIND would put it in (issue #752).
    await expect(cards.filter({ hasText: MEAL_TITLE })).toHaveCount(0);

    await page.getByTestId('recipe-kind-filter').filter({ hasText: 'Meals' }).click();
    await expect(cards.filter({ hasText: MEAL_TITLE })).toHaveCount(1);
  });
});
