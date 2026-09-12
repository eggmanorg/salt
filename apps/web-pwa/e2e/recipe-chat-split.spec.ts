/**
 * The recipe and its chef, side by side (issue #696, Phase 4).
 *
 * On a screen with room for it the dish and the conversation about it sit next to each
 * other: the recipe on one half, the chat on the other, with the gutter falling on the
 * crease. The target is a Pixel 9 Pro Fold, unfolded — the same device, the same measured
 * `split` gate and the same reasoning as the planner's `mealplan-split.spec.ts`.
 *
 * None of this can live in the unit suite: jsdom reports `matches: false` for every media
 * query, so `RecipeViewPage.chats.test.ts` only ever exercises the phone path — which is
 * exactly what we want it to keep doing.
 *
 * Three facts are worth pinning:
 *
 *   1. It is a PANE, not a drawer. The drawer is SUPPRESSED at this size rather than
 *      painted over, and there is no `role="dialog"` anywhere on the page.
 *   2. The two columns are EQUAL. The device reports one viewport segment, so nothing can
 *      be aligned to the crease directly; the gutter stays over it only because the halves
 *      are the same width, which is why the equality is asserted to a pixel.
 *   3. Selecting another chat swaps the pane and the recipe does not move — the whole
 *      point of docking the conversation beside the dish rather than over it.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

// The fold, unfolded — its usable frame inside a browser tab, measured on the real
// device. Identical to `mealplan-split.spec.ts`; see the note there for why the width is
// four pixels under Tailwind's `md` and the gate is therefore a named `split` variant.
const VIEWPORT = { width: 755, height: 587 };

// The gutter between the columns (`split:gap-10`), which is what sits over the crease.
const GUTTER_PX = 40;

// Slack for sub-pixel layout. Deliberately tight: "equal halves" is the mechanism keeping
// the gutter on the fold, so a couple of pixels of drift is a real defect, not rounding.
const EPSILON = 1;

const RECIPE_TITLE = 'Split Test Dahl';
const RECIPE_ID = 'split-test-dahl';

test.describe('recipes — the dish and its chef, side by side', () => {
  test.use({ viewport: VIEWPORT });

  test('the chat docks beside the recipe as equal halves, with no drawer, and swaps on a tap', async ({
    page,
  }, testInfo) => {
    // One seed plus two session writes and a reload's worth of settling — the
    // single-tab tier, with headroom.
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // Bridge-seeded through the same `buildRecipe` the two describes below use
    // (NF-C4). It used to be typed into the retired editor, which issue #1319
    // Phase 8 deleted; the subject here is the LAYOUT the two columns take, which
    // owes nothing to how the dish was written. `openSeeded` is deliberately not
    // reused: it starts a conversation, and the counts below need none to exist.
    await seedRecipe(page, buildRecipe(RECIPE_ID, RECIPE_TITLE, 'recipe'));
    await page.goto(`/#/recipes/${RECIPE_ID}`);
    // The arrival. A URL assertion here would pass on the hash `goto` was handed,
    // before the document had reached the store.
    await expect(page.getByRole('heading', { name: RECIPE_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── The chat is docked, and it is not a drawer ───────────────────────────
    const chatColumn = page.getByTestId('recipe-chat-sidebar');
    await expect(chatColumn).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Suppressed, not merely hidden: at this size the drawer is not rendered at all.
    await expect(page.getByTestId('recipe-chat-drawer')).toHaveCount(0);
    // And nothing on the page is a dialog — no scrim, no focus trap, no scroll lock.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The chat list lives in that column, above the conversation it selects — and
    // there is exactly one of it on the page.
    await expect(page.getByTestId('recipe-chat-list')).toHaveCount(1);
    await expect(chatColumn.getByTestId('recipe-chat-list')).toBeVisible();

    // ── The navigation is unchanged at this size ─────────────────────────────
    // The split seam (700px) and the nav seam (1024px) are deliberately different
    // numbers: the fold keeps its bottom bar AND gets two columns.
    const visibleNav = page
      .getByRole('navigation', { name: 'Main navigation' })
      .filter({ visible: true });
    await expect(visibleNav).toHaveCount(1);
    const navBox = (await visibleNav.boundingBox())!;
    expect(Math.abs(navBox.y + navBox.height - VIEWPORT.height)).toBeLessThanOrEqual(EPSILON);

    // ── Equal halves, with the gutter between them ───────────────────────────
    const grid = page.getByTestId('recipe-view');
    const recipeColumn = grid.locator('> div').first();
    const recipeBox = (await recipeColumn.boundingBox())!;
    const chatBox = (await chatColumn.boundingBox())!;
    expect(Math.abs(recipeBox.width - chatBox.width)).toBeLessThanOrEqual(EPSILON);
    expect(Math.abs(chatBox.x - (recipeBox.x + recipeBox.width) - GUTTER_PX)).toBeLessThanOrEqual(
      EPSILON,
    );

    // ── Two conversations, and selecting one swaps the pane ──────────────────
    await page.getByTestId('recipe-chat-new-btn').click();
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId('recipe-chat-new-btn').click();
    await expect(page.getByTestId('recipe-chat-list-item')).toHaveCount(2, {
      timeout: SYNC_TIMEOUT,
    });

    // Still no drawer, and still no dialog, after opening chats at this size.
    await expect(page.getByTestId('recipe-chat-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const items = page.getByTestId('recipe-chat-list-item');
    const recipeTopBefore = (await recipeColumn.boundingBox())!.y;

    // The newest is selected; picking the older one swaps which is marked.
    await expect(items.nth(0)).toHaveClass(/border-primary/);
    await items.nth(1).click();
    await expect(items.nth(1)).toHaveClass(/border-primary/);
    await expect(items.nth(0)).not.toHaveClass(/border-primary/);

    // …and the recipe beside it did not move.
    expect(Math.abs((await recipeColumn.boundingBox())!.y - recipeTopBefore)).toBeLessThanOrEqual(
      EPSILON,
    );
  });
});

// ─── Two panes, two scrollbars (issue #737) ───────────────────────────────────

const SEED_TIME = '2026-01-01T00:00:00.000Z';

/**
 * A recipe long enough that its column genuinely overflows, or an `outing` — which by
 * definition has no ingredients and no method, and is therefore the case with nothing
 * to scroll at all. Both exist to prove the composer's reachability does not depend on
 * the recipe's length, which under the old `sticky` + `calc()` pairing it did.
 *
 * Also the fixture the FIRST describe seeds, since issue #1319 Phase 8 left no
 * by-hand way to author a dish: one builder for every recipe this file needs.
 */
