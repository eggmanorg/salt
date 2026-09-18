/**
 * Cook mode E2E (issue #556, Phase 5) — the whole cook against real Firestore,
 * real security rules, and a real layout engine.
 *
 * What lives HERE because nowhere else can reach it:
 * - **Which step the footer acts on once the deck has actually moved.** The
 *   footer's target comes from a geometric probe (`probeVisibleStep`), so in
 *   jsdom it never resolves and the footer silently falls back to "first
 *   incomplete" — a fallback that happens to give the right answer whether or
 *   not the deck moved. Only a real engine can tell the two apart.
 * - **The first-use chip cap.** `expandChip` decides by measuring
 *   `scrollWidth > clientWidth`; without layout that is never true, so every
 *   jsdom tap returns early and the expand/collapse behaviour is unreachable.
 * - **Resume across a real reload** — session doc + mise ticks rehydrated from
 *   Firestore through the real adapter, not a mocked store.
 *
 * - **The timer sheet against a real dialog and a real session document**
 *   (#748). The sheet portals OUT of cook mode's full-viewport container, and a
 *   timer's whole point is that its end time survives the round-trip — neither
 *   is observable in jsdom, where there is no portal stacking and no Firestore.
 *   The plain start-in-one-tap path stays with the unit tests.
 *
 * Deliberately NOT here (Phase 2–4 cover them in milliseconds): the timer
 * countdown/fire/dismiss states, the recipe-changed banner, restart, the
 * deleted-recipe orphan path, and the fling-landing decision — that last one is pure arithmetic in `$lib/cookDeck`
 * and is unit tested, whereas synthesised pointer physics in CI is flake rather
 * than signal. The deck is therefore driven by the footer and the keyboard.
 */
import type { Locator, Page } from '@playwright/test';
import type { Recipe } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import {
  getShoppingListItems,
  seedAisles,
  seedCanonItem,
  seedRecipe,
  seedShoppingListBeforeBoot,
} from './helpers/seed';
import { HYDRATE_TIMEOUT, SYNC_TIMEOUT, TRIGGER_TIMEOUT } from './helpers/timeouts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RECIPE_ID = 'e2e-cook-recipe';
const SEED_TIME = '2026-01-01T00:00:00.000Z'; // persistRecipe re-stamps updatedAt

interface StepSpec {
  readonly id: string;
  readonly text: string;
  /** The author's aside for this step. Omitted → `note: null`, no callout. */
  readonly note?: string;
  /** The step's own timer. Omitted → `timer: null`, no timer control at all. */
  readonly timer?: { readonly durationMinutes: number; readonly description: string | null };
}

interface IngredientSpec {
  readonly rawText: string;
  /** The step this ingredient is first needed in — what drives the chip row. */
  readonly step: string;
  /**
   * The parsed name, when the test needs the line's WORDING and its ITEM to
   * differ (the long-press add takes the item; `IngredientText` renders the
   * whole measured line). Omitted → `parsed: null`, the verbatim rendering the
   * layout tests below depend on.
   */
  readonly item?: string;
  /** Parsed preparation clauses, appended after the item by `IngredientText`.
   *  Only meaningful alongside `item`. */
  readonly preparation?: readonly string[];
}

/**
 * A whole recipe document, shaped for cook mode. `parsed: null` on every
 * ingredient makes `IngredientText` render `rawText` verbatim, so a chip's
 * on-screen width is a direct function of the seeded string — which is what the
 * layout assertions below depend on.
 */
