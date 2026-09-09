/**
 * "Make a variation" E2E (issue #763).
 *
 * The journey Duplicate could not serve: you are on a dish, you want the same
 * idea with a different protein, and you want to talk it through rather than
 * drive a form. Runs against the Firestore + Auth emulators with the MODEL faked
 * (FUNCTIONS_AI_FAKE) and every other layer live — the callable boundary, both
 * Genkit flows, the Firestore writes and the realtime subscriptions.
 *
 *   stubAi('chefChat' | 'generateChatTitle' | 'authorRecipe' |
 *          'parseRecipeIngredients', …) writes the canned model answers
 *     → ⋮ → Make a variation creates a chatSessions doc holding basedOnRecipeId
 *       → the chat opens on /#/chat/:id with a "Based on: …" chip and an empty
 *         transcript, titled "<dish> variation"
 *         → a message runs the real chefChat callable against the fake model
 *           → "Save as recipe" runs the real authorRecipe callable, which
 *             assembles in CREATE mode
 *             → a SECOND, independent recipe exists and the conversation is
 *               listed on it
 *
 * The load-bearing assertion is the last one plus its mirror: the original
 * recipe document is byte-for-byte what it was before the variation started.
 * A variation that quietly edited its base would still look right on screen.
 *
 * Left on the project's 1280x720 desktop default, like `recipe-duplicate.spec.ts`
 * — the ⋮ menu exists at every width and nothing here asserts on layout.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

const ORIGINAL = 'Chorizo Variation Pilaf';
const ORIGINAL_INGREDIENT = '200 g chorizo, sliced';
const ORIGINAL_STEP = 'Fry the chorizo until the oil runs red.';

// The variation the user asks for, and the chef's canned answer. Phrases a real
// model would never produce verbatim, so their appearance can only be the stub.
const USER_MESSAGE = 'prawns instead of chorizo';
const STUB_REPLY =
  'Deterministic stubbed chef reply: add 2 tbsp oil and hold the prawns until the last three minutes.';
const STUB_TITLE = 'Stubbed Prawn Conversation';

// The librarian's canned output — a genuinely different dish with its own name,
// which is what makes "its own name, not the original's" assertable.
const VARIATION_TITLE = 'Stubbed Prawn & Red Pepper Pilaf';
const VARIATION_INGREDIENT = '300 g king prawns';
const VARIATION_STEP = 'Stir the prawns through for the last three minutes.';

const STUB_AUTHOR = {
  title: VARIATION_TITLE,
  description: 'A prawn take on the pilaf.',
  servings: 4,
  tags: ['weeknight'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [
        { rawText: VARIATION_INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 },
      ],
    },
  ],
  steps: [{ text: VARIATION_STEP, timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

// `assembleRecipeDraft` re-parses every ingredient on the create path, so the
// parse model is reached too and needs its own canned answer. Shape must satisfy
// ParseRecipeIngredientsAIOutputSchema — the slim pre-ID AI shape.
const STUB_PARSE = {
  groups: [
    {
      name: null,
      items: [
        {
          rawText: VARIATION_INGREDIENT,
          quantity: { type: 'single' as const, value: 300 },
          unit: 'g' as const,
          item: 'king prawns',
          preparation: [],
          notes: null,
          isOptional: false,
          displayText: '300 g',
        },
      ],
    },
  ],
};

async function getRecipes(page: Page): Promise<Recipe[]> {
  return page.evaluate<Recipe[]>(() => window.__e2e!.getRecipes() as Recipe[]);
}

async function getSessions(page: Page): Promise<ChatSessionDoc[]> {
  return page.evaluate<ChatSessionDoc[]>(() => window.__e2e!.getChatSessions() as ChatSessionDoc[]);
}

test.describe('recipes — make a variation', () => {
  test('⋮ → Make a variation talks through a new dish and saves it, leaving the original alone', async ({
    page,
  }, testInfo) => {
    // 120s: a seed save, a chat round-trip and a librarian round-trip through the
    // emulator, each gated on its own signal-bound wait below.
    test.setTimeout(120_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Register every canned model answer BEFORE driving the UI ───────────────
    await page.evaluate((r) => window.__e2e!.stubAi('chefChat', r), STUB_REPLY);
    await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_TITLE);
    await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
    await page.evaluate((p) => window.__e2e!.stubAi('parseRecipeIngredients', p), STUB_PARSE);

    // ── Seed: the dish the variation starts from, created through the UI ───────
    await page.goto('/#/recipes/new');
    await expect(page.getByRole('heading', { name: /new recipe/i })).toBeVisible();
    await page.getByTestId('recipe-title-input').fill(ORIGINAL);

    await page.getByTestId('recipe-add-group-btn').click();
    // .nth(0) indexes the single group row THIS test just added — its own set.
    const group0 = page.getByTestId('recipe-group').nth(0);
    await group0.getByTestId('recipe-add-ingredient-btn').click();
    await group0.getByTestId('recipe-ingredient-input').nth(0).fill(ORIGINAL_INGREDIENT);

    await page.getByTestId('recipe-add-step-btn').click();
    await page.getByTestId('recipe-step-input').nth(0).fill(ORIGINAL_STEP);

    await page.getByTestId('recipe-save-btn').click();
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    const originalUrl = page.url();
    const originalId = originalUrl.match(/#\/recipes\/([a-z0-9-]+)/)?.[1];
    expect(originalId).toBeTruthy();
    await expect(page.getByRole('heading', { name: ORIGINAL })).toBeVisible();

    // The original exactly as it stands, for the byte-comparison at the end.
    await expect
      .poll(async () => (await getRecipes(page)).some((r) => r.id === originalId), {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(true);
    const originalBefore = (await getRecipes(page)).find((r) => r.id === originalId)!;

    // ── ⋮ → Make a variation opens a NEW chat that knows the dish ──────────────
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-make-variation-menu-item').click();

    await expect(page).toHaveURL(/#\/chat\/[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    const sessionId = page.url().match(/#\/chat\/([a-z0-9-]+)/)?.[1];
    expect(sessionId).toBeTruthy();

    // The chip states the relationship, and the seeded title names the dish.
    await expect(page.getByTestId('chat-based-on-chip')).toContainText(`Based on: ${ORIGINAL}`);
    await expect(page.getByRole('heading', { name: `${ORIGINAL} variation` })).toBeVisible();
    // An EMPTY transcript — the recipe rides on the session, not as a pasted turn.
    await expect(page.getByTestId('chat-message-user')).toHaveCount(0);
    await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);

    // It starts from the recipe without belonging to it: that is what keeps it off
    // the original's own chat list and on the ordinary 14-day expiry until saved.
    const seeded = (await getSessions(page)).find((s) => s.id === sessionId)!;
    expect(seeded.basedOnRecipeId).toBe(originalId);
    expect(seeded.recipeId).toBeNull();

    // ── Talk it through ───────────────────────────────────────────────────────
    await page.getByTestId('chat-input').fill(USER_MESSAGE);
    await page.getByTestId('chat-send-btn').click();
    await expect(
      page.getByTestId('chat-message-user').filter({ hasText: USER_MESSAGE }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(
      page.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
    ).toBeVisible({ timeout: 30_000 });

    // ── Save as recipe → a brand new dish ─────────────────────────────────────
    await page.getByTestId('chat-save-recipe-btn').click();
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: 60_000 });
    const variationUrl = page.url();
    const variationId = variationUrl.match(/#\/recipes\/([a-z0-9-]+)/)?.[1];

    // A SECOND document, with its own name and its own content.
    expect(variationId).not.toBe(originalId);
    await expect(page.getByRole('heading', { name: VARIATION_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText('prawns');
    await expect(page.getByTestId('recipe-view-step')).toHaveCount(1);

    // No "makes" link inherited from the original, and a manual source — the
    // create path's defaults, which is what stops it being a second copy. `image`
    // null is what lets the hero trigger generate one from the NEW content.
    const variation = (await getRecipes(page)).find((r) => r.id === variationId)!;
    expect(variation.producesCanonId ?? null).toBeNull();
    expect(variation.source).toEqual({ type: 'manual' });
    expect(variation.image).toBeNull();

    // ── The conversation is listed on the dish it produced ────────────────────
    await expect
      .poll(async () => (await getSessions(page)).find((s) => s.id === sessionId)?.recipeId, {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(variationId);
    // …and still points at where it came from.
    expect((await getSessions(page)).find((s) => s.id === sessionId)!.basedOnRecipeId).toBe(
      originalId,
    );
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });

    // ── The original is untouched ─────────────────────────────────────────────
    await page.goto(`/#${originalUrl.split('#')[1]}`);
    await expect(page.getByRole('heading', { name: ORIGINAL, exact: true })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText('chorizo');
    // The whole document, field for field — the assertion an on-screen check
    // cannot make. A variation that had edited its base in passing fails here.
    const originalAfter = (await getRecipes(page)).find((r) => r.id === originalId)!;
    expect(originalAfter).toEqual(originalBefore);
    // The variation chat is not listed on the original: it never belonged to it.
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(0);
  });
});
