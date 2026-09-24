import { getFirestore, FieldValue, type DocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { DevSettingsSchema, type EnrichmentKind } from '@salt/domain/schemas';
import { removeFlatBackground } from '../imaging/removeFlatBackground.js';
import { normalizeIconFraming } from '../imaging/normalizeIconFraming.js';
import { ICON_CONTENT_MAX, uploadIcon } from '../imaging/iconStorage.js';
import { aiFakeEnabled } from '../ai/fakeModel.js';
import {
  recordEnrichmentFailure,
  clearEnrichmentFailure,
} from '../adapters/enrichmentFailureStore.js';
import { reportServerError } from '../observability/reportServerError.js';
import { withFirestoreTrigger, traceContextFromWrittenDoc } from './triggerEntrypoint.js';

// The Tier-1 pictogram pipeline, once (issue #989).
//
// Three triggers draw Tier-1 pictograms — canon items (#148), product forms
// (#871) and kitchen tools (#882) — and they were one file copied three times:
// the same edge-trigger decision, the same fail-open kill switch, the same
// draw → background-removal → framing → upload → write-back chain. They differ
// on six mechanical axes and nothing else: the collection, the Storage prefix,
// the document schema, which field the picture is OF, which flow draws it, and
// (since #1419) which `enrichmentFailures` kind a failed drawing is recorded
// under.
// They are now DECLARATIONS over this module, and a fifth icon family is a
// descriptor rather than a file.
//
// The copies had already drifted, which is the argument for doing it: three dead
// `withAiTimeout` imports left by #915 and a dead flush import plus an empty
// `finally` left by #920 sat in these files for two issues, because nothing
// checks an import nobody calls.
//
// WHAT THIS DOES NOT ABSORB:
//
//  • `onEquipmentManifestWritten` authors text briefs and reconciles orphans; it
//    draws nothing. It shares exactly one thing with the three — the kill-switch
//    reader — and imports that alone.
//  • Canon's embedding branch, AND the `Promise.allSettled` pairing that guards
//    it beside the icon branch. Both are canon-only policy, so both stay in
//    `onCanonItemWritten.ts`: that file composes its own trigger body out of the
//    two exported pieces below (`parseIconDocument` + `maybeGenerateIcon`)
//    rather than handing this factory a hook only it would ever pass. A shared
//    factory with a one-user extension point is a worse trade than ten lines of
//    composition at the one call site that needs them.
//  • The Storage upload and the framing constant. `uploadIcon` and
//    `ICON_CONTENT_MAX` are not trigger-specific and live in
//    `src/imaging/iconStorage.ts` beside the rest of the imaging chain, where
//    the callable draw/upload paths can reach them too.
//
// Registration stays at each call site, deliberately: `memory`, `region`,
// `concurrency` and `timeoutSeconds` must be pinned in a literal options object
// at the `onDocumentWritten` call, because these modules are evaluated before
// index.ts's `setGlobalOptions` runs and a pin hoisted in here would not apply.
// `tests/functionMemoryPin.test.ts` scans for exactly that.

/**
 * All this module needs of a drawable document — the tri-state `thumbnail`
 * contract every icon family shares, field for field.
 *
 * `null` = not drawn yet, an https URL = a real icon, the CANON_ICON_HIDDEN
 * "hidden" sentinel = the user opted out and it is never drawn again.
 */
export interface IconDocument {
  readonly thumbnail: string | null;
  /** Transient one-shot steer, consumed and cleared by the write that sets the icon. */
  readonly iconHint?: string | undefined;
  /** Regenerate nonce (epoch ms) — see `iconNeedsGeneration`. */
  readonly iconRequestedAt?: number | undefined;
}

/**
 * Structural stand-in for the family's zod schema. Deliberately structural
 * rather than `z.ZodType`: `cloud-functions` does not depend on `zod` directly
 * (the schemas arrive through `@salt/domain/schemas`), and adding a dependency
 * to name a type would be an issue-first layer change for nothing. Same shape as
 * `timerWriteTrigger.ts`'s.
 */
export interface IconDocumentSchema<TDoc> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: TDoc }
    | { readonly success: false; readonly error: { readonly message: string } };
}