function buildRecipe(steps: readonly StepSpec[], ingredients: readonly IngredientSpec[]): Recipe {
  return {
    cureCategory: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Emulator Ragù',
    description: null,
    ingredients: [
      {
        id: 'group-1',
        name: null,
        items: ingredients.map((ing, index) => ({
          id: `ing-${index + 1}`,
          rawText: ing.rawText,
          parsed: ing.item
            ? {
                quantity: { type: 'single' as const, value: 400 },
                unit: 'g' as const,
                item: ing.item,
                preparation: [...(ing.preparation ?? [])],
                notes: null,
                displayText: null,
              }
            : null,
          canonId: null,
          matchState: 'pending' as const,
          isOptional: false,
          firstUsedInStepId: ing.step,
        })),
      },
    ],
    steps: steps.map((s) => ({
      id: s.id,
      text: s.text,
      timer: s.timer ? { ...s.timer } : null,
      note: s.note ?? null,
    })),
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

const JOURNEY_STEP_COUNT = 4;
const JOURNEY_INGREDIENT_COUNT = 7;

function journeyRecipe(): Recipe {
  return buildRecipe(
    [
      { id: 'step-1', text: 'Warm the oil in a heavy pan over a low flame.' },
      { id: 'step-2', text: 'Soften the onion, carrot and celery for ten minutes.' },
      { id: 'step-3', text: 'Add the tomatoes and simmer until the sauce turns glossy.' },
      { id: 'step-4', text: 'Season, then fold the drained pasta through the sauce.' },
    ],
    [
      { rawText: '3 tbsp olive oil', step: 'step-1' },
      { rawText: '1 onion, finely diced', step: 'step-2' },
      { rawText: '1 carrot, finely diced', step: 'step-2' },
      { rawText: '2 sticks celery, finely diced', step: 'step-2' },
      { rawText: '400g tinned plum tomatoes', step: 'step-3' },
      { rawText: 'Sea salt', step: 'step-4' },
      { rawText: '500g rigatoni', step: 'step-4' },
    ],
  );
}

// A note on step 1 and none on step 2, so "exactly one callout in the deck" is
// itself the assertion that a step without a note stays as it was.
const NOTE_STEP_ONE_TEXT = 'Soften the garlic in the oil over a low flame.';
const NOTE_FIRST_LINE = 'Do not let the garlic brown.';

function noteRecipe(): Recipe {
  return buildRecipe(
    [
      {
        id: 'step-1',
        text: NOTE_STEP_ONE_TEXT,
        note: `${NOTE_FIRST_LINE}\nIt turns bitter fast.`,
      },
      { id: 'step-2', text: 'Add the tomatoes and simmer until glossy.' },
    ],
    [
      { rawText: '2 cloves garlic', step: 'step-1' },
      { rawText: '400g tinned plum tomatoes', step: 'step-2' },
    ],
  );
}

// Two deliberately long lines plus three short ones, ALL first used in step 1 —
// so exactly one chip row exists in the deck and it can be addressed without a
// structural locator. The long pair is what proves the cap; the short ones are
// what prove a chip that already reads in full is inert.
const LONG_TOMATOES = '400g tinned plum tomatoes, drained and roughly chopped';
const LONG_OIL = '3 tbsp extra-virgin olive oil, plus more for drizzling';
const CHIP_STEP_ONE_TEXT = 'Warm the oil, then add everything else to the pan.';

function chipRecipe(): Recipe {
  return buildRecipe(
    [
      { id: 'step-1', text: CHIP_STEP_ONE_TEXT },
      { id: 'step-2', text: 'Simmer for an hour, stirring now and then.' },
      { id: 'step-3', text: 'Check the seasoning and serve.' },
    ],
    [
      { rawText: LONG_TOMATOES, step: 'step-1' },
      { rawText: LONG_OIL, step: 'step-1' },
      { rawText: 'Sea salt', step: 'step-1' },
      { rawText: 'Black pepper', step: 'step-1' },
      { rawText: '1 lemon', step: 'step-1' },
    ],
  );
}

// The timer fixture (issue #748). The timer sits on step 1 — the step the deck
// opens on — so its controls are reachable without moving the deck at all, and the
// spec's timer coverage never depends on the gesture layer.
const TIMER_STEP_LABEL = 'Simmer the sauce';
const TIMER_STEP_MINUTES = 20;
const AD_HOC_TIMER_NAME = 'Rice';

function timerRecipe(): Recipe {
  return buildRecipe(
    [
      {
        id: 'step-1',
        text: 'Simmer the sauce until it turns glossy.',
        timer: { durationMinutes: TIMER_STEP_MINUTES, description: TIMER_STEP_LABEL },
      },
      { id: 'step-2', text: 'Season, then fold the pasta through.' },
    ],
    [
      { rawText: '400g tinned plum tomatoes', step: 'step-1' },
      { rawText: 'Sea salt', step: 'step-2' },
    ],
  );
}

// The long-press fixture (issue #714). The line the cook reads and the name that
// goes on the list are deliberately different strings — that difference IS the
// assertion. Two words, so the entry parser leaves it whole: `looksCompound` is
// three-or-more, and below it the trigger never reaches the AI entry parse, and
// `cleanName === rawText` so it never rewrites the row's text either.
const SHOP_ITEM = 'plum tomatoes';
const SHOP_LINE_RENDERED = `400g ${SHOP_ITEM}`;
const SHOP_LIST_NAME = 'Weekly shop';
const SHOP_STEP_ONE_TEXT = 'Warm the oil in a heavy pan over a low flame.';

function shoppingRecipe(): Recipe {
  return buildRecipe(
    [
      { id: 'step-1', text: SHOP_STEP_ONE_TEXT },
      { id: 'step-2', text: 'Simmer until the sauce turns glossy.' },
    ],
    [
      {
        rawText: '400g tinned plum tomatoes, drained and roughly chopped',
        step: 'step-1',
        item: SHOP_ITEM,
        // Long enough that the chip is clipped by its half-row cap, so the
        // expand/collapse the hold must NOT trigger is actually reachable.
        preparation: ['drained and roughly chopped', 'then set aside to warm through'],
      },
      { rawText: 'Sea salt', step: 'step-2' },
    ],
  );
}

// ─── Shared arrival ───────────────────────────────────────────────────────────

// Since the list and its config are seeded before boot
// (`seedShoppingListBeforeBoot`, NF-C4), this is only a settle gate on the
// config listener's FIRST snapshot — a wait that always terminates — rather
// than the old bet on a post-attach update the emulator transport could drop
// for good. The default id is what the hold's add resolves against, and it
// arrives on the config listener rather than with any navigation (NF-A3).
// `SYNC_TIMEOUT` names that path — a single-tab store settle — instead of
// silently inheriting playwright.config.ts's 10s `expect` default (NF-A5).
async function awaitDefaultList(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__e2e!.getDefaultListId() ?? null), {
      timeout: SYNC_TIMEOUT,
    })
    .not.toBeNull();
}

