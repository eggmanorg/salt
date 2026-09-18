import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { BatchSchema, PushSubscriptionSchema } from '@salt/domain/schemas';
import type { BatchDoc } from '@salt/domain/schemas';
import { dateInZone, longRunNudge, longRunsWantingReading } from '@salt/domain';
import { flushServerObservability } from '@salt/observability/server';
import { sendWebPush } from '../adapters/sendWebPush.js';
import { reportServerError } from '../observability/reportServerError.js';

// Weekly "what is drying" nudge (issue #1406, phase 04 of epic #778).
//
// WHY IT EXISTS. A cure runs for months and a kraut for weeks. The existing stage
// reminders fire when a stage STARTS (`onBatchWritten` → `onBatchStageDispatch`), and
// a ninety-day dry has exactly one stage — so after the day you hang it the app goes
// silent until the day you take it down, and the readings that make the log worth
// keeping never get entered because nothing ever asks. This asks, once a week.
//
// IT ASKS; IT DOES NOT CHASE. It does not check whether a reading was already logged,
// does not track whether anything was done about it, and never appears twice in a
// week. A ninety-day cure gets thirteen nudges, not ninety — the cadence is the whole
// point (`docs/formulas-schedules-batches.md` → *What not to build* forbids a daily
// one outright).
//
// THE CLOUD TASKS HORIZON GUARD IS UNTOUCHED BY THIS. `CLOUD_TASKS_HORIZON_DAYS` in
// `triggers/batchStageTypes.ts` answers a different question — a stage whose START is
// more than 30 days out, which Cloud Tasks cannot accept — and it warns and skips. This
// sweep covers the readings DURING a long stage. Different questions; do not delete,
// raise or route around the guard.
//
// THE SHAPE IS `remindShoppingDay`'s, DELIBERATELY: a scheduled broadcast with a pinned
// `timeZone`, VAPID resolved from secrets, a skip-invalid send loop that prunes `gone`
// endpoints, never a throw out of the handler (Rule 10), and
// `flushServerObservability()` in `finally`. What differs is the question and the
// audience.
//
// COST SHAPE — one collection query per week, filtered to `state == 'running'` (a
// single-field equality, so the automatic index serves it and no
// `firestore.indexes.json` entry is needed), then one `pushSubscriptions` query per
// person who has something drying. On every week where nothing qualifies — which is
// every week in production today — it is one query and a return.
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const vapidPublicKey = defineSecret('VAPID_PUBLIC_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// FRIDAY MORNING, and the reason is the one that matters: Daniel does not work
// Fridays, so it is the morning he would actually go and weigh something. A nudge that
// lands on a working day is a nudge that gets dismissed.
//
// `onSchedule`'s `timeZone` is a deploy-time constant that cannot be driven from
// Firestore, which is why it is pinned here and NOT read from
// `appSettings.homeLocation.timezone` — that field exists to anchor the weather
// forecast, and coupling a cron to it would buy nothing while letting the two zones
// drift apart. Same precedent as `remindShoppingDay` and `sweepOrphanedStorage`.
// Changing the day or the hour later is a one-constant edit.
const REMINDER_SCHEDULE = '0 10 * * 5';
const REMINDER_TIME_ZONE = 'Europe/London';

export const remindBatchReadings = onSchedule(
  {
    schedule: REMINDER_SCHEDULE,
    timeZone: REMINDER_TIME_ZONE,
    region: 'europe-west2',
    memory: '512MiB',
    secrets: [vapidPrivateKey, vapidPublicKey, posthogApiKey],
    // NO EXACTLY-ONCE LEDGER, for the reason `remindShoppingDay` states at its own
    // `retryCount`. A weekly cron with retryCount: 0 has one realistic duplicate
    // source — a rare Cloud Scheduler double-delivery — and the week-keyed
    // notification `tag` already collapses it: the second push REPLACES the first
    // rather than stacking, and with renotify: false it does not re-buzz. #544 needed
    // a real `timerDeliveries` ledger because a cook timer is audible, time-critical
    // and dispatched via at-least-once Cloud Tasks with 5 retries. This is an ambient
    // nudge about a whole week; none of that applies, and it must not re-buzz.
    retryCount: 0,
  },
  async () => {
    const db = getFirestore();
    try {
      const now = new Date();
      // The week's key, in the zone the cron fires in, so the tag and the firing day
      // can never disagree.
      const runDate = dateInZone(now, REMINDER_TIME_ZONE);

      // (a) Every run still going. `state == 'running'` is the only filter Firestore
      // can apply — whether a run is in a LONG WAIT is a property of its frozen stages
      // and is decided by the domain rule below, never by a query.
      const snap = await db.collection('batches').where('state', '==', 'running').get();
      const batches: BatchDoc[] = [];
      for (const doc of snap.docs) {
        const parsed = BatchSchema.safeParse(doc.data());
        if (!parsed.success) {
          // A schedule has no caller to surface a Failure to: log and skip the doc.
          // One corrupt run must not silence the nudge for everything else.
          logger.error('remindBatchReadings: invalid batch doc, skipping', {
            batchId: doc.id,
            error: parsed.error.message,
          });
          continue;
        }
        batches.push(parsed.data);
      }

      // (b) WHICH RUNS WANT WEIGHING, and whose they are. The rule is
      // `@salt/domain`'s: pure, clockless, by the shape of the frozen stages and never
      // by `recipeKind` (CLAUDE.md's never-branch-on-kind invariant). Bread's longest
      // wait is an overnight retard, so no bread run can qualify — which is why this
      // ships dark with every batch in production silent to it.
      const byStarter = longRunsWantingReading(batches, now.toISOString(), REMINDER_TIME_ZONE);
      if (byStarter.size === 0) return;

      // (c) VAPID material, exactly as `remindShoppingDay` resolves it. Missing keys
      // mean the feature is not provisioned in this environment — log and return
      // rather than throw, since Scheduler would only replay the same failure.
      const publicKey = vapidPublicKey.value();
      const privateKey = vapidPrivateKey.value();
      const subject = 'mailto:admin@salt.app';
      if (!publicKey || !privateKey) {
        logger.error('remindBatchReadings: VAPID not provisioned', { date: runDate });
        return;
      }

      // (d) ONE NOTIFICATION PER PERSON, ADDRESSED TO THE RUN'S STARTER — not
      // broadcast, and not narrowed by a feature flag. `onBatchWritten`'s
      // `resolveNotifyUids` deliberately is NOT reused: that gate's own header calls
      // it cosmetic and it is evaluated in the browser, so who receives a notification
      // must not hang off it. `batch.startedBy` is the audience, and it is used to
      // ADDRESS a notification rather than to scope anything (see
      // `BatchSchema.startedBy` for the full statement, including the accepted limit:
      // starter away, nobody else nudged).
      let sent = 0;
      let pruned = 0;
      let runs = 0;
      for (const [startedBy, theirRuns] of byStarter) {
        runs += theirRuns.length;
        const { title, body } = longRunNudge(theirRuns);
        // The copy is `@salt/domain`'s, not this file's — a Cloud Function cannot
        // import an app, and this sentence has one owner (`longRunNudge`). The run's
        // own frozen `recipeTitle` rides on it, exactly as a stage reminder's does
        // since #680: the whole point is that it names what is drying.
        const payload = {
          type: 'batch-readings' as const,
          // Keyed to the WEEK, not the run: a second delivery on the same Friday
          // replaces the first silently instead of buzzing again.
          tag: `batch-readings::${runDate}`,
          // The LIST, never a single run, even when only one qualifies. Each run there
          // is already one tap from the reading sheet, and a deep link would be wrong
          // the moment a second thing is hanging.
          url: '/#/batches',
          title,
          body,
          renotify: false,
        };

        const subsSnap = await db
          .collection('pushSubscriptions')
          .where('ownerUid', '==', startedBy)
          .get();
        for (const subDoc of subsSnap.docs) {
          const parsedSub = PushSubscriptionSchema.safeParse(subDoc.data());
          if (!parsedSub.success) continue; // skip-invalid; one bad doc must not stop the rest
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
      }

      logger.info('remindBatchReadings: reminded', {
        date: runDate,
        starters: byStarter.size,
        runs,
        sent,
        pruned,
      });
    } catch (err) {
      // Never throw out of a scheduled handler (Rule 10): there is no caller, and
      // Scheduler would replay a deterministic failure. Report and let next Friday's
      // run try again — SyncError, the unexpected-infrastructure class.
      logger.error('remindBatchReadings: reminder failed', { error: String(err) });
      reportServerError(err, 'SyncError');
    } finally {
      await flushServerObservability();
    }
  },
);
