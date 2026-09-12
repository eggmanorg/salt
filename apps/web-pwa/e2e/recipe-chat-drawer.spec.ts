/**
 * The chef, raised over the recipe rather than instead of it (issue #696, Phase 3).
 *
 * The promise this spec pins is the one thing the feature is for: on a phone, opening a
 * chat about a dish does not take you off the dish. So it walks the journey — a dish with
 * an ingredient on screen, a chat started from the recipe page, and then assert what has
 * to be true while the chat is up:
 *
 *   the drawer is on screen AND the ingredients are still readable above it
 *     → dragging the handle up gives the chat most of the screen
 *       → the page header is still not covered (the #641 rule for a non-modal overlay)
 *         → the bottom navigation is reachable throughout
 *           → closing leaves you on the recipe, with the chat listed on it
 *
 * No AI stub: nothing here sends a turn. Creating the session is an ordinary Firestore
 * write, and every wait below is bound to a rendered signal rather than a clock.
 *
 * The dish is BRIDGE-SEEDED (NF-C4): issue #1319 Phase 8 deleted the editor and its
 * routes, and what this spec is about starts once a dish is on screen.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';

// A phone, pinned explicitly: the drawer only exists below the docked seam, and the
// project's default desktop viewport would put this spec on the column layout instead.
// Same numbers as `recipe-alternatives.spec.ts` and `mealplan.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

// Long on purpose. A new chat is named "<recipe title> chat", and that title is what the
// list truncates — the regression this spec guards (the page going wider than the phone)
// only shows on a title whose untruncated width beats the column.
const RECIPE_TITLE = 'Drawer Test Dahl With Preserved Lemon And Coconut';
const INGREDIENT = '1 ½ cups red lentils, rinsed';
const RECIPE_ID = 'drawer-test-dahl';

// One ingredient, because "the thing you are chatting about is still readable" is
// asserted against a rendered ingredient row. Nothing else on the dish matters here.
const RECIPE: Recipe = {
  id: RECIPE_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: RECIPE_TITLE,
  description: null,
  ingredients: [
    {
      id: `${RECIPE_ID}-g1`,
      name: null,
      items: [
        {
          id: `${RECIPE_ID}-i1`,
          rawText: INGREDIENT,
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
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

test.describe('recipes — the chef drawer on a phone', () => {
  test('opening a chat keeps you on the recipe, drags between two stops, and closes back', async ({
    page,
  }, testInfo) => {
    // Single-tab, no cross-tab convergence and no AI wait: the 60 s single-tab tier.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── A recipe with something to read while you chat ───────────────────────
    await seedRecipe(page, RECIPE);
    await page.goto(`/#/recipes/${RECIPE_ID}`);
    // The heading is the arrival — it cannot render until the seeded document has
    // reached the store, whereas the URL is already whatever `goto` was handed. The
    // URL is read AFTER it, so the "you never left the dish" comparison below is
    // against a page that is genuinely showing the dish.
    await expect(page.getByRole('heading', { name: RECIPE_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    const recipeUrl = page.url();

    // ── The chat list is on the dish, and empty ──────────────────────────────
    await expect(page.getByTestId('recipe-chat-list')).toBeVisible();
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(0);

    // ── Start a chat: the drawer rises, the recipe stays ─────────────────────
    await page.getByTestId('recipe-chat-new-btn').click();

    const drawer = page.getByTestId('recipe-chat-drawer');
    await expect(drawer).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Still the recipe, not the chat route. This is the whole feature.
    expect(page.url()).toBe(recipeUrl);
    // Named after the dish until the chef retitles it.
    await expect(drawer).toContainText(`${RECIPE_TITLE} chat`);

    // Both on screen at once: the composer AND the thing it is about.
    await expect(drawer.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toBeVisible();
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText(INGREDIENT);

    // Non-modal, and deliberately so: no dialog role, no modal flag, and the page
    // behind is not pointer-events-dead (which is what `Sheet` would have done).
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(drawer).not.toHaveAttribute('aria-modal', 'true');
    await expect
      .poll(() => page.evaluate(() => document.body.style.pointerEvents))
      .not.toBe('none');

    // The bottom navigation is reachable the whole time — the drawer sits above it.
    const nav = page.getByRole('navigation').first();
    await expect(nav).toBeVisible();

    // The page still fits the phone. The recipe column is a grid item, so its automatic
    // minimum size is its content's minimum — and the chat now listed on the recipe
    // carries a `truncate` title, which is one unbreakable `nowrap` line. Without
    // `min-w-0` on the column that title sizes the whole page, and the recipe and the
    // chat both spill sideways until the page is left and re-entered.
    expect(await pageOverflowsSideways(page)).toBe(false);

    // ── Drag the handle up: the chat takes most of the screen ────────────────
    const handle = page.getByTestId('recipe-chat-drawer-handle');
    await expect(handle).toBeVisible();
    // The drawer RISES into its resting stop, so both the height and the handle's
    // position are still moving for a few frames after it becomes visible. Measuring
    // either mid-flight reads a number that was never a stop, and — worse — aims the
    // drag at where the handle used to be, so the gesture lands on nothing.
    const peekHeight = await settledHeight(page);

    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Several steps so the drag clears the tap slop and registers as a gesture.
    await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 8 });
    await page.mouse.move(box.x + box.width / 2, box.y - 260, { steps: 8 });
    await page.mouse.up();

    // The spring settles on the full stop — polled, because the settle is animated.
    await expect.poll(() => drawerHeight(page)).toBeGreaterThan(peekHeight + 50);

    // Even at full, the page is never entirely covered (#641): a strip stays.
    await expect.poll(() => drawerTop(page)).toBeGreaterThan(0);
    await expect(nav).toBeVisible();

    // ── Close: back on the recipe, with the conversation now listed on it ────
    await page.getByTestId('recipe-chat-drawer-close').click();
    await expect(drawer).toHaveCount(0);
    expect(page.url()).toBe(recipeUrl);
    await expect(page.getByRole('heading', { name: RECIPE_TITLE })).toBeVisible();
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(1);
    await expect(page.getByTestId('recipe-chat-list-item')).toContainText(`${RECIPE_TITLE} chat`);
    // …and closing does not leave the recipe stretched behind it.
    expect(await pageOverflowsSideways(page)).toBe(false);
  });
});

/**
 * Does the scrolling region hold content wider than itself? `<main>` is the scroller
 * (`AppShell`), so a page that spills sideways shows up there and NOT on
 * `document.documentElement`, which is why this asks the element rather than the document.
 */
async function pageOverflowsSideways(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    return !!main && main.scrollWidth > main.clientWidth + 1;
  });
}

/**
 * The drawer's height once the spring has stopped moving it — two consecutive equal
 * readings. Everything that measures or aims at the drawer has to wait for this.
 */
async function settledHeight(page: import('@playwright/test').Page): Promise<number> {
  let previous = -1;
  await expect
    .poll(async () => {
      const height = await drawerHeight(page);
      const settled = height > 0 && height === previous;
      previous = height;
      return settled;
    })
    .toBe(true);
  return previous;
}

/** The drawer's rendered height, in CSS pixels. */
async function drawerHeight(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.getByTestId('recipe-chat-drawer').boundingBox();
  return box?.height ?? 0;
}

/** The drawer's top edge in viewport coordinates — how much page is left above it. */
async function drawerTop(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.getByTestId('recipe-chat-drawer').boundingBox();
  return box?.y ?? 0;
}
