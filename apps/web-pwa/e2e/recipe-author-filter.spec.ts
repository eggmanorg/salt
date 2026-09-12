/**
 * Recipe authorship E2E (issue #845, Phase 3).
 *
 * Two things, one shared setup. The two chips on the recipe list — "Added by
 * me" / "Edited by me" — matched against the signed-in member's `Member.name`;
 * and the "Added by" picker, which is how a name the backfill got wrong is put
 * right — on the recipe's own page since issue #1319 Phase 7, not in an editor.
 * Runs against the Firestore + Auth emulators with no AI anywhere on the path.
 *
 * Why this needs TWO browser contexts rather than a hand-shaped fixture: the
 * names under test are not test data, they are STAMPED by the app. Every write
 * goes through `stampRecipeAttribution`, which reads the signed-in member — so a
 * recipe attributed to somebody else can only be produced by somebody else
 * actually writing one, and a second real session is the only way to get a
 * second real name into the library. That is also precisely the production
 * situation the filter exists for: two people, one shared library.
 *
 * Deliberately NOT here (the unit suite covers each in milliseconds): the
 * AND-combination of both chips, the interaction with search and tags, and the
 * blank-name state where nobody is signed in.
 */
import type { Page } from '@playwright/test';
import type { Recipe, RecipeKind } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

const SEED_TIME = '2026-01-01T00:00:00.000Z'; // persistRecipe re-stamps updatedAt

// A bare entry: the filter reads `createdBy` / `lastEditedBy` and nothing else,
// so everything a card can carry beyond its title is left empty on purpose.
// Both attribution fields are blank here — `persistRecipe` stamps them with
// whoever is signed in on the seeding tab, which is the whole point.
function buildRecipe(id: string, title: string, kind: RecipeKind = 'recipe'): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind,
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
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

// The member name the app will stamp: `seedMemberAllowlist` writes the email's
// local part as `Member.name`, and attribution is a snapshot of that name.
function memberName(email: string): string {
  return email.split('@')[0] ?? email;
}

// The signal that the roster has loaded AND the signed-in email matched a member
// on it. `kitchenLabel` reads "<name>'s Kitchen" only once `currentMember`
// resolves, and plain "My Kitchen" until then — so this is the app telling us it
// knows who is at the keyboard. Seeding before that point would write a recipe
// with NO attribution at all (`stampRecipeAttribution` leaves both fields alone
// rather than stamping a placeholder), and every assertion below would be about
// blank names instead of the filter.
async function waitForMember(page: Page, email: string): Promise<void> {
  await expect(page.getByTestId('kitchen-link')).toContainText(`${memberName(email)}'s Kitchen`, {
    timeout: SYNC_TIMEOUT,
  });
}

function card(page: Page, title: string) {
  return page.getByRole('heading', { name: title, level: 3 });
}

