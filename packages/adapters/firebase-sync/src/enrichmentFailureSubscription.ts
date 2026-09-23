import type { DomainError } from '@salt/shared-types';
import {
  EnrichmentFailureSchema,
  ENRICHMENT_FAILURES_COLLECTION,
  type EnrichmentFailureDoc,
} from '@salt/domain/schemas';
import { subscribeCollection } from './subscribeCollection.js';

// Background-enrichment failures (issue #1419) — the READ side of a collection
// the client can only read. Every write is a Cloud Functions trigger's, through
// the Admin SDK, and `firestore.rules` denies client writes outright; so unlike
// `canonSubscription` there is no upsert and no delete here, and there is no
// callable either, because nothing a user does writes one. A record appears when
// a background job gives up and disappears when the same job next succeeds.

/**
 * Subscribe to every recorded background-enrichment failure.
 *
 * Delivered as a Map keyed by the DOCUMENT id — `enrichmentFailureId(kind,
 * subjectId)` — because that is how every caller asks the question: a page
 * holding a recipe wants to know whether THIS recipe's kit inference failed, and
 * a keyed lookup answers it without walking the collection. The document carries
 * both halves of the key as fields too, so a caller that wants to list them
 * (Phase 2's other surfaces, Phase 3's notification) still can.
 *
 * SKIP-AND-LOG on a per-document validation failure, following
 * `subscribeEquipmentIcons` and the list-read convention: one corrupt document
 * must not cost the app every other marker. A skipped record renders as no
 * marker, which is exactly how the app behaved before this collection existed.
 *
 * Stream-level errors still surface via `onError`.
 */
export function subscribeEnrichmentFailures(
  onFailures: (failures: Map<string, EnrichmentFailureDoc>) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [ENRICHMENT_FAILURES_COLLECTION],
      schema: EnrichmentFailureSchema,
      label: 'EnrichmentFailureSchema',
      project: (failure, id): [string, EnrichmentFailureDoc] => [id, failure],
    },
    (entries) => onFailures(new Map(entries)),
    onError,
  );
}
