import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { BatchSchema, PushSubscriptionSchema } from '@salt/domain/schemas';
import { sendWebPush } from '../adapters/sendWebPush.js';
import { reportServerError } from '../observability/reportServerError.js';
import { BATCH_STAGE_REGION, type BatchStageTaskPayload } from './batchStageTypes.js';
import { withTaskTrigger } from './triggerEntrypoint.js';
import { timerDeliveryStamp } from './timerDeliveryRetention.js';

// Cloud Task handler that sends a batch stage reminder (issue #812, phase 3 of epic
// #778). Fires at the `plannedStartAt` of a stage enqueued by `onBatchWritten` —
// "Shape into the tin / Overnight white tin" at 09:20, "Preheat the oven" at 06:45
// after eight silent hours in the fridge.
//
// The whole body is wrapped so a permanent error is REPORTED and swallowed —
// throwing out of an onTaskDispatched handler makes Cloud Tasks retry (up to
// maxAttempts), which for a deterministic failure is pure noise.
//
// Defined locally (not imported from index.ts) to avoid a circular import; the
// Firebase CLI aggregates same-named defineSecret calls across files at deploy.
// VAPID keypair signs the push; the PostHog key powers error reporting and
// telemetry — and ONLY those. Nothing here asks PostHog whether a feature is on:
// since #831 the audience is frozen into the task at enqueue time (see
// `notifyUids`), precisely so a PostHog outage cannot cost a reminder that is due
// this minute.
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const vapidPublicKey = defineSecret('VAPID_PUBLIC_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// What a reminder says when the stage was left unlabelled. A batch is family-shared
// and its recipe title is frozen onto the document, so the body is never generic —
// only the stage's own name can be missing.
const FALLBACK_TITLE = 'A batch stage is due';

// ─── WEB PUSH ONLY. NO PUSHOVER, DELIBERATELY ───────────────────────────────────
//
// The cook timer's dual-sink routing (#680) is not structural mirroring, it is cook
// timer PRODUCT policy, and its mechanism cannot even be applied here: Pushover
// targeting resolves ONE MEMBER's `<firstname>-`-prefixed devices from a uid, and a
// batch has no uid. A batch is family-shared and carries no `ownerUid` on purpose —
// nobody in particular owns the crock — so there is no person to resolve devices
// for and no one to leave out.
//
// So this broadcasts, following `remindShoppingDay`: every doc in
// `pushSubscriptions`, read via the Admin SDK, which bypasses the owner-scoped
// rules. Whoever is closest to the kitchen shapes the loaf. If a batch reminder ever
// proves as time-critical as a pan on a hob, Pushover is a separate decision to
// take then, on evidence, not a line to copy across now.
//
// Since #831 that broadcast is NARROWED by the task's `notifyUids` — the people who
// had the `bread` feature flag when the reminder was scheduled. That is not a
// reversal of the paragraph above: the batch still has no owner, and this handler
// still resolves nobody. It reads a list that was decided upstream, at enqueue,
// where a slow flag lookup costs nothing. An ABSENT list still means broadcast (a
// task queued before #831); an EMPTY one means nobody.
//
// ─── TTL STAYS AT sendWebPush's EXISTING 3600 ───────────────────────────────────
//
// A one-hour relevance window is not merely tolerable for a stage reminder, it is
// the correct policy: a reminder that arrives hours late is ACTIVELY MISLEADING —
// the schedule has moved on and the dough has not, and "shape the loaf" delivered at
// midnight would send someone to a fridge for no reason. A missed reminder is a
// smaller harm than a wrong one. The helper therefore needs no TTL parameter, and
// deliberately has not grown one.

export const onBatchStageDispatch = onTaskDispatched<BatchStageTaskPayload>(
  {
    region: BATCH_STAGE_REGION,
    memory: '512MiB',
    secrets: [vapidPrivateKey, vapidPublicKey, posthogApiKey],
    // A push endpoint can be transiently unavailable; retry a handful of times with
    // backoff. A PERMANENT failure never throws (see below), so it never burns
    // retries.
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 5 },
    // Cap fan-out so a burst of reminders can't stampede the push services.
    rateLimits: { maxConcurrentDispatches: 6 },
  },
  withTaskTrigger<BatchStageTaskPayload>(async (req) => {
    const { batchId, stageId, plannedStartAt, notifyUids } = req.data;
    const db = getFirestore();

    try {
      // (a) Re-read the LIVE batch. Absent → the run was deleted (the
      // cancellation-free design: we never delete tasks, we no-op stale ones).
      const batchSnap = await db.collection('batches').doc(batchId).get();
      if (!batchSnap.exists) return;

      const parsed = BatchSchema.safeParse(batchSnap.data());
      if (!parsed.success) {
        logger.error('onBatchStageDispatch: invalid batch doc, skipping', {
          batchId,
          error: parsed.error.message,
        });
        return;
      }
      const batch = parsed.data;

      // (b) An abandoned run has no next action. Nothing to say.
      if (batch.state !== 'running') return;

      // (c) Confirm the stage STILL sits at this planned time. Marking an earlier
      // stage done re-times everything after it, so a stage that moved has a
      // different `plannedStartAt` and this task matches nothing → stale, no-op. A
      // fresh task for the new time was enqueued by the same write that moved it.
      const stage = batch.stages.find(
        (s) => s.id === stageId && s.plannedStartAt === plannedStartAt,
      );
      if (!stage) return;

      // (d) …and that it has not already happened, or been decided against. A stage
      // marked done early, already under way, or SKIPPED (issue #1275) needs no
      // invitation to start. Re-read from the live batch, exactly as the cook timer
      // does: the enqueue filters what it can see at write time, and this is what
      // catches a skip made after the task was already queued.
      if (stage.actualStartAt !== null || stage.actualEndAt !== null) return;
      if (stage.skipped !== null) return;

      // (e) Exactly-once claim in the SHARED server-owned `timerDeliveries` ledger —
      // the same collection the cook timer uses (#544), not a second one of its own.
      // It is already server-owned, client-denied and exactly this kind of dedupe
      // record; a `batchDeliveries` twin with identical rules and identical purpose
      // would be duplication and nothing else. The `batch_` prefix keeps the two
      // producers' key spaces from ever colliding. A duplicate dispatch (Cloud Tasks
      // is at-least-once, plus retries) finds the doc present and bails.
      const plannedStartAtMs = Date.parse(plannedStartAt);
      const ledgerRef = db
        .collection('timerDeliveries')
        .doc(`batch_${batchId}_${stageId}_${plannedStartAtMs}`);
      let alreadyDelivered = false;
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(ledgerRef);
        if (existing.exists) {
          alreadyDelivered = true;
          return;
        }
        tx.set(ledgerRef, { ...timerDeliveryStamp(), batchId, stageId });
      });
      if (alreadyDelivered) return;

      // (f) VAPID material. Both keys come from bound secrets; the subject is a fixed
      // contact (a valid mailto is all web-push needs). Missing keys mean the feature
      // is not provisioned in this environment — log and return rather than throw.
      const publicKey = vapidPublicKey.value();
      const privateKey = vapidPrivateKey.value();
      const subject = 'mailto:admin@salt.app';
      if (!publicKey || !privateKey) {
        logger.error('onBatchStageDispatch: VAPID not provisioned', { batchId, stageId });
        return;
      }

      // (g) The copy, derived from live state — which is why the task payload carries
      // ids only. The stage's own label leads and the dish follows ("Shape into the
      // tin" / "Overnight white tin"), the same two facts in the same order as the
      // cook timer, and `recipeTitle` is the batch's FROZEN copy so a renamed or
      // deleted recipe still reads correctly.
      const payload = {
        type: 'batch-stage' as const,
        // Per BATCH and per STAGE. A batch-wide tag would let the preheat reminder
        // silently replace the shape reminder eight hours earlier; a tag that also
        // carried the planned time would let a re-timed stage stack two live
        // notifications for one action.
        tag: `batch::${batchId}::${stageId}`,
        // EXPLICIT, chosen server-side, exactly as the shopping reminder does — and
        // deliberately NOT reconstructed in the service worker. The cook timer
        // recovers a recipe id by string-slicing `sessionId`, which is only tolerable
        // because `cookSessions` has a composite `${recipeId}_${uid}` id; a batch id
        // is an opaque UUID and that hack must not spread.
        url: `/#/batches/${batchId}`,
        title: stage.label.trim() || FALLBACK_TITLE,
        body: batch.recipeTitle,
        // TRUE, which is the OPPOSITE of the shopping reminder's choice, and for the
        // reason that makes the shopping reminder's choice right for it: that one is
        // a repeatable nudge about a whole day, collapsed by a date-keyed tag INSTEAD
        // of a ledger. This is a timed call to act, hours from the last one, deduped
        // by a real ledger — the same family as the cook timer, which re-buzzes. A
        // tag collision here could only ever be a genuinely new call to action.
        renotify: true,
      };

      // (h) BROADCAST — every device in `pushSubscriptions`, not one member's. See
      // the header: a batch has no owner, so it has no one to notify in particular.
      // Narrowed only by the frozen `notifyUids` below.
      const subsSnap = await db.collection('pushSubscriptions').get();
      // ABSENT means BROADCAST — a task enqueued before #831 carries no list, and
      // reading that as "nobody" would silently strand every already-queued
      // reminder. An EMPTY array is the opposite instruction and is honoured.
      const audience = notifyUids === undefined ? null : new Set(notifyUids);
      let sent = 0;
      let pruned = 0;
      let withheld = 0;
      for (const subDoc of subsSnap.docs) {
        const parsedSub = PushSubscriptionSchema.safeParse(subDoc.data());
        // Skip-invalid: one bad doc must not stop the broadcast.
        if (!parsedSub.success) continue;
        // AFTER the parse, so the uid tested is the validated one. Counted rather
        // than dropped silently: a blackout must be diagnosable from the log line.
        if (audience !== null && !audience.has(parsedSub.data.ownerUid)) {
          withheld += 1;
          continue;
        }
        const result = await sendWebPush(
          { subject, publicKey, privateKey },
          { endpoint: parsedSub.data.endpoint, keys: parsedSub.data.keys },
          payload,
        );
        if (result === 'gone') {
          // Permanently dead subscription (404/410) — prune so we stop trying.
          await subDoc.ref.delete();
          pruned += 1;
        } else if (result === 'failed') {
          // Transient/unexpected send failure. No user content in the error.
          reportServerError(new Error('web-push send failed'));
        } else {
          sent += 1;
        }
      }

      logger.info('onBatchStageDispatch: reminded', { batchId, stageId, sent, pruned, withheld });
    } catch (err) {
      // Never throw out of the handler (Rule 10) — a permanent error would otherwise
      // make Cloud Tasks retry to exhaustion. Report and return.
      logger.error('onBatchStageDispatch: unexpected error', { batchId, stageId, err });
      reportServerError(err);
    }
  }),
);
