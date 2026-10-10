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
 * The write is a canon item through the bridge's `seedCanonItem`, which is
 * built for exactly this — an `upsertCanonItem` left in flight while the SDK is
 * offline, answered by the local store. What is under test is the SDK's queue
 * across a reload, which every collection shares; a UI path would only add a
 * screen to the setup.
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
import { seedCanonItem, waitForCanonReady } from './helpers/seed';
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

// Signs in at `url`, takes Firestore offline, writes one canon item, and
// returns its document path once the SDK holds it as an unacknowledged write.
async function queueOfflineWrite(page: Page, url: string, name: string): Promise<string> {
  await gotoAndSignIn(page, uniqueEmail(test.info().testId), url);
  await waitForCanonReady(page);

  await page.evaluate(() => window.__e2e!.setFirestoreOffline(true));
  const item = await seedCanonItem(page, { name });
  const path = `canonItems/${item.id}`;

  // Queued, not sent: the SDK's own view carries it as a pending write, and
  // the server does not have it.
  await expect
    .poll(
      async () =>
        (await page.evaluate((p) => window.__e2e!.probeFirestoreCache(p), path)).hasPendingWrites,
      { timeout: SYNC_TIMEOUT },
    )
    .toBe(true);
  expect(await serverHasDoc(path)).toBe(false);
  return path;
}

async function takeRecoveryReload(page: Page): Promise<void> {
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => window.__e2e!.reloadForStallRecovery()),
  ]);
  await waitForBridge(page);
  // The new page instance is signed in and its listeners are attached — the
  // positive signal the control's negative hold is paired with (NF-A2).
  await waitForCanonReady(page);
}

test.describe('stuck-write recovery — durability across the reload', () => {
  test('a write queued while Firestore cannot reach the server lands after the recovery reload', async ({
    page,
  }) => {
    const path = await queueOfflineWrite(page, '/?e2ePersistentCache', 'Durable Eggs');

    await takeRecoveryReload(page);

    // The new page instance has its network on and replays the queued write.
    await expect.poll(() => serverHasDoc(path), { timeout: SYNC_TIMEOUT }).toBe(true);
  });

  test('control: without the persistent cache the same write is lost', async ({ page }) => {
    const path = await queueOfflineWrite(page, '/', 'Lost Eggs');

    await takeRecoveryReload(page);

    // eslint-disable-next-line playwright/no-wait-for-timeout -- NF-A2: bounded negative hold (a lost write never lands)
    await page.waitForTimeout(LOST_WRITE_HOLD_MS);
    expect(await serverHasDoc(path)).toBe(false);
  });
});
