import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { getFunctions } from 'firebase-admin/functions';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { logger } from 'firebase-functions';
import { BatchSchema, PushSubscriptionSchema, type BatchStageDoc } from '@salt/domain/schemas';
import { remindableStages } from '@salt/domain';
import { BREAD_FLAG_KEY, isServerFeatureEnabled } from '@salt/observability/server';
import { reportServerError } from '../observability/reportServerError.js';
import { withFirestoreTrigger, traceContextFromWrittenDoc } from './triggerEntrypoint.js';
import {
  BATCH_STAGE_REGION,
  CLOUD_TASKS_HORIZON_DAYS,
  CLOUD_TASKS_HORIZON_MS,
  type BatchStageTaskPayload,
} from './batchStageTypes.js';

export type { BatchStageTaskPayload } from './batchStageTypes.js';

// Enqueue trigger for batch stage reminders (issue #812, phase 3 of epic #778). On
// every write to a batch, work out which stages earn a notification, diff them
// against the prior write, and enqueue ONE Cloud Task per newly-scheduled reminder.
// `onBatchStageDispatch` sends the push when the task fires.
//
// The rule about WHICH stages is `remindableStages`, in the domain, where it can be
// reasoned about without a clock: the first stage, and any stage that follows a
// `wait`. On the overnight loaf that is mix, shape, preheat and bake — and nothing
// at all across the eight hours in the fridge, which is the point.
//
// CANCELLATION-FREE, exactly as the cook timer is. Nothing here ever deletes a
// Cloud Task. Marking a stage done re-times every stage after it, which changes
// their `plannedStartAt`, which changes the diff key AND the task payload — so a
// fresh task is enqueued and the stale one no-ops on dispatch by re-reading the
// live batch. A cancellation path would buy nothing but a second thing to get wrong.
//
// ONE secret, and only since issue #831: the PostHog key, which powers the
// feature-flag read that freezes this reminder's audience (below) and the error
// reporting around it. Still no AI here, and still no push — the sending, and the
// VAPID material it needs, remain entirely in `onBatchStageDispatch`.
//
// Defined locally (not imported from index.ts) to avoid a circular import; the
// Firebase CLI aggregates same-named defineSecret calls across files at deploy.
//
// memory/region pinned INLINE because this module is evaluated before index.ts's
// setGlobalOptions runs (same reason the other triggers pin them inline).
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// firebase-admin's getUsers caps at 100 identifiers per call. The household is five
// people, so this will not chunk in practice; it is here so a future that reaches
// 101 devices fails by taking two round trips rather than by throwing.
const AUTH_LOOKUP_CHUNK = 100;

// A reminder's identity for diffing: same stage + same planned start. A re-timed
// stage is a NEW key and therefore a NEW task; an untouched one is not re-enqueued,
// which matters because a batch is written on every stage advance and would
// otherwise re-queue every remaining reminder each time.
function reminderKey(stage: BatchStageDoc): string {
  return `${stage.id}@${stage.plannedStartAt}`;
}

// WHO this batch's reminders may wake (issue #831), resolved ONCE per invocation and
// frozen into every task it enqueues.
//
// A batch is family-shared and carries no `ownerUid` on purpose — that reasoning is
// untouched, and dispatch still has no owner to resolve. What changes is only that
// the audience is decided HERE, at enqueue, and carried on the task: a reminder must
// not need PostHog to be reachable at 06:45, and the flag is per-person while the
// document is not.
//
// The hop is uid → email → flag, because the release condition targets an email
// while the person is identified by uid (the browser identifies with the uid as the
// distinct id and the email as a person property, so the server asks the same
// question the same way). A uid with no email cannot match the condition and simply
// does not pass.
//
// FAILS CLOSED, LOUDLY. A failed subscription read or Auth batch yields [] — no
// pushes — rather than a broadcast: a notification reaching someone who did nothing
// to ask for it is the harm this exists to prevent. It is logged and reported so a
// silent reminder blackout is visible rather than merely quiet. Never throws
// (Rule 10).
async function resolveNotifyUids(batchId: string): Promise<readonly string[]> {
  try {
    // Unfiltered, via the Admin SDK (which bypasses the owner-scoped rules) — the
    // same read `onBatchStageDispatch` does, so the two see the same candidates.
    const subsSnap = await getFirestore().collection('pushSubscriptions').get();

    const uids = new Set<string>();
    for (const subDoc of subsSnap.docs) {
      const parsed = PushSubscriptionSchema.safeParse(subDoc.data());
      // Skip-invalid, exactly as the dispatch loop does: one bad doc must not cost
      // everyone else their reminders.
      if (!parsed.success) continue;
      uids.add(parsed.data.ownerUid);
    }
    if (uids.size === 0) return [];

    // BATCH-resolved, not one getUser per device: several devices share one person,
    // and the set above has already collapsed them.
    const identifiers = [...uids].map((uid) => ({ uid }));
    const emails = new Map<string, string>();
    for (let i = 0; i < identifiers.length; i += AUTH_LOOKUP_CHUNK) {
      const { users } = await getAuth().getUsers(identifiers.slice(i, i + AUTH_LOOKUP_CHUNK));
      for (const user of users) {
        if (user.email) emails.set(user.uid, user.email);
      }
    }

    // Once per distinct PERSON, never once per device.
    const passing: string[] = [];
    for (const [uid, email] of emails) {
      if (await isServerFeatureEnabled(BREAD_FLAG_KEY, uid, { email })) passing.push(uid);
    }
    return passing;
  } catch (err) {
    logger.error('onBatchWritten: could not resolve the reminder audience, notifying nobody', {
      batchId,
      err,
    });
    reportServerError(err);
    return [];
  }
}