/**
 * Edge-trigger decision, shared by every icon family. The trigger fires on EVERY
 * write to the document, so generation must start only on the write that
 * *transitions* the document into "needs an icon" — never merely because the
 * thumbnail currently happens to be null. Otherwise an unrelated write landing
 * while a drawing is still in flight re-enters and starts a *duplicate*, because
 * `thumbnail` stays null until the first one finishes. That hazard is real in
 * every family: a canon-match synonym append or a traceContext stamp, the admin
 * catalog saving a form field-by-field on blur, a matcher added to a tool whose
 * picture is still being drawn.
 *
 * Generate when:
 *   - create (no prior doc) with a null thumbnail
 *   - thumbnail just went non-null → null (manual regenerate, or user cleared)
 *   - the `iconRequestedAt` nonce changed — covers a forced regenerate of a
 *     document whose thumbnail was *already* null
 * Skip when the thumbnail was already null before this write and stayed null:
 * the write that first set it null already owns the in-flight generation.
 *
 * `thumbnail !== null` (a real URL, or the "hidden" sentinel) always skips:
 * already drawn, or the user opted out forever. That is also what makes a
 * seeding script safe — it writes each document with its thumbnail ALREADY set,
 * so the trigger sees the create and skips rather than redrawing the whole
 * vocabulary at the seeder's expense.
 *
 * `prev?.['thumbnail'] ?? null` reads a MISSING key as "already null", so the
 * schema default arriving on the parsed `after` is never mistaken for a
 * just-cleared icon — otherwise the first unrelated edit to every document
 * written before its family had icons would fire a generation at once.
 */
export function iconNeedsGeneration(
  before: DocumentSnapshot | undefined,
  after: IconDocument,
): boolean {
  if (after.thumbnail !== null) return false; // real URL or "hidden" sentinel → skip
  if (!before?.exists) return true; // create → generate
  const prev = before.data();
  if ((prev?.['thumbnail'] ?? null) !== null) return true; // just cleared → generate
  // Already null and still null: only an explicit regenerate (nonce bump)
  // re-fires; any other field change (rename, aisle, matchers, a traceContext
  // stamp…) must not start a duplicate.
  return prev?.['iconRequestedAt'] !== after.iconRequestedAt;
}

/**
 * Reads the per-environment icon kill-switch (issue #238) from
 * `devSettings/singleton`. ONE flag, `canonIconGenerationEnabled`, covers every
 * pictogram family — same pipeline, same model, same cost profile, so a second
 * flag would only be a second thing to remember to flip alongside the first (the
 * decision taken in #871 and re-taken in #877 and #882).
 *
 * FAILS OPEN: a missing doc, an unexpected shape, or a read error all default to
 * ENABLED, so an environment that never configured the switch keeps the default
 * behaviour and a transient read glitch never silently halts generation.
 *
 * Read PER INVOCATION and deliberately not cached: caching would move a flip's
 * effect from the next invocation to the next cold start, in the one operational
 * control that exists to stop spend in a hurry. It is a single `get` on a hot
 * path, and it happens only once the cheap in-memory guards have passed.
 *
 * `name` is the calling function's deployed name, so the two log lines stay
 * grepable per trigger.
 */
export async function isIconGenerationEnabled(name: string): Promise<boolean> {
  try {
    const snap = await getFirestore().collection('devSettings').doc('singleton').get();
    if (!snap.exists) return true;
    const parsed = DevSettingsSchema.safeParse(snap.data());
    if (!parsed.success) {
      // Expected validation fallback (a doc that doesn't match the schema, e.g. a
      // partially-written settings doc): NOT reported — a ValidationError-class
      // "expected" outcome, suppressed per policy. The fail-open default and the
      // warn log are the contract.
      logger.warn(`${name}: invalid devSettings doc, defaulting to enabled`);
      return true;
    }
    return parsed.data.canonIconGenerationEnabled;
  } catch (err) {
    logger.warn(`${name}: devSettings read failed, defaulting to enabled`, { err });
    // A read THROW (vs the shape mismatch above) is a StorageError-class failure.
    // Non-critical (we fail open), but genuinely unexpected, so report it
    // additively — best-effort, never throws.
    reportServerError(err, 'StorageError');
    return true;
  }
}

