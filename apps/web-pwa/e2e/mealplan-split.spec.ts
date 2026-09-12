/**
 * The planner side by side (#663, Phase 2).
 *
 * On a screen with room for it the week and the open day sit next to each other:
 * the run of dated day cards on the left at exactly the size a phone gives them,
 * and the day you are looking at docked on the right. The target is a Pixel 9 Pro
 * Fold, unfolded.
 *
 * Everything here needs a browser doing real layout, which is why none of it can
 * live in the unit suite: jsdom reports `matches: false` for every media query, so
 * `MealPlanWeekPage.test.ts` only ever exercises the phone path — which is exactly
 * what we want it to keep doing.
 *
 * The two facts worth pinning are:
 *
 *   1. It is a PANE, not a dialog. No `role="dialog"` is on the page at all: the
 *      bottom sheet is suppressed rather than painted over, because a modal
 *      dialog's scrim, focus trap and scroll lock are real whether or not you can
 *      see them (issue #641). Tapping another day swaps the pane and the week does
 *      not move — which is the whole point of docking it beside the week rather
 *      than sliding it over.
 *
 *   2. The two columns are EQUAL. The device reports one viewport segment, so
 *      nothing can be aligned to the crease directly; the gutter stays over it only
 *      because the two halves are the same width. A pane carrying its own border
 *      and padding as a flex child would be exactly that much wider than the week
 *      beside it (flex distributes free space to CONTENT boxes) and the gutter
 *      would drift off the fold, which is why the equality is asserted to a pixel.
 */
import type { Page } from '@playwright/test';
import type { Day, MealPlanWeek } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedFirstDayOfWeek, seedMealPlanWeek } from './helpers/seed';
import { HYDRATE_TIMEOUT, SYNC_TIMEOUT } from './helpers/timeouts';

// The fold, unfolded — its USABLE FRAME INSIDE A BROWSER TAB, measured on the real
// device. The screen is 755 x 783; browser chrome takes ~200px of the height, and
// Playwright's viewport is the frame, not the screen. It clears the layout's 480px
// height floor with room to spare, and its width is four pixels under Tailwind's
// `md` — which is why the gate is a named `split` variant and not `md:`.
const VIEWPORT = { width: 755, height: 587 };

// The gutter between the two columns (`split:gap-10`), which is what sits over the
// crease. Settled, and measured on the device.
const GUTTER_PX = 40;

// Slack for sub-pixel layout. Deliberately tight: "equal halves" is the mechanism
// keeping the gutter on the fold, so a couple of pixels of drift is a real defect
// here rather than rounding.
const EPSILON = 1;

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

/** The day written out, exactly as the page formats it (UTC, en-GB). */
function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

// Seven planned days, each named for its position, so "which day is the pane
// showing" is answerable from one field rather than from a date format.
function weekOf(startDate: string): MealPlanWeek {
  const days: Record<string, Day> = {};
  for (let i = 0; i < 7; i++) {
    days[addDays(startDate, i)] = {
      note: `Dinner ${i + 1}`,
      recipeIds: [],
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
 * Wait until the planner is showing the seeded week — `firstDayOfWeek` arrives on
 * its own Firestore snapshot, and until it lands the page is showing a different
 * seven days under the app's default. Same reasoning (and the same bridge read) as
 * `mealplan-deck.spec.ts`.
 */
async function weekOnScreen(page: Page, startDate: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__e2e!.getMealPlanSnapshot().startDate), {
      timeout: SYNC_TIMEOUT,
    })
    .toBe(startDate);
  await expect(page.getByTestId(`day-${startDate}-row`)).toBeAttached({ timeout: SYNC_TIMEOUT });
}

async function readDayNote(page: Page, dayKey: string): Promise<string | undefined> {
  return page.evaluate((key) => window.__e2e!.getMealPlanSnapshot().days[key]?.note, dayKey);
}

/**
 * Write out the planner's debounced edits and wait for Firestore to ack them.
 *
 * A settling step through the `window.__e2e` bridge, which is the sanctioned shape
 * (`docs/e2e-test-spec.md` NF-A1/NF-C4) — and emphatically not a sleep in disguise.
 * A typed note coalesces its `setDoc` behind a 400 ms debounce (issue #940), and
 * `page.fill()` never blurs the field, so the component's own blur flush never runs.
 * Under emulators the client runs WITHOUT `persistentLocalCache` (`src/lib/firebase.ts`),
 * so a write that has not been issued is not queued anywhere a reload could replay
 * it — it is simply lost, which is what made the assertion below flake (issue #1085).
 *
 * That gap is now closed at the coalescer (issue #1304). It used to end here: if the
 * 400 ms window elapsed before this ran, the write had left the coalescer and was in
 * flight, and the flush found nothing to do — narrow, needing two CDP round trips to
 * overtake a 400 ms timer, but not zero. `writeCoalescer`'s `flushAll` now waits for
 * writes already on the wire as well as queued ones, so this resolves on the ack
 * either way. Kept as a record so a recurrence is recognised rather than
 * re-investigated.
 */
async function settlePlannerWrites(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e!.flushMealPlanWrites());
}

/** A day row's top edge in page coordinates — how "the week did not move" is read. */
async function rowTop(page: Page, date: string): Promise<number> {
  const box = await page.getByTestId(`day-${date}-row`).boundingBox();
  if (!box) throw new Error(`no box for day-${date}-row`);
  return box.y;
}

