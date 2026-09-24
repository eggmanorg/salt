import { z } from 'zod';

// Background-enrichment failures, written down where the app can read them
// (issue #1419, Phase 1).
//
// ─── What was wrong ─────────────────────────────────────────────────────────
// Every background job in Salt already LOGGED its failures — `logger.error` plus
// `reportServerError` to PostHog at every catch site. What none of them did was
// leave a trace anywhere a person or the app could see, so a recipe whose kit
// inference gave up looked identical to a recipe nobody had ever asked the kit
// question about. That is how four recipes reached the library with no equipment
// list and sat there for up to twelve days (#1418).
//
// This collection is NOT a second reporting path. PostHog still owns reporting,
// §7.6's category gating is untouched, and nothing here reports anything. It is
// the same fact, written somewhere the household can read it.
//
// ─── Why a separate collection, and not a field ─────────────────────────────
// `recipes` (and `canonItems`, and `productForms`, and `kitchenTools`) are
// rewritten wholesale by a client `setDoc` on every canonicalise, per-row
// rematch, edit and "apply changes" — CLAUDE.md's LWW note is explicit that a
// trigger-written field is clobbered by one. That is the `timerDeliveries`
// reasoning (docs/data-model.md → `timerDeliveries`), and it applies here
// unchanged.
//
// The equipment brief settles it independently: when `describeEquipmentSubject`
// fails there is no `equipmentIcons/{itemId}` document at all, so there is
// nothing to put a field on.
//
// It is NOT `timerDeliveries` itself, and the difference is the rules block
// rather than taste. That collection is a dedupe ledger no client ever reads
// (`allow read, write: if false`). This one exists TO BE READ by the client —
// that is its entire point — so its rules follow `equipmentIcons`:
// `allow read: if request.auth != null; allow write: if false`.
//
// ─── Family-shared, with no `userId` ────────────────────────────────────────
// Recipes are family-shared, so "this recipe is missing its equipment list" is
// everybody's business. The four per-user collections stay four.
export const ENRICHMENT_FAILURES_COLLECTION = 'enrichmentFailures';

/**
 * Which background job gave up.
 *
 * A CLOSED enum, and deliberately not the collection name plus a field name: the
 * marker copy, and Phase 3's notification line, are written per kind, and a
 * string that can be anything makes both of those a lookup with a fallback
 * nobody ever sees.
 *
 * EIGHT KINDS FOR NINE UNITS OF WORK, and the one that is missing is
 * `describeRecipeScene`'s art-direction brief. It has no failure of its own to
 * record: `describeSceneOrNothing` degrades to `undefined` and the hero image is
 * generated anyway, from the prompt's own "read the dish yourself" clause. The
 * only user-visible hole it can contribute to is a missing hero, and that is
 * `recipeImage` below. Recording it separately would mark a recipe as failed
 * while its picture was sitting right there.
 */
export const EnrichmentKindSchema = z.enum([
  /** `generateRecipeImage` — `recipes/{id}.image`. */
  'recipeImage',
  /** `identifyRecipeKit` — `recipes/{id}.kit` + `kitInferredAt`. */
  'recipeKit',
  /** `estimateRecipeTimes` — `recipes/{id}.metadata.phases` + `timesEstimatedAt`. */
  'recipeTimes',
  /** `describeEquipmentSubject` — the `equipmentIcons/{itemId}` document itself. */
  'equipmentBrief',
  /** `embedText` — `canonEmbeddings/{id}`. */
  'canonEmbedding',
  /** `generateCanonIcon` — `canonItems/{id}.thumbnail`. */
  'canonIcon',
  /** `generateCanonIcon` over a form — `productForms/{id}.thumbnail`. */
  'productFormIcon',
  /** `generateKitchenToolIcon` — `kitchenTools/{id}.thumbnail`. */
  'kitchenToolIcon',
]);

export type EnrichmentKind = z.infer<typeof EnrichmentKindSchema>;

/**
 * Why it gave up — a small closed enum, and no free text.
 *
 * An AI error message can quote the user's own content back, and §7.6 requires
 * raw user input to be scrubbed from anything reported. A three-way enum stays
 * truthful ("the model was overloaded" and "it took too long" are genuinely
 * different things to a reader) without carrying a single character of it.
 *
 * STATED BOUNDARY, not an invariant: `classifyEnrichmentFailure` reads an
 * unstructured `unknown` and falls back to `unknown` whenever it cannot tell.
 * Nothing branches on this field — no guard reads it, no retry consults it — so
 * a misclassification costs a slightly wrong word on a marker and nothing else.
 */
export const EnrichmentFailureReasonSchema = z.enum(['timeout', 'upstream', 'unknown']);

export type EnrichmentFailureReason = z.infer<typeof EnrichmentFailureReasonSchema>;

export const EnrichmentFailureSchema = z.object({
  /** Which job. See `EnrichmentKindSchema`. */
  enrichment: EnrichmentKindSchema,
  /**
   * The document the job was FOR — a recipe id, an equipment item (or accessory)
   * id, a canon id, a product-form id, a kitchen-tool id. Never a uid, and never
   * read as scoping: the record is family-shared.
   */
  subjectId: z.string().min(1),
  /**
   * What that subject is CALLED, as it was at the moment of failure — the recipe
   * title, the canon item's name, the tool's label.
   *
   * A snapshot, exactly as `recipes.createdBy` is, and stale for the same reason
   * a rename makes that one stale. It is here so the record reads on its own:
   * without it, a row in this collection is two opaque ids, and Phase 3's
   * notification ("Spaghetti Bolognese: couldn't work out the equipment list")
   * has nothing to say. Never matched against anything.
   */
  subjectLabel: z.string(),
  /** Why, as far as we can tell. See `EnrichmentFailureReasonSchema`. */
  reason: EnrichmentFailureReasonSchema,
  /** When, epoch ms. Audit and ordering only. */
  failedAt: z.number(),
});

export type EnrichmentFailureDoc = z.infer<typeof EnrichmentFailureSchema>;

/**
 * The document id for one (job, subject) pair.
 *
 * DERIVED RATHER THAN RANDOM, and that is what makes the whole collection
 * self-maintaining. A re-failure overwrites its own row instead of piling up a
 * second, and the next SUCCESS deletes a row it can name without reading
 * anything first — which is Open Question 4(a), the recommendation the issue
 * carries, at the cost of one `.delete()` beside each existing write-back.
 *
 * `_` is safe as the separator because the kind is a fixed closed enum with no
 * underscore in any member, so the split point is never ambiguous — the same
 * reasoning `timerDeliveries`' key prefixes rest on.
 */
export function enrichmentFailureId(enrichment: EnrichmentKind, subjectId: string): string {
  return `${enrichment}_${subjectId}`;
}
