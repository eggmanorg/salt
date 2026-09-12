/**
 * A recipe becomes a meal where it is read — and stops being one (issue #1343).
 *
 * A meal is an ordinary `recipes/{id}` carrying `componentRecipeIds`; there is no
 * meal kind and nothing is minted. Until now the only way to give an existing
 * recipe its first dish was the retired editor's picker, which #1319 Phase 8
 * deletes. The door that replaces it is the "Made from" card's own dashed
 * `+ Dishes` slot, shown in edit mode on any kind `takesComponents` admits.
 *
 * What this spec drives, and why a browser is the right place for it:
 *
 *   THE CARD MOUNTS ON CAPABILITY, NOT ON PRESENCE, so a recipe with nothing
 *   attached offers the slot the moment Edit is pressed — and the consequence of
 *   using it is a SHELF CHANGE on another route, which only a real navigation can
 *   show.
 *
 *   THE CARD SURVIVES BEING EMPTIED. Taking the last dish off used to unmount the
 *   card under the finger doing it, picker and all. The unit suites pin the
 *   component's own gate; what this adds is the same gesture against a real
 *   Firestore write settling underneath it, which is where the old defect
 *   actually bit.
 *
 * The demotion lands on Done, never on the tap — Salt records what you did rather
 * than policing it half-way through — so the return trip to the Recipes shelf is
 * asserted after Done and not before.
 *
 * Both dishes and the recipe are bridge-seeded (NF-C4): authoring them is three
 * round trips before the thing under test begins. No AI stub is needed — nothing
 * here calls a flow, and the `onRecipeWritten` hero trigger short-circuits under
 * `FUNCTIONS_AI_FAKE` regardless.
 */
