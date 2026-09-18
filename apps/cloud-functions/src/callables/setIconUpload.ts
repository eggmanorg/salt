import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import {
  SetIconUploadInputSchema,
  EQUIPMENT_ICONS_COLLECTION,
  KITCHEN_TOOLS_COLLECTION,
  type IconUploadFamily,
} from '@salt/domain/schemas';
import { makeCallable } from '../tracedCallable.js';
import { normalizeIconFraming } from '../imaging/normalizeIconFraming.js';
import { ICON_CONTENT_MAX, uploadIcon } from '../imaging/iconStorage.js';

// Your own picture in place of a generated pictogram (issue #892, Phase 2).
//
// Recipe heroes have worked this way since #455; this brings the four Tier-1
// families alongside them. The browser crops the photo square (ImageCropper
// `aspect="1:1"`, ui-spec-v11 §1) and the bytes arrive here as base64.
//
// ─── Why a callable, and why storage.rules do not move ──────────────────────
// `storage.rules` is public-read / `write: if false` on every prefix and stays
// that way. A Storage write needs the Admin SDK, so EVERY family's upload comes
// through here regardless of whether its collection is client-writable — which is
// what makes this the one place the four postures converge (canon items, product
// forms and kitchen tools are client-writable; `equipmentIcons` is not). Kitchen
// tools gain their first cloud-functions callable by it.
//
// ─── Parameterised on family, like requestIconRegeneration ──────────────────
// The four differ only in which collection and which Storage prefix they address;
// the processing, the framing and the write are one behaviour. Unlike
// requestIconRegeneration this is a whole callable rather than a shared helper,
// because there is no per-family auth guard or wire schema to keep apart — one
// discriminated input serves all four.
//
// ─── The framing is the point, not a nicety ─────────────────────────────────
// `normalizeIconFraming` with the shared `ICON_CONTENT_MAX` is what stops a
// column of icons ragging between apparent sizes. It measures the subject's
// ALPHA bounding box, which on an opaque photograph is the whole crop — so a
// square crop lands 108×108 and sits at the same apparent size as the drawn
// pictograms either side of it. (ui-spec-v11 §1.1 records that arithmetic; it is
// why the crop is square.)
//
// `removeFlatBackground` is deliberately NOT run. Its edge flood-fill is keyed to
// the flat generated fill colour and is documented as safe only because the house
// style keeps the subject off the frame edge. On a photograph it is unpredictable.
//
// ─── The nonce is load-bearing ──────────────────────────────────────────────
// Every icon family reuses the same Storage object path and writes it
// `immutable`, so an overwrite yields a byte-identical download URL and the
// browser serves the picture you just replaced. `iconRequestedAt` feeds
// `CanonIcon`'s `version` cache-bust prop. An upload that set `thumbnail` without
// stamping a fresh nonce would appear to do nothing.
//
// ─── What an upload does NOT need ───────────────────────────────────────────
// No `source: 'upload'` discriminator. The background triggers already guard on
// `thumbnail != null` and skip, so an upload is protected from regeneration for
// free; the only thing that replaces it is someone pressing Regenerate, which is
// what that button means.

const posthogApiKey = defineSecret('POSTHOG_API_KEY');

/** Where each family keeps its document and its Storage object. */
const TARGETS: Record<IconUploadFamily, { collection: string; prefix: string }> = {
  canon: { collection: 'canonItems', prefix: 'canon-icons' },
  productForm: { collection: 'productForms', prefix: 'product-form-icons' },
  kitchenTool: { collection: KITCHEN_TOOLS_COLLECTION, prefix: 'kit-icons' },
  equipment: { collection: EQUIPMENT_ICONS_COLLECTION, prefix: 'equipment-icons' },
};

// region/memory pinned inline (issue #883): this module is imported at the top of
// index.ts, so its onCall is built before setGlobalOptions runs. 512MiB is the
// floor the rest of the image path uses — enough for one sharp decode of an
// uploaded crop, and no more, since nothing here calls an image model.
export const setIconUpload = makeCallable({
  options: {
    region: 'europe-west2',
    secrets: [posthogApiKey],
    memory: '512MiB',
  },
  handler: async (request) => {
    const parsed = SetIconUploadInputSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError('invalid-argument', 'Invalid request payload.');
    }
    const { family, id, imageBase64 } = parsed.data;
    const { collection, prefix } = TARGETS[family];
    const ref = getFirestore().collection(collection).doc(id);

    // A PARTIAL `.update()` below, which fails on an absent document — and that is
    // the intended ordering rather than an oversight. Three of the four families
    // always have a document by the time an icon can be uploaded for them. The
    // fourth, `equipmentIcons`, is authored by the brief trigger — or, for an
    // ENTRY's own document since #1465 Phase 2, by `authorEntryIconBrief` when
    // somebody asks for one — so an upload before that lands would otherwise
    // `.set()` a document missing the required
    // `subjectBrief`/`briefSourceName` and strand it invalid. Checking first turns
    // that into an honest refusal the client can word.
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', 'There is nothing here to put a picture on yet.');
    }

    // Decode → frame. No re-encode step of its own: normalizeIconFraming already
    // emits a 128px WebP with alpha, which is exactly what the generated path
    // stores, so an uploaded pictogram is byte-normalised identically to a drawn
    // one.
    const raw = Buffer.from(imageBase64, 'base64');
    const webp = await normalizeIconFraming(raw, { contentMax: ICON_CONTENT_MAX });
    const url = await uploadIcon(prefix, id, webp);

    // Partial update: the picture and the cache-bust nonce, nothing else. A
    // whole-document write from a function would clobber whatever somebody
    // typed a moment ago — a synonym, a matcher, a brief — under LWW.
    await ref.update({ thumbnail: url, iconRequestedAt: Date.now() });
    return { ok: true } as const;
  },
});
