/**
 * Planner deck geometry — the three things that can only be seen with a browser
 * doing real layout (#639 Phase 4, #647, and the fixes on top of them).
 *
 * Everything here is about WHERE things end up, which is exactly what the unit
 * suite cannot answer: jsdom lays nothing out, so `MealPlanWeekPage.test.ts`
 * installs a fake layout of uniform 200px rows. That fake is a good model of the
 * deck's arithmetic and a useless model of its failures — every bug below came
 * from rows that are NOT uniform and NOT the height they were first measured at.
 *
 *   1. The week STAYS on today when the rows grow underneath it. The anchor used
 *      to measure a list barely taller than the viewport — day cards are text-only
 *      until the recipes store delivers their photographs — clamp today's offset
 *      to nearly nothing, land at the top of the week, and latch. Re-entering the
 *      planner with the stores already warm anchored perfectly, which is why it
 *      survived review. In production the trigger is one Firestore subscription
 *      arriving after another, which no test can order; so the growth is PROVOKED
 *      here, by seeding the week text-only and then attaching its recipes. From
 *      the deck's side those are the same event: the content it measured against
 *      is suddenly half as tall again.
 *
 *   2. The rail runs down the edge of the rows. #647 moved the stem into the
 *      gutter with a matching viewport bleed, which left a hairline near the
 *      screen edge, detached from the dates it belongs to. Note what is compared:
 *      the rail against the ROWS, not against the deck — the deck bled left too,
 *      so a rail-vs-deck assertion would have passed all the way through the
 *      regression.
 *
 *   3. The shop rule and the next-week mark survive being snapped to. Both used
 *      to be siblings ABOVE the day they describe, so the one gesture that puts
 *      that day under the header — snapping to it — was also the gesture that
 *      pushed its mark off the top of the screen.
 *
 * Dates: today's own weekday decides everything about this layout, so the spec
 * pins `firstDayOfWeek` to put today at a known index rather than hoping the run
 * date is helpful (see `seedFirstDayOfWeek` for why that one document is seeded
 * before the app boots). Index 6 — the last day of the cycle — is deliberate: it
 * is far enough down that a clamped anchor leaves today well below the fold, and
 * it is inside the window that appends next week, which is what gives (3) a
 * next-week mark to snap to.
 */
import type { Page } from '@playwright/test';
import type { Day, MealPlanWeek, Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedFirstDayOfWeek, seedMealPlanWeek, seedRecipe } from './helpers/seed';
import { HYDRATE_TIMEOUT, SYNC_TIMEOUT } from './helpers/timeouts';

// A phone. The deck's whole reason for existing is a viewport shorter than its
// content, and the geometry below is only interesting at that ratio.
const VIEWPORT = { width: 393, height: 851 };

// `leadPx` in the page's deck tuning: a day snaps flush against the top of the
// viewport with one row-gap of the previous day showing above it.
const LEAD_PX = 24;

// Slack for sub-pixel layout and for the spring's last fraction of a pixel.
const EPSILON = 4;

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The weekday that, as `firstDayOfWeek`, puts `today` at `index` of its week. */
function firstDayPutting(today: string, index: number) {
  const start = addDays(today, -index);
  return WEEKDAY_NAMES[new Date(`${start}T00:00:00.000Z`).getUTCDay()]!;
}

