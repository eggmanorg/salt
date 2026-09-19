/**
 * Chef chat E2E (issue #206 / test-infra Phase 5).
 *
 * First e2e for the chat module. Drives the full chat lifecycle through the UI
 * with a deterministically stubbed assistant reply, and proves owner-scoping —
 * Chat is the ONE owner-scoped exception to Salt's "all data is family-shared"
 * rule (every chatSessions read/write is filtered by ownerUid).
 *
 *   stubAi('chefChat', …) + stubAi('generateChatTitle', …) write the canned
 *     model answers to the shared emulator Firestore
 *     → "New chat" creates a chatSessions doc owned by the signed-in user
 *       → sending a message calls the REAL streaming chefChat callable, whose
 *         Genkit *model* is the deterministic fake under FUNCTIONS_AI_FAKE=1
 *         (the Phase 1 seam; see fakeModel.ts)
 *         → the user + stubbed assistant turns render and persist to Firestore
 *           → reload re-hydrates the session from Firestore (round-trip)
 *             → a second user (separate browser context) sees ZERO sessions,
 *               because the realtime subscription is owner-scoped.
 *
 * Only the model output is faked: the callable boundary, the Genkit flow, the
 * Firestore writes and the realtime store subscription are all production paths.
 * The owner-scoping query (`where('ownerUid', '==', uid)`) is exercised live.
 *
 * THE TURN IS WRITTEN BY THE FLOW since #1430, not by the browser — so the reload
 * block below is now the end-to-end statement of that: the document it re-hydrates
 * from was written server-side, and the ownerUid check that permitted the write is
 * the flow's own, not `firestore.rules`'. The cross-user block after it carries
 * more weight for the same reason — user B's store must stay empty although a
 * Cloud Function, which the rules do not constrain, is now a writer here.
 *
 * Asserts the conversation in BOTH the chat-sessions store (via the
 * window.__e2e.getChatSessions bridge) and the rendered DOM, plus reload
 * persistence and cross-user isolation.
 */
import { expect, test } from './fixtures/test';
import { gotoAndSignIn, uniqueEmail } from './helpers/auth';
import { SYNC_TIMEOUT } from './helpers/timeouts';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';
import type { Page } from '@playwright/test';

// The canned assistant reply. The chefChat flow's output schema is z.string(),
// so the fake model returns JSON.stringify(<this string>) and Genkit's string
// formatter parses it back to the plain string. A phrase a real model would
// never produce verbatim, so its appearance can only come from the stub.
const STUB_REPLY = 'Deterministic stubbed chef reply: sear the halloumi.';

// generateChatTitle also runs (fire-and-forget) after the first exchange and
// hits the fake model too — stub it so it returns a deterministic title rather
// than throwing "no stub registered" inside the background title call.
const STUB_TITLE = 'Stubbed Halloumi Chat';

const USER_MESSAGE = 'How do I cook halloumi?';

async function getSessions(page: Page): Promise<ChatSessionDoc[]> {
  return page.evaluate<ChatSessionDoc[]>(() => window.__e2e!.getChatSessions() as ChatSessionDoc[]);
}

