/**
 * Equipment capture + edit E2E tests.
 *
 * These tests run against the Firestore + Auth emulators and exercise the
 * full equipment manifest lifecycle: capture flow, rule authoring/editing, and
 * persistence across reload.
 *
 * AI determinism: the capture flow drives two AI callables — identifyEquipment
 * (step 1 → 2) and populateEquipmentEntry (step 2 → 3). Under the test stack
 * (FUNCTIONS_AI_FAKE=1) both are routed through the fake-model seam, so the spec
 * registers a canned answer for each via window.__e2e.stubAi BEFORE triggering
 * the flow and then asserts the KNOWN stubbed values. There is no live Gemini
 * key and no AI-optional fallback: a missing stub fails loudly by design.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
// HYDRATE_TIMEOUT covers the first post-navigation render: the SPA route
// hydrates after sign-in + a fresh emulator wipe and (for seeded specs) the
// manifest subscription must deliver. Under sustained load (--repeat-each) this
// first paint can exceed SYNC_TIMEOUT, so initial-render assertions use this
// larger explicit budget rather than relying on retries.
import { HYDRATE_TIMEOUT, SYNC_TIMEOUT } from './helpers/timeouts';

// Deterministic AI answers. These are values a real model would not reliably
// produce for the given inputs, so their presence in the UI/store can only come
// from the stub — proving the capture path ran the (faked) AI, not a fallback.
const STUB_CANDIDATE = 'My Stand Mixer';
const STUB_RATIONALE = 'Deterministic stub candidate for e2e.';
const STUB_ACCESSORY = 'Deterministic Stub Whisk';

test.describe('equipment — capture, edit, and persistence', () => {
  test('capture a device end-to-end (deterministic AI), author a rule, reload, see it persisted', async ({
    page,
  }, testInfo) => {
    // Two faked AI calls plus several sync waits; well under the old 120s with
    // determinism, but keep headroom for emulator cold-starts.
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Sign in directly at the capture route. AuthGate renders the router (and
    // thus the equipment route) only once authenticated, so the route mounts
    // fresh after sign-in — avoiding the post-auth hashchange that the SPA router
    // occasionally drops under sustained load (the route shell renders but its
    // content does not), which was the residual first-navigation flake.
    await gotoAndSignIn(page, email, '/#/equipment/new');

    // Register canned answers for BOTH equipment AI flows up front. The fake
    // model reads these from Firestore when the real callables run, so the
    // capture path is fully deterministic.
    await page.evaluate(
      ({ candidate, rationale, accessory }) => {
        const stubIdentify = window.__e2e!.stubAi('identifyEquipment', {
          candidates: [{ name: candidate, rationale }],
        });
        const stubPopulate = window.__e2e!.stubAi('populateEquipmentEntry', {
          name: candidate,
          accessories: [{ name: accessory, included: true }],
        });
        return Promise.all([stubIdentify, stubPopulate]);
      },
      { candidate: STUB_CANDIDATE, rationale: STUB_RATIONALE, accessory: STUB_ACCESSORY },
    );

    // ── Step 1: raw name ──────────────────────────────────────────────────
    // Already on /#/equipment/new (signed in there). The route mounts after
    // AuthGate reveals the router; give the first render an explicit budget.
    await expect(page.getByRole('heading', { name: /add equipment/i })).toBeVisible({
      timeout: HYDRATE_TIMEOUT,
    });

    await page.getByTestId('equipment-raw-name-input').fill('KitchenAid Stand Mixer');
    await page.getByRole('button', { name: /identify/i }).click();

    // ── Step 2: confirm name ──────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: /confirm name/i })).toBeVisible({
      timeout: 10_000,
    });

    // The stubbed identify answer must surface as a selectable candidate. Pick
    // it so the confirmed name is the known stubbed value.
    const candidate = page.getByTestId('equipment-candidate').filter({ hasText: STUB_CANDIDATE });
    await expect(candidate).toBeVisible({ timeout: 10_000 });
    await candidate.click();
    await expect(page.getByTestId('equipment-confirmed-name-input')).toHaveValue(STUB_CANDIDATE);

    await page.getByTestId('equipment-confirm-name-btn').click();

    // ── Step 3: accessories ───────────────────────────────────────────────
    // Confirm triggers populateEquipmentEntry (faked). The stubbed accessory
    // must render deterministically — no generous AI fallback timeout needed.
    await expect(page.getByRole('heading', { name: STUB_CANDIDATE })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId('equipment-draft-accessory').filter({ hasText: STUB_ACCESSORY }),
    ).toBeVisible({ timeout: 10_000 });

    // Add a manual accessory alongside the AI-suggested one.
    await page.getByTestId('equipment-new-accessory-input').fill('QA Test Whisk');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(
      page.getByTestId('equipment-draft-accessory').filter({ hasText: 'QA Test Whisk' }),
    ).toBeVisible();

    // Save.
    await page.getByTestId('equipment-save-btn').click();

    // ── Edit page: navigate to newly created item ─────────────────────────
    await expect(page).toHaveURL(/#\/equipment\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    await expect(page.getByRole('heading', { name: STUB_CANDIDATE })).toBeVisible();

    // Both the AI-suggested accessory and the manual one are present.
    await expect(page.getByTestId('equipment-accessories').getByText(STUB_ACCESSORY)).toBeVisible();
    await expect(
      page.getByTestId('equipment-accessories').getByText('QA Test Whisk'),
    ).toBeVisible();

    // Wait for the "Added X" success toast to dismiss before clicking
    // controls in the bottom-right, where the toast viewport overlays.
    // The Toast auto-dismiss timer pauses on mouseenter — move the cursor
    // away from the bottom-right corner so the 5s timer can run.
    await page.mouse.move(0, 0);
    await expect(page.getByText(new RegExp(`added ${STUB_CANDIDATE}`, 'i'))).toBeHidden({
      timeout: SYNC_TIMEOUT,
    });

    // ── Author a rule ─────────────────────────────────────────────────────
    await page.getByTestId('equipment-add-rule-input').fill('Use slow speed (1–2) for bread dough');
    await page.getByTestId('equipment-add-rule-btn').click();

    await expect(
      page.getByTestId('equipment-rules').getByTestId('equipment-rule-text').first(),
    ).toHaveText('Use slow speed (1–2) for bread dough', { timeout: SYNC_TIMEOUT });

    // ── Reload and verify persistence ─────────────────────────────────────
    const currentUrl = page.url();
    await page.reload();
    await page.goto(currentUrl);

    // Wait for subscription to hydrate.
    await expect(page.getByRole('heading', { name: STUB_CANDIDATE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    await expect(page.getByTestId('equipment-accessories').getByText(STUB_ACCESSORY)).toBeVisible();
    await expect(
      page.getByTestId('equipment-accessories').getByText('QA Test Whisk'),
    ).toBeVisible();

    await expect(
      page.getByTestId('equipment-rules').getByTestId('equipment-rule-text').first(),
    ).toHaveText('Use slow speed (1–2) for bread dough');
  });

  test('edit an existing rule and see the change persist across reload', async ({
    page,
  }, testInfo) => {
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email);

    const ITEM_ID = 'rule-edit-mixer';
    const ORIGINAL_RULE = 'Use the dough hook for bread';
    const EDITED_RULE = 'Use the dough hook on speed 2 for bread';

    // Navigate to the item page FIRST, then seed. The equipment manifest
    // subscription is established at app init against the just-cleared (empty)
    // Firestore; if we seed before navigating, a late empty/stale onSnapshot can
    // clobber the seeded store right after navigation (a pre-existing seed-vs-
    // subscription race that also flakes the list/delete specs). Seeding AFTER
    // the empty subscription has settled makes our write the LAST snapshot the
    // subscription delivers, so nothing overwrites it.
    await page.goto(`/#/equipment/${ITEM_ID}`);
    // Before the seed lands the page shows "not found"; that confirms the route
    // hydrated and the subscription settled empty.
    await expect(page.getByText(/equipment item not found/i)).toBeVisible({
      timeout: HYDRATE_TIMEOUT,
    });

    // Seed an item that already has a rule — this isolates the rule-edit path
    // from the full AI capture flow.
    await page.evaluate(
      ({ id, rule }) =>
        window.__e2e!.seedEquipmentManifest({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          items: [
            {
              id,
              schemaVersion: 1,
              name: 'Seeded Stand Mixer',
              accessories: [],
              rules: [rule],
              environment: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      { id: ITEM_ID, rule: ORIGINAL_RULE },
    );

    // The seeded item now renders.
    await expect(page.getByRole('heading', { name: /seeded stand mixer/i })).toBeVisible({
      timeout: HYDRATE_TIMEOUT,
    });

    // The seeded rule renders. The row element itself carries data-rule-index.
    const ruleRow = page.locator('[data-testid="equipment-rule-row"][data-rule-index="0"]');
    await expect(
      page.getByTestId('equipment-rules').getByTestId('equipment-rule-text').first(),
    ).toHaveText(ORIGINAL_RULE, { timeout: SYNC_TIMEOUT });

    // Enter edit mode via the row's Edit button (no testid — use aria-label),
    // replace the text, and Save (Save button is scoped within the editing row).
    await ruleRow.getByRole('button', { name: /edit rule/i }).click();
    const editInput = page.getByTestId('equipment-edit-rule-input');
    await expect(editInput).toHaveValue(ORIGINAL_RULE);
    await editInput.fill(EDITED_RULE);
    await ruleRow.getByRole('button', { name: /^save$/i }).click();

    // The displayed rule text updates to the edited value.
    await expect(
      page.getByTestId('equipment-rules').getByTestId('equipment-rule-text').first(),
    ).toHaveText(EDITED_RULE, { timeout: SYNC_TIMEOUT });

    // The store reflects the edit at the same index (rules are index-keyed).
    await expect
      .poll(
        async () => {
          const manifest = await page.evaluate(() => window.__e2e!.getEquipmentManifest());
          return manifest?.items.find((i) => i.id === ITEM_ID)?.rules[0];
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toBe(EDITED_RULE);

    // Persists across reload (data is durable in Firestore; the fresh page must
    // re-hydrate the subscription, so allow the larger first-render budget).
    await page.reload();
    await page.goto(`/#/equipment/${ITEM_ID}`);
    await expect(
      page.getByTestId('equipment-rules').getByTestId('equipment-rule-text').first(),
    ).toHaveText(EDITED_RULE, { timeout: HYDRATE_TIMEOUT });
  });

  test('equipment item appears in list page after capture', async ({ page }, testInfo) => {
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email);

    // Navigate FIRST so the manifest subscription is established and settled
    // (empty, post-clear) before seeding — otherwise a late empty onSnapshot can
    // clobber the seeded store right after navigation. Seeding last makes our
    // write the final snapshot the subscription delivers.
    await page.goto('/#/equipment');
    await expect(page.getByRole('heading', { name: 'Equipment' })).toBeVisible({
      timeout: HYDRATE_TIMEOUT,
    });

    // Seed manifest via bridge for a fast, AI-free path.
    await page.evaluate(() =>
      window.__e2e!.seedEquipmentManifest({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        items: [
          {
            id: 'test-mixer',
            schemaVersion: 1,
            name: 'Stand Mixer',
            accessories: [],
            rules: [],
            environment: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    // Gate the DOM assertion on the STORE converging to the seeded state.
    // seedEquipmentManifest sets the store synchronously, but the live
    // onSnapshot subscription is still attached: a late empty snapshot from the
    // freshly-cleared Firestore can land AFTER the seed and clobber the store
    // back to empty, blanking the just-rendered row (the ~1-in-6 list flake).
    // Polling getEquipmentManifest() until the item is present means we only
    // assert the DOM once the subscription has settled on the seeded item — the
    // late-empty snapshot has already passed and the seed's own write echoed
    // back. The list page renders equipment-list-item directly from this store,
    // so a present store guarantees the row is about to paint.
    await expect
      .poll(
        async () => {
          const manifest = await page.evaluate(() => window.__e2e!.getEquipmentManifest());
          return manifest?.items.some((i) => i.id === 'test-mixer') ?? false;
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toBe(true);

    await expect(
      page
        .getByTestId('equipment-list')
        .getByTestId('equipment-list-item')
        .filter({ hasText: 'Stand Mixer' }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });
  });

  test('delete equipment item removes it from the list', async ({ page }, testInfo) => {
    const email = uniqueEmail(testInfo.testId);
    await gotoAndSignIn(page, email);

    // Navigate first, then seed (see the list-appears test for the seed-vs-
    // subscription ordering rationale).
    await page.goto('/#/equipment');
    await expect(page.getByRole('heading', { name: 'Equipment' })).toBeVisible({
      timeout: HYDRATE_TIMEOUT,
    });

    await page.evaluate(() =>
      window.__e2e!.seedEquipmentManifest({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        items: [
          {
            id: 'to-delete',
            schemaVersion: 1,
            name: 'Old Blender',
            accessories: [],
            rules: [],
            environment: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    // Gate on the STORE converging to the seeded item before touching the DOM —
    // same late-empty-onSnapshot clobber race as the list-appears test. Without
    // this, a stale empty snapshot can blank the seeded row right after it
    // renders, so selection mode then operates on an empty list.
    await expect
      .poll(
        async () => {
          const manifest = await page.evaluate(() => window.__e2e!.getEquipmentManifest());
          return manifest?.items.some((i) => i.id === 'to-delete') ?? false;
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toBe(true);

    // Wait for the seeded row to render before entering selection mode.
    await expect(
      page
        .getByTestId('equipment-list')
        .getByTestId('equipment-list-item')
        .filter({ hasText: 'Old Blender' }),
    ).toBeVisible({ timeout: SYNC_TIMEOUT });

    // Enter selection mode, then select the row via its checkbox.
    await page.getByRole('button', { name: /^select$/i }).click();
    const row = page
      .getByTestId('equipment-list')
      .locator('li')
      .filter({ has: page.locator('[data-equipment-id="to-delete"]') });
    await row.getByRole('checkbox').click();

    // Bulk delete uses the shared deferred-delete + Undo snackbar (no confirm
    // dialog, no soft-delete): the row hides immediately and the real delete
    // commits only once the Undo toast lapses.
    await page.getByTestId('equipment-bulk-delete').click();

    const undo = page.getByRole('button', { name: /undo/i });
    await expect(undo).toBeVisible({ timeout: SYNC_TIMEOUT });

    // Row hides right away.
    await expect(
      page
        .getByTestId('equipment-list')
        .getByTestId('equipment-list-item')
        .filter({ hasText: 'Old Blender' }),
    ).toHaveCount(0, { timeout: SYNC_TIMEOUT });

    // Let the snackbar lapse — the delete commits to Firestore and survives a reload.
    await expect(undo).toHaveCount(0, { timeout: SYNC_TIMEOUT });
    await page.reload();
    await expect(
      page
        .getByTestId('equipment-list')
        .getByTestId('equipment-list-item')
        .filter({ hasText: 'Old Blender' }),
    ).toHaveCount(0, { timeout: SYNC_TIMEOUT });
  });
});