test.describe('meal planner — the week and the day, side by side', () => {
  test.use({ viewport: VIEWPORT });

  test('the day docks beside the week, swaps on a tap, and the two columns are equal halves', async ({
    page,
  }, testInfo) => {
    // Sign-in, two document round-trips and a reload: the same budget the planner
    // spec runs on, not the 60s single-tab create tier (NF-F2).
    test.setTimeout(90_000);

    const today = new Date().toLocaleDateString('en-CA');
    const startDate = today;
    const tomorrow = addDays(today, 1);

    // Today at index 0 of the cycle: the deck then opens at the very top of the
    // week with tomorrow's row directly beneath today's, which is what makes the
    // "tap another day" step a real tap rather than a scripted scroll. Index 0 is
    // also outside the window that appends next week, so the run of days is
    // exactly seven. Seeded before the app boots — see `seedFirstDayOfWeek`.
    await seedFirstDayOfWeek(firstDayPutting(today, 0));

    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/');
    await page.goto('/#/mealplan');
    await expect(page.getByTestId('week-deck')).toBeVisible({ timeout: HYDRATE_TIMEOUT });

    await seedMealPlanWeek(page, weekOf(startDate));
    await weekOnScreen(page, startDate);

    // ── The pane is there, and it is not a dialog ────────────────────────────
    const pane = page.getByTestId('day-pane');
    await expect(pane).toBeVisible({ timeout: SYNC_TIMEOUT });
    // The whole page, not just the pane: the sheet is SUPPRESSED at this size, so
    // there is no dialog anywhere — no scrim, no focus trap, no scroll lock.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // ── It opened on today, without a tap ────────────────────────────────────
    await expect(page.getByTestId('day-pane-note')).toHaveValue('Dinner 1', {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId(`day-${today}-row`)).toHaveAttribute('data-selected', 'true');
    // …and it says which day it is, in the same words the sheet's title used.
    await expect(page.getByTestId('day-pane-title')).toHaveText(longDate(today));

    // ── The navigation is unchanged at this size ─────────────────────────────
    // The split seam (700px) and the nav seam (1024px) are deliberately different
    // numbers: the fold keeps its bottom bar AND gets two panes. Both navs carry
    // the same accessible name, so the visible one is the assertion — and it is
    // the BOTTOM one, which is what its position proves.
    const visibleNav = page.getByRole('navigation', { name: 'Main navigation' }).filter({
      visible: true,
    });
    await expect(visibleNav).toHaveCount(1);
    const navBox = await visibleNav.boundingBox();
    expect(navBox).not.toBeNull();
    expect(Math.abs(navBox!.y + navBox!.height - VIEWPORT.height)).toBeLessThanOrEqual(EPSILON);

    // ── Equal halves, with the gutter between them ───────────────────────────
    // This is what keeps the gap over the crease: the device reports one viewport
    // segment, so nothing is aligned to the fold directly — the two columns simply
    // are the same width, centred, with the settled 40px between them.
    const weekBox = await page.getByTestId('week-column').boundingBox();
    const paneBox = await pane.boundingBox();
    expect(weekBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    expect(Math.abs(weekBox!.width - paneBox!.width)).toBeLessThanOrEqual(EPSILON);
    expect(Math.abs(paneBox!.x - (weekBox!.x + weekBox!.width) - GUTTER_PX)).toBeLessThanOrEqual(
      EPSILON,
    );
    // …and the pair is centred, so the space each side is even.
    expect(
      Math.abs(weekBox!.x - (VIEWPORT.width - (paneBox!.x + paneBox!.width))),
    ).toBeLessThanOrEqual(EPSILON);

    // ── Tapping another day swaps the pane, and the week does not move ───────
    const todayTopBefore = await rowTop(page, today);
    await page.getByTestId(`day-${tomorrow}-summary`).click();
    await expect(page.getByTestId('day-pane-note')).toHaveValue('Dinner 2', {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId(`day-${tomorrow}-row`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId(`day-${today}-row`)).not.toHaveAttribute('data-selected', 'true');
    // Still no dialog: a tap on a row is a selection here, never an opening.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(Math.abs((await rowTop(page, today)) - todayTopBefore)).toBeLessThanOrEqual(EPSILON);

    // ── An edit made in the pane is an edit to the day it is showing ─────────
    // Bound to the SELECTED day, not to today: the pane is showing tomorrow.
    const meal = `Pane-edited dinner ${testInfo.testId}`;
    await page.getByTestId('day-pane-note').fill(meal);
    await expect.poll(() => readDayNote(page, tomorrow), { timeout: SYNC_TIMEOUT }).toBe(meal);
    expect(await readDayNote(page, today)).toBe('Dinner 1');

    // ── …and it round-trips through Firestore ────────────────────────────────
    // The poll above proves the OPTIMISTIC APPLY and nothing more, so settle the
    // coalesced write before reloading or the reload races it (issue #1085).
    await settlePlannerWrites(page);
    // Reload rather than re-navigating: `/#/mealplan` is the URL we are already on,
    // so `goto` would be a same-document hash navigation and remount nothing.
    await page.reload();
    await weekOnScreen(page, startDate);
    // The pane comes back on TODAY — a cold load seeds it the same way the deck
    // anchors itself — so the edited day is one tap away, and holds what we wrote.
    await expect(page.getByTestId('day-pane-note')).toHaveValue('Dinner 1', {
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId(`day-${tomorrow}-summary`).click();
    await expect(page.getByTestId('day-pane-note')).toHaveValue(meal, { timeout: SYNC_TIMEOUT });
  });
});
