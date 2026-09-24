import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import {
  EquipmentManifestSchema,
  EQUIPMENT_ICONS_COLLECTION,
  EQUIPMENT_MANIFEST_COLLECTION,
  EQUIPMENT_MANIFEST_DOC_ID,
  type EquipmentItemDoc,
} from '@salt/domain/schemas';
import { equipmentIconOwnerIds } from '@salt/domain';
import { describeEquipmentSubjectFlow } from '../flows/describeEquipmentSubject.js';
import { aiFakeEnabled } from '../ai/fakeModel.js';
import { reportServerError } from '../observability/reportServerError.js';
import {
  recordEnrichmentFailure,
  clearEnrichmentFailure,
} from '../adapters/enrichmentFailureStore.js';
import { isIconGenerationEnabled } from './iconWriteTrigger.js';
import { withFirestoreTrigger, traceContextFromWrittenDoc } from './triggerEntrypoint.js';

// Equipment pictogram BRIEFS (issue #877).
//
// THIS TRIGGER NEVER GENERATES AN IMAGE. It authors appliance descriptions and
// nothing else; the picture is drawn only when someone presses Draw, by the
// `drawEquipmentIcon` callable. That split is the feature, not an optimisation:
// an image call is slow and costs real money, and a picture you dislike gives you
// no handle on WHY — you re-roll and hope. A brief is a sentence you can read in
// two seconds and correct in ten, and correcting it fixes the cause rather than
// resampling the symptom.
//
// Two consequences follow, and both are why this file is short:
//
//   • The expensive path is off the automatic side entirely, so the
//     per-invocation generation cap the canon trigger would have needed is a
//     non-problem. Nineteen 'fast'-tier text calls are quick and cheap (measured
//     ~2.8 s median, ~55 s total for a cold full-manifest catch-up) where
//     nineteen image calls were neither.
//   • No `sharp`, no Storage, no image decode — so this needs NONE of the canon
//     trigger's 1 GiB / concurrency-1 posture. That posture exists because
//     parallel libvips decodes OOM-kill the instance and lose every in-flight
//     icon; it belongs on the Draw callable, which is the thing that runs sharp.
//
// ─── Level-triggered, deliberately ──────────────────────────────────────────
// The canon trigger is EDGE-triggered (`iconNeedsGeneration`) because it writes
// back to the very document it watches, so it must not re-enter on its own write.
// This one writes only to `equipmentIcons/{itemId}` and NEVER to the manifest, so
// there is no self-refire to defend against and the guard can be the honest
// question: does this item's brief match this item's name?
//
// That also hands rewrite-on-rename over for free. Correcting "Sage oven" to
// "Sage the Smart Oven Pizzaiolo SPZ820" is exactly the moment the description
// should improve, and `briefSourceName !== item.name` is already true.
//
// Being level-triggered means two manifest writes in quick succession can both
// author the same brief. That is duplicate work, not a bug: the write is
// idempotent (same two fields, last one wins) and it costs one cheap text call.
// An edge guard would buy nothing and cost the nonce gymnastics this design
// exists to avoid.

// Defined here rather than imported from index.ts to avoid a circular import;
// the Firebase CLI aggregates same-named defineSecret calls across files at
// deploy time. This trigger reaches Gemini for the brief.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
// Optional, as elsewhere: when unset, reporting no-ops and the logger still emits.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

/**
 * Delete icon documents whose item is no longer in the manifest.
 *
 * This is not tidiness. `sweepOrphanedStorage` decides a Storage object is
 * orphaned by checking whether its owning Firestore doc still exists — so a left
 * -behind `equipmentIcons/{id}` would make the sweep look at
 * `equipment-icons/{id}.webp`, correctly conclude "not orphaned", and never
 * reclaim it. Reconciling here is what lets the sweep do its job.
 *
 * Runs on EVERY manifest write, including when generation is disabled: it makes
 * no AI call and costs one id-only collection scan.
 *
 * THE LIVE SET IS ITEMS *AND* ENTRIES (issue #1465, Phase 2). An accessory or
 * family member may now own `equipmentIcons/{accessoryId}`, and this pass deletes
 * anything outside the set it is handed — so building it from the items alone
 * would have wiped every entry picture in the kit the first time anyone ticked a
 * checkbox. `equipmentIconOwnerIds` is the definition of what the collection may
 * hold, and `tests/triggers/onEquipmentManifestWritten.test.ts` goes red if this
 * pass stops asking it.
 */
async function reconcileRemovedItems(liveIds: ReadonlySet<string>): Promise<void> {
  const db = getFirestore();
  const snap = await db.collection(EQUIPMENT_ICONS_COLLECTION).select().get();
  const stale = snap.docs.filter((d) => !liveIds.has(d.id));
  if (stale.length === 0) return;

  await Promise.all(
    stale.map((d) =>
      d.ref.delete().catch((err: unknown) => {
        // One failed delete must not cost the others, and must not fail the
        // trigger — the next manifest write retries it.
        logger.error('onEquipmentManifestWritten: orphan icon delete failed', { id: d.id, err });
        reportServerError(err, 'StorageError');
      }),
    ),
  );
  logger.info('onEquipmentManifestWritten: reconciled orphan icon docs', {
    deleted: stale.length,
  });
}

