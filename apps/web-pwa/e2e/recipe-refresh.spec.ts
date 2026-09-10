/**
 * ⋮ → Refresh, through the review gate (issue #890).
 *
 * Refresh asks the chef to write an existing dish out again and then runs the
 * review gate over the reply, without being asked twice. That is TWO callables
 * behind one menu item, which is exactly why it earns an e2e: the unit suites pin
 * each half (`apps/web-pwa/tests/RecipeViewPage.refresh.test.ts` for the
 * sequence, `apps/cloud-functions/tests/flows/authorRecipe.test.ts` for the
 * prompt), and only this can show one tap driving chefChat → transcript →
 * authorRecipe → diff → Firestore document.
 *
 * Runs against the Firestore + Auth emulators with the MODEL faked
 * (FUNCTIONS_AI_FAKE) and every other layer live — the callable boundary, the
 * Genkit flow, the Firestore write and the realtime subscription.
 *
 *   stubAi('chefChat', …) + stubAi('generateChatTitle', …) + stubAi('authorRecipe', …)
 *     → ⋮ → Refresh sends the canned turn and reviews the reply
 *       → the diff proposes the re-written dish
 *         → Apply writes it / Discard leaves the dish alone
 *
 * Two tests, one per side of the gate, because "nothing is written until you say
 * so" is half of what Refresh promises and the half a happy path cannot show.
 *
 * `generateChatTitle` is stubbed because Refresh opens a chat where there was
 * none, and a first exchange titles itself in the background — unstubbed it is a
 * live model call fired off a journey that never looks at the title.
 *
 * No `parseRecipeIngredients` or canon stub, deliberately: the canned answer
 * repeats the seeded ingredient's rawText verbatim, and the amendment grounds
 * `assembleRecipeDraft` on the base recipe — so the existing parse and canon
 * match are reused and neither flow is called at all. Stubbing a flow this
 * journey never reaches would only suggest it does (NF-E1).
 *
 * Left on the project's 1280x720 desktop default. The ⋮ menu is the only surface
 * Refresh has at any width (#735), so there is no second surface to drive.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

const DISH = 'Refresh Pilaf';
const INGREDIENT = '200 g chorizo, sliced';
const STEP = 'Fry the chorizo and add the rice and stir it through and cover.';
const TAG = 'refreshgate';

// The metadata the user typed. A refresh may PUT BACK what a recipe has lost, but
// it has no business clearing what the cook entered — and the librarian's canned
// answer forgets all of it, so this doubles as the metadata-preserve assertion.
const SEEDED_METADATA = {
  servings: 4,
  // Null since #1212: the editor's three time boxes are gone with the phase key
  // on, and this dish is authored through the editor. Servings and the tag carry
  // the "the librarian dropped it, the merge kept it" assertion.
  // Not typed by anyone: `emptyRecipe` stamps an empty phase strip on every new
  // recipe (issue #1122), so the stored document carries both keys from creation.
  // They are here because this is a whole-`metadata` equality — it is the
  // assertion that would catch a refresh QUIETLY CLEARING a strip the cook had
  // corrected, which is the same job it already does for the tags.
  phases: [],
  timingSummary: null,
  tags: [TAG],
};

// What the chef writes back: the whole dish, not a list of changes, which is what
// the librarian then has something to transcribe FROM.
const STUB_REPLY = `Chorizo Pilaf, serves 4.

Fry the chorizo. Then add the rice, stir it through, and cover.

I split your one step in two — the frying and the rice are different moments.`;
const STUB_CHAT_TITLE = 'Refreshing the pilaf';

// The librarian's canned transcription of that reply: the run-on step comes back
// as two (the one-operation rule), the title is tidied, and the metadata it was
// never given a reason to touch is DROPPED — null servings, null times, no tags.
const REFRESHED_TITLE = 'Chorizo Pilaf';
const REFRESHED_STEPS = ['Fry the chorizo.', 'Add the rice and stir it through, then cover.'];

const STUB_AUTHOR = {
  title: REFRESHED_TITLE,
  description: 'A one-pan chorizo pilaf.',
  servings: null,
  tags: [],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: REFRESHED_STEPS.map((text) => ({
    text,
    timerMinutes: null,
    timerLabel: null,
    note: null,
  })),
  notes: null,
};

/** Register every canned model answer this journey reaches, before driving the UI. */
async function stubModel(page: Page): Promise<void> {
  await page.evaluate((r) => window.__e2e!.stubAi('chefChat', r), STUB_REPLY);
  await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_CHAT_TITLE);
  await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
}

async function getRecipes(page: Page): Promise<Recipe[]> {
  return page.evaluate<Recipe[]>(() => window.__e2e!.getRecipes() as Recipe[]);
}

async function titleOf(page: Page, recipeId: string): Promise<string | undefined> {
  return (await getRecipes(page)).find((r) => r.id === recipeId)?.title;
}