/** Sign in, seed the recipe, and enter cook mode the way a cook does — from the
 *  recipe view's Cook button. */
async function startCook(
  page: Page,
  email: string,
  recipe: Recipe,
  opts: { readonly shoppingList?: string } = {},
): Promise<void> {
  // The deck settles with an UNDER-DAMPED spring: it overshoots its target by
  // ~10% and pulls back, and the footer re-probes which step is on top for every
  // frame of that. A web-first assertion can therefore go green on an overshoot
  // frame, and the very next click would tick the step the deck was passing
  // through rather than the one it came to rest on. Under reduced motion
  // `animateDeckTo` assigns the target offset directly — no frames, no
  // overshoot, exactly one settled state per move. A real user setting, and it
  // makes every deck move deterministic without a single sleep (NF-A1).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The default shopping list is seeded BEFORE the app boots, so it is in the
  // config listener's first snapshot (NF-C4) — the helper takes no Page, and
  // that is what enforces the ordering. The seeded name is the one the add
  // toast quotes.
  if (opts.shoppingList) await seedShoppingListBeforeBoot(opts.shoppingList);
  await gotoAndSignIn(page, email, '/');
  if (opts.shoppingList) await awaitDefaultList(page);
  await seedRecipe(page, recipe);
  await page.goto(`/#/recipes/${recipe.id}`);
  await page.getByTestId('recipe-cook-button').click();
  await expect(page).toHaveURL(new RegExp(`#/recipes/${recipe.id}/cook$`));
  await expect(page.getByTestId('cook-mode-page')).toBeVisible({ timeout: SYNC_TIMEOUT });
}

