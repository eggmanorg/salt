/**
 * The chat review gate, on both of its doors (issue #764).
 *
 * Amending a recipe by chat is reachable two ways — the recipe page's chat
 * sidebar, and the full `/chat/:id` page — and the propose/merge/apply logic
 * behind them used to be written twice. The copies drifted: the sidebar
 * preserved metadata the librarian omitted, the chat page spread the draft
 * straight through, so the same conversation came back proposing to erase
 * Serves 4, all three times and every tag. Both doors now call the one merge in
 * `src/lib/recipeAmend.ts`, and the first two tests are the pin on that: same
 * conversation, same seeded dish, same assertions, one per surface.
 *
 * A third test (issue #838) puts a MEAL through the same gate. The chef now reads
 * a meal's attached dishes, so the gate is where "nothing aggregates" has to hold:
 * an amend must not merge a dish's ingredients onto the meal, and must not drop
 * the dishes. Same conversation, same stubs, one extra seeded component.
 *
 * Runs against the Firestore + Auth emulators with the MODEL faked
 * (FUNCTIONS_AI_FAKE) and every other layer live — the callable boundary, the
 * Genkit flows, the Firestore write and the realtime subscription.
 *
 *   stubAi('chefChat' | 'generateChatTitle' | 'authorRecipe', …)
 *     → ⋮ → Ask/amend opens a chat on the dish
 *       → a message runs the real chefChat callable against the fake model
 *         → "Review changes" runs the real authorRecipe callable, whose canned
 *           answer OMITS servings, all three times and the tags
 *           → the diff proposes the title change and NOTHING about metadata
 *             → Apply writes a document that still has Serves 4 and its tag
 *
 * No `parseRecipeIngredients` stub, deliberately: the librarian's canned answer
 * repeats the seeded ingredient's rawText verbatim, which is exactly what edit
 * mode is built to recognise — `assembleRecipeDraft` reuses the existing parse
 * and canon match and never calls the parse or canon flows at all. Adding a stub
 * for a flow this journey does not reach would only suggest it does.
 *
 * Left on the project's 1280x720 desktop default: above `lg` the chat docks as a
 * column, which is the sidebar surface test 1 needs. The drawer below `lg` is
 * the same button calling the same handler (`reviewChangesAction` is rendered
 * for both), so it is covered by the sidebar test and not driven separately.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

const DISH = 'Review Gate Pilaf';
const INGREDIENT = '200 g chorizo, sliced';
const STEP = 'Fry the chorizo until the oil runs red.';
const TAG = 'reviewgate';

// The metadata the user typed, which the librarian is about to forget. Both
// tests assert the saved document still holds exactly this — the same expected
// value checked on both surfaces IS the "identical saved document" assertion.
const SEEDED_METADATA = {
  servings: 4,
  // Null since #1212: the editor's three time boxes are gone with the phase key
  // on, and this dish is authored through the editor. Servings and the tag carry
  // the "the librarian dropped it, the merge kept it" assertion.
  // Stamped by `emptyRecipe` on every new recipe (issue #1122), so it is part of
  // the seeded document even though nobody typed it. Its presence here is what
  // pins `mergeAmendedRecipe` carrying the strip through an amend rather than
  // dropping the key — this equality is the "identical saved document" assertion.
  phases: [],
  timingSummary: null,
  tags: [TAG],
};

const USER_MESSAGE = 'add some chilli';
const STUB_REPLY =
  'Deterministic stubbed chef reply: half a teaspoon of chilli flakes, stirred in.';
const STUB_CHAT_TITLE = 'Stubbed Chilli Conversation';

// The librarian's canned answer: the change the user asked for is in the title
// and the method, and the metadata it was never asked about is DROPPED — null
// servings, null times, no tags. That omission is the defect this spec exists
// for. The ingredient repeats the seeded rawText verbatim, as edit mode
// instructs, so it is carried over rather than re-parsed.
const AMENDED_TITLE = 'Stubbed Chilli Pilaf';
const AMENDED_STEP = 'Fry the chorizo, then stir in the chilli flakes.';

const STUB_AUTHOR = {
  title: AMENDED_TITLE,
  description: 'The pilaf, with chilli.',
  servings: null,
  tags: [],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: AMENDED_STEP, timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

// ─── The meal case (issue #838) ──────────────────────────────────────────────
//
// The same dish, plus one attached component whose ingredient must NEVER appear
// on the meal. The meal carries the same title, ingredient and step as the seeded
// dish above so the one stubbed librarian answer serves both tests.
const COMPONENT_INGREDIENT = '1 whole chicken, 1.6 kg';

function recipeFixture(
  id: string,
  title: string,
  opts: { rawText: string; componentRecipeIds?: string[] },
): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [
      {
        id: `${id}-g1`,
        name: null,
        items: [
          {
            id: `${id}-i1`,
            rawText: opts.rawText,
            parsed: null,
            canonId: null,
            matchState: 'pending',
            isOptional: false,
            firstUsedInStepId: null,
          },
        ],
      },
    ],
    steps: [{ id: `${id}-s1`, text: STEP, timer: null, note: null }],
    metadata: { ...SEEDED_METADATA },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: opts.componentRecipeIds ?? [],
    kit: [],
    image: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

const COMPONENT_DISH = recipeFixture('review-gate-chicken', 'Review Gate Roast Chicken', {
  rawText: COMPONENT_INGREDIENT,
});
const MEAL = recipeFixture('review-gate-roast', 'Review Gate Sunday Roast', {
  rawText: INGREDIENT,
  componentRecipeIds: [COMPONENT_DISH.id],
});

async function getRecipes(page: Page): Promise<Recipe[]> {
  return page.evaluate<Recipe[]>(() => window.__e2e!.getRecipes() as Recipe[]);
}

async function getSessions(page: Page): Promise<ChatSessionDoc[]> {
  return page.evaluate<ChatSessionDoc[]>(() => window.__e2e!.getChatSessions() as ChatSessionDoc[]);
}

/** Register every canned model answer this journey reaches, before driving the UI. */
async function stubModel(page: Page): Promise<void> {
  await page.evaluate((r) => window.__e2e!.stubAi('chefChat', r), STUB_REPLY);
  await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_CHAT_TITLE);
  await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
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

