/**
 * Meal planner first E2E (issue #169 coverage gap).
 *
 * Exercises the weekly planner happy path end-to-end:
 *   open the current week → open a day's editor sheet and configure it (meal
 *   note + attendee + chef + guests) → the whole-doc save round-trips to
 *   Firestore → reload → the data persists (proving the Firestore round-trip,
 *   not just a hot store).
 *
 * Determinism: the week id is a date that depends on the run date, so nothing is
 * hardcoded. We click `this-week`, read the actual `startDate` from the
 * `getMealPlanSnapshot()` bridge, derive a concrete day key from it, and assert
 * against the exact key we used.
 *
 * Members: the signed-in user is seeded onto the allowlist as a member whose id
 * is the normalised email (see helpers/auth.ts), so it appears as a member chip
 * with attendee/chef testids keyed by that email. We use it as the attendee.
 *
 * There is intentionally no delete/clear assertion: the meal planner has no
 * delete/clear/deferred-delete pattern (a day is reset by editing it back or by
 * Load template, not deleted). Recipe attach is a reserved seam (#17, not
 * shipped) — "add a meal" means setting the day's meal note + attendees here.
 */
import type { Day, MealPlanWeek, Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedMealPlanWeek, seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly (#663, Phase 2). The planner shows the week and the
// open day SIDE BY SIDE from 700x480 up, and the day is then a docked pane rather
// than a bottom sheet — so the default desktop project viewport (1280x720) would
// silently move every assertion below onto the other layout. These are the same
// numbers `mealplan-deck.spec.ts` runs at; the split layout has its own spec.
test.use({ viewport: { width: 393, height: 851 } });

// Read the current week's startDate from the in-page store bridge.
async function readStartDate(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => window.__e2e!.getMealPlanSnapshot().startDate);
}

// The note saved for a given day key, or undefined if the day isn't present.
async function readDayNote(
  page: import('@playwright/test').Page,
  dayKey: string,
): Promise<string | undefined> {
  return page.evaluate((key) => window.__e2e!.getMealPlanSnapshot().days[key]?.note, dayKey);
}

// The recipe ids attached to a given day key.
async function readDayRecipeIds(
  page: import('@playwright/test').Page,
  dayKey: string,
): Promise<readonly string[]> {
  return page.evaluate(
    (key) => window.__e2e!.getMealPlanSnapshot().days[key]?.recipeIds ?? [],
    dayKey,
  );
}

// Today's day key, if the displayed week holds it, else the week's first day.
// Today is the anchor wherever it can be: the planner opens on its row and puts
// it flush under the header (#639), so it is the one day guaranteed to be both
// in the displayed week and on screen.
async function readAnchorDayKey(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const days = window.__e2e!.getMealPlanSnapshot().days;
    const today = new Date().toLocaleDateString('en-CA');
    return today in days ? today : Object.keys(days).sort()[0]!;
  });
}

// A placeholder document, whole (#652). Seeded through the bridge rather than
// authored in the editor because the thing under test needs one that already has
// a HERO: a placeholder with no photograph is deliberately never picked, and hero
// generation is skipped under the e2e AI fake. The url never has to resolve —
// nothing here asserts on pixels, only on which document got attached.
function placeholderRecipe(id: string, mood: 'bright' | 'comfort'): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind: 'placeholder',
    title: `Placeholder — ${mood}`,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [mood],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    image: { url: `https://example.test/${id}.webp` },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Recipe;
}