test.describe('recipes — authorship filters', () => {
  test('narrows the library to mine, survives a section switch, and clears', async ({
    browser,
  }, testInfo) => {
    // 90s: two sign-ins and four save round-trips through the emulator, each
    // gated on its own signal-bound wait below.
    test.setTimeout(90_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      const emailA = uniqueEmail(testInfo.testId + '-a');
      const emailB = uniqueEmail(testInfo.testId + '-b');

      // ── The other partner writes two entries, one per shelf ────────────────
      await gotoAndSignIn(pageA, emailA, '/', { admin: true });
      await waitForMember(pageA, emailA);
      await seedRecipe(pageA, buildRecipe('e2e-author-a-recipe', 'Their Ragu'));
      await seedRecipe(pageA, buildRecipe('e2e-author-a-outing', 'Their Curry House', 'outing'));

      // ── I write mine, in a session of my own ───────────────────────────────
      // Signing in AFTER A's writes means my tab's listeners deliver them in
      // their first snapshot, which is not subject to the emulator's
      // long-polling drop hazard (NF-D1) the way a post-attach update is.
      await gotoAndSignIn(pageB, emailB, '/', { admin: true });
      await waitForMember(pageB, emailB);
      await seedRecipe(pageB, buildRecipe('e2e-author-b-recipe', 'My Ragu'));
      await seedRecipe(pageB, buildRecipe('e2e-author-b-outing', 'My Curry House', 'outing'));

      // ── The list, unfiltered: both partners' recipes ───────────────────────
      await pageB.goto('/#/recipes');
      await expect(card(pageB, 'My Ragu')).toBeVisible({ timeout: SYNC_TIMEOUT });
      await expect(card(pageB, 'Their Ragu')).toBeVisible({ timeout: SYNC_TIMEOUT });
      await expect(pageB.getByTestId('recipe-result-count')).not.toContainText('filtered');

      // The row is offered because the library now holds two names. Scoped to
      // its own region so the chips resolve by their accessible names without
      // colliding with anything else the page can render.
      const authorRow = pageB.getByTestId('recipe-author-filters');
      const addedByMe = authorRow.getByRole('button', { name: 'Added by me' });
      const editedByMe = authorRow.getByRole('button', { name: 'Edited by me' });
      await expect(addedByMe).toBeVisible({ timeout: SYNC_TIMEOUT });

      // ── "Added by me" → only my dishes ─────────────────────────────────────
      await addedByMe.click();
      await expect(card(pageB, 'My Ragu')).toBeVisible();
      await expect(card(pageB, 'Their Ragu')).toBeHidden();
      await expect(pageB.getByTestId('recipe-result-count')).toContainText('filtered');
      await expect(addedByMe).toHaveAttribute('aria-pressed', 'true');

      // ── A section switch keeps it on ───────────────────────────────────────
      // "Mine" is not per-section vocabulary the way tags are: it means the same
      // thing on every shelf, so walking to the next one must not drop it.
      // The outings shelf sits behind the row's "+N more" expander.
      await pageB.getByTestId('recipe-kind-show-all').click();
      await pageB
        .getByTestId('recipe-kind-filters')
        .getByRole('button', { name: 'When you CBA' })
        .click();
      await expect(addedByMe).toHaveAttribute('aria-pressed', 'true');
      await expect(card(pageB, 'My Curry House')).toBeVisible();
      await expect(card(pageB, 'Their Curry House')).toBeHidden();

      // ── "Edited by me" reads the other field, and is its own toggle ────────
      await addedByMe.click();
      await editedByMe.click();
      await expect(card(pageB, 'My Curry House')).toBeVisible();
      await expect(card(pageB, 'Their Curry House')).toBeHidden();
      await expect(addedByMe).toHaveAttribute('aria-pressed', 'false');

      // ── "Clear" drops the chips but leaves me where I was standing ─────────
      await pageB.getByTestId('recipe-clear-filters').click();
      await expect(editedByMe).toHaveAttribute('aria-pressed', 'false');
      await expect(card(pageB, 'Their Curry House')).toBeVisible();
      await expect(card(pageB, 'My Curry House')).toBeVisible();
      // Still on the outings shelf — clearing a filter is not a teleport home.
      await expect(card(pageB, 'My Ragu')).toBeHidden();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('offers no authorship row while the library carries a single name', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email, '/', { admin: true });
    await waitForMember(page, email);

    await seedRecipe(page, buildRecipe('e2e-author-solo-1', 'Solo Ragu'));
    await seedRecipe(page, buildRecipe('e2e-author-solo-2', 'Solo Stew'));

    await page.goto('/#/recipes');
    // Both cards on screen first: the absence below is then a real absence
    // rather than a list that has not rendered yet.
    await expect(card(page, 'Solo Ragu')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(card(page, 'Solo Stew')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // Every entry is mine, so a filter for "mine" could only ever answer
    // "everything" — the row is not rendered at all.
    await expect(page.getByTestId('recipe-author-filters')).toHaveCount(0);
  });

  test('corrects a misattributed entry, and both the chip and her filter follow', async ({
    browser,
  }, testInfo) => {
    // 90s: two sign-ins and two write round-trips through the emulator (the seed,
    // then the in-place correction), each gated on its own signal-bound wait below.
    test.setTimeout(90_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      const emailA = uniqueEmail(testInfo.testId + '-a');
      const emailB = uniqueEmail(testInfo.testId + '-b');
      const nameA = memberName(emailA);
      const nameB = memberName(emailB);

      // A signs in FIRST purely to get onto the roster — the picker offers
      // `Member.name`s and nothing else, so the person a recipe is being handed
      // to has to be a real member before the correction is even offerable.
      await gotoAndSignIn(pageA, emailA, '/', { admin: true });
      await waitForMember(pageA, emailA);

      // ── B writes it, so B is who the library records ───────────────────────
      await gotoAndSignIn(pageB, emailB, '/', { admin: true });
      await waitForMember(pageB, emailB);
      await seedRecipe(pageB, buildRecipe('e2e-author-fix', 'Misattributed Ragu'));

      await pageB.goto('/#/recipes/e2e-author-fix');
      await expect(pageB.getByTestId('recipe-attribution-chip')).toHaveText(`Added by ${nameB}`, {
        timeout: SYNC_TIMEOUT,
      });

      // ── The correction, in place ────────────────────────────────────────────
      // Reached the way a person reaches it, which changed in issue #1319: Edit is
      // an icon-only button in the action row at every width, and the picker is in
      // the identity card on THIS page rather than on a separate editor. The ⋮ menu
      // no longer carries an Edit item at all.
      await pageB.getByTestId('recipe-edit-mode-button').click();
      await pageB.getByTestId('recipe-edit-added-by').click();

      const addedBy = pageB.getByTestId('recipe-added-by-select');
      // It opens on the record as it stands, not on a blank.
      await expect(addedBy).toHaveText(nameB, { timeout: SYNC_TIMEOUT });
      await addedBy.click();
      // A roster pick, never typed: the filter below is a plain `===` against
      // `Member.name`, so the option's own text is what has to land.
      await pageB.getByRole('option', { name: nameA }).click();
      await expect(addedBy).toHaveText(nameA);
      // No Save: Done leaves edit mode and flushes what was written on the pick.
      await pageB.getByTestId('recipe-done-button').click();

      // The chip now names the real author — and still names B as the last editor,
      // because that is exactly what happened and `lastEditedBy` is re-stamped by
      // every write.
      await expect(pageB.getByTestId('recipe-attribution-chip')).toHaveText(
        `Added by ${nameA} · edited by ${nameB}`,
        { timeout: SYNC_TIMEOUT },
      );

      // ── And it is hers now, by her own filter ──────────────────────────────
      // Reloaded rather than merely navigated: A's tab has had listeners
      // attached since before the recipe existed, and the emulator's forced
      // long-polling drops post-attach updates (NF-D1). A fresh load takes the
      // whole library in its FIRST snapshot, which is not subject to that.
      await pageA.goto('/#/recipes');
      await pageA.reload();
      await expect(card(pageA, 'Misattributed Ragu')).toBeVisible({ timeout: SYNC_TIMEOUT });

      // The row is offered at all only because the library now holds two names —
      // which it does precisely because of the correction just made.
      const addedByMe = pageA
        .getByTestId('recipe-author-filters')
        .getByRole('button', { name: 'Added by me' });
      await expect(addedByMe).toBeVisible({ timeout: SYNC_TIMEOUT });
      await addedByMe.click();
      await expect(addedByMe).toHaveAttribute('aria-pressed', 'true');
      await expect(card(pageA, 'Misattributed Ragu')).toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