/** ⋮ → Ask/amend, then one turn of conversation. Returns the session id. */
async function talkAboutTheDish(page: Page): Promise<string> {
  await page.getByTestId('recipe-actions-overflow').click();
  await page.getByTestId('recipe-ask-amend-menu-item').click();

  await page.getByTestId('chat-input').fill(USER_MESSAGE);
  await page.getByTestId('chat-send-btn').click();
  await expect(page.getByTestId('chat-message-user').filter({ hasText: USER_MESSAGE })).toBeVisible(
    {
      timeout: SYNC_TIMEOUT,
    },
  );
  // The assistant turn is what unlocks "Review changes" on both surfaces.
  await expect(
    page.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
  ).toBeVisible({ timeout: 30_000 });

  const session = (await getSessions(page))[0];
  expect(session).toBeTruthy();
  return session!.id;
}

/**
 * The heart of both tests: the summary is open, it proposes the change that was
 * discussed, and it proposes NOTHING about the metadata the librarian dropped.
 * `RecipeChangeSummary` renders a group per section, so an absent group is an
 * absent proposal — and before the fix, the metadata and tag groups were both
 * present here on the full chat page, offering to erase what the user typed.
 */
async function expectNoMetadataRemovalProposed(page: Page): Promise<void> {
  await expect(page.getByTestId('recipe-change-summary')).toBeVisible({ timeout: 60_000 });
  // The positive signal first — the diff really did compute and really did see
  // the change — so the two absence checks below are read from a settled sheet.
  await expect(page.getByTestId('recipe-change-group-basics')).toContainText(AMENDED_TITLE);
  await expect(page.getByTestId('recipe-change-group-metadata')).toHaveCount(0);
  await expect(page.getByTestId('recipe-change-group-tags')).toHaveCount(0);
}