function buildRecipe(id: string, title: string, kind: 'recipe' | 'outing'): Recipe {
  const long = kind === 'recipe';
  return {
    id,
    schemaVersion: 1,
    kind,
    title,
    description: null,
    ingredients: long
      ? [
          {
            id: 'group-1',
            name: null,
            items: Array.from({ length: 10 }, (_, i) => ({
              id: `ing-${i + 1}`,
              rawText: `${i + 1} portion of ingredient number ${i + 1}`,
              parsed: null,
              canonId: null,
              matchState: 'pending' as const,
              isOptional: false,
              firstUsedInStepId: 'step-1',
            })),
          },
        ]
      : [],
    steps: long
      ? Array.from({ length: 12 }, (_, i) => ({
          id: `step-${i + 1}`,
          text: `Step ${i + 1}. Wordy enough that the recipe column has real length to scroll.`,
          timer: null,
          note: null,
        }))
      : [],
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
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: '',
    lastEditedBy: '',
  };
}

/** How much `<main>` has left to scroll. Under `fill` this must be nothing. */
function mainScrollRange(page: Page): Promise<number> {
  return page.locator('main').evaluate((el) => el.scrollHeight - el.clientHeight);
}

/**
 * The floor the composer has to sit above: the top of the bottom navigation, not the
 * bottom of the viewport. At this size the nav is a fixed bar OVER the page, so a box
 * measuring as "inside the viewport" can still be completely hidden behind it — which
 * is exactly what a short recipe looked like before this change.
 */
async function usableFloor(page: Page): Promise<number> {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true });
  return (await nav.boundingBox())!.y;
}

/** Assert the composer is fully on screen and clear of the bottom navigation. */
async function expectComposerUsable(page: Page): Promise<void> {
  const box = (await page.getByTestId('chat-input').boundingBox())!;
  const floor = await usableFloor(page);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(floor + EPSILON);
}

