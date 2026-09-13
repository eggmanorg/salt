// Journey 5 — cook session + timer dispatch (issue #722).
//
// OPT-IN, and not for cost: arming a timer with `notify: true` ends in a real
// push to whatever devices the owner has registered, and the Pushover secrets
// are provisioned in dev and staging. A probe must not silently buzz someone's
// phone on every sweep. `notify: false` is not an alternative —
// `onCookTimerWrite` only enqueues a task for a newly-armed *notify* timer, so
// there would be nothing to dispatch and nothing to assert.
//
// The chain under test is the one no emulator suite covers end to end:
//
//   cookSessions write → onCookTimerWrite enqueues a Cloud Task
//                      → onCookTimerDispatch claims the exactly-once ledger
//                      → timerDeliveries/{sessionId}_{timerId}_{endsAtMs}
//
// The ledger is a SEPARATE server-owned doc, never a write-back onto the
// client-owned session (a full-document setDoc would clobber it under LWW), and
// it is claimed transactionally *before* any push is attempted — so the
// assertion holds whether or not a device is actually registered.

import { CookSessionSchema } from '@salt/domain/schemas';

import { writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert } from '../harness/runner.js';

/** Long enough to write the session before it fires, short enough to wait on. */
const TIMER_LEAD_MS = 25_000;
/** Task scheduling latency on top of the lead time. */
const DELIVERY_TIMEOUT_MS = 180_000;
/** How long to watch for a (wrong) second delivery. */
const DUPLICATE_WATCH_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const cookTimer: Journey = {
  name: 'cook-timer',
  description: 'A cook-session timer dispatches once, through the exactly-once ledger.',
  domain: 'cooking',
  optIn: 'sends a real push notification to the owner’s registered devices',

  async run(ctx) {
    const recipeId = ctx.id('recipe');
    // Deterministic id, so it inherits the probe- prefix from the recipe id.
    const sessionId = `${recipeId}_${ctx.identity.uid}`;
    const stepId = `${recipeId}-step-1`;
    // A step timer's identity IS its step id (#748); the ledger and the Cloud
    // Task payload are both keyed by the TIMER id, which here is the same string.
    const timerId = stepId;
    const now = new Date();
    const nowIso = now.toISOString();

    ctx.track('recipes', recipeId);
    ctx.track('cookSessions', sessionId);

    // The dispatcher re-reads the recipe to title the notification, so the
    // recipe has to exist. `image` is pre-set to keep onRecipeWritten from
    // generating a hero this journey does not assert on.
    await ctx.step('create the recipe the cook session hangs off', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `recipes/${recipeId}`, {
        id: recipeId,
        schemaVersion: 1,
        kind: 'recipe',
        title: `Probe timer ${ctx.runId}`,
        description: null,
        ingredients: [],
        steps: [{ id: stepId, text: 'Probe step with a timer.', timer: null, note: null }],
        metadata: {
          servings: 1,
          tags: [],
        },
        source: null,
        notes: null,
        image: { url: `https://example.invalid/probe/${ctx.runId}.webp`, source: 'upload' },
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      assert(result.errorStatus === null, `recipe create refused: ${result.errorStatus ?? ''}`);
    });

    const endsAt = new Date(now.getTime() + TIMER_LEAD_MS).toISOString();
    const endsAtMs = new Date(endsAt).getTime();
    const ledgerId = `${sessionId}_${timerId}_${endsAtMs}`;
    ctx.track('timerDeliveries', ledgerId);

    const session = {
      id: sessionId,
      schemaVersion: 1,
      ownerUid: ctx.identity.uid,
      recipeId,
      recipeUpdatedAtAtStart: nowIso,
      checkedIngredientIds: [],
      completedStepIds: [],
      activeTimers: [
        { id: timerId, stepId, label: 'Probe timer', durationMinutes: 1, endsAt, notify: true },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await ctx.step('arming a timer on an owned cook session is permitted', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `cookSessions/${sessionId}`, session);
      assert(result.errorStatus === null, `session create refused: ${result.errorStatus ?? ''}`);

      // Guard the shape the dispatcher will re-read and re-validate: if this
      // drifted, dispatch would log "invalid cookSession doc" and silently
      // no-op, which would look identical to a queue that never fired.
      const parsed = CookSessionSchema.safeParse(session);
      assert(
        parsed.success,
        `the armed session fails CookSessionSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
    });

    const delivery = await ctx.settle(
      'the timer dispatches and claims the exactly-once ledger',
      async () => {
        // Server-owned and client-denied, so this read must go through admin.
        const snapshot = await ctx.admin.firestore
          .collection('timerDeliveries')
          .doc(ledgerId)
          .get();
        return snapshot.exists ? snapshot.data() : null;
      },
      { timeoutMs: DELIVERY_TIMEOUT_MS },
    );

    await ctx.step('the ledger entry identifies the session and timer it delivered', async () => {
      assert(
        delivery?.['sessionId'] === sessionId,
        `ledger sessionId is ${String(delivery?.['sessionId'])}, expected ${sessionId}`,
      );
      assert(
        delivery?.['timerId'] === timerId,
        `ledger timerId is ${String(delivery?.['timerId'])}, expected ${timerId}`,
      );
    });

    await ctx.step('re-writing the same armed timer does not deliver twice', async () => {
      // Only NEWLY-armed timers are enqueued, so an unchanged re-write must add
      // nothing. Scoped to this run's session, never a global ledger count.
      await writeAsUser(ctx.env, ctx.identity, `cookSessions/${sessionId}`, {
        ...session,
        updatedAt: new Date().toISOString(),
      });
      await sleep(DUPLICATE_WATCH_MS);

      const duplicates = await ctx.admin.firestore
        .collection('timerDeliveries')
        .where('sessionId', '==', sessionId)
        .get();

      assert(
        duplicates.size === 1,
        `expected exactly one delivery for this session, found ${duplicates.size}`,
      );
    });
  },
};
