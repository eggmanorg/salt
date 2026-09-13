import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { KitchenTimersSchema, PushSubscriptionSchema } from '@salt/domain/schemas';
import { sendWebPush, isApplePushEndpoint } from '../adapters/sendWebPush.js';
import { deliverViaPushover } from '../adapters/deliverViaPushover.js';
import { reportServerError } from '../observability/reportServerError.js';
import { KITCHEN_TIMER_REGION, type KitchenTimerTaskPayload } from './kitchenTimerTypes.js';
import { withTaskTrigger } from './triggerEntrypoint.js';
import { timerDeliveryStamp } from './timerDeliveryRetention.js';

// Cloud Task handler that sends a standalone kitchen-timer push (issue #842).
// Fires at the `endsAt` of a timer enqueued by onKitchenTimerWrite — "Eggs" at
// 18:10, with no cook anywhere in sight.
//
// The whole body is wrapped so a permanent error is REPORTED and swallowed —
// throwing out of an onTaskDispatched handler makes Cloud Tasks retry (up to
// maxAttempts), which for a deterministic failure is pure noise.
//
// Defined locally (not imported from index.ts) to avoid a circular import; the
// Firebase CLI aggregates same-named defineSecret calls across files at deploy.
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const vapidPublicKey = defineSecret('VAPID_PUBLIC_KEY');
const pushoverAppToken = defineSecret('PUSHOVER_APP_TOKEN');
const pushoverUserKey = defineSecret('PUSHOVER_USER_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// ─── WHY THIS MIRRORS THE COOK TIMER AND NOT THE BATCH STAGE ──────────────────
//
// onBatchStageDispatch broadcasts to every device and sends no Pushover, because
// a batch is family-shared and carries no `ownerUid` — there is nobody to resolve
// devices for. A kitchen timer is the opposite: it is owner-scoped by
// construction, the uid is the document id, and it is exactly as time-critical as
// a pan on a hob. So it takes the cook timer's dual-sink routing, targeted at one
// member's devices.
//
// The line below the sinks is the same one #680 drew for cook timers: a native
// Pushover client gets the high-priority wake Chrome's push path does not, so
// Pushover leads and web push covers whoever it did not reach.
//
// The message carries the timer's own NAME, which is user content crossing to a
// third party — the same explicit product call #680 made for cook timers, and for
// the same reason: a timer you cannot identify from the lock screen is most of the
// value gone. Do not re-tighten without asking; it is a decision, not a slip.

// What a notification says when the timer somehow carries no name. The schema
// requires a non-null label and the page never writes an empty one, so this is a
// belt-and-braces default rather than an expected path.
const FALLBACK_TITLE = 'Timer finished';

// Where the notification lands. My Kitchen is the surface for a timer that came
// from nowhere in particular — the timer will be sitting there in its fired state
// when they arrive. EXPLICIT and server-chosen, never reconstructed in the service
// worker: push-sw.js's `sessionId` slice is a cook-timer-only licence granted by
// that collection's composite document id, and this route has no id in it at all.
const KITCHEN_URL = '/#/mine';

// A timer armed from a batch's cook page goes BACK to that page (issue #1327,
// Phase 2), which draws it in the same bar it was started from. This is the whole
// user-visible point of `origin`: a notification that lands on Mine while the chef
// is stood at the oven is the cost option (a) would have shipped.
//
// Taken from the LIVE document re-read below, not from the task — which is why the
// payload could stay ids-only and why no user content rides the queue. A timer
// whose origin was dropped by a re-time simply lands on Mine, the same as any
// kitchen timer.
function timerUrl(batchId: string | null): string {
  return batchId === null ? KITCHEN_URL : `/#/batches/${batchId}/cook`;
}

// Absolute, because Pushover's link is opened by a native app rather than a page,
// so there is no origin to resolve a path against. Hosting is `<projectId>.web.app`
// in all three environments and GCLOUD_PROJECT is set by the Functions runtime, so
// this needs no new configuration — the same derivation the cook timer uses.
// Undefined when there is no project id (local unit runs): the notification still
// sends, just unlinked.
function absoluteDeepLink(path: string): string | undefined {
  const projectId = process.env['GCLOUD_PROJECT'] ?? process.env['GCP_PROJECT'] ?? '';
  if (!projectId) return undefined;
  return `https://${projectId}.web.app${path}`;
}

export const onKitchenTimerDispatch = onTaskDispatched<KitchenTimerTaskPayload>(
  {
    region: KITCHEN_TIMER_REGION,
    memory: '512MiB',
    secrets: [vapidPrivateKey, vapidPublicKey, pushoverAppToken, pushoverUserKey, posthogApiKey],
    // A push endpoint can be transiently unavailable; retry a handful of times
    // with backoff. A PERMANENT failure never throws (see below), so it never
    // burns retries.
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 5 },
    // Cap fan-out so a burst of timers can't stampede the push services.
    rateLimits: { maxConcurrentDispatches: 6 },
  },
  withTaskTrigger<KitchenTimerTaskPayload>(async (req) => {
    const { uid, timerId, endsAt } = req.data;
    const db = getFirestore();

    try {
      // (a) Re-read the LIVE document. Absent → the member has never had a timer,
      // or dismissed their last one (the cancellation-free design: we never delete
      // tasks, we no-op stale ones).
      const snap = await db.collection('kitchenTimers').doc(uid).get();
      if (!snap.exists) return;

      const parsed = KitchenTimersSchema.safeParse(snap.data());
      if (!parsed.success) {
        logger.error('onKitchenTimerDispatch: invalid kitchenTimers doc, skipping', {
          uid,
          error: parsed.error.message,
        });
        return;
      }
      const doc = parsed.data;

      // (b) Confirm the timer STILL sits at this end-time. Dismissed, or re-timed
      // to a different `endsAt` → this is a stale task and says nothing. The write
      // that re-timed it queued a fresh task for the new time.
      const timer = doc.timers.find((t) => t.id === timerId && t.endsAt === endsAt);
      if (!timer) return;

      // (c) Exactly-once claim in the SHARED server-owned `timerDeliveries` ledger
      // — the same collection the cook timer (#544) and the batch stage (#812) use,
      // not a third one of its own. It is already server-owned, client-denied and
      // exactly this kind of dedupe record; a twin with identical rules and
      // identical purpose would be duplication and nothing else. The `kitchen_`
      // prefix keeps the producers' key spaces apart, and the uid is in the key
      // because a timer id is only unique within one member's document.
      //
      // ALWAYS a separate doc, NEVER a write-back onto `kitchenTimers/{uid}`: the
      // client writes that document whole, so a client `setDoc` would clobber the
      // record under LWW.
      const endsAtMs = new Date(endsAt).getTime();
      const ledgerRef = db
        .collection('timerDeliveries')
        .doc(`kitchen_${uid}_${timerId}_${endsAtMs}`);
      let alreadyDelivered = false;
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(ledgerRef);
        if (existing.exists) {
          alreadyDelivered = true;
          return;
        }
        tx.set(ledgerRef, { ...timerDeliveryStamp(), uid, timerId });
      });
      if (alreadyDelivered) return;

      // (d) The owner's device subscriptions — filtered on `ownerUid`, which is
      // read off the parsed document rather than taken from the task, so the send
      // target is proven by the same document that armed the timer.
      const subsSnap = await db
        .collection('pushSubscriptions')
        .where('ownerUid', '==', doc.ownerUid)
        .get();
      const subscriptions = subsSnap.docs
        .map((d) => ({ ref: d.ref, parsed: PushSubscriptionSchema.safeParse(d.data()) }))
        .filter((s) => s.parsed.success);

      // (e) VAPID material. Missing keys mean web push is not provisioned here —
      // log and skip that sink; Pushover is independent and may still deliver.
      const publicKey = vapidPublicKey.value();
      const privateKey = vapidPrivateKey.value();
      const subject = 'mailto:admin@salt.app';
      const webPushProvisioned = Boolean(publicKey && privateKey);
      if (!webPushProvisioned) {
        logger.error('onKitchenTimerDispatch: VAPID not provisioned', { uid, timerId });
      }

      // (f) The copy, taken from LIVE state — which is why the task carries ids
      // only, and why a timer renamed after it was armed announces itself by the
      // name the chef will be looking for. The timer's own name leads, exactly as
      // a cook timer's label does; the second line says what kind of thing just
      // happened, since there is no dish to name.
      // One path, chosen once, used by both sinks — so the lock screen and the
      // Pushover notification can never disagree about where this timer lives.
      const url = timerUrl(timer.origin?.batchId ?? null);
      const payload = {
        type: 'kitchen-timer' as const,
        // Per TIMER. A kitchen-wide tag would let a second timer silently replace
        // the first one's notification while it was still unread.
        tag: `kitchen::${timerId}`,
        url,
        title: timer.label.trim() || FALLBACK_TITLE,
        body: 'Your kitchen timer just finished.',
        // Re-buzzes, like the cook timer and the batch stage: a timed call to act,
        // deduped by a real ledger rather than by the tag.
        renotify: true,
      };

      // (g) PUSHOVER FIRST — it is the primary channel, and whether it delivered
      // decides the web-push fan-out below.
      const pushoverOutcome = await deliverViaPushover({
        name: 'onKitchenTimerDispatch',
        token: pushoverAppToken.value(),
        user: pushoverUserKey.value(),
        ownerUid: uid,
        context: { timerId },
        link: absoluteDeepLink(url),
        linkTitle: timer.origin?.batchId ? 'Back to the cook' : 'Go to the kitchen',
        payload,
      });
      const pushoverDelivered = pushoverOutcome === 'delivered';

      // (h) WEB PUSH, ROUTED PER DEVICE, on the cook timer's rule: an Apple
      // endpoint ALWAYS (APNs is the channel that measurably works there, and
      // Pushover may have reached a different device entirely), everything else
      // only as a fallback when Pushover did not deliver (Android web push is
      // throttled into uselessness by Doze and per-OEM battery management).
      let webPushDelivered = 0;
      if (webPushProvisioned) {
        for (const sub of subscriptions) {
          if (!sub.parsed.success) continue; // narrowing (filtered above)
          const data = sub.parsed.data;
          const isApple = isApplePushEndpoint(data.endpoint);
          if (!isApple && pushoverDelivered) continue;

          const result = await sendWebPush(
            { subject, publicKey, privateKey },
            { endpoint: data.endpoint, keys: data.keys },
            payload,
          );
          if (result === 'sent') {
            webPushDelivered += 1;
          } else if (result === 'gone') {
            // Permanently dead subscription (404/410) — prune so we stop trying.
            await sub.ref.delete();
          } else {
            // Transient/unexpected send failure. No user content in the error.
            reportServerError(new Error('web-push send failed'));
          }
        }
      }

      // (i) Report ONLY total non-delivery. Neither sink failing alone is worth an
      // alert now that each is the other's backstop — but a timer that reached
      // nothing at all is someone waiting on a ping that is never coming.
      if (!pushoverDelivered && webPushDelivered === 0) {
        reportServerError(
          new Error('Kitchen timer reached no device — neither Pushover nor web push'),
        );
      }

      logger.info('onKitchenTimerDispatch: delivered', {
        uid,
        timerId,
        pushoverOutcome,
        webPushDelivered,
      });
    } catch (err) {
      // Never throw out of the handler (Rule 10) — a permanent error would
      // otherwise make Cloud Tasks retry to exhaustion. Report and return.
      logger.error('onKitchenTimerDispatch: unexpected error', { uid, timerId, err });
      reportServerError(err);
    }
  }),
);