/** Creates the dish through the editor and returns its id. */
async function seedDish(page: Page): Promise<string> {
  await page.goto('/#/recipes/new');
  await expect(page.getByRole('heading', { name: /new recipe/i })).toBeVisible();
  await page.getByTestId('recipe-title-input').fill(DISH);

  await page.getByTestId('recipe-servings-input').fill(String(SEEDED_METADATA.servings));
  // Prep / Cook / Total are no longer typed here (issue #1212): with the phase key
  // on the editor offers the strip instead, and an e2e build has no PostHog key so
  // every gate reads ON. They stay null on this document, which costs this spec
  // nothing — Servings and the tag are the metadata the librarian drops, and they
  // are what the preservation assertion below actually rests on.
  await page.getByTestId('recipe-tags-input').fill(TAG);
  await page.getByTestId('recipe-tags-input').press('Enter');

  await page.getByTestId('recipe-add-group-btn').click();
  // .nth(0) indexes the single group row THIS test just added — its own set.
  const group0 = page.getByTestId('recipe-group').nth(0);
  await group0.getByTestId('recipe-add-ingredient-btn').click();
  await group0.getByTestId('recipe-ingredient-input').nth(0).fill(INGREDIENT);

  await page.getByTestId('recipe-add-step-btn').click();
  await page.getByTestId('recipe-step-input').nth(0).fill(STEP);

  await page.getByTestId('recipe-save-btn').click();
  await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
  const id = page.url().match(/#\/recipes\/([a-z0-9-]+)/)?.[1];
  expect(id).toBeTruthy();

  await expect
    .poll(async () => (await getRecipes(page)).find((r) => r.id === id)?.metadata.servings, {
      timeout: SYNC_TIMEOUT,
    })
    .toBe(SEEDED_METADATA.servings);
  return id!;
}

/**
 * ⋮ → Refresh, settled on the open review sheet.
 *
 * 90 s: TWO real callable round-trips through the emulator — the chef, then the
 * librarian — cold function starts included, and gated on the sheet appearing
 * rather than on a clock.
 */
async function refreshAndReview(page: Page): Promise<void> {
  await page.getByTestId('recipe-actions-overflow').click();
  await page.getByTestId('recipe-refresh-menu-item').click();
  await expect(page.getByTestId('recipe-change-summary')).toBeVisible({ timeout: 90_000 });
  // The positive signal that the diff really computed and really saw the chef's
  // answer, before either test reads anything else off the sheet.
  await expect(page.getByTestId('recipe-change-group-basics')).toContainText(REFRESHED_TITLE);
}

test.describe('recipes — refresh through the review gate', () => {
  test('applies the re-written dish and keeps the metadata the librarian dropped', async ({
    page,
  }, testInfo) => {
    // 180s: a seed save plus TWO model round-trips through the emulator, each
    // gated on its own signal-bound wait.
    test.setTimeout(180_000);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });
    await stubModel(page);

    const recipeId = await seedDish(page);
    await refreshAndReview(page);

    // A refresh proposes no metadata change: the merge preserves what the
    // librarian omitted, so those groups are absent from the sheet entirely.
    await expect(page.getByTestId('recipe-change-group-metadata')).toHaveCount(0);
    await expect(page.getByTestId('recipe-change-group-tags')).toHaveCount(0);

    await page.getByTestId('recipe-change-apply').click();

    await expect
      .poll(() => titleOf(page, recipeId), { timeout: SYNC_TIMEOUT })
      .toBe(REFRESHED_TITLE);
    // The chef's account of what it did is in the transcript, where you can read
    // it — that is half the point of asking a chef rather than a transcriber.
    await expect(page.getByTestId('chat-message-assistant').last()).toContainText(
      'I split your one step in two',
    );
    const saved = (await getRecipes(page)).find((r) => r.id === recipeId)!;
    // The run-on step came back as two, which is what a refresh is FOR.
    expect(saved.steps.map((s) => s.text)).toEqual(REFRESHED_STEPS);
    // And the cook's own numbers survived it.
    expect(saved.metadata).toEqual(SEEDED_METADATA);
  });

  test('discarding leaves the dish exactly as it was', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });
    await stubModel(page);

    const recipeId = await seedDish(page);
    await refreshAndReview(page);

    await page.getByTestId('recipe-change-discard').click();
    await expect(page.getByTestId('recipe-change-summary')).toBeHidden();

    // Steady state first: the store still holds the seeded dish (NF-A2).
    await expect.poll(() => titleOf(page, recipeId), { timeout: SYNC_TIMEOUT }).toBe(DISH);
    // Then a bounded hold on the NEGATIVE property "a discarded proposal is never
    // written" — a late save would land within this window, and the whole promise
    // of the gate is that there is no such save.
    // eslint-disable-next-line playwright/no-wait-for-timeout -- NF-A2: bounded negative hold (a discarded proposal is never written)
    await page.waitForTimeout(2_000);
    const untouched = (await getRecipes(page)).find((r) => r.id === recipeId)!;
    expect(untouched.title).toBe(DISH);
    expect(untouched.steps.map((s) => s.text)).toEqual([STEP]);
    expect(untouched.metadata).toEqual(SEEDED_METADATA);
  });
});