test.describe('chat — stubbed chef reply, lifecycle, owner-scoping', () => {
  test('start a session, send a message, see the stubbed reply, persist, and stay owner-scoped', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      const emailA = uniqueEmail(testInfo.testId + '-a');
      const emailB = uniqueEmail(testInfo.testId + '-b');

      // User A signs in on the chat list (chat is NOT admin-gated).
      await gotoAndSignIn(page1, emailA, '/#/chat');

      // ── Register the canned model answers BEFORE driving the UI ────────────
      await page1.evaluate((reply) => window.__e2e!.stubAi('chefChat', reply), STUB_REPLY);
      await page1.evaluate((title) => window.__e2e!.stubAi('generateChatTitle', title), STUB_TITLE);

      // ── Lifecycle: list starts empty ──────────────────────────────────────
      await expect(page1.getByTestId('chat-new-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });
      await expect.poll(() => getSessions(page1), { timeout: SYNC_TIMEOUT }).toHaveLength(0);
      await expect(page1.getByTestId('chat-session-item')).toHaveCount(0);

      // ── Create a session → land on /#/chat/:id ────────────────────────────
      await page1.getByTestId('chat-new-btn').click();
      await expect(page1).toHaveURL(/#\/chat\/[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
      const sessionUrl = page1.url();
      const sessionId = sessionUrl.match(/#\/chat\/([a-z0-9-]+)/)?.[1];
      expect(sessionId).toBeTruthy();

      // ── Type and send a message ───────────────────────────────────────────
      await expect(page1.getByTestId('chat-input')).toBeVisible();
      await page1.getByTestId('chat-input').fill(USER_MESSAGE);
      await page1.getByTestId('chat-send-btn').click();

      // The user turn renders.
      await expect(
        page1.getByTestId('chat-message-user').filter({ hasText: USER_MESSAGE }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });

      // The stubbed assistant turn renders — the streaming chefChat callable ran
      // against the fake model and the reply round-tripped through Firestore.
      await expect(
        page1.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
      ).toBeVisible({ timeout: 30_000 });

      // ── Assert the conversation landed in the owner-scoped store ───────────
      await expect
        .poll(
          async () => {
            const s = (await getSessions(page1)).find((x) => x.id === sessionId);
            return s?.messages.map((m) => `${m.role}:${m.text}`) ?? [];
          },
          { timeout: SYNC_TIMEOUT },
        )
        .toEqual([`user:${USER_MESSAGE}`, `assistant:${STUB_REPLY}`]);

      const stored = (await getSessions(page1)).find((x) => x.id === sessionId)!;
      expect(stored.ownerUid).toBeTruthy();

      // ── Back nav → the list now shows the session ─────────────────────────
      // The back control is labelled generically ("Back") since `goBack` returns
      // to wherever you came from — here the chat list you pushed from.
      await page1.getByRole('button', { name: 'Back' }).click();
      await expect(page1).toHaveURL(/#\/chat$/, { timeout: SYNC_TIMEOUT });
      await expect(page1.getByTestId('chat-session-item')).toHaveCount(1, {
        timeout: SYNC_TIMEOUT,
      });

      // ── Reload persistence: the messages survive a Firestore round-trip ───
      await page1.goto(sessionUrl);
      await expect(
        page1.getByTestId('chat-message-user').filter({ hasText: USER_MESSAGE }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });
      await expect(
        page1.getByTestId('chat-message-assistant').filter({ hasText: STUB_REPLY }),
      ).toBeVisible({ timeout: SYNC_TIMEOUT });

      await expect
        .poll(
          async () => {
            const s = (await getSessions(page1)).find((x) => x.id === sessionId);
            return s?.messages.length ?? 0;
          },
          { timeout: SYNC_TIMEOUT },
        )
        .toBe(2);

      // ── Owner-scoping: user B (separate context) sees ZERO sessions ───────
      // The chatSessions subscription filters where ownerUid == uid, so user B's
      // store must never contain user A's session — the crux of the owner-scoped
      // Chat exception. Assert via BOTH the store snapshot and the empty DOM.
      await gotoAndSignIn(page2, emailB, '/#/chat');
      await expect(page2.getByTestId('chat-new-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });

      // User B's store stays empty even after a settling window (it must never
      // receive user A's owner-scoped session).
      await expect.poll(() => getSessions(page2), { timeout: SYNC_TIMEOUT }).toHaveLength(0);
      // Hold for a moment and re-assert: no cross-user leak ever arrives.
      // eslint-disable-next-line playwright/no-wait-for-timeout -- NF-A2: bounded negative hold (no cross-user leak)
      await page2.waitForTimeout(2000);
      expect(await getSessions(page2)).toHaveLength(0);
      await expect(page2.getByTestId('chat-session-item')).toHaveCount(0);

      // User A still sees their own session (no regression from B signing in).
      await expect.poll(() => getSessions(page1), { timeout: SYNC_TIMEOUT }).toHaveLength(1);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

/**
 * Asking the chef to save a recipe (issue #1480), end to end.
 *
 * The journey the floppy-disc icon already serves, reached by saying so instead:
 *
 *   stubAi('chefChat', { tool: 'saveRecipe', then: … }) — the tool-call stub the
 *     fake model gained with this issue, which makes it request a tool on its
 *     first pass and speak on its second
 *     → sending "create a recipe from this" runs the REAL chefChat callable,
 *       whose Genkit tool loop calls the real `saveRecipe` tool
 *       → the flow records the request on `chatSessions/{id}` and the browser
 *         picks it up off the subscription it already runs
 *         → `authorRecipeFromChat` runs — the same leg the button runs — and
 *           lands on the finished recipe, which the conversation now belongs to
 *
 * NOBODY TOUCHES THE BUTTON, and the spec never looks for it: that is the whole
 * assertion. What proves the save was the chef's is that the navigation and the
 * recipe happen with no click between sending the message and arriving.
 *
 * BOTH FEATURE GATES ARE OPEN HERE because there is no PostHog key in the
 * emulator build, and "unconfigured means ungated" on both sides
 * (`isObservabilityFeatureEnabled`, `isServerFeatureEnabled`). So this covers the
 * flag-ON path only; the flag-OFF path is a unit concern and is pinned in
 * `chefChat.saveIntent.test.ts` and `ChatSessionPage.saveIntent.test.ts`.
 */
const SAVE_REQUEST = 'create a recipe from this';
const SAVE_REPLY = 'Deterministic stubbed chef reply: saving that for you now.';
const SAVED_TITLE = 'Stubbed Halloumi Skewers';
const SAVED_INGREDIENT = '250 g halloumi';
const SAVED_STEP = 'Grill until the cheese takes colour on both sides.';

// The librarian's canned answer — the same create path the button takes.
const STUB_AUTHOR = {
  title: SAVED_TITLE,
  kind: 'recipe',
  description: 'Squeaky, charred, quick.',
  servings: 2,
  tags: ['quick'],
  ingredientGroups: [
    {
      name: null,
      ingredients: [{ rawText: SAVED_INGREDIENT, isOptional: false, firstUsedInStepOrdinal: 0 }],
    },
  ],
  steps: [{ text: SAVED_STEP, timerMinutes: null, timerLabel: null, note: null }],
  notes: null,
};

// `assembleRecipeDraft` re-parses every ingredient on the create path, so the
// parse model is reached too.
const STUB_PARSE = {
  groups: [
    {
      name: null,
      items: [
        {
          rawText: SAVED_INGREDIENT,
          quantity: { type: 'single' as const, value: 250 },
          unit: 'g' as const,
          item: 'halloumi',
          preparation: [],
          notes: null,
          isOptional: false,
          displayText: '250 g',
        },
      ],
    },
  ],
};

async function getRecipes(page: Page): Promise<Recipe[]> {
  return page.evaluate<Recipe[]>(() => window.__e2e!.getRecipes() as Recipe[]);
}

test.describe('chat — asking the chef to save a recipe', () => {
  test('a save the chef was asked for lands on the recipe, with no button pressed', async ({
    page,
  }, testInfo) => {
    // 120s: a chat round-trip with a tool loop in it, then a librarian
    // round-trip, each gated on its own signal-bound wait below.
    test.setTimeout(120_000);
    const email = uniqueEmail(testInfo.testId);
    // Chat is not admin-gated; the recipe page this lands on is, while the module
    // is incomplete (#179).
    await gotoAndSignIn(page, email, '/#/chat', { admin: true });

    await page.evaluate(
      (then) => window.__e2e!.stubAi('chefChat', { tool: 'saveRecipe', then }),
      SAVE_REPLY,
    );
    await page.evaluate((t) => window.__e2e!.stubAi('generateChatTitle', t), STUB_TITLE);
    await page.evaluate((a) => window.__e2e!.stubAi('authorRecipe', a), STUB_AUTHOR);
    await page.evaluate((p) => window.__e2e!.stubAi('parseRecipeIngredients', p), STUB_PARSE);

    await expect(page.getByTestId('chat-new-btn')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await page.getByTestId('chat-new-btn').click();
    await expect(page).toHaveURL(/#\/chat\/[a-z0-9-]+$/, { timeout: SYNC_TIMEOUT });
    const sessionId = page.url().match(/#\/chat\/([a-z0-9-]+)/)?.[1];
    expect(sessionId).toBeTruthy();

    // ── Ask. And then touch nothing. ──────────────────────────────────────────
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await page.getByTestId('chat-input').fill(SAVE_REQUEST);
    await page.getByTestId('chat-send-btn').click();

    await expect(page).toHaveURL(/#\/recipes\/(?!new)[a-z0-9-]+$/, { timeout: 90_000 });
    const recipeId = page.url().match(/#\/recipes\/([a-z0-9-]+)/)?.[1];
    expect(recipeId).toBeTruthy();
    await expect(page.getByRole('heading', { name: SAVED_TITLE })).toBeVisible({
      timeout: SYNC_TIMEOUT,
    });

    // ── Indistinguishable from a button-saved recipe ──────────────────────────
    // Same create path, same attribution, no hero yet so the trigger draws one.
    await expect
      .poll(async () => (await getRecipes(page)).find((r) => r.id === recipeId)?.source, {
        timeout: SYNC_TIMEOUT,
      })
      .toEqual({ type: 'manual' });
    const saved = (await getRecipes(page)).find((r) => r.id === recipeId)!;
    expect(saved.producesCanonId ?? null).toBeNull();

    // ── The conversation now belongs to the dish it invented ─────────────────
    // `claimRecipe`, exactly as the button's handler runs it — the general leg
    // claims, and this is the general leg.
    await expect
      .poll(async () => (await getSessions(page)).find((s) => s.id === sessionId)?.recipeId, {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(recipeId);

    // ── The request was TAKEN, not merely read ───────────────────────────────
    // Cleared before the save ran, so a reload cannot save the same conversation
    // a second time.
    expect(
      (await getSessions(page)).find((s) => s.id === sessionId)?.pendingSaveIntent ?? null,
    ).toBeNull();
  });
});