export const onBatchWritten = onDocumentWritten(
  {
    document: 'batches/{batchId}',
    region: BATCH_STAGE_REGION,
    memory: '512MiB',
    secrets: [posthogApiKey],
  },
  withFirestoreTrigger<{ batchId: string }>(async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    const batchId = event.params.batchId;

    // Batch deleted — nothing to enqueue. Tasks already queued for it no-op on
    // dispatch (the re-read finds no document).
    if (!after?.exists) return;

    const parsed = BatchSchema.safeParse(after.data());
    if (!parsed.success) {
      // A trigger has no caller to surface a Failure to: log and return.
      logger.error('onBatchWritten: invalid batch doc, skipping', {
        batchId,
        error: parsed.error.message,
      });
      return;
    }
    const batch = parsed.data;

    // An abandoned run has no next action by definition, so it earns no reminders.
    // Its outstanding tasks are left to no-op rather than chased down.
    if (batch.state !== 'running') return;

    // Prior reminder keys, so an ordinary write that moved nothing — a rename, a
    // rationale, an `updatedAt` bump — does not re-enqueue. Absent/invalid before →
    // empty set (a create, or a first valid parse), so every reminder is new.
    const priorKeys = new Set<string>();
    if (before?.exists) {
      const beforeParsed = BatchSchema.safeParse(before.data());
      if (beforeParsed.success) {
        for (const stage of beforeParsed.data.stages) priorKeys.add(reminderKey(stage));
      }
    }

    // The one clock reading in the whole enqueue, and it is here rather than in the
    // domain rule for exactly that reason (CLAUDE.md Rule 1).
    const nowMs = Date.now();
    const horizonMs = nowMs + CLOUD_TASKS_HORIZON_MS;

    const due = remindableStages(batch.stages).filter((stage) => {
      if (priorKeys.has(reminderKey(stage))) return false;

      // A stage that has already begun or already finished needs no reminder to
      // begin. This is what keeps the immediate successor of a just-advanced stage
      // quiet: `withStageAdvanced` stamps its `actualStartAt` at the same instant it
      // re-times it, so the cook who has just tapped "done" is not pinged to start
      // the thing they are already standing over.
      if (stage.actualStartAt !== null || stage.actualEndAt !== null) return false;

      // A SKIPPED STAGE IS NOT REMINDED (issue #1275). Filtered here rather than in
      // `remindableStages`, which is pure, planned-only and must not learn about
      // live state — its header says so. The RULE itself ("first stage, and any
      // stage after a `wait`") is untouched by a skip: the stage AFTER a skipped one
      // still earns its reminder on exactly the same reading of the process.
      if (stage.skipped !== null) return false;

      const atMs = Date.parse(stage.plannedStartAt);
      if (!Number.isFinite(atMs)) {
        logger.error('onBatchWritten: unreadable plannedStartAt, skipping stage', {
          batchId,
          stageId: stage.id,
          plannedStartAt: stage.plannedStartAt,
        });
        return false;
      }

      // ALREADY PAST. Cloud Tasks dispatches a past `scheduleTime` immediately, and
      // a reminder that arrives for a moment already gone is not a reminder. The
      // common case is a batch anchored "I am mixing NOW": the first stage's planned
      // start is the instant the button was tapped, and pinging someone to start
      // what they are visibly already doing is noise. The valuable half of the
      // first-stage rule is untouched — a schedule back-solved from "out of the oven
      // at 07:30" puts the mix hours in the future, which is precisely when nothing
      // else in the app would have told them.
      if (atMs <= nowMs) return false;

      // Beyond the Cloud Tasks 30-day horizon — see CLOUD_TASKS_HORIZON_MS. Skip it
      // LOUDLY and carry on with the rest: one unschedulable stage of a long cure
      // must not cost the reminders that ARE within reach. Nothing in this phase can
      // reach here (bread is eighteen hours); phase 04 will.
      if (atMs > horizonMs) {
        logger.warn('onBatchWritten: stage is beyond the Cloud Tasks horizon, not enqueued', {
          batchId,
          stageId: stage.id,
          plannedStartAt: stage.plannedStartAt,
          horizonDays: CLOUD_TASKS_HORIZON_DAYS,
        });
        return false;
      }

      return true;
    });

    if (due.length === 0) return;

    // AFTER the early-out, deliberately: a write with nothing to enqueue — the
    // overwhelming majority of them — costs no subscription read, no Auth lookup and
    // no flag evaluation.
    const notifyUids = await resolveNotifyUids(batchId);

    // Region-qualified, never the bare name — see BATCH_STAGE_REGION for the
    // us-central1 fallback this avoids and the outage it caused once already.
    const queue = getFunctions().taskQueue<BatchStageTaskPayload>(
      `locations/${BATCH_STAGE_REGION}/functions/onBatchStageDispatch`,
    );

    for (const stage of due) {
      try {
        await queue.enqueue(
          { batchId, stageId: stage.id, plannedStartAt: stage.plannedStartAt, notifyUids },
          { scheduleTime: new Date(stage.plannedStartAt) },
        );
      } catch (err) {
        // One failed enqueue must not fail the whole trigger (and re-fire it,
        // re-enqueuing the stages that DID succeed → duplicates). Report and move
        // on; the dispatch ledger de-dupes any eventual double anyway.
        logger.error('onBatchWritten: enqueue failed', {
          batchId,
          stageId: stage.id,
          plannedStartAt: stage.plannedStartAt,
          err,
        });
        reportServerError(err);
      }
    }
  }, traceContextFromWrittenDoc),
);
