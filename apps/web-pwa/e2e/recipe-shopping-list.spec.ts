/**
 * Recipe → shopping list E2E tests (issue #179, Phase 5).
 *
 * Exercises the "Add to shopping list" action from the recipe view against the
 * Firestore + Auth + Functions emulators. Ingredients are written as raw entries
 * (matchState: pending); the onShoppingListItemWrite trigger then canonicalises
 * each one (clean name + structured amount/unit). The shopping row labels by the
 * parsed name — resolveItemDisplayName strips the leading amount/unit at display
 * time — so rows read "Spaghetti" / "Onion", not "400g spaghetti" / "1 onion",
 * regardless of whether the async trigger has run. The 'recipe' SourceRef
 * survives the trigger's rewrite untouched (issue #320).
 *
 * The list itself is setup, not subject: both tests get one already-default list
 * seeded before the app boots (`seedShoppingListBeforeBoot`). Creating a list
 * through the UI is covered by shopping-list-multi-list.spec.ts and
 * shopping-list-happy-path.spec.ts. The recipes are setup too, and bridge-seeded
 * for the same reason — plus a harder one since issue #1319 Phase 8: the editor
 * they used to be typed into no longer exists.
 *
 * Covers:
 * - Items from all ingredient groups reach the shopping list.
 * - Items carry the 'recipe' SourceRef with correct recipeId and servings.
 * - Servings selector defaults to recipe.metadata.servings; stepper adjusts it.
 * - A second "Add to list" appends more items (no deduplication — each call is
 *   its own row, matching existing shopping list behaviour).
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail, waitForBridge } from './helpers/auth';
import { seedRecipe, seedShoppingListBeforeBoot } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Ingredient, Recipe, ShoppingListItem } from '@salt/domain';
import type { Page } from '@playwright/test';

// A phone, pinned explicitly (#696, Phase 4). The recipe page docks its chat column
// from 700x480 up, and this spec inherits the project's 1280x720 desktop default —
// which would put it on the two-column layout the assertions below were never
// written for. Same numbers as `recipe-alternatives.spec.ts`.
test.use({ viewport: { width: 393, height: 851 } });

// The "Shop" button is a no-op until the app knows which list is the default: with
// `defaultListId` still unresolved, `openAddToList` toasts and returns, and nothing
// reopens the sheet — so a click that lands first fails the test outright rather than
// retrying. Waiting on the bridge is the real signal for that (NF-A1/NF-A3).
//
// Since the list and its config are seeded before boot, this is now only a settle
// gate on the listener's FIRST snapshot — a wait that always terminates — rather
// than the old bet on a post-attach update that the emulator transport could drop
// for good. One gate, straight after sign-in, is enough: the store only moves
// forward from there, and everything that needs a default list happens later.
// Both recipes are bridge-seeded (NF-C4). They used to be typed into the recipe
// editor, which issue #1319 Phase 8 deleted along with its routes — and authoring
// was never the subject here: what these tests are about is what the "Add to
// shopping list" sheet does with a recipe's ingredients once it has one.
//
// Every item is seeded as a freshly typed one stands — `parsed: null`,
// `canonId: null`, `matchState: 'pending'` — because that is what the assertions
// downstream rest on. An unmatched ingredient defaults to add: true in the review
// sheet (hence "Add 3 to list"), and the row label comes from
// `resolveItemDisplayName` stripping the leading amount at display time rather
// than from a canon match. Seeding a matched item would quietly change both.
function pendingItem(id: string, rawText: string): Ingredient {
  return {
    id,
    rawText,
    parsed: null,
    canonId: null,
    matchState: 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function recipeFixture(
  id: string,
  title: string,
  servings: number,
  groups: readonly { readonly name: string | null; readonly items: Ingredient[] }[],
): Recipe {
  return {
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: groups.map((g, i) => ({ id: `${id}-g${i + 1}`, name: g.name, items: g.items })),
    steps: [],
    metadata: { servings, phases: [], timingSummary: null, tags: [] },
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
}

const PASTA_ID = 'test-pasta';
const PASTA = recipeFixture(PASTA_ID, 'Test Pasta', 4, [
  {
    name: null,
    items: [
      pendingItem(`${PASTA_ID}-i1`, '400g spaghetti'),
      pendingItem(`${PASTA_ID}-i2`, '2 cloves garlic'),
    ],
  },
  { name: 'For the sauce', items: [pendingItem(`${PASTA_ID}-i3`, '100ml double cream')] },
]);

const QUICK_ID = 'quick-recipe';
const QUICK = recipeFixture(QUICK_ID, 'Quick Recipe', 2, [
  { name: null, items: [pendingItem(`${QUICK_ID}-i1`, '1 onion')] },
]);

async function awaitDefaultList(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__e2e!.getDefaultListId() ?? null), {
      timeout: SYNC_TIMEOUT,
    })
    .not.toBeNull();
}

test.describe('recipe → shopping list extraction', () => {
  test('adds all ingredients from all groups and carries recipe source', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);

    // ── Bootstrap: an already-default shopping list, before the app boots ────
    await seedShoppingListBeforeBoot('Weekly shop');

    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });
    await awaitDefaultList(page);

    // ── A recipe with two ingredient groups (servings: 4) ────────────────────
    await seedRecipe(page, PASTA);
    await page.goto(`/#/recipes/${PASTA_ID}`);
    // The arrival. `recipe-view` renders only once the seeded document has reached
    // the store — the URL is already the one `goto` was handed, so asserting it
    // would let the "Add to list" click below land on a page with no recipe.
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });
    const recipeId = PASTA_ID;

    // ── Open review sheet: default servings = 4, confirm ──────────────────────
    // Unmatched ingredients (no canon match in the client store) default to
    // add: true, so all three rows are included; the button reads "Add 3 to list".
    await page.getByTestId('recipe-add-to-list-button').click();
    await expect(page.getByTestId('recipe-add-review-list')).toBeVisible();
    await expect(page.getByTestId('recipe-servings-value')).toContainText('4');

    await page.getByTestId('recipe-add-to-list-confirm').click();
    await expect(page.getByTestId('recipe-add-review-list')).not.toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByText(/added \d+ items? to the list/i)).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── Navigate to shopping list and verify all three items appear ───────────
    await page.goto('/#/shopping');
    await expect(page.getByTestId('shopping-list-page')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // The shopping row labels by the parsed name (resolveItemDisplayName strips
    // the leading amount/unit at display time), so "400g spaghetti" renders as
    // "Spaghetti". The parsed name is a substring of the raw entry, so these
    // checks hold immediately on the pending row and continue to hold after the
    // async trigger writes the structured amount/unit; they never depend on the
    // canon match resolving (relevant since #297 wired the fake-model seam).
    await expect(page.getByText('spaghetti')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByText('cloves garlic')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByText('double cream')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // ── Verify 'recipe' SourceRef on each item via the in-page store ──────────
    await waitForBridge(page);
    const storeItems = await page.evaluate<ShoppingListItem[]>(
      () => window.__e2e!.getShoppingListItems() as ShoppingListItem[],
    );

    const fromRecipe = storeItems.filter((item) => item.sources.some((s) => s.kind === 'recipe'));
    expect(fromRecipe).toHaveLength(3);

    for (const item of fromRecipe) {
      const src = item.sources.find((s) => s.kind === 'recipe') as {
        kind: 'recipe';
        recipeId: string;
        servings: number;
      };
      expect(src.recipeId).toBe(recipeId);
      expect(src.servings).toBe(4);
    }
  });

  test('servings selector: defaults to recipe servings, stepper adjusts saved value', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);

    // Bootstrap: an already-default shopping list, before the app boots.
    await seedShoppingListBeforeBoot('Test list');

    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });
    await awaitDefaultList(page);

    // A recipe with servings: 2, seeded and opened. `recipe-view` is the arrival;
    // the URL is true the moment `goto` returns and proves nothing.
    await seedRecipe(page, QUICK);
    await page.goto(`/#/recipes/${QUICK_ID}`);
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // Open review sheet: default should be 2.
    await page.getByTestId('recipe-add-to-list-button').click();
    await expect(page.getByTestId('recipe-add-review-list')).toBeVisible();
    await expect(page.getByTestId('recipe-servings-value')).toContainText('2');

    // Decrease to 1 — then the button should be disabled.
    await page.getByTestId('recipe-servings-decrease').click();
    await expect(page.getByTestId('recipe-servings-value')).toContainText('1');
    await expect(page.getByTestId('recipe-servings-decrease')).toBeDisabled();

    // Increase to 6.
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('recipe-servings-increase').click();
    }
    await expect(page.getByTestId('recipe-servings-value')).toContainText('6');

    await page.getByTestId('recipe-add-to-list-confirm').click();
    await expect(page.getByText(/added \d+ items? to the list/i)).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // Verify SourceRef.servings = 6 via the shopping list store.
    await page.goto('/#/shopping');
    await expect(page.getByTestId('shopping-list-page')).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Row labels by the parsed name — "1 onion" renders as "Onion" (the "1" is
    // lifted into the separate amount field), so assert the parsed name.
    await expect(page.getByText('onion')).toBeVisible({ timeout: SYNC_TIMEOUT });

    await waitForBridge(page);
    const storeItems = await page.evaluate<ShoppingListItem[]>(
      () => window.__e2e!.getShoppingListItems() as ShoppingListItem[],
    );

    const recipeItems = storeItems.filter((item) => item.sources.some((s) => s.kind === 'recipe'));
    expect(recipeItems).toHaveLength(1);

    const src = recipeItems[0]!.sources.find((s) => s.kind === 'recipe') as {
      servings: number;
    };
    expect(src.servings).toBe(6);
  });
});
