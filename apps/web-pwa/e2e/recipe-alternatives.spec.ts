/**
 * "When you CBA" — outings end to end (issue #637, Phase 3).
 *
 * An outing is a takeaway, a picnic, a meal out or a fend-for-yourself night: it
 * fills a planner slot but has no ingredients and no method. This walks the one
 * journey that has to work — New → When you CBA → title + description → save —
 * and then pins the two halves of the promise the UI makes about it: the entry
 * lives under its OWN section (and is absent from the default Recipes view), and
 * its page offers nothing that does not apply to it.
 *
 * Phase 4 adds the second journey: an outing is PICKABLE in the meal planner —
 * same picker as a recipe, same note auto-fill — and the day it lands on offers
 * no "Add to shop", because a takeaway has nothing to buy.
 *
 * No AI stub is needed. Creating an entry fires the `onRecipeWritten` hero-image
 * trigger, but nothing asserted here depends on that trigger's output — the same
 * reason recipe-crud.spec.ts does not stub either.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe, RecipeKind } from '@salt/domain';

const OUTING_TITLE = 'Takeaway — Indian';
const RECIPE_TITLE = 'Reference Recipe';
const RECIPE_ID = 'alternatives-reference-recipe';
const SEEDED_OUTING_ID = 'alternatives-planned-outing';

// A title and a kind, which is the whole of what these two tests need seeded: one
// is a foil to be distinguished FROM, the other is the entry the planner offers.
// Bridge-seeded (NF-C4) since issue #1319 Phase 8 deleted the editor's routes —
// including `/recipes/new/outing`, the one an outing used to be typed into. What
// these assertions are about is the section a kind lands on and the day it fills,
// not how it was written.
function entry(id: string, title: string, kind: RecipeKind): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind,
    title,
    description: null,
    ingredients: [],
    steps: [],
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
}

// A phone, pinned explicitly (#663, Phase 2). The second test below plans a night
// through the day's BOTTOM SHEET, and from 700x480 up the planner shows that same
// detail as a docked pane instead (with its own `day-pane-*` testids) — so the
// default desktop project viewport would put this spec on the other layout. Same
// numbers as `mealplan.spec.ts` and `mealplan-deck.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

test.describe('recipes — when you CBA', () => {
  test('create an outing, find it under its own section, and not among the recipes', async ({
    page,
  }, testInfo) => {
    // Single-tab, no cross-tab convergence and no AI wait: the 60 s budget is the
    // single-tab tier (NF-F2). Every wait below is bound to a real signal.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── A recipe to be distinguished FROM ────────────────────────────────────
    // Bridge-seeded. The outing below is still CREATED, through the New sheet,
    // because that half is the journey under test; this one is only the foil the
    // section filter has to keep separate from it.
    await seedRecipe(page, entry(RECIPE_ID, RECIPE_TITLE, 'recipe'));

    // ── Create the outing from the New menu ──────────────────────────────────
    // Since issue #1319 Phase 6 this is a SHEET, not a page: a name and a
    // description are the whole of what a "When you CBA" entry cannot exist
    // without, and everything else is done on its own page afterwards.
    await page.goto('/#/recipes');
    await page.getByTestId('recipe-new-btn').click();
    await page.getByTestId('recipe-new-outing').click();

    // Still on the list — the sheet is over it, not a route of its own.
    await expect(page).toHaveURL(/#\/recipes$/);
    await expect(page.getByTestId('recipe-new-name')).toBeVisible();

    // Nothing that does not apply is offered, and nothing that belongs on the
    // entry's own page is either — no ingredients, no method, no dish picker.
    await expect(page.getByText('Ingredients', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Method', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('recipe-new-dish-picker')).toHaveCount(0);

    await page.getByTestId('recipe-new-name').fill(OUTING_TITLE);
    await page.getByTestId('recipe-new-description').fill('Curry from the place on the corner.');
    await page.getByTestId('recipe-new-create').click();

    // ── It drops you on the entry's own page, already editing it ─────────────
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId('recipe-done-button')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('recipe-done-button').click();

    // ── Its page offers only what applies ────────────────────────────────────
    await expect(page.getByRole('heading', { name: OUTING_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByText('Curry from the place on the corner.')).toBeVisible();

    await expect(page.getByTestId('recipe-cook-button')).toHaveCount(0);
    await expect(page.getByTestId('recipe-add-to-list-button')).toHaveCount(0);
    await expect(page.getByText('Ingredients', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Method', { exact: true })).toHaveCount(0);
    // Editing and deleting always apply, so the header is never left bare — but
    // they are read in two different places since issue #1319. Editing is an
    // icon-only button in the action row, at every width, because it acts on THIS
    // page; Delete stays in the ⋮ overflow with the other things done TO the
    // document. The fact being pinned is that both affordances are there on a kind
    // that offers nothing else.
    await expect(page.getByTestId('recipe-edit-mode-button')).toBeVisible();
    await page.getByTestId('recipe-actions-overflow').click();
    await expect(page.getByTestId('recipe-delete-menu-item')).toBeVisible();
    await page.keyboard.press('Escape');

    // ── Sections ─────────────────────────────────────────────────────────────
    await page.goto('/#/recipes');
    const cards = page.getByTestId('recipe-list-item');
    const sections = page.getByTestId('recipe-kind-filters');

    // The default view is unchanged: recipes, and only recipes.
    await expect(cards.filter({ hasText: RECIPE_TITLE })).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(cards.filter({ hasText: OUTING_TITLE })).toHaveCount(0);

    // Switching sections swaps one for the other. "When you CBA" is a secondary
    // section, so the row has to be expanded before its chip exists.
    await page.getByTestId('recipe-kind-show-all').click();
    await sections.getByRole('button', { name: 'When you CBA' }).click();
    await expect(cards.filter({ hasText: OUTING_TITLE })).toHaveCount(1);
    await expect(cards.filter({ hasText: RECIPE_TITLE })).toHaveCount(0);

    // And the section survives a reload back onto the default, which is what
    // makes "Recipes looks the same as today" true for anyone who never opens
    // the other section.
    await page.reload();
    await expect(cards.filter({ hasText: RECIPE_TITLE })).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(cards.filter({ hasText: OUTING_TITLE })).toHaveCount(0);
  });

  test('plan a CBA night: it is offered in the picker, fills the day, and asks for no shopping', async ({
    page,
  }, testInfo) => {
    // Single-tab and no AI/trigger wait, but two separate document round-trips
    // (the seeded outing, then the meal-plan week) plus a route change — the same
    // budget the planner spec runs on, not the 60 s create-only tier (NF-F2).
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Seed the outing ──────────────────────────────────────────────────────
    // Bridge-seeded. It was authored through `/#/recipes/new/outing` so that the
    // thing a user creates in Phase 3 was demonstrably the thing the planner
    // offers in Phase 4 — but that route is gone (issue #1319 Phase 8), and the
    // creation half is now pinned by the test above and by
    // `recipe-new-sheet.spec.ts`. What is left here is the planner's side of it:
    // an entry of kind `outing` is offered, fills a day, and asks for no shopping.
    const outingId = SEEDED_OUTING_ID;
    await seedRecipe(page, entry(outingId, OUTING_TITLE, 'outing'));

    // ── Anchor on a real day of the current week ─────────────────────────────
    await page.goto('/#/mealplan');
    await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('this-week').click();
    await expect(page.getByTestId('week-range')).not.toHaveText('', { timeout: SYNC_TIMEOUT });

    // Derived from the store, never guessed: today is the one day guaranteed to
    // be both in the displayed week and on screen (the deck opens on it, #639).
    const dayKey = await page.evaluate(() => {
      const days = window.__e2e!.getMealPlanSnapshot().days;
      const today = new Date().toLocaleDateString('en-CA');
      return today in days ? today : Object.keys(days).sort()[0]!;
    });
    expect(dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const testid = `day-${dayKey}`;

    await page.getByTestId(`${testid}-summary`).click();
    await expect(page.getByTestId(`${testid}-detail`)).toBeVisible({ timeout: SYNC_TIMEOUT });

    // ── The outing is offered, alongside the recipes ─────────────────────────
    // The picker input is an unlabelled action affordance (NF-B2); the OPTION —
    // the content under test — is resolved accessibly. Its accessible name is the
    // title plus its "When you CBA" badge, hence the substring match.
    await page.getByTestId(`${testid}-recipe-picker`).click();
    const option = page.getByRole('option', { name: new RegExp(OUTING_TITLE) });
    await expect(option).toBeVisible({ timeout: SYNC_TIMEOUT });
    // The badge is what tells it apart from a recipe at a glance.
    await expect(option).toContainText('When you CBA');
    await option.click();

    // ── The day takes its title and its id, exactly as a recipe night would ──
    // Poll the store, not the DOM: the attach is an optimistic whole-doc save and
    // the assertion is about what landed (NF-A3/NF-D3).
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const d = window.__e2e!.getMealPlanSnapshot().days[key];
            return { recipeIds: d?.recipeIds ?? [], note: d?.note ?? '' };
          }, dayKey),
        { timeout: SYNC_TIMEOUT },
      )
      .toEqual({ recipeIds: [outingId], note: OUTING_TITLE });

    // ── And nothing that does not apply is offered ───────────────────────────
    // The row is there and removable; only "Add to shop" is absent, because a
    // takeaway has nothing to buy.
    await expect(page.getByTestId(`${testid}-recipe-row-${outingId}`)).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId(`${testid}-recipe-remove-${outingId}`)).toBeVisible();
    await expect(page.getByTestId(`${testid}-recipe-addshop-${outingId}`)).toHaveCount(0);
  });
});