test.describe('meal planner — week happy path', () => {
  test('configure a day, save, reload, and the plan persists', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Sign in at the root (AuthGate blocks rendering until authed), then open the
    // planner via its hash route — mirrors the recipe spec's deep-link pattern.
    await gotoAndSignIn(page, email, '/');
    await page.goto('/#/mealplan');

    // Anchor deterministically on the current week (the page also resets to it
    // on mount, but click explicitly so the test owns the anchor).
    await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('this-week').click();
    await expect(page.getByTestId('week-range')).not.toHaveText('', { timeout: SYNC_TIMEOUT });

    // Derive a real day key from the store rather than guessing a date. TODAY is
    // the anchor: the planner opens on today's row and puts it flush under the
    // header (#639), so it is the one day guaranteed to be both in the displayed
    // week and on screen — which a fixed "day 3 of the week" is not, now that the
    // page is a deck rather than a scroller and, from the last three days of the
    // cycle, also holds next week beneath it.
    const startDate = await readStartDate(page);
    expect(startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dayKey = await readAnchorDayKey(page);
    expect(dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // ── Next week appears from Tuesday (#639, Phase 6) ──
    // Date-dependent by nature, so the expectation is DERIVED, not hardcoded:
    // from the last three days of the cycle the deck also holds the whole of next
    // week under a dated mark, and before that it holds this week alone. The
    // primary snapshot is still one week — next week's days are a second document
    // and never appear in it, so the day key above stays unambiguous either way.
    // Counted rather than branched on: the expected count IS the expectation, so
    // the same two assertions run on every day of the week. A count (not
    // visibility) is the honest test — the appended week starts below the fold of
    // a deck that opens on today.
    const { expectedNextWeek, nextWeekFirstDay } = await page.evaluate((start: string) => {
      const utc = (d: string) => new Date(`${d}T00:00:00.000Z`);
      const today = new Date().toLocaleDateString('en-CA');
      const index = Math.round((utc(today).getTime() - utc(start).getTime()) / 86_400_000);
      const next = utc(start);
      next.setUTCDate(next.getUTCDate() + 7);
      // The last three days of a seven-day cycle — the domain rule, restated here
      // because e2e sees only the wire, not `weekExtendsIntoNext`.
      return {
        expectedNextWeek: Number(index >= 4),
        nextWeekFirstDay: next.toISOString().slice(0, 10),
      };
    }, startDate);
    await expect(page.getByTestId('next-week-mark')).toHaveCount(expectedNextWeek, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId(`day-${nextWeekFirstDay}`)).toHaveCount(expectedNextWeek, {
      timeout: SYNC_TIMEOUT,
    });

    const testid = `day-${dayKey}`;
    const meal = `Spaghetti bolognese ${testInfo.testId}`;

    // Tap the day's row to raise its editor sheet (#640).
    await page.getByTestId(`${testid}-summary`).click();
    await expect(page.getByTestId(`${testid}-detail`)).toBeVisible({ timeout: SYNC_TIMEOUT });

    // Set the meal note (this is "add a meal to a day" — recipe attach is a
    // reserved, unshipped seam).
    await page.getByTestId(`${testid}-note`).fill(meal);

    // Mark the signed-in member attending and make them chef; add a guest.
    // Attending reveals the home time ON THE MEMBER'S OWN LINE (#640, Phase 3) —
    // no second row, and the personal note stays behind its affordance, so the
    // chef hat is reachable without scrolling the sheet.
    await page.getByTestId(`${testid}-attend-${email}`).click();
    await expect(page.getByTestId(`${testid}-time-${email}`)).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId(`${testid}-chef-${email}`).click();
    await page.getByTestId(`${testid}-guests-inc`).click();

    // Every edit is an optimistic whole-doc save. Poll the store snapshot until
    // it reflects all four mutations for our day key.
    await expect.poll(() => readDayNote(page, dayKey), { timeout: SYNC_TIMEOUT }).toBe(meal);
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const day = window.__e2e!.getMealPlanSnapshot().days[key];
            return {
              note: day?.note,
              chefs: day?.chefs ?? [],
              attendees: (day?.attendees ?? []).map((a) => a.memberId),
              guests: day?.guests ?? 0,
            };
          }, dayKey),
        { timeout: SYNC_TIMEOUT },
      )
      .toEqual({ note: meal, chefs: [email], attendees: [email], guests: 1 });

    // The rendered guest count reflects the saved state.
    await expect(page.getByTestId(`${testid}-guests-count`)).toHaveText('1', {
      timeout: SYNC_TIMEOUT,
    });

    // ── Reload: prove the Firestore round-trip, not a hot store ──
    // `page.reload()`, NOT `goto('/#/mealplan')`: we are already at that URL, and
    // navigating to the URL you are on is a same-document hash navigation — the
    // app never remounts, so nothing is proved and the day's sheet is still open
    // underneath. Reload keeps the hash, so the router lands back on the planner.
    // The page's onMount anchors to this week on its own; clicking `this-week`
    // again would force a re-subscription (the store briefly nulls the week),
    // which remounts the day editors mid-interaction. So we rely on the mount
    // anchor and just wait for the week to load.
    await page.reload();
    await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(testid)).toBeVisible({ timeout: SYNC_TIMEOUT });

    // The same week loads from Firestore with our day intact.
    await expect.poll(() => readDayNote(page, dayKey), { timeout: SYNC_TIMEOUT }).toBe(meal);
    await expect
      .poll(
        () =>
          page.evaluate((key) => {
            const day = window.__e2e!.getMealPlanSnapshot().days[key];
            return {
              chefs: day?.chefs ?? [],
              attendees: (day?.attendees ?? []).map((a) => a.memberId),
              guests: day?.guests ?? 0,
            };
          }, dayKey),
        { timeout: SYNC_TIMEOUT },
      )
      .toEqual({ chefs: [email], attendees: [email], guests: 1 });

    // And the persisted state is reflected in the DOM after reload.
    await expect(page.getByTestId(`${testid}-summary`)).toContainText(meal, {
      timeout: SYNC_TIMEOUT,
    });
    // Open the day again to inspect the editor. One click, no retry: which day is
    // open is owned by the PAGE now (#640), so a week settling in from Firestore
    // re-renders the row without closing the sheet. Under the old row-local
    // toggle this needed a `toPass` loop, because the snapshot that arrived
    // mid-interaction reset it.
    await page.getByTestId(`${testid}-summary`).click();
    await expect(page.getByTestId(`${testid}-detail`)).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(`${testid}-note`)).toHaveValue(meal, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(`${testid}-guests-count`)).toHaveText('1', {
      timeout: SYNC_TIMEOUT,
    });
  });
});