/** The six axes an icon family differs on, plus the name its logs are grepped by. */
export interface IconTriggerDescriptor<TDoc extends IconDocument> {
  /** The deployed function name, used as the log prefix. */
  readonly name: string;
  /** The collection the finished icon is written back to. */
  readonly collection: string;
  /**
   * Which `enrichmentFailures` kind a failed drawing is recorded under (issue
   * #1419), and the SIXTH axis — added by that issue, which is why the sentence
   * above says six where #989 said five.
   *
   * A declared field rather than a value derived from `collection`, because the
   * two do not line up: product forms draw through the CANON flow but must not
   * share canon's marker, and a derivation would put the mapping somewhere the
   * closed enum could not see it. The enum is also the marker-copy list, so a
   * new icon family declaring a kind is what makes its marker have words.
   */
  readonly enrichment: EnrichmentKind;
  /** This family's Storage prefix — distinct per family; see `imaging/iconStorage.ts`. */
  readonly storagePrefix: string;
  /** Parses the written document. Kept whole so schema defaults and back-compat run. */
  readonly schema: IconDocumentSchema<TDoc>;
  /** The field the picture is OF: a canon item's name, a form's or a tool's label. */
  readonly subjectOf: (doc: TDoc) => string;
  /**
   * Runs this family's Genkit flow. A closure rather than the flow itself
   * because "family" is not one-to-one with "flow": three flows serve four
   * families (product forms draw through the CANON flow, since a form IS a
   * grocery) and the two flows name their subject differently — `name` for
   * groceries, `label` for kitchen tools.
   *
   * NO `withAiTimeout` here or at any caller (issue #915). The flow owns its
   * budget — 60s + 1 retry, sized for an image generation — and a wrapper here
   * would impose the house 20s default on top of it, so a drawing that took
   * longer than 20s would be cut short and retried whole. That is the
   * nested-budget disagreement the equipment paths already cite as the thing not
   * to copy.
   */
  readonly draw: (subject: string, hint?: string) => Promise<{ imageBase64: string }>;
}

/**
 * Icon branch: draw the pictogram when this write transitions the document into
 * "needs an icon" (see `iconNeedsGeneration`).
 *
 * Trade-off of edge-triggering: a generation that *fails* leaves `thumbnail`
 * null but no longer self-heals on the next unrelated write — the regenerate
 * path (which bumps `iconRequestedAt`) is the retry.
 *
 * Exported for the one family that cannot use the factory below wholesale:
 * `onCanonItemWritten` pairs this branch with its own embedding branch under
 * `Promise.allSettled`, and that pairing is canon-only policy that belongs in
 * canon's file rather than as a hook in here.
 */
