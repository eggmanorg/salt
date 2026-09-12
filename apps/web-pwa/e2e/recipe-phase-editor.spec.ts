/**
 * Hand-editing a recipe's phase strip, in a real browser (issue #1212, re-cut for
 * issue #1319 Phase 8).
 *
 * One journey, because the phase has one promise the model cannot keep for the
 * cook: what you type into the strip is what the recipe page draws, and it is
 * still there when you come back. That is a claim about a ROUND TRIP — the boxes →
 * the coalesced write → Firestore → a full reload → the boxes again — and every
 * jsdom test of it stops at the first arrow.
 *
 * WHERE THE TYPING HAPPENS NOW. The strip used to be a block in the recipe editor
 * at `/recipes/:id/edit`, and this spec drove that page. Phase 8 deleted it: the
 * strip is edited IN PLACE on `/#/recipes/:id` — Edit, tap the strip, type, Done —
 * and there is no Save button and no navigation, so the recipe itself is seeded
 * through the bridge (NF-C4) and the typing starts on the page that reads it. The
 * testids are the in-place editor's own (`recipe-phase-row`,
 * `recipe-phase-*-field`, `recipe-phase-add`, `recipe-phase-done`); the read-mode
 * drawing keeps the ones `recipe-phase-timeline.spec.ts` shares.
 *
 * It is still the sibling of `recipe-phase-timeline.spec.ts`, which seeds STRIPS
 * through the bridge because its subject is the drawing. Here the strip is typed
 * and only the recipe is seeded: the in-place editor is the seam under test.
 *
 * THE RELOAD IS FENCED. An in-place edit is coalesced — the store moves
 * synchronously and the `setDoc` lands at the end of the debounce window or on the
 * flush `Done` issues — and nothing the page renders says the round trip finished,
 * so a reload taken straight after Done races that flush (the race
 * `recipe-crud.spec.ts` documents and declines to run). The fence is
 * `storedPhaseLabels` below: it reads the Firestore document itself over the
 * emulator's REST API, so the reload happens only once the server genuinely holds
 * the strip, and what comes back after it can only have come from there.
 *
 * Since issue #1233 the strip is also the ONLY timing control on the page: the
 * three Prep / Cook / Total boxes are gone, because `scheduleFor` and
 * `insertComponentByElapsedTime` read the strip and nothing reads them. Their
 * absence is asserted below so a re-added box cannot slip back in unnoticed.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { FIRESTORE_DOCUMENTS_BASE_URL } from './helpers/emulator';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

// A phone, as `recipe-phase-timeline.spec.ts` pins: the recipe page docks its
// chat column from 700x480 up and this spec would otherwise inherit the
// project's desktop default.
test.use({ viewport: { width: 393, height: 851 } });

const DISH = 'Hand Edited Loaf';
const DISH_ID = 'hand-edited-loaf';

// A recipe with NO strip: the empty `phases` is the state the dashed
// `+ Add a phase` slot exists for, and it is what makes the first row below one
// this test genuinely created rather than one it inherited.
const DISH_FIXTURE: Recipe = {
  id: DISH_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: DISH,
  description: null,
  ingredients: [],
  steps: [],
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

interface PhaseInput {
  readonly label: string;
  readonly handsOn: string;
  readonly handsOff: string;
}

const TYPED: readonly PhaseInput[] = [
  { label: 'Mix and knead', handsOn: '20', handsOff: '0' },
  { label: 'Prove overnight', handsOn: '0', handsOff: '90' },
  { label: 'Shape and bake', handsOn: '10', handsOff: '30' },
];

// NF-B3: `nth` throughout this spec indexes the phase rows THIS test just added,
// in the order it added them — the order is the thing under test, so positional
// addressing is the point rather than a dodge. The rows carry no accessible name
// of their own (three identically-labelled fields per row), and the legend's
// `> li` / `> div` scoping is the same one `recipe-phase-timeline.spec.ts` uses.

/** Fill row `index` of the phase editor — the label and both minute figures. */
async function fillPhase(page: Page, index: number, phase: PhaseInput): Promise<void> {
  await page.getByTestId('recipe-phase-label-field').nth(index).fill(phase.label);
  await page.getByTestId('recipe-phase-hands-on-field').nth(index).fill(phase.handsOn);
  await page.getByTestId('recipe-phase-hands-off-field').nth(index).fill(phase.handsOff);
}

/** The legend's rows, in the order the strip draws them. */
function legendRows(page: Page) {
  return page.getByTestId('recipe-phase-legend').locator('> li');
}

/**
 * The phase labels as FIRESTORE holds them, read straight off the emulator's REST
 * API rather than out of the page.
 *
 * This is the settled-flush signal the reload below needs, and the only one
 * available from a spec: the store is updated optimistically, so nothing readable
 * in the browser distinguishes "written" from "about to be written". `Bearer
 * owner` bypasses the rules, exactly as the seeders in `helpers/seed.ts` do.
 */
