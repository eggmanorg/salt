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
 * No AI and no second tab: single-tab local state plus the coalesced write, so
 * SYNC_TIMEOUT is the only budget needed.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly — same reason as `recipe-crud.spec.ts`: the recipe
// view page docks its chat column from 700x480 up, and the notes assertions here
// are written for the single-column layout. It also puts the toolbar on the width
// that actually has to fit it.
test.use({ viewport: { width: 393, height: 851 } });

const NOTE = 'watch the **salt**\nghee not *butter*\n- rest it for ten minutes';

test.describe('recipes — notes formatting toolbar and rendering', () => {
  test('toolbar formats the selection, the closed card renders it, and the stored string stays plain', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });

    // ── Seed a recipe to hang a note on ──────────────────────────────────────
    // Still the retired editor: there is no by-hand path left for a recipe, so this
    // moves to the `seedRecipe` bridge when Phase 8 deletes the route. Nothing
    // below touches the editor again.
    await page.goto('/#/recipes/new');
    await expect(page.getByRole('heading', { name: /new recipe/i })).toBeVisible();
    await page.getByTestId('recipe-title-input').fill('Notes Formatting Test');
    await page.getByTestId('recipe-save-btn').click();
    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    const recipeUrl = page.url();

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

    // ── Done, then a reload: the stored string is the same plain Markdown ────
    // There is no Save, so the flush on leaving edit mode is what commits it —
    // and a reload is the only honest way to assert what actually landed.
    await page.getByTestId('recipe-done-button').click();
    await page.goto(`/#${recipeUrl.split('#')[1]}`);
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
