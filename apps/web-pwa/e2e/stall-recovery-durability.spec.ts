/**
 * Stuck-write recovery: queued writes survive the recovery reload (issue #1667,
 * Phase 2 — the CLAUDE.md Rule 12 pin for that claim).
 *
 * On a wedged page the recovery reloads rather than flushing, trusting that
 * writes Firestore has queued but the server never confirmed are held in
 * `persistentLocalCache` (IndexedDB) and replayed by the next page instance.
 * This spec queues a write while Firestore cannot reach the server, takes the
 * recovery's own reload path, and asserts the document reaches the emulator
 * afterwards.
 *
 * The e2e build normally runs WITHOUT a persistent cache (apps/web-pwa/src/lib/
 * firebase.ts — no local mutation queue under emulators), so the durability
 * test opts its page loads into the production cache with `?e2ePersistentCache`.
 * The control test runs the same steps WITHOUT it and asserts the write is
 * lost: that is what proves the durability assertion can go red, rather than
 * passing because the write found some other way to the server.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail, waitForBridge } from './helpers/auth';
import { FIRESTORE_DOCUMENTS_BASE_URL } from './helpers/emulator';
import { getShoppingListItems, seedShoppingListBeforeBoot } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// The bounded hold for the control's negative assertion (NF-A2): long enough
// for a replayed write to have reached the emulator several times over — the
// durability test's positive poll lands within SYNC_TIMEOUT, normally ~1 s.
const LOST_WRITE_HOLD_MS = 5_000;

async function serverHasDoc(path: string): Promise<boolean> {
  const res = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  return res.ok;
}

// Opens the seeded list, takes Firestore offline, adds one item through the
// UI, and returns the item's document path once the SDK holds it locally.
async function queueOfflineAdd(page: Page, url: string, listId: string, text: string) {
  await gotoAndSignIn(page, uniqueEmail(test.info().testId), url);
  await expect(page.getByTestId('shopping-list-page')).toBeVisible({ timeout: SYNC_TIMEOUT });

  // The add field renders once the list's items have loaded; take Firestore
  // offline only after that, or the first server snapshot never arrives.
  const input = page.getByTestId('shopping-item-input');
  await expect(input).toBeVisible({ timeout: SYNC_TIMEOUT });

  await page.evaluate(() => window.__e2e!.setFirestoreOffline(true));
  await input.fill(text);
  await page.getByTestId('shopping-item-add-btn').click();

  let itemId = '';
  await expect
    .poll(
      async () => {
        itemId = (await getShoppingListItems(page)).find((i) => i.rawText === text)?.id ?? '';
        return itemId;
      },
      { timeout: SYNC_TIMEOUT },
    )
    .not.toBe('');
  const path = `shoppingLists/${listId}/items/${itemId}`;

  // The SDK's own view carries the write as unacknowledged — it is queued, not
  // sent — and the server does not have it.
  await expect
    .poll(
      async () =>
        (await page.evaluate((p) => window.__e2e!.probeFirestoreCache(p), path)).hasPendingWrites,
      {
        timeout: SYNC_TIMEOUT,
      },
    )
    .toBe(true);
  expect(await serverHasDoc(path)).toBe(false);
  return path;
}

async function takeRecoveryReload(page: Page) {
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => window.__e2e!.reloadForStallRecovery()),
  ]);
  await waitForBridge(page);
  await expect(page.getByTestId('shopping-list-page')).toBeVisible({ timeout: SYNC_TIMEOUT });
}

test.describe('stuck-write recovery — durability across the reload', () => {
  test('a write queued while Firestore cannot reach the server lands after the recovery reload', async ({
    page,
  }) => {
    const list = await seedShoppingListBeforeBoot('Weekly shop');
    const path = await queueOfflineAdd(
      page,
      `/?e2ePersistentCache#/shopping/${list.id}`,
      list.id,
      'durable eggs',
    );

    await takeRecoveryReload(page);

    // The new page instance has its network on and replays the queued write.
    await expect.poll(() => serverHasDoc(path), { timeout: SYNC_TIMEOUT }).toBe(true);
  });

  test('control: without the persistent cache the same write is lost', async ({ page }) => {
    const list = await seedShoppingListBeforeBoot('Weekly shop');
    const path = await queueOfflineAdd(page, `/#/shopping/${list.id}`, list.id, 'lost eggs');

    await takeRecoveryReload(page);

    // Bounded negative (NF-A2): the page is back and online (asserted above),
    // so a surviving write would land well inside this hold.
    // eslint-disable-next-line playwright/no-wait-for-timeout -- NF-A2: bounded negative hold (a lost write never lands)
    await page.waitForTimeout(LOST_WRITE_HOLD_MS);
    expect(await serverHasDoc(path)).toBe(false);
  });
});
