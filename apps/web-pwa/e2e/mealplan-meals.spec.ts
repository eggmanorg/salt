/**
 * Meals in the planner — a dinner built from several dishes (issue #752, Phase 2).
 *
 * A meal is an ordinary `recipes/{id}` carrying `componentRecipeIds`; there is no
 * fifth kind and no second collection. What Phase 2 adds is FROZEN EXPANSION:
 * picking a meal writes `[mealId, ...componentRecipeIds]` into the day, once, and
 * editing the meal afterwards never rewrites a night already planned.
 *
 * Three journeys, and between them they cover the whole promise:
 *
 *   1. Pick the meal, get the dinner. Four rows land from one tap, the day's note
 *      takes the meal's title and the day's card takes the meal's photograph —
 *      the last two by ordering the expansion, not by teaching either mechanic
 *      what a meal is. The components carry a DIFFERENT picture on purpose: the
 *      card can only be showing the meal's if the meal leads.
 *
 *   2. Shop the week, and the dinner is one line with one tick. The count on the
 *      confirm button stays the FLAT number of review sheets that follow, which
 *      is the promise the queue keeps — so unticking one row has to drop four.
 *
 *   3. Find the meal without scrolling past the dishes (#1454). The night's add
 *      box carries a row of shelf chips; tapping `Meals` leaves the roast alone
 *      in the list and picking it there plans exactly the dinner journey 1 plans.
 *      The chips only narrow what you are LOOKING at, so the outcome is identical
 *      — which is the whole assertion.
 *
 * Recipes are bridge-seeded (NF-C4) rather than authored: a meal with three
 * components is four editor round-trips plus the "Made from" picker before the
 * thing under test begins, and none of that is what these journeys are about.
 * No AI stub is needed — the `onRecipeWritten` hero trigger leaves a document that
 * already carries an `image` alone, and short-circuits under `FUNCTIONS_AI_FAKE`
 * regardless.
 */
