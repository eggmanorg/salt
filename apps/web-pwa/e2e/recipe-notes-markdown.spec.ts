/**
 * Recipe notes formatting E2E (issue #717, Phase 2; rewritten for issue #1319
 * Phase 7).
 *
 * Covers Markdown notes where they are now written: the notes card ON THE RECIPE
 * PAGE. The Bold/Italic/List toolbar acting on the real textarea selection, the
 * rendered Markdown, and the fact that none of it changes what gets saved —
 * `notes` stays a plain Markdown string.
 *
 * WHAT CHANGED AND WHY THE COVERAGE DID NOT SHRINK. The retired editor had an
 * Edit/Preview pair and a Save button, and this spec used to drive both. The card
 * has neither, deliberately: it renders the note as Markdown whenever it is not
 * being typed into, so the preview IS the read state (`RecipeNotesCard`'s header
 * says so), and there is no Save because every keystroke writes itself. So the
 * three things the old preview assertions pinned are pinned here against the
 * CLOSED card instead — the same `<Markdown … breaks />`, reached by closing the
 * box rather than by toggling a mode.
 *
 * The recipe the note hangs on is BRIDGE-SEEDED (NF-C4). Phase 8 deleted the
 * editor's routes outright, so there is no by-hand path left to author one — and
 * authoring was never this spec's subject, only the note is.
 *
 * No AI and no second tab: single-tab local state plus the coalesced write, so
 * SYNC_TIMEOUT is the only budget needed.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { settleRecipeWrites } from './helpers/settle';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { Recipe } from '@salt/domain';

// A phone, pinned explicitly — same reason as `recipe-crud.spec.ts`: the recipe
// view page docks its chat column from 700x480 up, and the notes assertions here
// are written for the single-column layout. It also puts the toolbar on the width
// that actually has to fit it.
test.use({ viewport: { width: 393, height: 851 } });

const NOTE = 'watch the **salt**\nghee not *butter*\n- rest it for ten minutes';

const RECIPE_ID = 'notes-formatting-test';

// A recipe with nothing on it but a name — the note is what this spec writes, so
// everything else is deliberately empty. Bridge-seeded (NF-C4): there is no
// by-hand path left for a recipe since issue #1319 Phase 8 deleted the editor,
// and authoring one was never what this spec was about.
const RECIPE: Recipe = {
  id: RECIPE_ID,
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Notes Formatting Test',
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

test.describe('recipes — notes formatting toolbar and rendering', () => {
  test('toolbar formats the selection, the closed card renders it, and the stored string stays plain', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Seed a recipe to hang a note on ──────────────────────────────────────
    // Through the bridge, then opened. `recipe-view` is the arrival signal: the
    // page renders nothing under it until the seeded document has reached the
    // store, whereas the URL is whatever `goto` was given the moment it returned.
    await seedRecipe(page, RECIPE);
    await page.goto(`/#/recipes/${RECIPE_ID}`);
    await expect(page.getByTestId('recipe-view')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // ── Open the note where it is read ───────────────────────────────────────
    // A recipe with no note shows nothing at all until the page is editing, and
    // then a dashed slot — which is the thing to tap.
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-notes').click();
    const notes = page.getByTestId('recipe-notes-input');
    await expect(notes).toBeVisible();

    /**
     * Select the last `length` characters by walking left with Shift held.
     *
     * Deliberately not `Shift+Home`: on macOS Chromium, Home is
     * "start of document", not "start of line", so a line-based selection
     * silently means something different locally than it does on the Linux CI
     * runners. Arrow keys move one character on every platform.
     */
    async function selectLastChars(length: number): Promise<void> {
      for (let i = 0; i < length; i++) await notes.press('Shift+ArrowLeft');
    }

    // ── Bold wraps a selection inside the line, not the whole line ───────────
    await notes.fill('watch the salt');
    await selectLastChars('salt'.length);
    await page.getByTestId('recipe-notes-bold-btn').click();
    await expect(notes).toHaveValue('watch the **salt**');

    // ── Italic wraps a selection on a second line ────────────────────────────
    // The toolbar leaves the caret at the end of what it inserted, which here is
    // the end of the text — so typing continues from there.
    await notes.pressSequentially('\nghee not butter');
    await selectLastChars('butter'.length);
    await page.getByTestId('recipe-notes-italic-btn').click();
    await expect(notes).toHaveValue('watch the **salt**\nghee not *butter*');

    // ── List prefixes the caret's own line, with no selection at all ─────────
    await notes.pressSequentially('\nrest it for ten minutes');
    await page.getByTestId('recipe-notes-list-btn').click();
    await expect(notes).toHaveValue(NOTE);

    // ── Closing the box renders the Markdown, not the markers ────────────────
    // This is where the old Edit/Preview toggle went: there is one rendering, the
    // read state, so a preview cannot disagree with what the page shows.
    await page.getByTestId('recipe-notes-done').click();
    await expect(notes).toHaveCount(0);
    // The toolbar goes with the textarea it drives — there is no selection to
    // act on once the box is closed.
    await expect(page.getByTestId('recipe-notes-bold-btn')).toHaveCount(0);
    // A real list item is the accessible-role proof that `- ` was parsed rather
    // than displayed; the marker assertions prove the same for bold/italic.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'rest it for ten minutes' }),
    ).toHaveCount(1);
    await expect(page.getByText('**watch the salt**')).toHaveCount(0);
    await expect(page.getByText('- rest it for ten minutes')).toHaveCount(0);

    // ── Re-opening the box loses nothing ─────────────────────────────────────
    await page.getByTestId('recipe-edit-notes').click();
    await expect(page.getByTestId('recipe-notes-input')).toHaveValue(NOTE);
    await page.getByTestId('recipe-notes-done').click();

    // ── Done, then a REAL reload: the stored string is the same plain Markdown ─
    // This used to be a `page.goto` back to the URL the page was already on — a
    // same-document hash navigation that never remounts, so it proved the store
    // still held the note and nothing whatever about Firestore (PR #1340 review,
    // should-fix 8). It could not be turned into a `page.reload()` at the time
    // because a reload straight after Done races the coalesced flush, which is
    // the race `recipe-crud.spec.ts` documented and declined.
    //
    // Issue #1304 supplied the missing signal: `settleRecipeWrites` resolves only
    // once Firestore has acked the write Done issued — including a write already
    // on the wire, which is precisely this case, since Done itself flushes. So
    // the reload below tears the app down and rebuilds it from the server, and
    // what comes back is the STORED string rather than a survivor of the store.
    await page.getByTestId('recipe-done-button').click();
    await settleRecipeWrites(page);
    await page.reload();
    await expect(
      page.getByRole('listitem').filter({ hasText: 'rest it for ten minutes' }),
    ).toHaveCount(1, { timeout: SYNC_TIMEOUT });
    await expect(page.getByText('**watch the salt**')).toHaveCount(0);

    // …and the stored value is still the markers, not the rendering.
    await page.getByTestId('recipe-edit-mode-button').click();
    await page.getByTestId('recipe-edit-notes').click();
    await expect(page.getByTestId('recipe-notes-input')).toHaveValue(NOTE, {
      timeout: SYNC_TIMEOUT,
    });
  });
});
