/**
 * The trigger-driven AI deadline, pinned against the quota of the function it
 * actually runs in (issue #1418, root CLAUDE.md rule 12).
 *
 * ── What went wrong, and why a prose comment was not enough ──────────────────
 *
 * `identifyRecipeKit` and `estimateRecipeTimes` took `AI_TEXT_FLOW_TIMEOUT`, a
 * 55s budget whose header justified both its number and its lack of a retry
 * entirely in terms of CALLABLES — "a human pressing a button they can press
 * again", inside "the 90–120s function quota these flows are exported with".
 * Neither flow is exported as a callable at all. Their only host is
 * `onRecipeWritten`, a Firestore trigger deployed at 300s that nobody is waiting
 * on, and whose kit branch is edge-triggered on a nonce so a failure re-fires
 * for nobody. Four production recipes arrived with no kit in the thirteen days
 * to 2026-09-17, and on the two traced failures the model had in fact FINISHED
 * and returned a correct answer that we discarded at 55s.
 *
 * `generateGuidedPlan.ts` states the same relationship in prose, in capitals,
 * and guarantees nothing. `proposeSchedule` pairs its deadlines through named
 * constants AND a test. This file is that test for the trigger; its other half
 * — which budget each flow actually passes — is `flows/triggerFlowBudget.test.ts`,
 * kept apart so neither file has to mock the other's world (UT-B1/UT-B2).
 *
 * ── The two-sided invariant, and why both sides matter ───────────────────────
 *
 *   quota − headroom  ≤  AI budget  <  quota
 *
 *  • STRICTLY BELOW the quota, because that is the deadline's only legitimate
 *    job here. Cloud Run enforcing `timeoutSeconds` kills the invocation
 *    outright: no `logger.error`, no `reportServerError`, no mark on the
 *    document. Giving up first is what turns a silent platform kill into a
 *    recorded failure. It is NOT a cost control — `withAiTimeout` is a
 *    `Promise.race` with no `AbortController`, so the upstream call is billed
 *    whether we wait for it or not.
 *  • AT LEAST quota − headroom, which is the half that was broken and the half
 *    this file exists for. A budget far below the quota abandons work the
 *    function still had minutes to finish, and which has already been paid for.
 *
 * ── Why it reads the REGISTERED options, not the constant ────────────────────
 *
 * `onRecipeWritten` imports `AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS` for its own
 * `timeoutSeconds`, so today they cannot drift. Asserting the constant against
 * itself would pin nothing against the one way they still can: somebody putting
 * a literal back. So the trigger's real options object is captured below as it
 * is handed to `onDocumentWritten` — the same object the deploy reads.
 *
 * Verified red three ways before it was kept: flows reverted to the callable
 * budget, the budget shrunk back to 55s, and a literal `timeoutSeconds` put back
 * on the trigger. Each breaks two of these assertions.
 */
import { describe, it, expect, vi } from 'vitest';

// The registered trigger options, captured as the module loads. Five mocks, and
// every one of them is a module this file genuinely cannot import for real
// (UT-B2): they are the Firebase runtime, not collaborators of the unit.
let recipeTriggerOptions: { timeoutSeconds?: number } | undefined;
vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (opts: { timeoutSeconds?: number }, handler: unknown) => {
    recipeTriggerOptions = opts;
    return handler;
  },
}));
vi.mock('firebase-functions/params', () => ({ defineSecret: () => ({ value: () => '' }) }));
vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({}),
  FieldValue: { delete: () => 'DELETE' },
}));
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({}) }));

// Imported for real — the constants under test must be the real ones.
const {
  AI_TEXT_FLOW_TIMEOUT,
  AI_TRIGGER_FLOW_TIMEOUT,
  AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS,
  AI_TRIGGER_RECORDING_HEADROOM_MS,
} = await import('../src/adapters/withAiTimeout.js');

// Importing the trigger is what populates `recipeTriggerOptions` above.
await import('../src/triggers/onRecipeWritten.js');

describe('onRecipeWritten: the AI deadline is sized against the quota it runs in', () => {
  it('is registered with the named quota, not a literal that can drift', () => {
    expect(recipeTriggerOptions?.timeoutSeconds).toBe(AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS);
  });

  it('gives up before the platform does, leaving time to record the failure', () => {
    const quotaMs = (recipeTriggerOptions?.timeoutSeconds ?? 0) * 1000;
    expect(quotaMs).toBeGreaterThan(0);
    expect(AI_TRIGGER_FLOW_TIMEOUT.timeoutMs).toBeLessThan(quotaMs);
    expect(quotaMs - AI_TRIGGER_FLOW_TIMEOUT.timeoutMs).toBeGreaterThanOrEqual(
      AI_TRIGGER_RECORDING_HEADROOM_MS,
    );
  });

  it('does not abandon work the function still had time to finish', () => {
    // The half that was broken: 55s inside a 300s quota threw away answers that
    // had already been produced and already been paid for.
    const quotaMs = (recipeTriggerOptions?.timeoutSeconds ?? 0) * 1000;
    expect(AI_TRIGGER_FLOW_TIMEOUT.timeoutMs).toBeGreaterThanOrEqual(
      quotaMs - AI_TRIGGER_RECORDING_HEADROOM_MS,
    );
  });

  it('stays inside the 540s platform maximum for an event-driven function', () => {
    // Firebase forcibly terminates an event-driven function at 540s — a platform
    // maximum, not a default. A quota raised past it deploys and then dies.
    expect(AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS).toBeLessThanOrEqual(540);
  });

  it('does not retry, because a second attempt could not fit in the quota', () => {
    const attempts = AI_TRIGGER_FLOW_TIMEOUT.retries + 1;
    expect(AI_TRIGGER_FLOW_TIMEOUT.timeoutMs * attempts).toBeLessThan(
      AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS * 1000,
    );
  });

  it('leaves the callable budget alone', () => {
    // Out of scope by decision (issue #1418): a user is watching those, and a
    // longer spinner is not obviously kinder.
    expect(AI_TEXT_FLOW_TIMEOUT).toEqual({ timeoutMs: 55_000, retries: 0 });
    expect(AI_TRIGGER_FLOW_TIMEOUT.timeoutMs).toBeGreaterThan(AI_TEXT_FLOW_TIMEOUT.timeoutMs);
  });
});