/** Waits for the applied save to land, and hands back the document it wrote. */
async function savedRecipeAfterApply(page: Page, recipeId: string): Promise<Recipe> {
  await expect
    .poll(async () => (await getRecipes(page)).find((r) => r.id === recipeId)?.title, {
      timeout: SYNC_TIMEOUT,
    })
    .toBe(AMENDED_TITLE);
  return (await getRecipes(page)).find((r) => r.id === recipeId)!;
}

test.describe('recipes — the chat review gate', () => {
  test('from the recipe page sidebar: applies the change and keeps the metadata the librarian dropped', async ({
    page,
  }, testInfo) => {
    // 120s: a seed save, a chat round-trip and a librarian round-trip through the
    // emulator, each gated on its own signal-bound wait.
    test.setTimeout(120_000);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });
    await stubModel(page);

    const recipeId = await seedDish(page);
    await talkAboutTheDish(page);

    await page.getByTestId('sidebar-apply-changes-btn').click();
    await expectNoMetadataRemovalProposed(page);

    await page.getByTestId('recipe-change-apply').click();
    const saved = await savedRecipeAfterApply(page, recipeId);
    expect(saved.title).toBe(AMENDED_TITLE);
    // The payoff: what the user typed is still there, on this surface and the other.
    expect(saved.metadata).toEqual(SEEDED_METADATA);
  });

  test('from the full chat page: applies the change and keeps the metadata the librarian dropped', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });
    await stubModel(page);

    const recipeId = await seedDish(page);
    const sessionId = await talkAboutTheDish(page);

    // The same conversation, through the other door.
    await page.goto(`/#/chat/${sessionId}`);
    await expect(page.getByTestId('chat-apply-changes-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('chat-apply-changes-btn').click();
    await expectNoMetadataRemovalProposed(page);

    await page.getByTestId('recipe-change-apply').click();
    // Applying from here lands you on the dish you just changed.
    await expect(page).toHaveURL(new RegExp(`#/recipes/${recipeId}$`), { timeout: SYNC_TIMEOUT });
    const saved = await savedRecipeAfterApply(page, recipeId);
    expect(saved.title).toBe(AMENDED_TITLE);
    // The same expected value as the sidebar test: one merge, one outcome.
    expect(saved.metadata).toEqual(SEEDED_METADATA);
  });

  /**
   * A meal through the same gate (issue #838).
   *
   * The chef now reads a meal's attached dishes, and the founding invariant of
   * meals is that NOTHING AGGREGATES: a dish's ingredients never land on the meal.
   * The cost of breaking it is concrete — the planner writes
   * `[mealId, ...componentRecipeIds]` into a day, so an ingredient copied onto the
   * meal is SHOPPED TWICE for one dinner. The librarian is structurally prevented
   * from copying one (it is never shown the lists — see
   * `apps/cloud-functions/src/flows/componentContext.ts`), and this is the pin on
   * the other end of that: amend a meal by chat, apply, and the saved document
   * still has only its own ingredient and still has its dish attached.
   *
   * Seeded through `seedRecipe` rather than the editor's component picker: the
   * subject here is what the amend writes, and the attach UI has its own coverage
   * in `meal-component-create.spec.ts`.
   */
  test('a meal keeps its own ingredients and its dishes: no component lines merged in', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), '/', { admin: true });
    await stubModel(page);

    await seedRecipe(page, COMPONENT_DISH);
    await seedRecipe(page, MEAL);
    await page.goto(`/#/recipes/${MEAL.id}`);
    await expect(page.getByRole('heading', { name: MEAL.title })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    await talkAboutTheDish(page);
    await page.getByTestId('sidebar-apply-changes-btn').click();
    await expect(page.getByTestId('recipe-change-summary')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('recipe-change-apply').click();

    const saved = await savedRecipeAfterApply(page, MEAL.id);
    // The meal's own line, and ONLY the meal's own line.
    const rawTexts = saved.ingredients.flatMap((g) => g.items.map((i) => i.rawText));
    expect(rawTexts).toEqual([INGREDIENT]);
    expect(rawTexts).not.toContain(COMPONENT_INGREDIENT);
    // And the dish is still attached — `assembleRecipeDraft`'s carry-through, which
    // every amend would otherwise erase.
    expect(saved.componentRecipeIds).toEqual([COMPONENT_DISH.id]);
  });
});