export async function maybeGenerateIcon<TDoc extends IconDocument>(
  descriptor: IconTriggerDescriptor<TDoc>,
  id: string,
  doc: TDoc,
  before: DocumentSnapshot | undefined,
): Promise<void> {
  const { name, collection, storagePrefix, subjectOf, draw } = descriptor;

  if (!iconNeedsGeneration(before, doc)) return;

  // E2E (FUNCTIONS_AI_FAKE): skip generation entirely. The real image model and
  // the Storage upload (which authenticates via the GCE metadata server) are not
  // emulator-safe and hang the trigger; no e2e spec asserts a generated icon.
  // Unreachable in production (the flag is never set there).
  if (aiFakeEnabled()) return;

  // The subject is the document's own human-facing name — "Baked Beans", "Lime
  // juice", "Mixing bowl". It needs no decoration: prompting "lime (lime juice)"
  // invites the model to draw both, and a tool's matchers are alternative
  // phrasings rather than subjects, so naming them would ask for several tools
  // in one frame.
  const subject = subjectOf(doc).trim();
  if (!subject) return;

  // Per-environment kill-switch, checked only once the cheap in-memory guards
  // pass (i.e. we would otherwise generate).
  if (!(await isIconGenerationEnabled(name))) return;

  // Optional one-shot steer from whoever judged the last drawing wrong.
  const hint = doc.iconHint?.trim();

  try {
    const { imageBase64 } = await draw(subject, hint);
    const raw = Buffer.from(imageBase64, 'base64');
    // Background removal, then framing. The model centres its subject only
    // loosely — measured 55–72% of the frame across production icons — so
    // without the second step every icon lands at its own apparent size and all
    // of them read small inside their tile.
    const webp = await normalizeIconFraming(await removeFlatBackground(raw), {
      contentMax: ICON_CONTENT_MAX,
    });
    const url = await uploadIcon(storagePrefix, id, webp);
    // Set the icon and clear the one-shot hint in the same write. A PARTIAL
    // update, never a full-document set: a curator may well have been editing the
    // document while the picture was being drawn, and LWW at document level would
    // throw their edit away.
    await getFirestore()
      .collection(collection)
      .doc(id)
      .update({ thumbnail: url, iconHint: FieldValue.delete() });
    // There is a picture now, so any record of a previous failure goes (issue
    // #1419). Unconditional and never throws.
    await clearEnrichmentFailure(descriptor.enrichment, id);
  } catch (err) {
    // Leave thumbnail null so a later regenerate retries; never block the
    // trigger. Drawing chains an AI flow, image processing and a Storage upload,
    // so a throw here is unexpected: report it additively alongside the logger,
    // best-effort and never throwing (Rule 10). The entrypoint's finally flushes.
    logger.error(`${name}: icon generation failed`, { id, err });
    reportServerError(err);
    // And written down where the app can read it (issue #1419). This is the
    // branch the comment above is about: a drawing that fails no longer
    // self-heals, so until a human presses redo the only trace of it — before
    // this — was a log line.
    await recordEnrichmentFailure({
      enrichment: descriptor.enrichment,
      subjectId: id,
      subjectLabel: subject,
      err,
    });
  }
}

/**
 * Parses a written document against its family's schema, or logs and returns
 * undefined. An absent/deleted `after` is simply "nothing to do".
 *
 * Trigger boundary: an invalid shape is logged and swallowed — there is no caller
 * to surface a `Failure` to (Zod conventions, root CLAUDE.md).
 *
 * Exported for the same reason `maybeGenerateIcon` is: canon composes its own
 * trigger body, and this keeps the one log line single-source across both.
 */
export function parseIconDocument<TDoc extends IconDocument>(
  descriptor: IconTriggerDescriptor<TDoc>,
  id: string,
  after: DocumentSnapshot | undefined,
): TDoc | undefined {
  if (!after?.exists) return undefined;

  const parsed = descriptor.schema.safeParse(after.data());
  if (parsed.success) return parsed.data;

  logger.error(`${descriptor.name}: invalid doc shape, skipping`, {
    id,
    error: parsed.error.message,
  });
  return undefined;
}

export function iconWriteTrigger<TDoc extends IconDocument>(
  descriptor: IconTriggerDescriptor<TDoc>,
) {
  return withFirestoreTrigger<{ id: string }>(async (event) => {
    const id = event.params.id;
    const doc = parseIconDocument(descriptor, id, event.data?.after);
    if (!doc) return;

    // The icon branch is edge-triggered on before→after, so it needs the prior
    // snapshot. Reading `traceContext` is a no-op for its idempotency guard (it
    // keys off thumbnail/iconRequestedAt), so a bare traceContext-only re-fire
    // cannot loop into a duplicate generation.
    await maybeGenerateIcon(descriptor, id, doc, event.data?.before);
  }, traceContextFromWrittenDoc);
}