/**
 * Press and hold over `target` until the add lands, then let go.
 *
 * The hold's DURATION is the input here, so there is nothing to sleep for: the
 * success toast is the signal that the action fired, and waiting on it while the
 * button is still down is both the gesture and the settle (NF-A1/NF-A3). Driven
 * with the mouse rather than a tap because the action is pointer-agnostic by
 * design, and because this spec runs under `reducedMotion: 'reduce'` — where the
 * shopping row's touch-only swipe would be inert, this must not be.
 */
async function holdAndAwaitToast(page: Page, target: Locator): Promise<void> {
  const toast = page.getByText(`Added ${SHOP_ITEM} to ${SHOP_LIST_NAME}`);
  // A toast left over from an earlier hold would satisfy the wait below
  // instantly and release the button before the hold ever elapsed.
  await expect(toast).toHaveCount(0);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    await expect(toast).toBeVisible({ timeout: SYNC_TIMEOUT });
  } finally {
    await page.mouse.up();
  }
}

/** The timeline segment for a step, addressed by its accessible name. The name
 *  gains ", done" the moment the step is ticked, so the locator itself is the
 *  completion assertion. */
function timelineStep(page: Page, n: number, done = false): Locator {
  return page.getByRole('button', {
    name: `Step ${n} of ${JOURNEY_STEP_COUNT}${done ? ', done' : ''}`,
    exact: true,
  });
}

/** The step the footer is acting on: exactly the one the timeline marks current. */
async function expectFooterOnStep(page: Page, n: number, done = false): Promise<void> {
  await expect(timelineStep(page, n, done)).toHaveAttribute('aria-current', 'step');
}

/** The mise-en-place counter in the header, live only on the mise stage. */
function miseCounter(page: Page): Locator {
  return page.getByText(/Mise en place ·/);
}

// ─── The cook ─────────────────────────────────────────────────────────────────

