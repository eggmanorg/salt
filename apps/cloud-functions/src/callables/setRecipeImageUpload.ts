import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import { SetRecipeImageUploadInputSchema } from '@salt/domain/schemas';
import { makeCallable } from '../tracedCallable.js';
import { encodeHeroImage } from '../imaging/encodeHeroImage.js';
import { buildStorageDownloadUrl } from '../imaging/storageDownloadUrl.js';
import { reportFlowError } from '../observability/reportServerError.js';

// Bound so an unexpected Firestore/Storage write failure here can be reported
// (posthog-node). Optional like elsewhere — reporting no-ops when unset. This is
// NOT an AI call, so — like regenerateRecipeImage — only the posthog secret is
// bound (no GEMINI_API_KEY, no withAiTimeout, no AI-OTLP export in this process).
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

const IMAGE_STORAGE_PREFIX = 'recipe-images';

// User-uploaded hero image (issue #455, Phase 2). The browser crops a local photo
// to 3:2 (the ImageCropper primitive) and Saves; the cropped bytes arrive here as
// base64. We re-encode through the SAME encodeHeroImage the AI path uses (bounded
// 1280², WebP q80) so an uploaded hero is byte-normalised identically to a
// generated one, overwrite the stable `recipe-images/{id}.webp` object, and stamp
// `recipe.image = { url, source: 'upload' }`.
//
// Why a callable (mirroring regenerateRecipeImage) rather than a client Storage
// write: storage.rules stay `write: if false`, so the client never writes Storage
// directly (CLAUDE.md); the Admin SDK write is auth-gated here. A partial
// `.update()` also avoids the whole-document LWW clobber a client recipe write
// would risk against a concurrent trigger write.
//
// This does NOT re-fire image GENERATION: onRecipeWritten.imageNeedsGeneration
// returns false the instant `image !== null`, and it never touches a `source:
// 'upload'` image — so a manual photo is never clobbered by the AI trigger (no new
// guard needed). `imageRequestedAt` is bumped only as a cache-buster nonce: the
// hero renders through `recipeHeroUrl` in `@salt/domain` — which is
// `appendCacheBuster(url, imageRequestedAt ?? updatedAt)`, in one place since
// issue #933 rather than at eight call sites — and since the Storage path is
// byte-identical across uploads, a fresh nonce is what makes the new photo appear
// immediately without a hard reload.
//
// The same write deletes `imageBrief` (issue #1575). That field means "the art
// direction behind the photo you are looking at", and no art direction produced an
// uploaded photo — keeping the brief the trigger wrote for the previous AI hero
// would make it false, and every reader of it would act on a scene that is no
// longer on screen: the Regenerate dialog seeds from it, onRecipeWritten uses a
// present brief verbatim, and the prompt viewer builds from it. With the field
// gone, Regenerate over an uploaded photo takes the same path as a recipe that has
// never had a brief: an empty box, and the trigger authors a fresh one. Pinned by
// tests/callables/setRecipeImageUpload.test.ts. Recipes uploaded over an AI hero
// before this change still carry the old brief (fix-forward, no back-fill).
//
// region/memory are pinned inline (not via setGlobalOptions) because this module
// is imported at the top of index.ts and its onCall is built before
// setGlobalOptions runs — same reason regenerateRecipeImage pins them.
export const setRecipeImageUpload = makeCallable({
  options: {
    region: 'europe-west2',
    secrets: [posthogApiKey],
    // sharp decode/encode of a full-resolution upload needs headroom above the
    // 256MiB default — same 512MiB floor the rest of the image path uses.
    memory: '512MiB',
  },
  handler: async (request) => {
    const parsed = SetRecipeImageUploadInputSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError('invalid-argument', 'Invalid request payload.');
    }
    const { recipeId, imageBase64 } = parsed.data;

    // Decode → re-encode to the bounded WebP hero (sharp auto-detects the input
    // format, so the optional contentType hint is not needed here).
    const raw = Buffer.from(imageBase64, 'base64');
    const webp = await encodeHeroImage(raw);

    const bucket = getStorage().bucket();
    const path = `${IMAGE_STORAGE_PREFIX}/${recipeId}.webp`;
    await bucket.file(path).save(webp, {
      contentType: 'image/webp',
      // Same short max-age as the generated hero: the object path is stable but
      // its bytes change on each upload/regenerate, so it must not be immutable.
      metadata: { cacheControl: 'public, max-age=3600' },
    });
    const url = buildStorageDownloadUrl(bucket.name, path);

    // Partial update: set the hero to the uploaded photo, bump the cache-bust
    // nonce so the identical Storage URL re-fetches, and drop the previous AI
    // hero's brief (see the header). `source: 'upload'` marks it user-supplied so
    // the onRecipeWritten trigger skips it forever.
    await getFirestore()
      .collection('recipes')
      .doc(recipeId)
      .update({
        image: { url, source: 'upload' },
        imageBrief: FieldValue.delete(),
        imageRequestedAt: Date.now(),
      });
    return { ok: true } as const;
  },
});
