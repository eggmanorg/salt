import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  ENRICHMENT_FAILURES_COLLECTION,
  enrichmentFailureId,
  type EnrichmentFailureDoc,
  type EnrichmentFailureReason,
  type EnrichmentKind,
} from '@salt/domain/schemas';
import { AiTimeoutError } from './withAiTimeout.js';

// The write side of `enrichmentFailures` (issue #1419, Phase 1), in one place.
//
// Six triggers record into this collection and five of them delete from it, and
// the only thing they differ on is which kind and which subject — so this is a
// pair of calls rather than a block copied into every catch. The read side is
// `packages/adapters/firebase-sync`'s `subscribeEnrichmentFailures`; the shape
// and the id scheme are `@salt/domain/schemas/enrichmentFailure.ts`'s.
//
// ─── BEST-EFFORT, TWICE OVER (Rule 10) ──────────────────────────────────────
// Neither function ever rejects. They are called from inside branches that are
// themselves siblings under `Promise.allSettled`, and a rejection escaping one
// would retry BOTH — paying a second time for the branch that had already
// succeeded. So every failure here is swallowed after a log, exactly as
// `onShoppingListItemWrite`'s nested `.catch` around its own terminal-state
// write does.
//
// The consequence is worth stating plainly rather than implying the opposite:
// **a record that cannot be written is lost.** There is no queue and no retry.
// What is guaranteed is only the direction of the trade — recording a failure
// can never cost the enrichment, the sibling branch or the trigger — and that is
// what the test beside this file pins.

/**
 * Best-effort classification of an unstructured caught error.
 *
 * Deliberately conservative: anything it cannot positively identify comes back
 * `unknown`, and nothing anywhere branches on the answer. It exists so a marker
 * can say "it took too long" rather than "something went wrong" in the case
 * where that is demonstrably true, not to be an error taxonomy.
 *
 * `AiTimeoutError` is checked by NAME as well as by `instanceof`, because a flow
 * that re-wraps or serialises its rejection across a Genkit boundary loses the
 * prototype but keeps the name.
 */
export function classifyEnrichmentFailure(err: unknown): EnrichmentFailureReason {
  if (err instanceof AiTimeoutError) return 'timeout';
  if (!(err instanceof Error)) return 'unknown';
  if (err.name === 'AiTimeoutError') return 'timeout';

  const text = `${err.name} ${err.message}`.toLowerCase();
  if (text.includes('timed out') || text.includes('deadline')) return 'timeout';
  // The 2026-09-11 shape: Gemini 503s and 429s fanning out across every job in a
  // trigger run. These are the ones worth telling apart from a bug in our code,
  // because they are the ones a retry actually fixes.
  if (
    text.includes('overloaded') ||
    text.includes('unavailable') ||
    text.includes('503') ||
    text.includes('429') ||
    text.includes('resource_exhausted') ||
    text.includes('rate limit')
  ) {
    return 'upstream';
  }
  return 'unknown';
}

/**
 * Write down that a background job gave up on `subjectId`.
 *
 * The id is derived from (kind, subject), so a job that fails twice overwrites
 * its own row rather than leaving two.
 */
export async function recordEnrichmentFailure(input: {
  readonly enrichment: EnrichmentKind;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly err: unknown;
}): Promise<void> {
  const doc: EnrichmentFailureDoc = {
    enrichment: input.enrichment,
    subjectId: input.subjectId,
    subjectLabel: input.subjectLabel,
    reason: classifyEnrichmentFailure(input.err),
    failedAt: Date.now(),
  };
  try {
    await getFirestore()
      .collection(ENRICHMENT_FAILURES_COLLECTION)
      .doc(enrichmentFailureId(input.enrichment, input.subjectId))
      .set(doc);
  } catch (writeErr) {
    // Swallowed on purpose — see the header. Not reported to PostHog either: the
    // enrichment failure that brought us here has ALREADY been reported by the
    // catch block calling this, and a second event per failure would double
    // every alert (issue #1419 → "Do not add a second reporting path").
    logger.error('recordEnrichmentFailure: could not record', {
      enrichment: input.enrichment,
      subjectId: input.subjectId,
      writeErr,
    });
  }
}

/**
 * Clear the record for one (job, subject) pair, because the job has just
 * succeeded.
 *
 * Unconditional: a delete of a document that was never there is a no-op in
 * Firestore, so this needs no read and no "did it fail last time?" bookkeeping,
 * and the success path stays one extra call rather than a branch.
 */
export async function clearEnrichmentFailure(
  enrichment: EnrichmentKind,
  subjectId: string,
): Promise<void> {
  try {
    await getFirestore()
      .collection(ENRICHMENT_FAILURES_COLLECTION)
      .doc(enrichmentFailureId(enrichment, subjectId))
      .delete();
  } catch (err) {
    // A stale marker is a cosmetic wrong, and the next success clears it. Never
    // worth costing the enrichment that just succeeded.
    logger.error('clearEnrichmentFailure: could not clear', { enrichment, subjectId, err });
  }
}
