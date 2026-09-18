/**
 * The planning timeline, in a real browser (issue #1122).
 *
 * One journey, because the phase has one promise: a recipe that carries a phase
 * strip reads its timing FROM THE STRIP everywhere it is shown. Issue #1213 took
 * the feature key and the old-field fallbacks away entirely, so the second recipe
 * here is the one with no strip at all: it stores prep 15 / cook 30 / total 45 and
 * shows none of them, on the list or on the recipe page.
 *
 * What needs a real browser is exactly what jsdom cannot say: that the two
 * recipes' figures come back from Firestore and render side by side on the list,
 * and that the timeline draws a block per phase on the recipe page rather than
 * merely existing in the DOM. The width arithmetic itself is pinned in
 * `tests/phaseTimeline.test.ts`.
 *
 * Recipes are bridge-seeded (NF-C4): a hand-built strip is the cheapest way to get
 * one that is deliberately at odds with the stored numbers.
 */
import type { Recipe, RecipePhase } from '@salt/domain';
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { seedRecipe } from './helpers/seed';
import { SYNC_TIMEOUT } from './helpers/timeouts';

// A phone, pinned explicitly, as `meal-cook-plan.spec.ts` does: the recipe page
// docks its chat column from 700x480 up and this spec would otherwise inherit the
// project's desktop default.
test.use({ viewport: { width: 393, height: 851 } });

const LOAF_ID = 'phase-loaf';
const PASTA_ID = 'phase-pasta';

// A bread: three phases, one of them an overnight prove well over the drawing cap.
// 20 + 720 + 40 = 780 minutes, of which 30 are hands-on.
const LOAF_PHASES: RecipePhase[] = [
  { label: 'Mix and knead', handsOnMinutes: 20, handsOffMinutes: 0 },
  { label: 'Prove overnight', handsOnMinutes: 0, handsOffMinutes: 720 },
  { label: 'Shape and bake', handsOnMinutes: 10, handsOffMinutes: 30 },
];

function recipe(id: string, title: string, phases?: RecipePhase[]): Recipe {
  return {
    cureCategory: null,
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: 2,
      // The old fields the strip replaces. The loaf's are deliberately WRONG
      // against its phases, so nothing below can pass by reading them.
      tags: [],
      ...(phases === undefined ? {} : { phases, timingSummary: 'Half an hour of you, overnight.' }),
    },
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

test.describe('recipes — the planning timeline', () => {
  test('a recipe with phases reads from them; one without is untouched', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const email = uniqueEmail(testInfo.testId);
    // Recipes are gated to admins while the module is incomplete (#179).
    await gotoAndSignIn(page, email, '/', { admin: true });
    await seedRecipe(page, recipe(LOAF_ID, 'Overnight loaf', LOAF_PHASES));
    await seedRecipe(page, recipe(PASTA_ID, 'Ten minute pasta'));

    // ── The list: the chip is the strip's sum, or nothing ────────────────────
    await page.goto('/#/recipes');
    const loafCard = page.getByTestId('recipe-list-item').filter({ hasText: 'Overnight loaf' });
    await expect(loafCard).toContainText('13 hr', { timeout: SYNC_TIMEOUT });
    await expect(loafCard).not.toContainText('45 min');
    // And the recipe with no strip carries no chip: #1213 took away the fallback
    // to a stored total, and #1211 the field it fell back to — a recipe with no
    // strip has no timing to show. ("min", unqualified, would match the title.)
    const pastaCard = page.getByTestId('recipe-list-item').filter({ hasText: 'Ten minute pasta' });
    await expect(pastaCard).not.toContainText('45 min');
    await expect(pastaCard).not.toContainText('30 min');
    await expect(pastaCard).not.toContainText('15 min');

    // ── The recipe page: the strip is drawn, and the chips are gone ──────────
    await page.goto(`/#/recipes/${LOAF_ID}`);
    await expect(page.getByTestId('recipe-phases')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(page.getByTestId('recipe-timing-summary')).toHaveText(
      'Half an hour of you, overnight.',
    );

    // A block per phase, and a legend row per phase carrying every word.
    const bar = page.getByTestId('recipe-phase-timeline-bar');
    await expect(bar.locator('> div')).toHaveCount(LOAF_PHASES.length);
    const legend = page.getByTestId('recipe-phase-legend');
    await expect(legend.locator('> li')).toHaveCount(LOAF_PHASES.length);
    await expect(legend).toContainText('Prove overnight');
    await expect(legend).toContainText('12 hr hands-off');
    // The overnight prove is drawn shortened, and the strip says so in words.
    await expect(page.getByTestId('recipe-phase-shortened')).toHaveCount(1);
    await expect(page.getByTestId('recipe-phase-totals')).toContainText('13 hr start to finish');
    await expect(page.getByTestId('recipe-phase-totals')).toContainText('30 min hands-on');

    // The two accounts of the same fact are down to one.
    await expect(page.getByText('Prep 15 min')).toHaveCount(0);
    await expect(page.getByText('Cook 30 min')).toHaveCount(0);
    await expect(page.getByText('Total 45 min')).toHaveCount(0);

    // ── And a recipe with no strip shows no timing at all, not the old numbers ─
    // The fallback is gone rather than unreached (#1213): this document still
    // carries all three stored values, and the page shows none of them.
    await page.goto(`/#/recipes/${PASTA_ID}`);
    await expect(page.getByRole('heading', { name: 'Ten minute pasta' })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('recipe-phases')).toHaveCount(0);
    await expect(page.getByText('Total 45 min')).toHaveCount(0);
    await expect(page.getByText('Prep 15 min')).toHaveCount(0);
    await expect(page.getByText('Cook 30 min')).toHaveCount(0);
    await expect(page.getByTestId('recipe-cook-shape')).toHaveCount(0);
  });
});
