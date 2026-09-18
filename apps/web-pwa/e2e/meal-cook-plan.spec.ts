/**
 * A meal's cook plan — the dashboard for the evening (issue #752, Phase 4).
 *
 * One journey, because the phase has one promise: open the plan from the meal,
 * name a serve time, and every dish gets a start clock time worked back from it so
 * they all finish together. The bird goes in at 17:30, the potatoes at 18:10, the
 * gravy at 18:50, for a 19:00 serve.
 *
 * What needs a real browser here is the ROUND TRIP the unit tests cannot do: the
 * entry point on the recipe page, the route, the serve time landing in Firestore
 * on a document that did not exist a moment ago, and the schedule re-rendering off
 * the snapshot that comes back. The arithmetic itself is `scheduleFor`'s and is
 * pinned in the domain suite.
 *
 * THE COUNTDOWNS ARE DELIBERATELY NOT ASSERTED. "in 40 min" moves with the wall
 * clock between the render and the assertion, and the row that reads START NOW
 * depends on what time of day CI happens to run. The start CLOCK times are fixed
 * by the serve time and are the honest thing to check.
 *
 * The serve time is picked as a LOCAL "HH:mm" and rendered back as local time, so
 * every expectation below is timezone-independent by construction — no UTC
 * arithmetic anywhere.
 *
 * Recipes are bridge-seeded (NF-C4): a meal with three components is four editor
 * round trips plus the "Made from" picker before the thing under test begins. No
 * AI stub is needed — nothing here calls a flow, and the `onRecipeWritten` hero
 * trigger short-circuits under `FUNCTIONS_AI_FAKE` regardless.
 */
import type { Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly: the recipe page docks its chat column from 700x480
// up, and this spec would otherwise inherit the project's 1280x720 desktop
// default. Same numbers as `meal-component-create.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

const MEAL_ID = 'meal-roast';
const MEAL_TITLE = 'Sunday roast';

// Phase strips chosen so the three start times are the issue's own worked example
// and land on the quarter hours the picker offers. Each dish is seeded with a
// hands-on block and a hands-off one that sum to `elapsedMinutes`: since issue
// #1233 the strip is what the plan works back from, so a dish's whole process —
// not just its time in the oven — decides when it has to begin.
const DISHES = [
  { id: 'meal-chicken', title: 'Roast chicken', elapsedMinutes: 90, startsAt: '17:30' },
  { id: 'meal-potatoes', title: 'Roast potatoes', elapsedMinutes: 50, startsAt: '18:10' },
  { id: 'meal-gravy', title: 'Onion gravy', elapsedMinutes: 10, startsAt: '18:50' },
] as const;

const SERVE_AT = '19:00';

function recipe(
  id: string,
  title: string,
  opts: { elapsedMinutes?: number; componentRecipeIds?: string[] } = {},
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
      // Deliberately contradicts the strip: nothing reads it any more, and if
      // anything did the start times asserted below would move.
      phases:
        opts.elapsedMinutes === undefined
          ? []
          : [
              { label: 'Get it ready', handsOnMinutes: 10, handsOffMinutes: 0 },
              {
                label: 'Cook it',
                handsOnMinutes: 0,
                handsOffMinutes: opts.elapsedMinutes - 10,
              },
            ],
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: opts.componentRecipeIds ?? [],
    kit: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

/** The meal and its three dishes, seeded through the real persistence path. */
async function seedTheRoast(page: Page): Promise<void> {
  for (const dish of DISHES) {
    await seedRecipe(page, recipe(dish.id, dish.title, { elapsedMinutes: dish.elapsedMinutes }));
  }
  await seedRecipe(
    page,
    recipe(MEAL_ID, MEAL_TITLE, { componentRecipeIds: DISHES.map((d) => d.id) }),
  );
}

test.describe('meals — the cook plan says what goes on when', () => {
  test('name a serve time and every dish gets a start time counted back from it', async ({
    page,
  }, testInfo) => {
    // Four seeded recipes, a route change and a cook-session write — the
    // create-and-edit tier (NF-F2), not the trigger/AI one.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });
    await seedTheRoast(page);

    // ── Get there from the meal ──────────────────────────────────────────────
    // The entry point is part of the promise: without it the manager is
    // unreachable. The overflow menu and its items are action affordances with no
    // stable accessible name of their own (NF-B2), so they go by testid.
    await page.goto(`/#/recipes/${MEAL_ID}`);
    await expect(page.getByRole('heading', { name: MEAL_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-cook-plan-menu-item').click();
    await expect(page).toHaveURL(new RegExp(`#/recipes/${MEAL_ID}/cook-plan$`));

    // ── The running order ────────────────────────────────────────────────────
    // Stored order, which is the order they were attached in — never re-sorted by
    // the page. The meal itself is NOT a row: it has no steps of its own, so there
    // is nothing to start.
    const titles = page.getByTestId('cook-plan-row-title');
    await expect(titles).toHaveText(
      DISHES.map((d) => d.title),
      { timeout: SYNC_TIMEOUT },
    );

    // Nothing is scheduled until a serve time exists — the page says so rather
    // than inventing one.
    await expect(page.getByTestId('cook-plan-serve-trigger')).toContainText('Set serve time');
    await expect(page.getByTestId('cook-plan-row-start').first()).toHaveText('start when you like');

    // ── Name the serve time ──────────────────────────────────────────────────
    // A quarter-hour picker, so there is nothing to parse and nothing to mistype.
    // The value is a LOCAL wall-clock time; what is stored is the absolute instant
    // it names today, which is what survives a device switch.
    await page.getByTestId('cook-plan-serve-trigger').click();
    const option = page.getByRole('option', { name: SERVE_AT, exact: true });
    await expect(option).toBeVisible({ timeout: SYNC_TIMEOUT });
    await option.click();

    // ── …and the whole evening falls out of it ───────────────────────────────
    // The write creates the meal's cook session (opening the page wrote nothing),
    // and the schedule re-renders off the snapshot that comes back — so this is a
    // web-first wait on a real round trip, not on a timer.
    await expect(page.getByTestId('cook-plan-serve-trigger')).toContainText(`serving ${SERVE_AT}`, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('cook-plan-row-start')).toHaveText(
      DISHES.map((d) => `start ${d.startsAt}`),
      { timeout: SYNC_TIMEOUT },
    );

    // ── It is committed, not merely optimistic ───────────────────────────────
    // A reload re-reads `cookSessions/{mealId}_{uid}` from scratch; the serve time
    // and every start time it implies have to still be there. That is the outcome
    // "survives a reload and a device switch", asked the only way a browser can.
    await page.reload();
    await expect(page.getByTestId('cook-plan-serve-trigger')).toContainText(`serving ${SERVE_AT}`, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('cook-plan-row-start')).toHaveText(
      DISHES.map((d) => `start ${d.startsAt}`),
      { timeout: SYNC_TIMEOUT },
    );
  });
});