import type { Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly (#696, Phase 4): the recipe page docks its chat
// column from 700x480 up. Same numbers as `meal-component-create.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const ROAST_ID = 'becomes-roast';
const CHICKEN_ID = 'becomes-chicken';
const GRAVY_ID = 'becomes-gravy';
const ROAST_TITLE = 'Sunday roast';
const CHICKEN = 'Roast chicken';
const GRAVY = 'Onion gravy';

function recipe(id: string, title: string): Recipe {
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
    componentRecipeIds: [],
    kit: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

/** The roast's component ids, read from the store rather than the DOM (NF-D3). */
function readComponents(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const meal = window.__e2e!.getRecipes().find((r) => r.id === id);
    return [...(meal?.componentRecipeIds ?? [])];
  }, ROAST_ID);
}

/**
 * The list, on its default shelf, with the chicken standing as proof it has
 * rendered before any negative below is asked to mean anything.
 *
 * The section filter is component state, so it resets on this navigation — which
 * is only true because every call arrives from the recipe page. A `page.goto` to
 * the hash we are already on is a no-op and would silently read back the shelf the
 * previous call selected.
 */
async function openListOnRecipesShelf(page: Page) {
  await page.goto('/#/recipes');
  const cards = page.getByTestId('recipe-list-item');
  await expect(cards.filter({ hasText: CHICKEN })).toHaveCount(1, { timeout: SYNC_TIMEOUT });
  return cards;
}

test.describe('meals — an ordinary recipe becomes one, and stops being one', () => {
  test('the dashed slot converts it, and emptying it demotes on Done rather than mid-gesture', async ({
    page,
  }, testInfo) => {
    // Three bridge-seeded writes plus two in-place edits — the create-and-edit
    // tier (NF-F2), not the trigger/AI one.
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    await seedRecipe(page, recipe(CHICKEN_ID, CHICKEN));
    await seedRecipe(page, recipe(GRAVY_ID, GRAVY));
    // An ORDINARY recipe: nothing hangs off it, so today it is not a meal.
    await seedRecipe(page, recipe(ROAST_ID, ROAST_TITLE));

    await page.goto(`/#/recipes/${ROAST_ID}`);
    await expect(page.getByRole('heading', { name: ROAST_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── Read mode is untouched ───────────────────────────────────────────────
    // No card, and therefore no "New" menu either: the menu stays gated on the
    // document having dishes, in lockstep with the import dialogs it opens.
    await expect(page.getByText('Made from', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('meal-component-new-btn')).toHaveCount(0);

    // ── Edit mode offers the door in ─────────────────────────────────────────
    await page.getByTestId('recipe-edit-mode-button').click();
    const slot = page.getByTestId('recipe-edit-components');
    await expect(slot).toBeVisible();
    await expect(slot).toHaveText('+ Dishes');
    // Still no "New" menu — this is the conversion path, and it is the picker.
    await expect(page.getByTestId('meal-component-new-btn')).toHaveCount(0);

    await slot.click();
    await page.getByTestId('recipe-edit-component-picker').click();
    const chicken = page.getByRole('option', { name: CHICKEN });
    await expect(chicken).toBeVisible({ timeout: SYNC_TIMEOUT });
    await chicken.click();

    // The attach is a whole-document write settling asynchronously (NF-A3/NF-D3).
    await expect.poll(() => readComponents(page), { timeout: SYNC_TIMEOUT }).toEqual([CHICKEN_ID]);

    // The "New" menu arrives WITH the first dish, mid-edit, because the document
    // genuinely changed — as does the ⋮ Cook plan item below.
    await expect(page.getByTestId('meal-component-new-btn')).toBeVisible();

    await page.getByTestId('recipe-edit-components-done').click();
    await page.getByTestId('recipe-done-button').click();
    await expect(page.getByTestId('recipe-component-card')).toHaveCount(1);

    // It has a running order to schedule now, which an ordinary recipe has not.
    await page.getByTestId('recipe-actions-overflow').click();
    await expect(page.getByTestId('recipe-cook-plan-menu-item')).toBeVisible();
    await page.keyboard.press('Escape');

    // ── …and it has moved shelf ──────────────────────────────────────────────
    // A meal leaves the section its KIND would put it in (issue #752), which is
    // the consequence of the conversion no single page can show.
    const shelved = await openListOnRecipesShelf(page);
    await expect(shelved.filter({ hasText: ROAST_TITLE })).toHaveCount(0);
    await page.getByTestId('recipe-kind-filter').filter({ hasText: 'Meals' }).click();
    await expect(shelved.filter({ hasText: ROAST_TITLE })).toHaveCount(1);

    // ── Taking the last dish off does not pull the card away ─────────────────
    await page.goto(`/#/recipes/${ROAST_ID}`);
    await expect(page.getByTestId('recipe-component-card')).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-components').click();
    await page.getByTestId(`recipe-edit-component-remove-${CHICKEN_ID}`).click();

    await expect.poll(() => readComponents(page), { timeout: SYNC_TIMEOUT }).toEqual([]);

    // The gesture is still standing where it started: rows and picker both
    // mounted, and the card has not gone anywhere.
    await expect(page.getByTestId('recipe-edit-component-rows')).toBeVisible();
    await expect(page.getByTestId('recipe-edit-component-row')).toHaveCount(0);
    await expect(page.getByText('Made from', { exact: true })).toBeVisible();

    // …and a different dish goes straight in, which is the whole point of the card
    // not being pulled away. Mounted is not the same claim as usable, so this taps
    // it rather than asserting the picker is on screen.
    await page.getByTestId('recipe-edit-component-picker').click();
    const gravy = page.getByRole('option', { name: GRAVY });
    await expect(gravy).toBeVisible({ timeout: SYNC_TIMEOUT });
    await gravy.click();
    await expect.poll(() => readComponents(page), { timeout: SYNC_TIMEOUT }).toEqual([GRAVY_ID]);

    // Back to empty, to drive the demotion the rest of the way.
    await page.getByTestId(`recipe-edit-component-remove-${GRAVY_ID}`).click();
    await expect.poll(() => readComponents(page), { timeout: SYNC_TIMEOUT }).toEqual([]);

    await page.getByTestId('recipe-edit-components-done').click();
    // Closed back to the dashed slot, not to an empty list and not to nothing.
    await expect(page.getByTestId('recipe-edit-components')).toHaveText('+ Dishes');

    await page.getByTestId('recipe-done-button').click();
    await expect(page.getByText('Made from', { exact: true })).toHaveCount(0);

    // ── …and it is back among the recipes ────────────────────────────────────
    const demoted = await openListOnRecipesShelf(page);
    await expect(demoted.filter({ hasText: ROAST_TITLE })).toHaveCount(1);
    // Positives first: the chicken never stood on the Meals shelf, so its
    // disappearance is what says the shelf actually changed before the roast's
    // absence is asked to mean anything.
    await page.getByTestId('recipe-kind-filter').filter({ hasText: 'Meals' }).click();
    await expect(demoted.filter({ hasText: CHICKEN })).toHaveCount(0);
    await expect(demoted.filter({ hasText: ROAST_TITLE })).toHaveCount(0);

    // Committed, not merely optimistic.
    await page.goto(`/#/recipes/${ROAST_ID}`);
    await expect(page.getByRole('heading', { name: ROAST_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByText('Made from', { exact: true })).toHaveCount(0);
  });
});