// A recipe whose hero is a committed static asset, so the row grows a real
// 1.6:1 photograph on a real image decode — the growth that used to strand the
// anchor. Any bundled image does; this one is the app icon.
function recipeWithPhoto(id: string, title: string): Recipe {
  return {
    cureCategory: null,
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
    image: { url: '/icons/icon-192.png', source: 'upload' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

// Seven planned days. An empty `recipeIds` gives the text-only week — the same
// document, the same notes, and rows a third of the height, which is what the
// planner shows for the moment before the recipes store delivers.
function weekOf(startDate: string, recipeIds: readonly string[]): MealPlanWeek {
  const days: Record<string, Day> = {};
  for (let i = 0; i < 7; i++) {
    days[addDays(startDate, i)] = {
      note: `Dinner ${i + 1}`,
      recipeIds: recipeIds.length ? [recipeIds[i % recipeIds.length]!] : [],
      chefs: [],
      attendees: [],
      guests: 0,
    } satisfies Day;
  }
  return {
    id: startDate,
    schemaVersion: 1,
    startDate,
    days,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Wait until the planner is actually showing the seeded week.
 *
 * `firstDayOfWeek` decides which week "this week" IS, and it arrives on its own
 * Firestore snapshot — so between opening the planner and that snapshot landing,
 * the page is showing a different seven days under the app's default. Every
 * assertion below is about where today sits IN the displayed week, which is a
 * question with two different answers until this settles.
 */
async function weekIsLive(page: Page, startDate: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__e2e!.getMealPlanSnapshot().startDate), {
      timeout: SYNC_TIMEOUT,
    })
    .toBe(startDate);
}

async function weekOnScreen(page: Page, startDate: string): Promise<void> {
  await weekIsLive(page, startDate);
  await expect(page.getByTestId(`day-${startDate}-row`)).toBeAttached({ timeout: SYNC_TIMEOUT });
}

/** The gap between an element's top and the deck viewport's top, in CSS px. */
async function topGap(page: Page, testId: string): Promise<number> {
  const deck = await page.getByTestId('week-deck').boundingBox();
  const target = await page.getByTestId(testId).boundingBox();
  if (!deck || !target) throw new Error(`no box for ${testId}`);
  return target.y - deck.y;
}

/**
 * Snap the deck onto a day the way a user does: focus it and walk down a stop at
 * a time until that day is flush under the header. Each `toPass` attempt presses
 * once and re-measures, so the spring settles between presses without a sleep
 * (NF-A1) and a failure reports how far it actually got.
 *
 * The target is the day's ROW, never its card: the row is what the deck's stops
 * are measured from, and on a day that carries a mark the card starts well below
 * the row's top — so walking until the CARD reaches the lead would step straight
 * past the day and call it a landing.
 */
async function snapTo(page: Page, date: string): Promise<void> {
  await page.getByTestId('week-deck').focus();
  await page.keyboard.press('Home');
  await expect(async () => {
    const gap = await topGap(page, `day-${date}-row`);
    if (gap > LEAD_PX + EPSILON) {
      await page.keyboard.press('ArrowDown');
      throw new Error(`${date} is still ${Math.round(gap)}px below the header`);
    }
    expect(gap).toBeGreaterThanOrEqual(-EPSILON);
  }).toPass({ timeout: SYNC_TIMEOUT });
}

test.describe('meal planner — the deck lands where it should', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    // The deck short-circuits its spring under reduced motion, so a keyboard step
    // is instantaneous and every measurement below is of a settled deck.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('stays on today when the rows grow their photographs under it, and hangs off the rail', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const today = new Date().toLocaleDateString('en-CA');
    const startDate = addDays(today, -6);
    const recipeIds = ['deck-a', 'deck-b', 'deck-c'];

    // The household's week shape goes in before the app exists — see
    // `seedFirstDayOfWeek`. Everything after this is a running app being changed.
    await seedFirstDayOfWeek(firstDayPutting(today, 6));
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/');
    await page.goto('/#/mealplan');
    await expect(page.getByTestId('week-deck')).toBeVisible({ timeout: HYDRATE_TIMEOUT });

    for (const [i, id] of recipeIds.entries()) {
      await seedRecipe(page, recipeWithPhoto(id, `Deck dish ${i + 1}`));
    }

    // A week of text-only days first: 104px cards, a list barely taller than the
    // viewport. This is the shape the anchor MEASURES on a cold load.
    await seedMealPlanWeek(page, weekOf(startDate, []));
    await weekOnScreen(page, startDate);
    await expect
      .poll(async () => Math.round(await topGap(page, `day-${today}-row`)), {
        timeout: SYNC_TIMEOUT,
      })
      .toBeLessThanOrEqual(LEAD_PX + EPSILON);

    // …then give every day its recipe, so all seven rows grow a 1.6:1 photograph
    // UNDER a deck that has already landed. In production this is the recipes
    // store arriving after the week's, which no test can order reliably — so it is
    // provoked here instead, which is the same event from the deck's point of
    // view: the content it measured against is now half as tall again.
    await seedMealPlanWeek(page, weekOf(startDate, recipeIds));
    // Attached, not visible: whether the photograph is ON SCREEN is precisely the
    // thing under test below, so waiting for visibility here would make the bug
    // fail this line instead of the assertion written for it.
    await expect(page.getByTestId(`day-${today}-photo`)).toBeAttached({ timeout: SYNC_TIMEOUT });

    // Today is STILL flush under the header. Without the re-anchor the deck holds
    // the offset it clamped to while the list was short, and today — six rows down
    // a list that just grew by ~600px — ends up far below the fold.
    await expect
      .poll(async () => Math.round(await topGap(page, `day-${today}-row`)), {
        timeout: SYNC_TIMEOUT,
      })
      .toBeLessThanOrEqual(LEAD_PX + EPSILON);

    // The rail hangs off the edge of the ROWS. Compared against the rows, not the
    // deck: #647 bled the viewport left by the same amount it moved the stem, so
    // only the rows know where the content edge really is.
    const rail = await page.getByTestId('this-week-rail').boundingBox();
    const row = await page.getByTestId(`day-${today}-summary`).boundingBox();
    expect(rail).not.toBeNull();
    expect(row).not.toBeNull();
    expect(Math.abs(rail!.x - row!.x)).toBeLessThanOrEqual(EPSILON);
  });

  test('the shop rule and the next-week mark stay on screen when their day is snapped to', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const today = new Date().toLocaleDateString('en-CA');
    const startDate = addDays(today, -6);
    const nextStart = addDays(startDate, 7);
    const recipeIds = ['mark-a', 'mark-b'];

    await seedFirstDayOfWeek(firstDayPutting(today, 6));
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/');
    await page.goto('/#/mealplan');
    await expect(page.getByTestId('week-deck')).toBeVisible({ timeout: HYDRATE_TIMEOUT });

    for (const [i, id] of recipeIds.entries()) {
      await seedRecipe(page, recipeWithPhoto(id, `Mark dish ${i + 1}`));
    }
    // Today at index 6 is inside the window that appends next week, so both weeks
    // are seeded — an appended week with no document renders no rows at all.
    await seedMealPlanWeek(page, weekOf(startDate, recipeIds));
    await seedMealPlanWeek(page, weekOf(nextStart, recipeIds));
    await weekOnScreen(page, startDate);
    await expect(page.getByTestId('next-week-mark')).toBeAttached({ timeout: SYNC_TIMEOUT });

    // Set this week's shop day through the picker the header offers while no shop
    // day is set — the real control, not a document written behind the page.
    const shopDate = addDays(startDate, 3);
    await page.getByTestId('week-shop-trigger').click();
    await page.getByTestId(`week-shop-${shopDate}-am`).click();
    await expect(page.getByTestId(`day-${shopDate}-shop-marker`)).toBeAttached({
      timeout: SYNC_TIMEOUT,
    });

    // Snapping to the shop day must not scroll its own rule away — the rule should
    // be the FIRST thing on screen, not merely somewhere in the DOM. Pre-fix it was
    // a sibling above the deck's section, so it came to rest a dozen pixels above
    // the viewport's top edge: present, and invisible on the phone.
    await snapTo(page, shopDate);
    await expect
      .poll(async () => Math.round(await topGap(page, `day-${shopDate}-shop-marker`)), {
        timeout: SYNC_TIMEOUT,
      })
      .toBeGreaterThanOrEqual(-EPSILON);

    // …and the same for the week boundary, which lives in the first day of next
    // week for exactly the same reason.
    await snapTo(page, nextStart);
    await expect
      .poll(async () => Math.round(await topGap(page, 'next-week-mark')), {
        timeout: SYNC_TIMEOUT,
      })
      .toBeGreaterThanOrEqual(-EPSILON);
  });
});
