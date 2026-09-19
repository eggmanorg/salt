import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import {
  AuthorEntryIconBriefInputSchema,
  EquipmentManifestSchema,
  EQUIPMENT_ICONS_COLLECTION,
  EQUIPMENT_MANIFEST_COLLECTION,
  EQUIPMENT_MANIFEST_DOC_ID,
} from '@salt/domain/schemas';
import { equipmentEntrySubjectName } from '@salt/domain';
import { makeCallable } from '../tracedCallable.js';
import { describeEquipmentSubjectFlow } from '../flows/describeEquipmentSubject.js';

// Write one ENTRY's description, on request (issue #1465, Phase 2).
//
// ─── Why this exists at all ─────────────────────────────────────────────────
// An accessory or family member can have a pictogram of its own, and the pipeline
// that draws one is the item pipeline unchanged — `equipmentIcons/{accessoryId}`,
// `drawEquipmentIcon`, `setIconUpload`, `getImagePrompt`, all keyed by document
// id. Exactly one link in that chain is missing for an entry: the document. For
// an item `onEquipmentManifestWritten` authors it automatically, and
// `drawEquipmentIcon` refuses outright when it finds none ("No description to
// draw from yet"). For an entry nothing does, DELIBERATELY — ~140 entries, most
// never named in a recipe, and nobody asked to read ~140 descriptions or pay for
// the calls that write them.
//
// So the first act on an entry is asking for its description, and this callable
// is that act. Everything after it is the item flow, untouched.
//
// ─── It PERSISTS, which describeEquipmentSubject deliberately does not ──────
// The sibling callable hands a sentence back to the browser and writes nothing,
// because for an item the field is already occupied: it is the caption of the
// picture on screen, and an unaccepted revision must not overwrite it (#1433).
// Here there is no document and no picture, so there is nothing for the sentence
// to be a revision OF and nothing it could clobber. Once it exists, Revise and
// Draw behave for an entry exactly as they do for an item — and Draw is again the
// only thing that spends money on an image.
//
// `{ merge: true }` and `thumbnail: null` on create only, both copied from
// `maybeAuthorBrief` and load-bearing for the same reason: re-describing a
// renamed entry must leave the picture it already has exactly where it is.
//
// ─── Idempotent on the name, not on the call ────────────────────────────────
// Asking again for a description that was authored from the same words is a
// no-op and costs nothing: a double press, or a retry after a dropped response,
// must not buy a second text call. Rename either the entry or its appliance and
// the subject name moves, so the same button genuinely re-authors — which is the
// item trigger's rewrite-on-rename, reached by a press instead of by a write.
//
// ─── No outer withAiTimeout ─────────────────────────────────────────────────
// `describeEquipmentSubjectFlow` sets its own budget (AI_TEXT_FLOW_TIMEOUT, 55 s,
// no retry) in the file that calls the model, which is where the rule puts it.
// A second wrapper here would be two budgets disagreeing — the house default 20 s
// pre-empting a 55 s inner one — the exact nesting `apps/cloud-functions/CLAUDE.md`
// forbids and `maybeAuthorBrief` avoids for the same reason.

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// region pinned inline, as every top-imported module here does: this file is
// imported at the top of index.ts and its onCall is built before
// setGlobalOptions runs. 90 s matches `describeEquipmentSubject` — sized around
// the flow's own 55 s deadline with headroom — and the client declares a matching
// 90 s timeout, so raising one means raising the other. Memory comes from the
// 512MiB floor pinned here for the same top-import reason; nothing in this file
// decodes an image.
export const authorEntryIconBrief = makeCallable({
  options: {
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    timeoutSeconds: 90,
    memory: '512MiB',
  },
  handler: async (request) => {
    const parsed = AuthorEntryIconBriefInputSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError('invalid-argument', 'Invalid request payload.');
    }
    const { itemId, accessoryId } = parsed.data;

    const db = getFirestore();
    // The manifest is read server-side rather than trusting a subject name off
    // the wire: it is the authority on what this household owns, and a
    // client-supplied name would be an unvalidated string heading for a prompt.
    const manifestSnap = await db
      .collection(EQUIPMENT_MANIFEST_COLLECTION)
      .doc(EQUIPMENT_MANIFEST_DOC_ID)
      .get();
    const manifest = EquipmentManifestSchema.safeParse(manifestSnap.data());
    if (!manifest.success) {
      throw new HttpsError('failed-precondition', 'The equipment list could not be read.');
    }
    const item = manifest.data.items.find((i) => i.id === itemId);
    const accessory = item?.accessories.find((a) => a.id === accessoryId);
    if (!item || !accessory) {
      throw new HttpsError('not-found', 'No such entry on that equipment record.');
    }

    const name = equipmentEntrySubjectName(item, accessory);
    if (!name) {
      throw new HttpsError('failed-precondition', 'This entry has no name to describe.');
    }

    const ref = db.collection(EQUIPMENT_ICONS_COLLECTION).doc(accessoryId);
    const existing = await ref.get();
    if (existing.exists && existing.get('briefSourceName') === name) {
      return { ok: true } as const;
    }

    const { brief } = await describeEquipmentSubjectFlow({ name });
    await ref.set(
      {
        subjectBrief: brief,
        briefSourceName: name,
        updatedAt: new Date().toISOString(),
        // Create only — a re-describe after a rename must leave the existing
        // picture alone until a new one is approved.
        ...(existing.exists ? {} : { thumbnail: null }),
      },
      { merge: true },
    );
    return { ok: true } as const;
  },
});
