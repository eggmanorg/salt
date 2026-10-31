/**
 * Use from the freezer (issue #1685) — a shopping row whose ingredient is in a
 * freezer is used instead of bought, and Kitchen holds it until somebody gets it
 * out.
 *
 * Everything the household already has is setup, not subject, and is written
 * before the app boots (`seedDocumentBeforeBoot`): the freezer and its bags, the
 * canon they link to, the list, and rows ALREADY matched to that canon. A row is
 * matched by exact canon id, and the canonicalisation trigger acts only on a
 * `pending` row, so nothing here reaches a model (NF-E3, NF-E4) and nothing
 * depends on a post-attach update arriving (the hazard the pre-boot seeds exist
 * for). Assertions on stored state go through the bridge inside `expect.poll`
 * (NF-D2, NF-E2).
 *
 * The feature gate: an e2e build has no PostHog key, and a build without one
 * shows every feature (featureGate.ts), so the `freezer` surfaces render here.
 *
 * Covers:
 * - A recipe row → Use from the freezer → the row goes, the Kitchen item is
 *   stored, Kitchen shows it → Got it out → it is gone.
 * - A row shared by two recipes → committing one recipe's line leaves the other,
 *   its pack count worked out from that recipe's own amount (issue #1712).
 * - A row whose ingredient is in no freezer has no freezer line.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import {
  getShoppingListItems,
  seedAislesBeforeBoot,
  seedDocumentBeforeBoot,
  seedShoppingListBeforeBoot,
} from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Page } from '@playwright/test';

const NOW = '2026-10-12T09:00:00.000Z';
const PORK = 'canon-e2e-pork-loin';
const MINCE = 'canon-e2e-beef-mince';
const LEEK = 'canon-e2e-leek';

async function seedHousehold(): Promise<string> {
  const [meat] = await seedAislesBeforeBoot(['Meat']);
  for (const [id, name] of [
    [PORK, 'pork loin'],
    [MINCE, 'beef mince'],
    [LEEK, 'leek'],
  ] as const) {
    await seedDocumentBeforeBoot(`canonItems/${id}`, {
      id,
      name,
      schemaVersion: 5,
      synonyms: [],
      aisleId: meat?.id ?? null,
      thumbnail: null,
      needs_approval: false,
      shoppingBehavior: 'needed',
      updatedAt: NOW,
    });
  }
  await seedDocumentBeforeBoot('freezerConfig/current', {
    schemaVersion: 1,
    updatedAt: NOW,
    freezers: [{ id: 'fz-garage', name: 'Garage', shelves: ['A', 'B'] }],
    suppliers: [],
  });
  // Pork in 500 g packs, so a 500 g row starts at one; mince in 250 g packs and
  // four of them, so a 500 g row starts at two — and a combined 1 kg would be four.
  for (const [number, name, canonId, amount, grams] of [
    [47, 'Pork loin', PORK, 2, 500],
    [12, 'Beef mince', MINCE, 4, 250],
  ] as const) {
    await seedDocumentBeforeBoot(`freezerItems/${String(number).padStart(3, '0')}`, {
      schemaVersion: 1,
      number,
      name,
      freezerId: 'fz-garage',
      shelf: 'B',
      amount,
      canonId,
      recipeId: null,
      purchasedFrom: null,
      packWeight: { amount: grams, unit: 'g' },
      addedAt: NOW,
      updatedAt: NOW,
    });
  }
  const list = await seedShoppingListBeforeBoot('Weekly shop');
  return list.id;
}

async function seedRow(
  listId: string,
  id: string,
  rawText: string,
  canonId: string,
  recipe: { id: string; label: string } | null,
): Promise<void> {
  await seedDocumentBeforeBoot(`shoppingLists/${listId}/items/${id}`, {
    id,
    rawText,
    notes: '',
    sources: recipe
      ? [{ kind: 'recipe', recipeId: recipe.id, servings: 2, label: recipe.label }]
      : [{ kind: 'manual' }],
    canonId,
    matchState: 'matched',
    checked: false,
    needsCheck: false,
    amount: 500,
    unit: 'g',
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function defrostIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__e2e!.getDefrosts().map((d) => `${d.freezerNumber}_${d.recipeId ?? 'manual'}`),
  );
}

async function rowIds(page: Page): Promise<string[]> {
  return (await getShoppingListItems(page)).map((i) => i.id).sort();
}

test.describe('use from the freezer', () => {
  test('a recipe row goes to Kitchen, and Got it out clears it', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const listId = await seedHousehold();
    await seedRow(listId, 'row-pork', 'pork loin', PORK, { id: 'r-chilli', label: 'Chilli' });
    await seedRow(listId, 'row-leek', 'leek', LEEK, null);

    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), `/#/shopping/${listId}`);

    await expect(page.getByTestId('shopping-item-freezer')).toHaveCount(1, {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('shopping-item-freezer')).toContainText(
      'in the freezer · Garage, shelf B · #47 · 2 packs',
    );

    await page.getByTestId('shopping-item-use-from-freezer').click();
    await page.getByTestId('use-from-freezer-confirm').click();

    await expect.poll(() => rowIds(page), { timeout: SYNC_TIMEOUT }).toEqual(['row-leek']);
    await expect.poll(() => defrostIds(page), { timeout: SYNC_TIMEOUT }).toEqual(['47_r-chilli']);

    await page.goto('/#/mine');
    await expect(page.getByTestId('mine-task-title')).toHaveText('Defrost Pork loin', {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('mine-task-detail')).toContainText(
      'Garage · shelf B · #47 · 1 pack — for Chilli',
    );

    await page.getByTestId('mine-task-done').click();
    await expect.poll(() => defrostIds(page), { timeout: SYNC_TIMEOUT }).toEqual([]);
    await expect(page.getByTestId('mine-tasks')).toHaveCount(0);
  });

  test('a row shared by two recipes commits one recipe and leaves the other', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const listId = await seedHousehold();
    await seedRow(listId, 'row-chilli', 'beef mince', MINCE, { id: 'r-chilli', label: 'Chilli' });
    await seedRow(listId, 'row-pie', 'beef mince', MINCE, { id: 'r-pie', label: 'Cottage pie' });

    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), `/#/shopping/${listId}`);

    await expect(page.getByTestId('shopping-combined-freezer-hint')).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await page.getByTestId('shopping-combined-toggle').click();
    const breakdown = page.getByTestId('shopping-combined-breakdown');
    await expect(breakdown.getByTestId('shopping-item-use-from-freezer')).toHaveCount(2);

    await breakdown.getByTestId('shopping-item-use-from-freezer').first().click();
    // The recipe's own 500 g over 250 g packs (issue #1712), not the row's 1 kg.
    await expect(page.getByTestId('use-from-freezer-count')).toHaveText('2');
    await page.getByTestId('use-from-freezer-confirm').click();

    await expect.poll(() => rowIds(page), { timeout: SYNC_TIMEOUT }).toHaveLength(1);
    const [left] = await rowIds(page);
    expect(['row-chilli', 'row-pie']).toContain(left);
    await expect.poll(() => defrostIds(page), { timeout: SYNC_TIMEOUT }).toHaveLength(1);
  });

  test('a row whose ingredient is in no freezer has no freezer line', async ({
    page,
  }, testInfo) => {
    const listId = await seedHousehold();
    await seedRow(listId, 'row-leek', 'leek', LEEK, null);

    await gotoAndSignIn(page, uniqueEmail(testInfo.testId), `/#/shopping/${listId}`);

    await expect(page.getByTestId('shopping-item-row')).toHaveCount(1, { timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId('shopping-item-freezer')).toHaveCount(0);
  });
});