test.describe('meal planner — the note-only night (#652)', () => {
  test('typing a meal into an empty day gives it a placeholder card you can remove', async ({
    page,
  }, testInfo) => {
    // Single tab, no AI, no cross-tab convergence: the 60 s tier (NF-F2). Every
    // wait below is bound to a real signal — a store read or a rendered element.
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/');

    // ── The library ──────────────────────────────────────────────────────────
    // One picture in each mood, so a pick is guaranteed whatever month CI runs
    // in: the season chooses the mood, and a mood with an empty set is exactly
    // what makes `pickPlaceholder` return null and leave the day as text.
    await seedRecipe(page, placeholderRecipe('e2e-ph-bright', 'bright'));
    await seedRecipe(page, placeholderRecipe('e2e-ph-comfort', 'comfort'));
    const PLACEHOLDER_IDS = ['e2e-ph-bright', 'e2e-ph-comfort'];

    await page.goto('/#/mealplan');
    await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('this-week').click();
    await expect(page.getByTestId('week-range')).not.toHaveText('', { timeout: SYNC_TIMEOUT });

    const dayKey = await readAnchorDayKey(page);
    expect(dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const testid = `day-${dayKey}`;
    const meal = `Roast chicken dinner ${testInfo.testId}`;

    // The day starts unplanned, and says so.
    await expect(page.getByTestId(`${testid}-meal`)).toHaveText('Nothing planned', {
      timeout: SYNC_TIMEOUT,
    });

    // ── Plan it in a sentence ────────────────────────────────────────────────
    await page.getByTestId(`${testid}-summary`).click();
    await expect(page.getByTestId(`${testid}-detail`)).toBeVisible({ timeout: SYNC_TIMEOUT });

    // A placeholder is never OFFERED — it arrives on its own or not at all. The
    // two seeded above are the only recipes in the store, so an entirely empty
    // picker is the assertion; `isPlannable` is what empties it, not a second
    // filter in the planner.
    const dialog = page.getByRole('dialog');
    await page.getByTestId(`${testid}-recipe-picker`).click();
    await expect(dialog.getByText('Nothing found')).toBeVisible();
    // Dismissed by moving focus off the input, which is what the picker closes
    // on. Escape is avoided deliberately: the sheet underneath listens for it too.
    await dialog.getByRole('heading').click();
    await expect(dialog.getByText('Nothing found')).toBeHidden();

    // Typing the meal and tapping out of the field is the whole gesture.
    await page.getByTestId(`${testid}-note`).fill(meal);
    await page.getByTestId(`${testid}-note`).blur();

    // ── The day is now carrying a placeholder ────────────────────────────────
    await expect
      .poll(() => readDayRecipeIds(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toHaveLength(1);
    const attachedIds = await readDayRecipeIds(page, dayKey);
    expect(PLACEHOLDER_IDS).toContain(attachedIds[0]!);
    const attachedId = attachedIds[0]!;
    await expect.poll(() => readDayNote(page, dayKey), { timeout: SYNC_TIMEOUT }).toBe(meal);

    // It is attached, not conjured, so it is visible as an ordinary row with a
    // title and an X — the thing that makes the mechanism inspectable.
    await expect(page.getByTestId(`${testid}-recipe-row-${attachedId}`)).toBeVisible();
    await expect(page.getByTestId(`${testid}-recipe-remove-${attachedId}`)).toBeVisible();

    // And the week's row is a photographic card like any other planned night.
    await expect(page.getByTestId(`${testid}-photo`)).toHaveCount(1, { timeout: SYNC_TIMEOUT });

    // ── Leaving the field again attaches nothing further ─────────────────────
    // The day now has a recipe, which is the guard: the pick is frozen at the one
    // moment the day was planned and nothing re-evaluates it.
    await page.getByTestId(`${testid}-note`).fill(`${meal} (with gravy)`);
    await page.getByTestId(`${testid}-note`).blur();
    await expect
      .poll(() => readDayNote(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toBe(`${meal} (with gravy)`);
    expect(await readDayRecipeIds(page, dayKey)).toEqual([attachedId]);

    // ── Remove it, and the day goes back to being a block of text ────────────
    await page.getByTestId(`${testid}-recipe-remove-${attachedId}`).click();
    await expect
      .poll(() => readDayRecipeIds(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toHaveLength(0);
    await expect(page.getByTestId(`${testid}-photo`)).toHaveCount(0, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId(`${testid}-meal`)).toContainText(meal);
  });
});

// ─── Shop the week (#724) ───────────────────────────────────────────────────
// The one thing a browser proves that the unit suite cannot: the header's cart,
// the selection sheet and the run of review sheets all reach the real shopping
// list through the real write path, on a phone.
//
// Everything is hung on TODAY's night rather than spread across the week. Which
// days are offered depends on the run date and on `firstDayOfWeek`; today is the
// one day guaranteed to be in the displayed week, ahead of itself, and on screen
// — and a night with two recipes is exactly the case worth having in a browser,
// since it is the one that makes the queue run twice.

/** An ingredient line as the editor would write one before canon has seen it. */
function ingredient(id: string, rawText: string) {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'pending' as const,
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function shoppableRecipe(id: string, title: string, item: string): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [{ id: `${id}-g1`, name: null, items: [ingredient(`${id}-i1`, item)] }],
    steps: [],
    metadata: {
      servings: 2,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Recipe;
}

/** A takeaway: a planner slot with nothing to buy. */
function specialRecipe(id: string, title: string): Recipe {
  return {
    ...shoppableRecipe(id, title, ''),
    kind: 'special',
    ingredients: [],
  } as unknown as Recipe;
}

/** The displayed week, with one night carrying the given recipes. */
function weekWithNight(startDate: string, dayKey: string, recipeIds: string[]): MealPlanWeek {
  const days: Record<string, Day> = {};
  for (let i = 0; i < 7; i++) {
    const date = new Date(`${startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + i);
    const key = date.toISOString().slice(0, 10);
    days[key] = {
      note: '',
      recipeIds: key === dayKey ? recipeIds : [],
      chefs: [],
      attendees: [],
      guests: 0,
    };
  }
  return {
    id: startDate,
    schemaVersion: 1,
    startDate,
    days,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test.describe('meal planner — shop the week (#724)', () => {
  test('picks the week’s nights and reviews each recipe in turn', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/');

    // ── Bootstrap: a default shopping list to write to ───────────────────────
    // Without one the cart toasts and opens nothing, which is its own assertion
    // further down — but the flow under test needs a real list.
    await page.goto('/#/shopping');
    await expect(page).toHaveURL(/#\/shopping\/new/, { timeout: 10_000 });
    await page.getByTestId('shopping-create-list-name').fill('Weekly shop');
    await page.getByRole('button', { name: /create/i }).click();
    await expect(page).toHaveURL(/#\/shopping\/[0-9a-f-]{36}$/, { timeout: SYNC_TIMEOUT });

    // Creating a list also writes the lists CONFIG, and only the config makes it
    // the default. That write lands in the same instant as the app's own
    // listeners are attaching, and the emulator's forced long-polling transport
    // drops updates delivered in that window (the hazard `waitForCanonReady`
    // exists for) — observed here as a config doc present in Firestore and a
    // `defaultListId` still null in the store fifteen seconds later. A
    // listener's FIRST snapshot is not subject to it, so the page is reloaded
    // and the default is read off a fresh subscription. This is bootstrap, not
    // the thing under test: what is being proved below starts at the cart.
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__e2e?.getDefaultListId() ?? null), {
        timeout: SYNC_TIMEOUT,
      })
      .not.toBeNull();

    await page.goto('/#/mealplan');
    await expect(page.getByTestId('this-week')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('this-week').click();
    await expect(page.getByTestId('week-range')).not.toHaveText('', { timeout: SYNC_TIMEOUT });

    // ── A night with two dinners and a takeaway ──────────────────────────────
    await seedRecipe(page, shoppableRecipe('e2e-shop-a', 'Aubergine bake', '1 aubergine'));
    await seedRecipe(page, shoppableRecipe('e2e-shop-b', 'Chorizo stew', '200g chorizo'));
    await seedRecipe(page, specialRecipe('e2e-shop-out', 'Takeaway — Thai'));

    const startDate = await readStartDate(page);
    const dayKey = await readAnchorDayKey(page);
    await seedMealPlanWeek(
      page,
      weekWithNight(startDate, dayKey, ['e2e-shop-a', 'e2e-shop-b', 'e2e-shop-out']),
    );
    await expect
      .poll(() => readDayRecipeIds(page, dayKey), { timeout: SYNC_TIMEOUT })
      .toHaveLength(3);

    // ── Pick the nights ──────────────────────────────────────────────────────
    await page.getByTestId('shop-week-trigger').click();
    await expect(page.getByTestId('shop-week-list')).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Both dinners are offered, ticked; the takeaway has nothing to buy and is
    // simply not there.
    await expect(page.getByTestId(`shop-week-row-${dayKey}-e2e-shop-a`)).toBeVisible();
    await expect(page.getByTestId(`shop-week-row-${dayKey}-e2e-shop-b`)).toBeVisible();
    await expect(page.getByTestId(`shop-week-row-${dayKey}-e2e-shop-out`)).toHaveCount(0);
    await expect(page.getByTestId('shop-week-confirm')).toHaveText(/Review 2 recipes/);

    await page.getByTestId('shop-week-confirm').click();
    // The selection sheet is gone before the review opens — the two never stack.
    await expect(page.getByTestId('shop-week-list')).toHaveCount(0, { timeout: SYNC_TIMEOUT });

    // ── Review each in turn ──────────────────────────────────────────────────
    // Identified by their ingredients rather than by a title or a toast: what
    // each sheet is FOR is the thing under test, and the wording around it is
    // free to change.
    const review = page.getByTestId('recipe-add-review-list');
    await expect(review).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(review).toContainText('aubergine');
    await page.getByTestId('recipe-add-to-list-confirm').click();

    // The next recipe's sheet opens in its place.
    await expect(review).toContainText('chorizo', { timeout: SYNC_TIMEOUT });
    await page.getByTestId('recipe-add-to-list-confirm').click();

    // Nothing is left open once the last one is done.
    await expect(review).toHaveCount(0, { timeout: SYNC_TIMEOUT });

    // ── Both recipes' ingredients are on the shared list, attributed ─────────
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__e2e!.getShoppingListItems()))
            .flatMap((item) => item.sources)
            .filter((source) => source.kind === 'recipe')
            .map((source) => source.recipeId)
            .sort(),
        { timeout: SYNC_TIMEOUT },
      )
      .toEqual(['e2e-shop-a', 'e2e-shop-b']);

    await page.goto('/#/shopping');
    await expect(page.getByTestId('shopping-list-page')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByText('aubergine')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByText('chorizo')).toBeVisible({ timeout: SYNC_TIMEOUT });
  });
});