interface FirestoreValue {
  readonly stringValue?: string;
  readonly mapValue?: { readonly fields?: Record<string, FirestoreValue> };
  readonly arrayValue?: { readonly values?: readonly FirestoreValue[] };
}

async function storedPhaseLabels(recipeId: string): Promise<readonly string[]> {
  const res = await fetch(`${FIRESTORE_DOCUMENTS_BASE_URL}/recipes/${recipeId}`, {
    headers: { Authorization: 'Bearer owner' },
  });
  if (!res.ok) return [];
  const doc = (await res.json()) as { fields?: Record<string, FirestoreValue> };
  const phases = doc.fields?.['metadata']?.mapValue?.fields?.['phases']?.arrayValue?.values ?? [];
  return phases.map((p) => p.mapValue?.fields?.['label']?.stringValue ?? '');
}

test.describe('recipes — hand-editing the phase strip', () => {
  test('what the cook types is what the timeline draws, and it survives a reload', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── A dish with no timing on it yet ──────────────────────────────────────
    await seedRecipe(page, DISH_FIXTURE);
    await page.goto(`/#/recipes/${DISH_ID}`);
    // The arrival: nothing renders under `recipe-view` until the seeded document
    // has reached the store. The URL is already the one `goto` was handed.
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByRole('heading', { name: DISH })).toBeVisible();
    // A recipe with no strip draws none while it is being read.
    await expect(page.getByTestId('recipe-phases')).toHaveCount(0);

    // ── Time it by hand, where it is read ────────────────────────────────────
    // The dashed slot exists only in edit mode, and opening it produces the first
    // row itself — `+ Add a phase` is an imperative, so the tap that promises a
    // phase delivers one.
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-phases').click();
    await expect(page.getByTestId('recipe-phase-row')).toHaveCount(1);

    // The phase editor is the ONLY timing control on the page (issue #1233): the
    // three Prep/Cook/Total boxes went with the last reader of the stored times,
    // and the fields themselves went with #1211.
    await expect(page.getByTestId('recipe-prep-input')).toHaveCount(0);
    await expect(page.getByTestId('recipe-cook-input')).toHaveCount(0);
    await expect(page.getByTestId('recipe-total-input')).toHaveCount(0);

    // Row one came with the slot; every phase after it is an explicit Add.
    await fillPhase(page, 0, TYPED[0]!);
    for (let i = 1; i < TYPED.length; i += 1) {
      await page.getByTestId('recipe-phase-add').click();
      await fillPhase(page, i, TYPED[i]!);
    }
    await expect(page.getByTestId('recipe-phase-row')).toHaveCount(3);

    // ── Closed, and out of edit mode: the page draws exactly that strip ───────
    // Each assertion follows the gesture that changes it: closing the zone takes
    // the rows away, and Done takes the pencil that reopens them.
    await page.getByTestId('recipe-phase-done').click();
    await expect(page.getByTestId('recipe-phase-row')).toHaveCount(0);
    await page.getByTestId('recipe-done-button').click();
    await expect(page.getByTestId('recipe-edit-phases')).toHaveCount(0);

    await expect(page.getByTestId('recipe-phases')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(legendRows(page)).toHaveCount(3);
    await expect(page.getByTestId('recipe-phase-timeline-bar').locator('> div')).toHaveCount(3);
    for (const phase of TYPED) {
      await expect(page.getByTestId('recipe-phase-legend')).toContainText(phase.label);
    }

    // ── It reads back into the boxes, from Firestore, after a full reload ─────
    // Fenced on the document itself, not on anything the page says: see the
    // header. Only once the server holds all three labels is the reload honest.
    await expect
      .poll(() => storedPhaseLabels(DISH_ID), { timeout: SYNC_TIMEOUT })
      .toEqual(TYPED.map((p) => p.label));

    await page.reload();
    await expect(page.getByTestId('recipe-phases')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-phases').click();
    await expect(page.getByTestId('recipe-phase-row')).toHaveCount(3);
    await expect(page.getByTestId('recipe-phase-label-field').nth(1)).toHaveValue(
      'Prove overnight',
    );
    await expect(page.getByTestId('recipe-phase-hands-off-field').nth(1)).toHaveValue('90');

    // ── Correct it: reorder, rename, retime, delete ──────────────────────────
    await page.getByLabel('Move phase up').nth(2).click();
    await page.getByTestId('recipe-phase-label-field').nth(0).fill('Mix, knead and rest');
    await page.getByTestId('recipe-phase-hands-on-field').nth(0).fill('25');
    await page.getByLabel('Remove phase').nth(2).click();
    await expect(page.getByTestId('recipe-phase-row')).toHaveCount(2);

    await page.getByTestId('recipe-phase-done').click();
    await page.getByTestId('recipe-done-button').click();

    await expect(legendRows(page)).toHaveCount(2, { timeout: SYNC_TIMEOUT });
    await expect(legendRows(page).nth(0)).toContainText('Mix, knead and rest');
    await expect(legendRows(page).nth(1)).toContainText('Shape and bake');
    await expect(page.getByTestId('recipe-phase-legend')).not.toContainText('Prove overnight');
  });
});