/**
 * Author this item's brief if it has none, or if its name has moved on.
 *
 * `{ merge: true }` is load-bearing on the rename path: it leaves `thumbnail`,
 * `sourceName` and `iconRequestedAt` exactly as they were, so the existing icon
 * keeps showing until a new one is approved. You never lose a picture you liked
 * because the words changed. `thumbnail: null` is written ONLY on create, for the
 * same reason — writing it unconditionally would wipe the picture on every
 * rename, which is the precise failure this whole collection exists to prevent.
 */
async function maybeAuthorBrief(item: EquipmentItemDoc): Promise<void> {
  const name = item.name.trim();
  if (!name) return;

  const db = getFirestore();
  const ref = db.collection(EQUIPMENT_ICONS_COLLECTION).doc(item.id);
  const existing = await ref.get();
  if (existing.exists && existing.get('briefSourceName') === name) return;

  try {
    // No outer withAiTimeout. The flow sets its own budget (55 s, no retry), and
    // wrapping it again is exactly the nested-budget disagreement the canon path
    // carries, where a 20 s outer race can pre-empt a 60 s inner one.
    const { brief } = await describeEquipmentSubjectFlow({ name });
    await ref.set(
      {
        subjectBrief: brief,
        briefSourceName: name,
        updatedAt: new Date().toISOString(),
        // Only on create — see the note above.
        ...(existing.exists ? {} : { thumbnail: null }),
      },
      { merge: true },
    );
    await clearEnrichmentFailure('equipmentBrief', item.id);
  } catch (err) {
    // Log and return: a trigger has no caller to surface a Failure to, and the
    // item simply keeps its old brief (or none) until the next manifest write.
    logger.error('onEquipmentManifestWritten: brief authoring failed', { id: item.id, err });
    reportServerError(err);
    // Written down where the app can read it (issue #1419), and THE ONLY TRACE
    // THERE IS: on this path the `equipmentIcons/{itemId}` document is never
    // created at all, so unlike the recipe branches there is not even an
    // unstamped field to look at.
    //
    // RECORDED, NOT ANNOUNCED. This guard is level-triggered — the next manifest
    // write re-attempts it — so it fixes itself, and Phase 3 stays silent about
    // it deliberately.
    await recordEnrichmentFailure({
      enrichment: 'equipmentBrief',
      subjectId: item.id,
      subjectLabel: name,
      err,
    });
  }
}

export const onEquipmentManifestWritten = onDocumentWritten(
  {
    document: `${EQUIPMENT_MANIFEST_COLLECTION}/${EQUIPMENT_MANIFEST_DOC_ID}`,
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    // 512MiB floor, pinned inline. NOT about this trigger's own workload — it runs
    // no sharp and needs none of the canon trigger's 1GiB. It is the module-init
    // baseline every function in this repo carries (firebase-admin + Genkit +
    // OTel + posthog-node), which alone clears 256MiB; see the note above
    // `setGlobalOptions` in index.ts. This trigger is top-imported, so the global
    // 512MiB never reaches it and the endpoint fell to the 256MiB platform
    // default — it was OOM-killed after authoring its FIRST brief, leaving every
    // other item stuck on "Writing a description…" with nothing to review or
    // draw. Pinned inline for the same reason region is.
    memory: '512MiB',
    // One 'fast'-tier text call per stale item, measured at ~2.8 s median. A cold
    // 19-item catch-up is ~55 s of AI time, so 300 s leaves comfortable headroom.
    timeoutSeconds: 300,
  },
  withFirestoreTrigger(async (event) => {
    const after = event.data?.after;
    // The manifest deleted outright: nothing to reconcile against, and wiping
    // every icon on what is almost certainly a mistake is not this trigger's call.
    if (!after?.exists) return;

    const parsed = EquipmentManifestSchema.safeParse(after.data());
    if (!parsed.success) {
      logger.error('onEquipmentManifestWritten: invalid manifest shape, skipping', {
        error: parsed.error.message,
      });
      return;
    }
    const items = parsed.data.items;

    await reconcileRemovedItems(equipmentIconOwnerIds(items));

    // E2E (FUNCTIONS_AI_FAKE): no brief authoring. The real text model is not
    // emulator-safe here and no e2e spec asserts a generated brief.
    // Unreachable in production — the flag is never set there.
    if (aiFakeEnabled()) return;
    if (!(await isIconGenerationEnabled('onEquipmentManifestWritten'))) return;

    // Sequential, not parallel: nineteen concurrent Gemini calls from one
    // invocation is a rate-limit shape for no gain, and the whole point of the
    // gate is that this path is no longer time-critical.
    //
    // ITEMS ONLY, and that is a decision rather than an omission (issue #1465,
    // Phase 2). Entries can own pictures now, but there are ~140 of them and most
    // are never named in a recipe — authoring a brief for each would be ~140 text
    // calls on every manifest save, for descriptions nobody asked to read. An
    // entry's brief is authored on request by the `authorEntryIconBrief`
    // callable, and the test beside this file asserts this loop never reaches an
    // accessory.
    for (const item of items) {
      await maybeAuthorBrief(item);
    }
  }, traceContextFromWrittenDoc),
);
