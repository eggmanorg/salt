import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { DEFROSTS_COLLECTION, DefrostSchema, PushSubscriptionSchema } from '@salt/domain/schemas';
import {
  dateInZone,
  formatBagNumber,
  kitchenTasks,
  type Defrost,
  type KitchenTask,
} from '@salt/domain';
import { flushServerObservability } from '@salt/observability/server';
import { sendWebPush } from '../adapters/sendWebPush.js';
import { reportServerError } from '../observability/reportServerError.js';

// The 09:00 Kitchen reminder (issue #1683, epic #795). Each morning it reads
// what Kitchen is holding, asks `@salt/domain`'s `kitchenTasks` — the same
// projection Kitchen's To do list renders — which of those are due TODAY, and
// sends one collapsed notification about them to every device.
//
// It is the KITCHEN reminder, not a defrost reminder: a later kind of Kitchen
// task joins by a new source in `kitchenTasks` and a copy branch in
// `kitchenReminderCopy` below, never by a second scheduled function.
//
// WHAT NEVER PUSHES, and why there is no filter for most of it:
//   - a ticked-off item is a DELETED `defrosts` doc, so it is never read;
//   - an UNDATED task (`dueDate === null` — a hand-added pack, a meal not planned
//     in Kitchen's weeks when the pack was used, a doc from before #1696) has no
//     night to time a buzz against;
//   - a task whose `dueDate` is already PAST stays in Kitchen, but its one morning
//     has gone;
//   - a task whose recipe is planned again, or whose meal moves: the night is
//     STORED on the doc when the pack is used (#1696) and this function reads no
//     planner, so an item is due on exactly one date. Only another commit to the
//     same doc — a person acting — changes it, and that may buzz again. Pinned by
//     the test "a past stored night sends nothing, whatever the planner says".
// The last three are the single `dueDate === today` filter in the handler.
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const vapidPublicKey = defineSecret('VAPID_PUBLIC_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// A deploy-time constant, and "today" is computed in the same zone; why it is
// not read from `appSettings` is argued in `remindShoppingDay.ts`.
const REMINDER_TIME_ZONE = 'Europe/London';

/**
 * The notification's words for the tasks due this morning. Chosen per task
 * KIND: the exhaustive switch below fails the build when `KitchenTask` gains a
 * member that has not been given words here.
 *
 * Only one kind exists, so a morning can only hold defrosts. Wording for a
 * morning holding two kinds is the next kind's issue to design.
 */
export function kitchenReminderCopy(due: readonly KitchenTask[]): {
  title: string;
  body: string;
} {
  const defrosts: Defrost[] = [];
  for (const task of due) {
    switch (task.kind) {
      case 'defrost':
        defrosts.push(task.defrost);
        break;
      default: {
        // Unreachable at runtime: this line stops compiling first.
        const unhandled: never = task.kind;
        throw new Error(`kitchenReminderCopy: no copy for kind ${String(unhandled)}`);
      }
    }
  }
  const [only] = defrosts;
  if (defrosts.length === 1 && only) {
    return {
      // The app dates only a defrost with a recipe (`useFromFreezer`); the null
      // branch covers a doc written any other way.
      title:
        only.recipeTitle === null
          ? `Defrost the ${only.name} for tomorrow`
          : `Defrost the ${only.name} for tomorrow's ${only.recipeTitle}`,
      body: `${only.location} · #${formatBagNumber(only.freezerNumber)}`,
    };
  }
  return {
    title: `Defrost ${defrosts.length} things for tomorrow`,
    body: defrosts.map((d) => d.name).join(', '),
  };
}

async function readDefrosts(db: Firestore): Promise<Defrost[]> {
  const snap = await db.collection(DEFROSTS_COLLECTION).get();
  const defrosts: Defrost[] = [];
  for (const doc of snap.docs) {
    const parsed = DefrostSchema.safeParse(doc.data());
    if (!parsed.success) {
      // One corrupt doc must not silence the rest of the morning.
      logger.error('remindKitchenTasks: invalid defrost doc, skipping', {
        defrostId: doc.id,
        error: parsed.error.message,
      });
      continue;
    }
    defrosts.push(parsed.data);
  }
  return defrosts;
}

export const remindKitchenTasks = onSchedule(
  {
    schedule: '0 9 * * *',
    timeZone: REMINDER_TIME_ZONE,
    region: 'europe-west2',
    memory: '512MiB',
    secrets: [vapidPrivateKey, vapidPublicKey, posthogApiKey],
    // No exactly-once ledger: `retryCount: 0` plus the date-keyed tag and
    // `renotify: false` below — the argument is `remindShoppingDay.ts`'s.
    retryCount: 0,
  },
  async () => {
    const db = getFirestore();
    try {
      const today = dateInZone(new Date(), REMINDER_TIME_ZONE);

      // (a) Every source `kitchenTasks` takes. Empty — the cost on nearly every
      // day — means one collection read and nothing else.
      const defrosts = await readDefrosts(db);
      if (defrosts.length === 0) return;

      // (b) Which of them are due this morning, by the projection Kitchen itself
      // renders, so the list and the buzz cannot disagree.
      const due = kitchenTasks({ defrosts }).filter((task) => task.dueDate === today);
      if (due.length === 0) return;

      // (c) VAPID material, exactly as `remindShoppingDay` resolves it.
      const publicKey = vapidPublicKey.value();
      const privateKey = vapidPrivateKey.value();
      const subject = 'mailto:admin@salt.app';
      if (!publicKey || !privateKey) {
        logger.error('remindKitchenTasks: VAPID not provisioned', { date: today });
        return;
      }

      // (d) ONE notification for the whole morning. Item names and recipe titles
      // ride on it, as a cook timer's recipe title does since #680: a defrost
      // reminder that does not say what to defrost is no reminder.
      const { title, body } = kitchenReminderCopy(due);
      const payload = {
        type: 'kitchen-reminder' as const,
        tag: `kitchen::${today}`,
        // Kitchen, never a single item: its To do list shows each one's location.
        url: '/#/mine',
        title,
        body,
        renotify: false,
      };

      // (e) BROADCAST to every device: a Kitchen item is a household fact, not
      // the committer's. Read via the Admin SDK, which bypasses the owner rules.
      const subsSnap = await db.collection('pushSubscriptions').get();
      let sent = 0;
      let pruned = 0;
      for (const subDoc of subsSnap.docs) {
        const parsedSub = PushSubscriptionSchema.safeParse(subDoc.data());
        if (!parsedSub.success) continue; // skip-invalid; one bad doc must not stop the broadcast
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

      // Counts only: no item names or recipe titles in logs.
      logger.info('remindKitchenTasks: reminded', {
        date: today,
        due: due.length,
        sent,
        pruned,
      });
    } catch (err) {
      // Never throw out of a scheduled handler (Rule 10): there is no caller, and
      // Scheduler would replay a deterministic failure. Tomorrow's run tries again.
      logger.error('remindKitchenTasks: reminder failed', { error: String(err) });
      reportServerError(err, 'SyncError');
    } finally {
      await flushServerObservability();
    }
  },
);