async function openSeeded(page: Page, recipe: Recipe, email: string): Promise<void> {
  await gotoAndSignIn(page, email, '/', { admin: true });
  await seedRecipe(page, recipe);
  await page.goto(`/#/recipes/${recipe.id}`);
  await expect(page.getByRole('heading', { name: recipe.title })).toBeVisible({
    timeout: SYNC_TIMEOUT,
  });
  await expect(page.getByTestId('recipe-chat-sidebar')).toBeVisible({ timeout: SYNC_TIMEOUT });
  // A conversation has to exist for the composer to be on screen at all.
  await page.getByTestId('recipe-chat-new-btn').click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: SYNC_TIMEOUT });
}

test.describe('recipes — the dish and its chef scroll separately', () => {
  test.use({ viewport: VIEWPORT });

  test('the message box is on screen without scrolling, and the panes do not drag each other', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const recipe = buildRecipe('e2e-737-long', 'Split Scroll Dahl', 'recipe');
    await openSeeded(page, recipe, uniqueEmail(testInfo.testId));

    // ── The composer is there on load, with nothing scrolled ─────────────────
    // The regression this pins: it used to sit ~228px below the viewport floor.
    const input = page.getByTestId('chat-input');
    await expectComposerUsable(page);

    // ── And the page itself has nothing left to scroll ───────────────────────
    // This is what "two real scrollers" means: the page fills <main>, so the ONE
    // shared scrollbar that coupled the panes no longer exists.
    expect(await mainScrollRange(page)).toBeLessThanOrEqual(EPSILON);

    // ── Scrolling the recipe leaves the chat exactly where it is ─────────────
    const recipePane = page.getByTestId('recipe-view').locator('> div').first();
    const chatPane = page.getByTestId('recipe-chat-sidebar');
    const chatTopBefore = (await chatPane.boundingBox())!.y;
    const inputTopBefore = (await input.boundingBox())!.y;

    await recipePane.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    // The recipe column really did scroll — otherwise the rest asserts nothing.
    expect(await recipePane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    expect(Math.abs((await chatPane.boundingBox())!.y - chatTopBefore)).toBeLessThanOrEqual(
      EPSILON,
    );
    expect(Math.abs((await input.boundingBox())!.y - inputTopBefore)).toBeLessThanOrEqual(EPSILON);

    // ── The dish's actions stay put however far the recipe is scrolled ───────
    const cook = page.getByTestId('recipe-cook-button');
    const cookBox = (await cook.boundingBox())!;
    expect(cookBox.y).toBeGreaterThanOrEqual(0);
    expect(cookBox.y + cookBox.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  test('a short outing — nothing to scroll, and the message box is still there', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    // "When you CBA": no ingredients, no method. Under the old layout there was no
    // scroll range with which to bring the composer up, so it was unreachable.
    const outing = buildRecipe('e2e-737-outing', 'Split Scroll Chippy', 'outing');
    await openSeeded(page, outing, uniqueEmail(testInfo.testId));

    await expectComposerUsable(page);
    expect(await mainScrollRange(page)).toBeLessThanOrEqual(EPSILON);
  });
});

// ─── Putting the chef away (issue #1141) ──────────────────────────────────────

/**
 * The same two-column screen, with the chat switched off. Only e2e can see this:
 * "one column, capped and centred" is layout, and jsdom lays nothing out.
 *
 * The two facts worth pinning are the ones a wrong gate breaks silently — the chat
 * column really goes (rather than leaving an empty track), and turning it back on
 * restores the equal halves the gutter-over-the-crease depends on.
 */
test.describe('recipes — putting the chef away', () => {
  test.use({ viewport: VIEWPORT });

  test('the toggle collapses the page to one column and restores the equal halves', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const recipe = buildRecipe('e2e-1141-toggle', 'Chef Away Dahl', 'recipe');
    await openSeeded(page, recipe, uniqueEmail(testInfo.testId));

    const grid = page.getByTestId('recipe-view');
    const recipeColumn = grid.locator('> div').first();
    const chatColumn = page.getByTestId('recipe-chat-sidebar');
    const toggle = page.getByTestId('recipe-chat-pane-toggle');

    // ── It starts on, exactly as it always has ───────────────────────────────
    await expect(chatColumn).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Hide chef chat');
    const halfWidth = (await recipeColumn.boundingBox())!.width;

    // ── Off: the chat column goes and the recipe takes the room ──────────────
    await toggle.click();
    await expect(chatColumn).toBeHidden();
    await expect(toggle).toHaveAccessibleName('Show chef chat');

    // Genuinely wider — not merely a hidden neighbour leaving an empty track.
    const wide = (await recipeColumn.boundingBox())!;
    expect(wide.width).toBeGreaterThan(halfWidth + GUTTER_PX);
    // And nothing overflows sideways: the cap is a ceiling, never a floor.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(EPSILON);

    // The list of past chats came with it, and there is still exactly one.
    await expect(page.getByTestId('recipe-chat-list')).toHaveCount(1);
    await expect(recipeColumn.getByTestId('recipe-chat-list')).toBeVisible();

    // Still not a drawer — the phone surface must not appear on a wide screen
    // merely because the pane is switched off.
    await expect(page.getByTestId('recipe-chat-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // ── On again: equal halves, gutter on the crease ─────────────────────────
    await toggle.click();
    await expect(chatColumn).toBeVisible();

    const recipeBox = (await recipeColumn.boundingBox())!;
    const chatBox = (await chatColumn.boundingBox())!;
    expect(Math.abs(recipeBox.width - chatBox.width)).toBeLessThanOrEqual(EPSILON);
    expect(Math.abs(chatBox.x - (recipeBox.x + recipeBox.width) - GUTTER_PX)).toBeLessThanOrEqual(
      EPSILON,
    );
    // The conversation survived the round trip — the column was hidden, not rebuilt.
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });
});

// ─── Above the nav seam, the recipe gets the room (issue #1197) ───────────────

// Well clear of `lg` (1024px) and of the `split` height floor — Playwright's stock
// `Desktop Chrome` size, which is the shape an actual desktop browser has.
const WIDE_VIEWPORT = { width: 1280, height: 720 };

// The gutter above `lg` (`lg:gap-6`). Narrower than the fold's 40px on purpose:
// there is no crease up here for it to cover, only two columns to separate.
const WIDE_GUTTER_PX = 24;

/**
 * Above `lg` the columns are 2fr/1fr, not the fold's equal halves.
 *
 * This is the case the 755px runs above are structurally blind to, and it stayed
 * broken in production because of it: the `split:` utilities are emitted AFTER the
 * `lg:` ones at equal specificity, so an unnarrowed `split:grid-cols-2` silently
 * beat `lg:grid-cols-[2fr_1fr]` at every width that matched both, and a desktop got
 * equal halves with a 40px gutter. Narrowing the crease classes to `split:max-lg:`
 * is the fix; this is the assertion that goes red if either the narrowing or the
 * ratio is undone.
 */
test.describe('recipes — the recipe takes two thirds above the nav seam', () => {
  test.use({ viewport: WIDE_VIEWPORT });

  test('the columns are 2:1 with the wider gutter, not equal halves', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const recipe = buildRecipe('e2e-1197-wide', 'Wide Split Dahl', 'recipe');
    await openSeeded(page, recipe, uniqueEmail(testInfo.testId));

    const grid = page.getByTestId('recipe-view');
    const recipeColumn = grid.locator('> div').first();
    const chatColumn = page.getByTestId('recipe-chat-sidebar');
    await expect(chatColumn).toBeVisible();

    const recipeBox = (await recipeColumn.boundingBox())!;
    const chatBox = (await chatColumn.boundingBox())!;

    // Two thirds against one. Doubling the chat's width doubles its rounding error
    // too, hence twice the slack — still far tighter than the 4:3 the bug produced.
    expect(Math.abs(recipeBox.width - chatBox.width * 2)).toBeLessThanOrEqual(EPSILON * 2);
    // And emphatically NOT equal halves, which is what the defect rendered.
    expect(recipeBox.width).toBeGreaterThan(chatBox.width + WIDE_GUTTER_PX);

    // The 24px gutter, not the fold's 40px.
    expect(
      Math.abs(chatBox.x - (recipeBox.x + recipeBox.width) - WIDE_GUTTER_PX),
    ).toBeLessThanOrEqual(EPSILON);

    // Still a pane at this size, and still never a drawer or a dialog.
    await expect(page.getByTestId('recipe-chat-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
