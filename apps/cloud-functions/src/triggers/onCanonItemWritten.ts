import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { normaliseName } from '@salt/domain';
import { CanonItemSchema, type CanonItemDoc } from '@salt/domain/schemas';
import { embedTextFlow } from '../flows/embedText.js';
import { generateCanonIconFlow } from '../flows/generateCanonIcon.js';
import { reportServerError } from '../observability/reportServerError.js';
import {
  recordEnrichmentFailure,
  clearEnrichmentFailure,
} from '../adapters/enrichmentFailureStore.js';
import {
  maybeGenerateIcon,
  parseIconDocument,
  type IconTriggerDescriptor,
} from './iconWriteTrigger.js';
import { withFirestoreTrigger, traceContextFromWrittenDoc } from './triggerEntrypoint.js';

// Defined here (not imported from index.ts) to avoid a circular import; the
// Firebase CLI aggregates same-named defineSecret calls across files at deploy
// time. The trigger reaches Gemini for both the embedding and the icon, so the
// key must be bound to its runtime.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
// Bound so server error reporting (posthog-node) can read POSTHOG_API_KEY at
// runtime — this trigger reports embedding/icon/devSettings-read failures.
// Optional like elsewhere: when unset, reporting no-ops and the logger still
// emits.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

const ICON_STORAGE_PREFIX = 'canon-icons';

/**
 * Embedding branch: generate the name embedding if absent, writing it to the
 * server-only `canonEmbeddings/{id}` collection (issue #410) rather than inline
 * on this client-subscribed doc.
 *
 * CANON-ONLY, and the reason this trigger is the only icon family that composes
 * its own body instead of declaring a descriptor to `iconWriteTrigger`: product
 * forms and kitchen tools are matched on label/matcher TEXT, never on a vector,
 * so there is nothing to embed.
 *
 * Idempotency guard (two cheap checks): skip if an INLINE vector is still present
 * (an un-migrated doc — already embedded, and the match adapter reads it via its
 * inline fallback), or if the relocated `canonEmbeddings/{id}` doc already exists.
 * A brand-new canon doc has neither and gets embedded here.
 *
 * SIDE BENEFIT vs the old inline `.update({ embedding })`: writing a DIFFERENT
 * collection no longer re-fires this (`canonItems/{id}`) trigger, so the embedding
 * computation no longer bounces the whole canon doc back out to every subscribed
 * client — one of the write amplifiers issue #410 targets is removed outright.
 */
async function maybeGenerateEmbedding(id: string, item: CanonItemDoc): Promise<void> {
  if (item.embedding) return;

  const db = getFirestore();
  const existing = await db.collection('canonEmbeddings').doc(id).get();
  if (existing.exists) return;

  const normalised = normaliseName(item.name);
  if (!normalised) return;

  try {
    // No outer withAiTimeout: the flow owns its budget (issue #915).
    const { values } = await embedTextFlow({ text: normalised });
    await db
      .collection('canonEmbeddings')
      .doc(id)
      .set({ embedding: values, updatedAt: new Date().toISOString() });
    await clearEnrichmentFailure('canonEmbedding', id);
  } catch (err) {
    logger.error('onCanonItemWritten: embedding failed', { id, err });
    // Additive: an embedding flow failure (AI/Genkit) is unexpected → report it
    // to PostHog alongside the logger. Best-effort, never throws. The entrypoint's
    // finally flushes before the function returns.
    reportServerError(err);
    // Written down where the app can read it (issue #1419). RECORDED, NOT
    // ANNOUNCED: this branch is level-triggered — any later write to the canon
    // item re-enters it and the vector self-heals — so it is worth a row and
    // never worth a notification.
    await recordEnrichmentFailure({
      enrichment: 'canonEmbedding',
      subjectId: id,
      subjectLabel: item.name,
      err,
    });
  }
}

/**
 * Canon's icon family, on the six axes `iconWriteTrigger` reads (issue #989,
 * plus the failure-record kind added by #1419).
 * Named here rather than inlined because the trigger body below passes it twice.
 */
const canonIconDescriptor: IconTriggerDescriptor<CanonItemDoc> = {
  name: 'onCanonItemWritten',
  collection: 'canonItems',
  enrichment: 'canonIcon',
  storagePrefix: ICON_STORAGE_PREFIX,
  schema: CanonItemSchema,
  subjectOf: (item) => item.name,
  draw: (name, hint) => generateCanonIconFlow({ name, ...(hint ? { hint } : {}) }),
};

export const onCanonItemWritten = onDocumentWritten(
  {
    document: 'canonItems/{id}',
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    // Image generation (~5–8s+) plus sharp processing need more headroom than
    // the default text-only triggers.
    timeoutSeconds: 300,
    // A batch of new canon items (e.g. a recipe creating 34) fires this trigger
    // many times at once. Cloud Run packs concurrent invocations onto one
    // instance, and each icon decode holds a libvips/sharp image buffer — a few
    // in parallel blow past the memory cap and the instance is OOM-killed,
    // losing every in-flight icon. concurrency:1 serialises icon work per
    // instance (Cloud Run scales out instances instead), bounding memory
    // regardless of batch size; 1GiB gives the single decode comfortable room —
    // an upward override of the 512MiB floor, pinned inline (this trigger module
    // loads before index.ts's setGlobalOptions, same reason region is inline).
    concurrency: 1,
    memory: '1GiB',
  },
  // Distributed-trace correlation (issue #362, Phase 5) comes from the shared
  // entrypoint: the onShoppingListItemWrite trigger stamped its browser-rooted
  // W3C traceparent onto this canon doc as `traceContext` when it wrote the
  // match, and continuing it here nests the icon + embedding work under the SAME
  // trace ("Add item …" → canon-match → icon) instead of re-rooting.
  //
  // This is the ONE icon family that does not hand its descriptor straight to
  // `iconWriteTrigger`: it composes the trigger body itself, because pairing the
  // icon branch with the canon-only embedding branch is canon-only policy. The
  // shared factory therefore has no hook for a second branch — the alternative
  // was an extension point with exactly one user, permanently, in a module the
  // next icon family is meant to be a one-line declaration over.
  withFirestoreTrigger<{ id: string }>(async (event) => {
    const id = event.params.id;
    // Reading `traceContext` is a no-op for both idempotency guards (they key off
    // thumbnail/iconRequestedAt/embedding), so a bare traceContext-only re-fire
    // cannot loop into a duplicate generation.
    const item = parseIconDocument(canonIconDescriptor, id, event.data?.after);
    if (!item) return;

    // Two independently-guarded side-effects. allSettled so a failure in one
    // branch never rejects the handler (which would retry both). The icon branch
    // is edge-triggered on before→after, so it needs the prior snapshot.
    await Promise.allSettled([
      maybeGenerateEmbedding(id, item),
      maybeGenerateIcon(canonIconDescriptor, id, item, event.data?.before),
    ]);
  }, traceContextFromWrittenDoc),
);
