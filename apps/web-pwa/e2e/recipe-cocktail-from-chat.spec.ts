/**
 * A cocktail created by the librarian (issue #765).
 *
 * The one thing a cocktail could not do was come into existence any way other
 * than by hand. All three AI creation paths — URL import, photo import and chat
 * "Save as recipe" — funnel through the same choke point
 * (`assembleRecipeDraft`), which used to hardcode `kind: 'recipe'`, so none of
 * them could produce anything but a dinner. This drives the one of the three that
 * is reachable end-to-end under the emulator harness.
 *
 *   stubAi('chefChat' | 'generateChatTitle' | 'authorRecipe' |
 *          'parseRecipeIngredients', …) writes the canned model answers
 *     → a chat about a Negroni runs the real chefChat callable
 *       → "Save as recipe" — the SAME single button, no kind picker — runs the
 *         real authorRecipe callable, whose librarian answers kind: 'cocktail'
 *         → the toast says "Cocktail created", not "Recipe saved!"
 *           → the stored document is a cocktail, and it is listed under the
 *             Cocktails chip of the recipe list and NOT under Recipes
 *
 * WHY NOT THE URL IMPORT, which is what the issue's deliverable named.
 * `extractRecipeFromUrl` performs a real SSRF-guarded HTTPS fetch of the page
 * BEFORE it ever reaches the model, and the guard refuses private IPs by design —
 * so there is no page an emulator-hosted spec can serve it, and there is no URL
 * import e2e in this suite for exactly that reason. The AI seam is not the
 * obstacle; the network guard in front of it is. The chat path exercises the same
 * choke point, the same schema and the same list rendering, and additionally
 * covers the toast, which the URL import does not touch.
 *
 * Left on the project's 1280x720 desktop default, like recipe-make-variation:
 * nothing here asserts on layout.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

const USER_MESSAGE = 'how do I make a negroni';
const STUB_REPLY =
  'Deterministic stubbed chef reply: equal parts gin, Campari and sweet vermouth, stirred over ice.';
const STUB_TITLE = 'Stubbed Negroni Conversation';

const COCKTAIL_TITLE = 'Stubbed Negroni';
const COCKTAIL_INGREDIENT = '30 ml Campari';
const COCKTAIL_STEP = 'Stir over ice and strain into a rocks glass.';

// The librarian's canned answer, and `kind` is the whole point of it: before
// #765 this field did not exist on the wire, and the assembled document came back
// a `recipe` however plainly the conversation was about a drink.
const STUB_AUTHOR = {
  title: COCKTAIL_TITLE,
  kind: 'cocktail',
  description: 'A bitter Italian aperitivo.',
  servings: 1,
  tags: ['aperitivo'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: COCKTAIL_INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: COCKTAIL_STEP, timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

// `assembleRecipeDraft` re-parses every ingredient on the create path, so the
// parse model is reached too. Shape must satisfy ParseRecipeIngredientsAIOutputSchema.
const STUB_PARSE = {
  groups: [
    {
      name: null,
      items: [
        {
          rawText: COCKTAIL_INGREDIENT,
          quantity: { type: 'single' as const, value: 30 },
          unit: 'ml' as const,
          item: 'Campari',
          preparation: [],
          notes: null,
          isOptional: false,
          displayText: '30 ml',
        },
      ],
    },
  ],
};

async function getRecipes(page: Page): Promise<Recipe[]> {
  return page.evaluate<Recipe[]>(() => window.__e2e!.getRecipes() as Recipe[]);
}

test.describe('recipes — a cocktail authored from a chat', () => {
  test('“Save as recipe” on a drink conversation files a cocktail, not a dinner', async ({
    page,
  }, testInfo) => {
    // 120s: a chat round-trip and a librarian round-trip through the emulator,
    // each gated on its own signal-bound wait below.
    test.setTimeout(120_000);
    const email = uniqueEmail(testInfo.testId);
    // Chat is not admin-gated, but the recipe list this lands on is, while the
    // module is incomplete (#179).
    await gotoAndSignIn(page, email, '/#/chat', { admin: true });

    // ── Register every canned model answer BEFORE driving the UI ───────────────
    await page.evaluate((r) => window.__e2e!.stubAi('chefChat', r), STUB_REPLY);
    await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_TITLE);
    await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
    await page.evaluate((p) => window.__e2e!.stubAi('parseRecipeIngredients', p), STUB_PARSE);

    // ── Talk to the chef about a drink ────────────────────────────────────────
    await expect(page.getByTestId('chat-new-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('chat-new-btn').click();
    await expect(page).toHaveURL(/#\/chat\/[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });

    await expect(page.getByTestId('chat-input')).toBeVisible();
    await page.getByTestId('chat-input').fill(USER_MESSAGE);
    await page.getByTestId('chat-send-btn').click();
    await expect(
      page.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
    ).toBeVisible({ timeout: 30_000 });

    // ── One button, no kind picker ────────────────────────────────────────────
    // The affordance the issue is explicit about NOT adding: there is no "save as
    // cocktail" anywhere, because the model has already worked out which it is.
    await expect(page.getByTestId('chat-save-recipe-btn')).toBeVisible();

    await page.getByTestId('chat-save-recipe-btn').click();
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: 60_000 });
    const cocktailId = page.url().match(/#\/recipes\/([a-z0-9-]+)/)?.[1];
    expect(cocktailId).toBeTruthy();

    // The toast names what was actually written. "Recipe saved!" here is the
    // pre-#765 behaviour and the most visible half of the bug.
    await expect(page.getByText('Cocktail created')).toBeVisible();

    await expect(page.getByRole('heading', { name: COCKTAIL_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── The stored document is a cocktail ─────────────────────────────────────
    await expect
      .poll(async () => (await getRecipes(page)).find((r) => r.id === cocktailId)?.kind, {
        timeout: SYNC_TIMEOUT,
      })
      .toBe('cocktail');

    // …and it is a create-path document like any other: its own identity, no
    // "makes" link, and no image, so the hero trigger draws it with cocktail art
    // direction from the existing pipeline.
    const cocktail = (await getRecipes(page)).find((r) => r.id === cocktailId)!;
    expect(cocktail.producesCanonId ?? null).toBeNull();
    expect(cocktail.source).toEqual({ type: 'manual' });

    // ── It is filed under Cocktails, and NOT under Recipes ────────────────────
    // Both halves matter: a document with the right `kind` that still rendered in
    // the dinner list would look identical to a working feature from the code.
    await page.goto('/#/recipes');
    const cocktailChip = page.getByTestId('recipe-kind-filter').filter({ hasText: 'Cocktails' });
    await expect(cocktailChip).toBeVisible({ timeout: SYNC_TIMEOUT });
    await cocktailChip.click();
    await expect(
      page.getByTestId('recipe-list-item').filter({ hasText: COCKTAIL_TITLE }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });

    await page.getByTestId('recipe-kind-filter').filter({ hasText: 'Recipes' }).first().click();
    await expect(
      page.getByTestId('recipe-list-item').filter({ hasText: COCKTAIL_TITLE }),
    ).toHaveCount(0);
  });
});