test.describe('cook mode', () => {
  test('a cook resumes on the step it left off at after a reload, and finishing clears it', async ({
    page,
  }, testInfo) => {
    // Single tab, no AI, no CF trigger — but one full reload + Firestore
    // rehydrate, which is the slowest leg here (NF-F2).
    test.setTimeout(90_000);
    await startCook(page, uniqueEmail(testInfo.testId), journeyRecipe());

    // ── Stage 1: mise en place ────────────────────────────────────────────────
    const miseRows = page.getByTestId('cook-mise-row');
    await expect(miseRows).toHaveCount(JOURNEY_INGREDIENT_COUNT);
    await expect(miseCounter(page)).toHaveText(/0\/7 ready/);

    const oliveOil = miseRows.filter({ hasText: '3 tbsp olive oil' });
    await oliveOil.click();
    await expect(oliveOil).toHaveAttribute('aria-pressed', 'true');
    await expect(miseCounter(page)).toHaveText(/1\/7 ready/, { timeout: SYNC_TIMEOUT });

    await page.getByTestId('cook-mise-check-all').click();
    await expect(miseCounter(page)).toHaveText(/7\/7 ready/, { timeout: SYNC_TIMEOUT });

    // ── Stage 2: guided steps ─────────────────────────────────────────────────
    await page.getByTestId('cook-stage-toggle').click();
    const deck = page.getByTestId('cook-steps-view');
    await expect(deck).toBeVisible();
    await expectFooterOnStep(page, 1);

    // The footer ticks the step you're on and brings the next outstanding one up.
    await page.getByTestId('cook-step-done').click();
    await expectFooterOnStep(page, 2);
    await expect(timelineStep(page, 1, true)).toBeVisible();

    // ── The footer follows the DECK, not the completion list ──────────────────
    // Paging with the keyboard moves the deck without ticking anything, so the
    // footer's target and "first incomplete" diverge — the one state jsdom can
    // never produce, because with no geometry the probe never resolves.
    await deck.press('ArrowDown');
    await expectFooterOnStep(page, 3);
    await expect(timelineStep(page, 2)).toBeVisible(); // paging past it did not tick it
    await deck.press('ArrowUp');
    await expectFooterOnStep(page, 2);

    await page.getByTestId('cook-step-done').click();
    await expectFooterOnStep(page, 3);

    // ── Reload mid-cook ───────────────────────────────────────────────────────
    await page.reload();
    // Straight back into the steps stage rather than mise: the session carries
    // step progress, so reopening a half-cooked recipe resumes it.
    await expect(page.getByTestId('cook-steps-view')).toBeVisible({ timeout: HYDRATE_TIMEOUT });
    await expectFooterOnStep(page, 3);
    await expect(timelineStep(page, 1, true)).toBeVisible();
    await expect(timelineStep(page, 2, true)).toBeVisible();

    // The mise ticks came back too, and the entry label reads the cook back:
    // this is a return to a cook already under way, not a fresh start.
    await page.getByTestId('cook-stage-back').click();
    await expect(miseCounter(page)).toHaveText(/7\/7 ready/);
    await expect(page.getByTestId('cook-stage-toggle')).toHaveText(/Continue cooking/);
    await page.getByTestId('cook-stage-toggle').click();
    await expectFooterOnStep(page, 3);

    // ── Scrolling back onto a done step offers Resume, never Done ─────────────
    await deck.press('ArrowUp');
    await expectFooterOnStep(page, 2, true);
    const resume = page.getByTestId('cook-step-resume');
    await expect(resume).toHaveText(/Resume · step 3/);
    await resume.click();
    await expectFooterOnStep(page, 3);

    // ── Finish ────────────────────────────────────────────────────────────────
    await page.getByTestId('cook-step-done').click();
    await expectFooterOnStep(page, 4);
    await page.getByTestId('cook-step-done').click();
    const finish = page.getByTestId('cook-mode-complete');
    await expect(finish).toBeVisible();
    await finish.click();
    await expect(page).toHaveURL(new RegExp(`#/recipes/${RECIPE_ID}$`), { timeout: SYNC_TIMEOUT });

    // Finishing DELETED the session doc — re-entering starts a clean cook.
    await page.getByTestId('recipe-cook-button').click();
    await expect(miseCounter(page)).toHaveText(/0\/7 ready/, { timeout: SYNC_TIMEOUT });
  });

  // ─── Step notes ─────────────────────────────────────────────────────────────

  // Issue #736. The note was a grey paragraph dimmer than the instruction above
  // it — at arm's length it read as a second sentence of the step. What is worth
  // asserting in a real browser (over the component test) is that the callout is
  // actually painted and actually sits between the instruction and the chips.
  test('a step note is painted as a callout between the instruction and the chips', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000); // single tab, no reload
    await startCook(page, uniqueEmail(testInfo.testId), noteRecipe());
    await page.getByTestId('cook-stage-toggle').click();

    const note = page.getByTestId('cook-step-note');
    await expect(note).toHaveCount(1); // step 2 has none
    await expect(note).toContainText(NOTE_FIRST_LINE);

    // The fill is really painted, not merely classed — a note that renders
    // transparent is the exact failure this change exists to prevent.
    await expect(async () => {
      const bg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      expect(bg).not.toBe('transparent');
    }).toPass({ timeout: SYNC_TIMEOUT });

    // Order on the page: instruction, then note, then the chip row.
    await expect(async () => {
      const instruction = (await page.getByText(NOTE_STEP_ONE_TEXT).boundingBox())!;
      const noteBox = (await note.boundingBox())!;
      const chips = (await page.getByTestId('cook-step-firstuse').first().boundingBox())!;
      expect(noteBox.y).toBeGreaterThan(instruction.y);
      expect(chips.y).toBeGreaterThan(noteBox.y);
      // The words did not shrink: the note reads at cook-mode size, not the
      // recipe page's caption size.
      const size = await note
        .locator('span')
        .last()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(18);
    }).toPass({ timeout: SYNC_TIMEOUT });
  });

  // ─── Timers you can change (issue #748) ─────────────────────────────────────

  test('a timer can be re-timed before it starts, set from scratch, and moved while it runs', async ({
    page,
  }, testInfo) => {
    // Single tab, no reload, no CF trigger — but three round-trips through the
    // session document, each of which has to land before the next assertion
    // (NF-F2).
    test.setTimeout(90_000);
    await startCook(page, uniqueEmail(testInfo.testId), timerRecipe());

    // The sheet's two fields, addressed by their accessible names (NF-B1). Both
    // are re-resolved on every use because the sheet is torn down between opens.
    const nameField = page.getByRole('textbox', { name: 'Timer name' });
    const minutesField = page.getByRole('textbox', { name: 'Minutes' });
    const chips = page.getByTestId('cook-timer-chip');

    // ── The step's own timer, adjusted before it starts ───────────────────────
    await page.getByTestId('cook-stage-toggle').click();
    await expect(page.getByTestId('cook-steps-view')).toBeVisible();

    await page.getByRole('button', { name: 'Adjust this timer' }).click();
    await expect(nameField).toHaveValue(TIMER_STEP_LABEL);
    await expect(minutesField).toHaveValue(String(TIMER_STEP_MINUTES));

    // The chips move by a minute below the half-hour and by five at it — and a
    // typed number is never snapped onto a grid on the way past.
    await page.getByRole('button', { name: 'Decrease minutes' }).click();
    await expect(minutesField).toHaveValue('19');
    await minutesField.fill('30');
    await page.getByRole('button', { name: 'Increase minutes' }).click();
    await expect(minutesField).toHaveValue('35');

    await minutesField.fill('3');
    await page.getByRole('button', { name: 'Start timer' }).click();

    // The countdown is the one the cook chose, not the recipe's twenty. The
    // window allows for the write landing anywhere inside SYNC_TIMEOUT (NF-A5).
    await expect(chips).toHaveCount(1);
    // A minute-wide window, not a ten-second one: the only thing under test is
    // that it is the THREE minutes chosen and not the recipe's twenty, and a
    // tighter band would tick past itself on a slow emulator round-trip.
    await expect(page.getByTestId('cook-timer-chip-time')).toHaveText(/^(2:\d\d|3:00)$/, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(chips).toContainText(TIMER_STEP_LABEL);

    // ── A timer for something the recipe never mentioned ──────────────────────
    await page.getByRole('button', { name: 'Start a timer' }).click();
    await expect(nameField).toHaveValue('Salt Timer');
    await expect(minutesField).toHaveValue('10');
    await nameField.fill(AD_HOC_TIMER_NAME);
    await minutesField.fill('2');
    await page.getByRole('button', { name: 'Start timer' }).click();

    // It joins the bar as an ordinary timer, under the name it was given.
    await expect(chips).toHaveCount(2, { timeout: SYNC_TIMEOUT });
    const adHoc = chips.filter({ hasText: AD_HOC_TIMER_NAME });
    await expect(adHoc.getByTestId('cook-timer-chip-time')).toHaveText(/^(1:\d\d|2:00)$/);

    // ── Moved while it runs ───────────────────────────────────────────────────
    await adHoc.getByTestId('cook-timer-chip-edit').click();
    await expect(nameField).toHaveValue(AD_HOC_TIMER_NAME);
    // Prefilled with what it was SET for, not what is left on it.
    await expect(minutesField).toHaveValue('2');
    await minutesField.fill('25');
    await page.getByRole('button', { name: 'Update timer' }).click();

    await expect(adHoc.getByTestId('cook-timer-chip-time')).toHaveText(/^(24:\d\d|25:00)$/, {
      timeout: SYNC_TIMEOUT,
    });
    // Re-timed, not restarted alongside itself: still one entry per timer.
    await expect(chips).toHaveCount(2);
  });

  // ─── Chip layout ────────────────────────────────────────────────────────────

  test('a first-use chip never exceeds half the step row, so two clipped chips still share one line', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000); // single tab, no reload
    await startCook(page, uniqueEmail(testInfo.testId), chipRecipe());
    await page.getByTestId('cook-stage-toggle').click();

    const row = page.getByTestId('cook-step-firstuse');
    const chips = page.getByTestId('cook-step-firstuse-chip');
    await expect(chips).toHaveCount(5);

    const tomatoes = chips.filter({ hasText: LONG_TOMATOES });
    const oil = chips.filter({ hasText: LONG_OIL });

    // `toPass` IS the settle here (NF-A3): the deck places itself on the first
    // incomplete step a frame after the chips first paint, so a one-shot
    // boundingBox() read could measure a row that is still moving.
    await expect(async () => {
      const rowBox = (await row.boundingBox())!;
      const half = rowBox.width / 2;
      // The cap is `calc(50% - 0.25rem)`: half the row MINUS half the `gap-2`.
      const cap = half - 4;

      for (const chip of await chips.all()) {
        expect((await chip.boundingBox())!.width).toBeLessThanOrEqual(half);
      }

      // Both long chips sit AT the cap rather than merely being narrow —
      // otherwise "two capped chips share a line" would prove nothing.
      const tomatoesBox = (await tomatoes.boundingBox())!;
      const oilBox = (await oil.boundingBox())!;
      expect(Math.abs(tomatoesBox.width - cap)).toBeLessThan(1.5);
      expect(Math.abs(oilBox.width - cap)).toBeLessThan(1.5);

      // Same line, side by side. A flat 50% would put the pair 8px over the row
      // and wrap the second one — which is the whole reason for the -0.25rem.
      expect(Math.abs(oilBox.y - tomatoesBox.y)).toBeLessThan(1);
      expect(oilBox.x).toBeGreaterThan(tomatoesBox.x);
    }).toPass({ timeout: SYNC_TIMEOUT });
  });

  test('tapping a first-use chip expands it only when its text is clipped, and any click elsewhere collapses it', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000); // single tab, no reload
    await startCook(page, uniqueEmail(testInfo.testId), chipRecipe());
    await page.getByTestId('cook-stage-toggle').click();

    const row = page.getByTestId('cook-step-firstuse');
    const chips = page.getByTestId('cook-step-firstuse-chip');
    await expect(chips).toHaveCount(5);

    const tomatoes = chips.filter({ hasText: LONG_TOMATOES });
    const salt = chips.filter({ hasText: 'Sea salt' });
    const half = (await row.boundingBox())!.width / 2;

    // A clipped chip lifts its own cap, and only its own — the row is a flex
    // wrap, so the rest reflow around it.
    await tomatoes.click();
    await expect(tomatoes).toHaveAttribute('data-expanded', 'true');
    expect((await tomatoes.boundingBox())!.width).toBeGreaterThan(half);

    // A click anywhere else puts it back.
    await page.getByText(CHIP_STEP_ONE_TEXT).click();
    await expect(tomatoes).toHaveAttribute('data-expanded', 'false');
    expect((await tomatoes.boundingBox())!.width).toBeLessThanOrEqual(half);

    // A chip that already reads in full has nothing to reveal, so tapping it
    // does nothing at all — it merely lets the window-level collapse run, which
    // closes whatever was open. The collapse of `tomatoes` is the settle that
    // proves the click landed; `salt` staying shut is the assertion.
    await tomatoes.click();
    await expect(tomatoes).toHaveAttribute('data-expanded', 'true');
    await salt.click();
    await expect(tomatoes).toHaveAttribute('data-expanded', 'false');
    await expect(salt).toHaveAttribute('data-expanded', 'false');
  });

  // ─── Ran out of something? Hold it (issue #714) ─────────────────────────────

  test('holding an ingredient puts its NAME on the default list, and Undo takes it back off', async ({
    page,
  }, testInfo) => {
    // Single tab, no reload, but a real canon-match CF trigger round-trip (NF-F2).
    test.setTimeout(90_000);

    await startCook(page, uniqueEmail(testInfo.testId), shoppingRecipe(), {
      shoppingList: SHOP_LIST_NAME,
    });

    // Canon seeded to the exact parsed name, so the match trigger resolves at
    // the deterministic exact-name stage and never reaches an embedding or an
    // arbitration model (NF-E3/NF-E4). The bridge is global, so this seeds
    // perfectly well from inside cook mode — all that matters is that it lands
    // before the write that fires the trigger.
    const [produce] = await seedAisles(page, ['Produce']);
    await seedCanonItem(page, { name: SHOP_ITEM, aisleId: produce!.id });

    // ── Hold a mise row ───────────────────────────────────────────────────────
    const miseRow = page.getByTestId('cook-mise-row').filter({ hasText: SHOP_ITEM });
    await expect(miseRow).toHaveCount(1);
    // The row reads as the measured line; only the NAME may reach the list.
    await expect(miseRow).toContainText(SHOP_LINE_RENDERED);

    await holdAndAwaitToast(page, miseRow);

    // The written document, read from the store rather than the optimistic DOM
    // (NF-E2). Name only: no amount, no unit, and the recipe's wording gone.
    await expect
      .poll(async () => (await getShoppingListItems(page)).map((i) => i.rawText), {
        timeout: SYNC_TIMEOUT,
      })
      .toEqual([SHOP_ITEM]);
    const [added] = await getShoppingListItems(page);
    expect(added!.amount).toBeUndefined();
    expect(added!.unit).toBeUndefined();
    expect(added!.sources).toHaveLength(1);
    expect(added!.sources[0]!.kind).toBe('manual');

    // A hold is not a tap: the mise row must not have ticked itself as well.
    await expect(miseRow).toHaveAttribute('aria-pressed', 'false');

    // ── Undo ──────────────────────────────────────────────────────────────────
    // Straight away, while the toast that offers it is still on screen — it
    // auto-dismisses, so nothing slow may come between the add and this.
    await page.getByRole('button', { name: /undo/i }).click();
    await expect
      .poll(async () => (await getShoppingListItems(page)).length, { timeout: SYNC_TIMEOUT })
      .toBe(0);

    // ── The same gesture, mid-cook, on a step's first-use chip ────────────────
    await page.getByTestId('cook-stage-toggle').click();
    const chip = page.getByTestId('cook-step-firstuse-chip').filter({ hasText: SHOP_ITEM });
    await expect(chip).toHaveCount(1);
    // A tap expands it — which is what makes "the hold did NOT expand it" below a
    // real assertion rather than a vacuous one. A chip whose text already reads in
    // full has nothing to reveal and would report `false` either way.
    await chip.click();
    await expect(chip).toHaveAttribute('data-expanded', 'true');
    await page.getByText(SHOP_STEP_ONE_TEXT).click(); // window-level collapse
    await expect(chip).toHaveAttribute('data-expanded', 'false');

    await holdAndAwaitToast(page, chip);
    await expect
      .poll(async () => (await getShoppingListItems(page)).map((i) => i.rawText), {
        timeout: SYNC_TIMEOUT,
      })
      .toEqual([SHOP_ITEM]);
    await expect(chip).toHaveAttribute('data-expanded', 'false');

    // ── The server files it, exactly as it would a typed entry ────────────────
    // Two words: below `looksCompound`'s three-word threshold, so the trigger
    // never reaches the AI entry parser, and `cleanName === rawText`, so it adds
    // the match without rewriting the row's text out from under the assertion.
    await expect
      .poll(async () => (await getShoppingListItems(page))[0]?.matchState, {
        timeout: TRIGGER_TIMEOUT,
      })
      .toBe('matched');
    expect((await getShoppingListItems(page))[0]!.rawText).toBe(SHOP_ITEM);
  });
});
