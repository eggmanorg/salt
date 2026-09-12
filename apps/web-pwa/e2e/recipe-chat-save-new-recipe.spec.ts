/**
 * "Save as new recipe", from a recipe's own chat (issue #798).
 *
 * The journey the review gate could not serve: you are on a dish, you ask what
 * would go with it, and the answer deserves to be its own recipe rather than
 * being folded into the one you are looking at. Runs against the Firestore + Auth
 * emulators with the MODEL faked (FUNCTIONS_AI_FAKE) and every other layer live —
 * the callable boundary, both Genkit flows, the Firestore writes and the realtime
 * subscriptions.
 *
 *   stubAi('chefChat' | 'generateChatTitle' | 'authorRecipe' |
 *          'parseRecipeIngredients', …) writes the canned model answers
 *     → ⋮ → Ask/amend opens a chat ON the lamb (recipeId set)
 *       → a message runs the real chefChat callable against the fake model
 *         → "Save as new recipe" runs the real authorRecipe callable, which
 *           assembles in CREATE mode with no base recipe at all
 *           → a SECOND, independent recipe exists, and the conversation is STILL
 *             listed on the lamb
 *
 * The load-bearing assertion is the last one plus its mirror: the recipe the chat
 * belongs to is byte-for-byte what it was before the salad was saved. A save that
 * quietly amended its host would still look right on screen — that is precisely
 * the failure mode this button sits one pixel away from, since the button beside
 * it exists to amend.
 *
 * Left on the project's 1280x720 desktop default: above the `split` seam the chat
 * docks as a column, which is the surface driven here. The drawer below it renders
 * the SAME snippet with the same handler (`saveAsNewRecipeAction`, rendered into
 * both hosts), so it is covered by this test and not driven separately — the same
 * reasoning `recipe-chat-review-gate.spec.ts` gives for its own pair.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

const DISH = 'Accompaniment Lamb Shoulder';
const DISH_INGREDIENT = '2 kg lamb shoulder';
const DISH_STEP = 'Roast low and slow for four hours.';
const DISH_ID = 'accompaniment-lamb-shoulder';

// The lamb, bridge-seeded (NF-C4): issue #1319 Phase 8 deleted the editor and its
// routes, and this journey's subject starts at the conversation. Its exact stored
// shape matters — the last assertion compares the document field for field against
// this one, to prove saving the salad left its host untouched.
const DISH_FIXTURE: Recipe = {
  id: DISH_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: DISH,
  description: null,
  ingredients: [
    {
      id: `${DISH_ID}-g1`,
      name: null,
      items: [
        {
          id: `${DISH_ID}-i1`,
          rawText: DISH_INGREDIENT,
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  steps: [{ id: `${DISH_ID}-s1`, text: DISH_STEP, timer: null, note: null }],
  metadata: { servings: null, phases: [], timingSummary: null, tags: [] },
  source: null,
  notes: null,
  producesCanonId: null,
  componentRecipeIds: [],
  kit: [],
  image: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  createdBy: '',
  lastEditedBy: '',
};

const USER_MESSAGE = 'what would go well with this?';
const STUB_REPLY =
  'Deterministic stubbed chef reply: a fennel, orange and olive salad, dressed sharply.';
const STUB_CHAT_TITLE = 'Stubbed Accompaniment Conversation';

// The librarian's canned answer: a DIFFERENT dish. Nothing of the lamb in it,
// which is what makes "its own recipe, not a hybrid" assertable.
const SALAD_TITLE = 'Stubbed Fennel, Orange & Olive Salad';
const SALAD_INGREDIENT = '2 bulbs fennel, shaved';
const SALAD_STEP = 'Toss the fennel with the orange segments and olives.';

const STUB_AUTHOR = {
  title: SALAD_TITLE,
  description: 'Sharp and cold, against the lamb.',
  servings: 4,
  tags: ['side'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: SALAD_INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: SALAD_STEP, timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

// `assembleRecipeDraft` re-parses every ingredient on the create path — this is a
// brand-new dish, so there is no existing parse to reuse — and the parse model
// needs its own canned answer. Shape must satisfy
// ParseRecipeIngredientsAIOutputSchema, the slim pre-ID AI shape.
const STUB_PARSE = {
  groups: [
    {
      name: null,
      items: [
        {
          rawText: SALAD_INGREDIENT,
          quantity: { type: 'single' as const, value: 2 },
          unit: null,
          item: 'fennel',
          preparation: ['shaved'],
          notes: null,
          isOptional: false,
          displayText: '2 bulbs',
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

test.describe('recipes — save a recipe chat as a new recipe', () => {
  test('keeps the accompaniment as its own dish and leaves the one you asked from alone', async ({
    page,
  }, testInfo) => {
    // 120s: a bridge seed, a chat round-trip and a librarian round-trip through the
    // emulator, each gated on its own signal-bound wait below.
    test.setTimeout(120_000);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });

    // ── Register every canned model answer BEFORE driving the UI ───────────────
    await page.evaluate((r) => window.__e2e!.stubAi('chefChat', r), STUB_REPLY);
    await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_CHAT_TITLE);
    await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
    await page.evaluate((p) => window.__e2e!.stubAi('parseRecipeIngredients', p), STUB_PARSE);

    // ── Seed: the dish the conversation is attached to ─────────────────────────
    await seedRecipe(page, DISH_FIXTURE);
    await page.goto(`/#/recipes/${DISH_ID}`);
    // `recipe-view` is the arrival — the page renders nothing under it until the
    // seeded document has reached the store. The URL is not: `goto` put that hash
    // in the bar before the read could possibly have come back.
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });
    const originalUrl = page.url();
    const originalId = DISH_ID;
    await expect(page.getByRole('heading', { name: DISH })).toBeVisible();

    // The lamb exactly as it stands, for the field-for-field comparison at the end.
    // Read from the store rather than assumed to equal the fixture: `persistRecipe`
    // stamps `updatedAt` and the attribution fields on the way through.
    const originalBefore = (await getRecipes(page)).find((r) => r.id === originalId)!;
    expect(originalBefore).toBeTruthy();

    // ── Ask the chef what would go with it ────────────────────────────────────
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-ask-amend-menu-item').click();

    await page.getByTestId('chat-input').fill(USER_MESSAGE);
    await page.getByTestId('chat-send-btn').click();
    await expect(
      page.getByTestId('chat-message-user').filter({ hasText: USER_MESSAGE }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });
    // The assistant turn is what unlocks both buttons in the column's footer.
    await expect(
      page.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
    ).toBeVisible({ timeout: 30_000 });

    const sessionId = (await getSessions(page))[0]!.id;
    // The conversation belongs to the lamb — this is the ATTACHED surface, which
    // is the only one the new button appears on.
    expect((await getSessions(page)).find((s) => s.id === sessionId)!.recipeId).toBe(originalId);

    // Both halves of the pair are on offer: fold it into this dish, or make it
    // another one. Only the second is pressed. They live behind one floppy-disc
    // icon in the chat header (#1310), so the menu is opened first.
    await page.getByTestId('sidebar-chat-actions-menu').click();
    await expect(page.getByTestId('sidebar-apply-changes-btn')).toBeVisible();

    // ── Save as new recipe → a brand new dish ─────────────────────────────────
    // The wait must exclude the recipe we are ALREADY on. This journey, unlike the
    // ones it is modelled on, presses its button from a `/recipes/:id` page — so a
    // plain "is on a recipe" pattern matches before the librarian has even been
    // called, and reads the original's id straight back. The id we are leaving is
    // the one thing the pattern has to refuse.
    await page.getByTestId('sidebar-save-new-recipe-btn').click();
    await expect(page).toHaveURL(new RegExp(`#/recipes/(?!${originalId}$)[a-z0-9-]+$`), {
      timeout: 60_000,
    });
    const saladId = page.url().match(/#\/recipes\/([a-z0-9-]+)/)?.[1];

    // A SECOND document, with its own name and its own content.
    expect(saladId).not.toBe(originalId);
    await expect(page.getByRole('heading', { name: SALAD_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    // The count splits into the two columns (issue #951): the stub parse carries
    // `unit: null` with `quantity: 2`, so the name cell reads the item and the
    // amount cell reads the bare number — not the whole raw line on the left with
    // an empty amount beside it.
    const saladIngredient = page.getByTestId('recipe-view-ingredient').nth(0);
    await expect(saladIngredient).toContainText('fennel');
    await expect(saladIngredient).toContainText('2');
    await expect(page.getByTestId('recipe-view-step')).toHaveCount(1);

    // The create path's defaults, which is what stops it being a copy of the lamb:
    // no "makes" link, a manual source, and `image: null` so the hero trigger
    // generates one from the NEW content.
    const salad = (await getRecipes(page)).find((r) => r.id === saladId)!;
    expect(salad.producesCanonId ?? null).toBeNull();
    expect(salad.source).toEqual({ type: 'manual' });
    expect(salad.image).toBeNull();
    // Nothing of the lamb came across — the proof that this was create mode and
    // not variation mode, which would have carried the shoulder joint over.
    expect(JSON.stringify(salad.ingredients)).not.toContain('lamb');

    // ── The conversation stays where it was ───────────────────────────────────
    // No claim: the chat is about the lamb and is still listed there, and the
    // salad has no chat of its own.
    expect((await getSessions(page)).find((s) => s.id === sessionId)!.recipeId).toBe(originalId);
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(0, {
      timeout: SYNC_TIMEOUT,
    });

    // ── The dish you asked from is untouched ──────────────────────────────────
    await page.goto(`/#${originalUrl.split('#')[1]}`);
    await expect(page.getByRole('heading', { name: DISH, exact: true })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText('lamb');
    // The whole document, field for field — the assertion an on-screen check
    // cannot make, and the one that separates this button from the one beside it.
    const originalAfter = (await getRecipes(page)).find((r) => r.id === originalId)!;
    expect(originalAfter).toEqual(originalBefore);
    // …and the conversation is still on its chat card.
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
  });
});