import type { Page } from '@playwright/test';
import type { Day, MealPlanWeek, Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import {
  seedFirstDayOfWeek,
  seedMealPlanWeek,
  seedRecipe,
  seedShoppingListBeforeBoot,
} from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly: from 700x480 up the planner shows the day's detail
// as a docked pane with its own `day-pane-*` testids instead of the bottom sheet
// this spec drives. Same numbers as `mealplan.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const MEAL_TITLE = 'Sunday roast';
const COMPONENT_TITLES = ['Roast chicken', 'Roast potatoes', 'Onion gravy'] as const;
const COMPONENT_IDS = ['meal-chicken', 'meal-potatoes', 'meal-gravy'] as const;
const MEAL_ID = 'meal-roast';

// Two committed static assets, so "which picture is the card showing" is a real
// question with a checkable answer. The meal wears one, every component the other.
const MEAL_HERO = '/icons/icon-192.png';
const COMPONENT_HERO = '/icons/icon-512.png';

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

function recipe(
  id: string,
  title: string,
  opts: { hero?: string; componentRecipeIds?: string[] } = {},
): Recipe {
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
    componentRecipeIds: opts.componentRecipeIds ?? [],
    kit: [],
    image: opts.hero ? { url: opts.hero, source: 'upload' } : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

/** The meal and its three dishes, seeded through the real persistence path. */
async function seedTheRoast(page: Page): Promise<void> {
  for (const [i, id] of COMPONENT_IDS.entries()) {
    await seedRecipe(page, recipe(id, COMPONENT_TITLES[i]!, { hero: COMPONENT_HERO }));
  }
  await seedRecipe(
    page,
    recipe(MEAL_ID, MEAL_TITLE, { hero: MEAL_HERO, componentRecipeIds: [...COMPONENT_IDS] }),
  );
}

/** A seven-day week whose FIRST day carries `recipeIds` and whose rest is empty. */
function weekWithDinner(startDate: string, recipeIds: readonly string[]): MealPlanWeek {
  const days: Record<string, Day> = {};
  for (let i = 0; i < 7; i++) {
    days[addDays(startDate, i)] = {
      note: '',
      recipeIds: [],
      chefs: [],
      attendees: [],
      guests: 0,
    };
  }
  days[startDate] = { note: '', recipeIds: [...recipeIds], chefs: [], attendees: [], guests: 0 };
  return {
    id: startDate,
    schemaVersion: 1,
    startDate,
    days,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Open today's night on the current week, and hand back its testid prefix.
 *
 * Today is derived from the store, never guessed: it is the one day guaranteed
 * to be both in the displayed week and on screen (the deck opens on it, #639).
 */
async function openTonight(page: Page): Promise<{ dayKey: string; testid: string }> {
  await page.goto('/#/mealplan');
  await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await page.getByTestId('this-week').click();
  await expect(page.getByTestId('week-range')).not.toHaveText('', { timeout: SYNC_TIMEOUT });

  const dayKey = await page.evaluate(() => {
    const days = window.__e2e!.getMealPlanSnapshot().days;
    const today = new Date().toLocaleDateString('en-CA');
    return today in days ? today : Object.keys(days).sort()[0]!;
  });
  expect(dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const testid = `day-${dayKey}`;

  await page.getByTestId(`${testid}-summary`).click();
  await expect(page.getByTestId(`${testid}-detail`)).toBeVisible({ timeout: SYNC_TIMEOUT });
  return { dayKey, testid };
}

/** What the plan document actually holds for one day — the store, not the DOM. */
function readDay(page: Page, dateKey: string): Promise<{ recipeIds: string[]; note: string }> {
  return page.evaluate((key) => {
    const d = window.__e2e!.getMealPlanSnapshot().days[key];
    return { recipeIds: [...(d?.recipeIds ?? [])], note: d?.note ?? '' };
  }, dateKey);
}

test.describe('meal planner — a night built from several dishes', () => {
  test('picking a meal plans the whole dinner, and the day wears the meal', async ({
    page,
  }, testInfo) => {
    // Four recipe documents, a route change and a whole-week write — the planner
    // spec's tier, not the 60 s create-only one (NF-F2).
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/', { admin: true });
    await seedTheRoast(page);

    // ── Anchor on a real day of the current week ─────────────────────────────
    const { dayKey, testid } = await openTonight(page);

    // ── One tap on the meal ──────────────────────────────────────────────────
    // The picker input is an unlabelled action affordance (NF-B2); the OPTION —
    // the content — is resolved accessibly. A meal is `kind: 'recipe'`, so it is
    // offered exactly like anything else — but since #1454 it wears a `Meals`
    // badge, which is part of the option's accessible name: the badge is the
    // only thing in the list that says which of these is the whole dinner.
    await page.getByTestId(`${testid}-recipe-picker`).click();
    const option = page.getByRole('option', { name: `${MEAL_TITLE} Meals` });
    await expect(option).toBeVisible({ timeout: SYNC_TIMEOUT });
    await option.click();

    // ── The whole dinner landed, meal FIRST ──────────────────────────────────
    // Poll the store, not the DOM: the attach is an optimistic whole-document save
    // and the assertion is about what landed (NF-A3/NF-D3). The order is the thing
    // under test as much as the membership — the two mechanics below depend on it.
    await expect
      .poll(() => readDay(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toEqual({
        recipeIds: [MEAL_ID, ...COMPONENT_IDS],
        note: MEAL_TITLE,
      });

    // Four rows, each removable on its own — which is what makes "drop the gravy
    // from Tuesday" need no new code at all.
    for (const id of [MEAL_ID, ...COMPONENT_IDS]) {
      await expect(page.getByTestId(`${testid}-recipe-row-${id}`)).toBeVisible();
      await expect(page.getByTestId(`${testid}-recipe-remove-${id}`)).toBeVisible();
    }
    // The day's dinner text is the MEAL's name, not the first dish's.
    await expect(page.getByTestId(`${testid}-note`)).toHaveValue(MEAL_TITLE);

    // ── …and the week's card wears the meal's photograph ─────────────────────
    // The card takes the first attached recipe that has a hero, unchanged since
    // #639. Meal-first is the whole of why that is the roast and not the chicken.
    // Escape closes the day's sheet. Safe here in a way it is not while the
    // picker is up (mealplan.spec.ts): the combobox closed when the option was
    // taken, so the sheet is the only thing listening.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`${testid}-detail`)).toBeHidden({ timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(`${testid}-photo`)).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(`${testid}-photo`)).toHaveAttribute(
      'src',
      new RegExp('icon-192\\.png'),
    );
  });

  test('shop the week: the dinner is one row with one tick, and still four reviews', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);

    // Both before the app boots, and both for the same measured drop hazard: the
    // default-list config and `firstDayOfWeek` each live in ONE document whose
    // listener attaches at boot with the doc absent (NF-C4). The week shape matters
    // here because the seeded week document below is keyed by its start date.
    await seedShoppingListBeforeBoot('Weekly shop');
    const today = new Date().toLocaleDateString('en-CA');
    await seedFirstDayOfWeek(firstDayPutting(today, 0));

    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/', { admin: true });
    await seedTheRoast(page);
    // A dish that belongs to nobody, so unticking the dinner leaves something
    // behind and the count has somewhere to land other than zero.
    await seedRecipe(page, recipe('meal-pie', 'Fish pie'));

    await page.goto('/#/mealplan');
    await expect(page.getByTestId('week-deck')).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Today starts the week, so the week document's start date IS today.
    await seedMealPlanWeek(page, weekWithDinner(today, [MEAL_ID, ...COMPONENT_IDS, 'meal-pie']));
    await expect
      .poll(() => page.evaluate(() => window.__e2e!.getMealPlanSnapshot().startDate), {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(today);

    // ── The sheet: one line for the dinner ───────────────────────────────────
    await page.getByTestId('shop-week-trigger').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('Shop the week')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // The meal speaks for its three dishes, and says so.
    await expect(sheet.getByText(`${MEAL_TITLE} · 3`)).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(sheet.getByText('Fish pie')).toBeVisible();
    // The dishes are not rows of their own — the tick above already covers them.
    for (const id of COMPONENT_IDS) {
      await expect(page.getByTestId(`shop-week-row-${today}-${id}`)).toHaveCount(0);
    }

    // The count is FLAT, and that is a promise: press it and five review sheets
    // follow, one per dish, even though only two rows were offered.
    const confirm = page.getByTestId('shop-week-confirm');
    await expect(confirm).toHaveText('Review 5 recipes');

    // ── One tick covers the whole dinner ─────────────────────────────────────
    // The testid sits on the primitive's wrapper; the control it names is inside.
    await page.getByTestId(`shop-week-tick-${today}-${MEAL_ID}`).getByRole('checkbox').click();
    await expect(confirm).toHaveText('Review 1 recipe');
  });

  test('filter the add box to Meals, and the roast is the only thing in it', async ({
    page,
  }, testInfo) => {
    // The shelf chips (#1454). Four seeded documents put two shelves in front of
    // this night — three dishes on Recipes, the roast on Meals — and the chip row
    // appears only because there is more than one.
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/', { admin: true });
    await seedTheRoast(page);

    const { dayKey, testid } = await openTonight(page);

    await page.getByTestId(`${testid}-recipe-picker`).click();
    await expect(page.getByRole('option', { name: `${MEAL_TITLE} Meals` })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    // Four things to read past before the chips are touched.
    await expect(page.getByRole('option')).toHaveCount(4);

    // ── Tap `Meals` ──────────────────────────────────────────────────────────
    // The chip row is `ChipGroup` + `Chip`, so the chip is a real button with its
    // own accessible name — the copy comes from SECTION_COPY and is asserted as
    // the user reads it, not by its data attribute.
    const mealsChip = page
      .getByTestId(`${testid}-recipe-section-filter`)
      .filter({ hasText: 'Meals' });
    await mealsChip.click();
    await expect(mealsChip).toHaveAttribute('aria-pressed', 'true');

    // The list stayed open underneath the tap, and the roast is alone in it.
    await expect(page.getByRole('option')).toHaveCount(1);
    const option = page.getByRole('option', { name: `${MEAL_TITLE} Meals` });
    await expect(option).toBeVisible();

    // ── …and picking it there plans exactly the dinner journey 1 plans ───────
    await option.click();
    await expect
      .poll(() => readDay(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toEqual({
        recipeIds: [MEAL_ID, ...COMPONENT_IDS],
        note: MEAL_TITLE,
      });

    // The night now holds every dish, so Meals has nothing left to offer and its
    // chip goes — the row falls back to the single shelf it started from, which
    // means no row at all.
    await expect(page.getByTestId(`${testid}-recipe-section-filters`)).toHaveCount(0);
  });
});
