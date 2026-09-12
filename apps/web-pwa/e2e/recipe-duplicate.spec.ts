/**
 * Recipe duplicate E2E (issue #735).
 *
 * Runs against the Firestore + Auth emulators with no AI on the assertion path.
 * Covers the whole user-visible contract of Duplicate, REWRITTEN for issue #1319
 * Phase 7: the ⋮ menu entry now writes the copy immediately and lands you on the
 * copy's own page, editing it, titled "X (copy)" and carrying the original's
 * ingredients and steps. It is a SECOND, independent document from the moment it
 * exists — which is the change: #735 could promise that backing out wrote nothing,
 * because the copy was an unsaved draft the retired editor painted. With no editor
 * there is no unsaved-recipe surface left, so the cost is accepted and stated: a
 * copy you abandon is a document to delete.
 *
 * The dish being duplicated is BRIDGE-SEEDED (NF-C4): Phase 8 deleted the editor's
 * routes, and how the original came to exist was never what Duplicate promises.
 *
 * Deliberately left on the project's 1280x720 desktop default rather than pinned
 * to a phone the way `recipe-crud.spec.ts` is: the point of #735 is that the ⋮
 * menu now exists at every width, and running here is what pins that. Nothing
 * below asserts on the recipe page's column layout, so the desktop split is
 * irrelevant to it.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';

const ORIGINAL = 'Duplicate Source Stew';
const COPY = `${ORIGINAL} (copy)`;
const INGREDIENT = '2 tbsp olive oil';
const STEP = 'Brown the beef in batches.';
const ORIGINAL_ID = 'duplicate-source-stew';

// One ingredient and one step, because what-carries is read off the COPY's page:
// a document with nothing on it would let `duplicateRecipe` carry nothing and
// still pass. Bridge-seeded (NF-C4) — issue #1319 Phase 8 deleted the editor.
const ORIGINAL_RECIPE: Recipe = {
  id: ORIGINAL_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: ORIGINAL,
  description: null,
  ingredients: [
    {
      id: `${ORIGINAL_ID}-g1`,
      name: null,
      items: [
        {
          id: `${ORIGINAL_ID}-i1`,
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
  steps: [{ id: `${ORIGINAL_ID}-s1`, text: STEP, timer: null, note: null }],
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

test.describe('recipes — duplicate', () => {
  test('⋮ → Duplicate writes the copy and lands on it, editing; doing it twice gives two', async ({
    page,
  }, testInfo) => {
    // 90s: three full write round-trips through the emulator (the seeded original,
    // then two duplicates, each of which writes as it is made since issue #1319
    // Phase 7), each gated on its own signal-bound wait below.
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Seed: one recipe with an ingredient and a step ─────────────────────────
    // Through the bridge, then opened. The heading is the arrival — a URL
    // assertion here would match the hash `goto` was handed, before the seeded
    // document could have reached the store, and `page.url()` read behind it
    // would be the same string either way.
    await seedRecipe(page, ORIGINAL_RECIPE);
    await page.goto(`/#/recipes/${ORIGINAL_ID}`);
    await expect(page.getByRole('heading', { name: ORIGINAL })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    const originalUrl = page.url();

    // ── Duplicate → the copy's own page, already editing it ────────────────────
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-duplicate-menu-item').click();

    // Wait for the ARRIVAL, not for a pattern the page already matches: we are
    // standing on `/#/recipes/{original}`, which satisfies the recipe-page regex
    // before the duplicate's write has even resolved — so `toHaveURL` is no wait at
    // all here and reading `page.url()` straight after it races the navigation.
    // The copy's own title is the first thing that can only be true once we are
    // there.
    await expect(page.getByRole('heading', { name: COPY })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    // A new id, never /recipes/new and never an /edit route.
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/);
    expect(page.url()).not.toBe(originalUrl);
    const copyUrl = page.url();
    // Edit mode, which is what "lands you on the duplicate's own page, editing it"
    // looks like from outside: Done replaces the whole action cluster.
    await expect(page.getByTestId('recipe-done-button')).toBeVisible();

    // The whole copy came with it — `duplicateRecipe`'s what-carries policy, read
    // off the page rather than out of an editor's boxes. .nth(0) = the first
    // ingredient / step of the copy this test just made, not a global index.
    await expect(page.getByTestId('recipe-view-ingredient').nth(0)).toContainText(INGREDIENT);
    await expect(page.getByTestId('recipe-view-step')).toHaveCount(1);
    await expect(page.getByTestId('recipe-view-step').nth(0)).toContainText(STEP);

    await page.getByTestId('recipe-done-button').click();
    await expect(page.getByTestId('recipe-edit-mode-button')).toBeVisible();

    // ── It is a document from the moment it exists ─────────────────────────────
    // The inverse of #735's "backing out writes nothing": there is nothing to back
    // out of. Navigating away leaves the copy in the library, which is why the
    // reload check below finds two.
    await page.goto('/#/recipes');
    await expect(page.getByTestId('recipe-list-item').filter({ hasText: COPY })).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });

    // ── Duplicating twice yields two copies, not one rewritten ─────────────────
    await page.goto(`/#${originalUrl.split('#')[1]}`);
    await expect(page.getByRole('heading', { name: ORIGINAL })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId('recipe-actions-overflow').click();
    await page.getByTestId('recipe-duplicate-menu-item').click();

    // Same wait as above, and for the same reason: the heading is the arrival, the
    // URL pattern is not.
    await expect(page.getByRole('heading', { name: COPY })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/);
    // A third document: not the original, and not the first copy either.
    expect(page.url()).not.toBe(originalUrl);
    expect(page.url()).not.toBe(copyUrl);

    // ── All three survive a reload: independent Firestore documents ────────────
    // `hasText` is a substring match and COPY contains ORIGINAL, so the original
    // plus two copies is three rows under that filter.
    await page.goto('/#/recipes');
    await page.reload();
    await expect(page.getByTestId('recipe-list-item').filter({ hasText: ORIGINAL })).toHaveCount(
      3,
      {
        timeout: SYNC_TIMEOUT,
      },
    );
    await expect(page.getByTestId('recipe-list-item').filter({ hasText: COPY })).toHaveCount(2);

    // The original is untouched — still its own title, not the copy's.
    await page.goto(`/#${originalUrl.split('#')[1]}`);
    await expect(page.getByRole('heading', { name: ORIGINAL, exact: true })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
  });
});
