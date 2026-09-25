import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import type { IngredientGroup } from '@salt/domain';
import { PHOTO_IMPORT_TIMEOUT_SECONDS } from '@salt/domain/schemas';
import type {
  AuthoredRecipeEnvelope,
  DescribeRecipeSceneInput,
  DescribeRecipeSceneOutput,
  ExtractRecipeFromUrlInput,
  ExtractRecipeFromPhotoInput,
  PhotoImportFailure,
  RecipeDoc,
  UrlImportFailure,
} from '@salt/domain/schemas';
import { readAuthoredAnswer, type AuthoredRecipe } from './authoredRecipeAnswer.js';
import { classifyCallableError, isBrowserOffline } from './callableErrors.js';
import { callFunction, invokeCallable } from './callFunction.js';

export async function callParseRecipeIngredients(
  rawText: string,
): Promise<ReadResult<IngredientGroup[], DomainError>> {
  return callFunction<{ rawText: string }, IngredientGroup[]>({
    name: 'parseRecipeIngredients',
    input: { rawText },
    // The function declares 90 s (`cloud-functions/src/index.ts:288`) against
    // the callable client's 70 s default (#928, B2-010).
    timeoutMs: 90_000,
  });
}

// Map the callable's HttpsError code → the URL-import failure channel. The CF
// entrypoint deliberately maps each UrlImportError code to a distinct gRPC code
// (see apps/cloud-functions/src/index.ts:mapUrlImportFailure), so the reverse
// mapping here is exact. Adapters never throw — every failure crosses as a
// Failure.
//
// Import-SPECIFIC outcomes keep their bespoke codes (the web copy map keys off
// them). Auth and transport are NOT import outcomes, so they cross as ordinary
// DomainError, exactly as the other fifteen callable sites in this package do —
// which is what lets the §7.6 reporting gate, which gates by CATEGORY, see them
// at all (issue #740). There is deliberately no `default:` that invents an
// import code for a failure that never reached the import.
function classifyUrlImportError(err: unknown): UrlImportFailure {
  // Offline FIRST, before any code is read (issue #916). A failed fetch reaches
  // the SDK as `functions/internal`, which the `ai-failed` arm below would
  // otherwise report as "the recipe reader had trouble" — a verdict on the import
  // for a call that never left the device.
  if (isBrowserOffline()) return { kind: 'NetworkError', reason: 'offline' };
  const code = (err as { code?: string }).code ?? '';
  switch (code) {
    case 'functions/invalid-argument':
      // Covers both invalid-url and blocked-url. The CF copy distinguishes
      // them via the message; the client treats both as "can't import this
      // address" — we surface blocked-url (the stricter, no-detail message)
      // only when the message indicates a blocked link, else invalid-url.
      return {
        kind: 'ImportError',
        code: /can't be imported/i.test(String((err as { message?: string }).message ?? ''))
          ? 'blocked-url'
          : 'invalid-url',
      };
    case 'functions/unavailable':
      return { kind: 'ImportError', code: 'fetch-failed' };
    case 'functions/failed-precondition':
      return { kind: 'ImportError', code: 'not-a-recipe' };
    case 'functions/deadline-exceeded':
    case 'functions/internal':
      return { kind: 'ImportError', code: 'ai-failed' };
    case 'functions/unauthenticated':
      // The 401 that used to be told to the user as "we couldn't reach that
      // page". The import never ran; the session had died.
      return { kind: 'AuthError', reason: 'unauthenticated' };
    case 'functions/permission-denied':
      return { kind: 'AuthError', reason: 'forbidden' };
    default:
      // Never reached the import. Honestly unknown — NOT a statement about the
      // recipe site — so it defers to the shared callable mapper (issue #916)
      // rather than asserting "transient" over a code nobody has classified.
      return classifyCallableError(err);
  }
}

// Clears a recipe's hero image server-side (issue #148, Tier-2), re-firing the
// onRecipeWritten trigger so the image branch regenerates. Used for both the
// "regenerate" and "generate for the first time" actions (both set image → null),
// and it un-hides in the same write. Mirrors callRegenerateCanonIcon.
//
// `brief` is the art direction for the next generation — the user's (possibly
// edited) scene paragraph. Omitted or blank means "no brief", which the callable
// writes as a cleared `imageBrief` and the trigger reads as "author one" — the
// path a recipe with no brief yet takes. Optional → back-compat.
export async function callRegenerateRecipeImage(
  recipeId: string,
  brief?: string,
): Promise<ReadResult<void, DomainError>> {
  return callFunction<{ recipeId: string; brief?: string }, { ok: true }, void>({
    name: 'regenerateRecipeImage',
    // Trimmed before the emptiness test: a brief of whitespace is no brief, and
    // must leave the field off the payload — the trigger reads an absent
    // `imageBrief` as "author one".
    input: brief && brief.trim() ? { recipeId, brief: brief.trim() } : { recipeId },
    project: () => undefined,
  });
}

// Re-asks what kit a recipe needs (issue #882). The callable clears the
// `kitInferredAt` stamp and bumps the `kitRequestedAt` nonce, which together
// re-fire the onRecipeWritten kit branch; the new list arrives on the recipe
// subscription. A callable rather than a client write
// for the reason `callRegenerateRecipeImage` is one — it costs an AI call, so it is
// auth-gated, and a partial server `.update()` cannot clobber a concurrent trigger
// write the way a whole-document client save would.
//
// NEVER throws (Rule 10): every failure crosses the boundary as
// `Failure<DomainError>`, mapped exactly as its neighbours map it.
export async function callRedoRecipeKit(recipeId: string): Promise<ReadResult<void, DomainError>> {
  return callFunction<{ recipeId: string }, { ok: true }, void>({
    name: 'redoRecipeKit',
    input: { recipeId },
    project: () => undefined,
  });
}

// Uploads a user-supplied hero photo for a recipe (issue #455, Phase 2). The
// cropped 3:2 bytes ride as a base64 string; the callable re-encodes them and
// writes `recipe-images/{id}.webp`, then stamps `recipe.image = { url, source:
// 'upload' }`. Mirrors callRegenerateRecipeImage: a callable (never a client
// Storage write — storage.rules stay write:false), try → success(undefined), catch
// through the shared `classifyCallableError`. NEVER throws (Rule 10). The optional
// `contentType` is an informational hint only.
export async function callSetRecipeImageUpload(
  recipeId: string,
  imageBase64: string,
  contentType?: string,
): Promise<ReadResult<void, DomainError>> {
  return callFunction<
    { recipeId: string; imageBase64: string; contentType?: string },
    { ok: true },
    void
  >({
    name: 'setRecipeImageUpload',
    input: contentType ? { recipeId, imageBase64, contentType } : { recipeId, imageBase64 },
    project: () => undefined,
  });
}

// Scene brief on demand (issue #522, Phase 3). Sends the recipe — plus, on a
// revision, the current brief and the user's steer — and receives the
// art-direction paragraph back. Persists NOTHING: the brief returns to the dialog
// for the user to read and edit, and only reaches Firestore if they then press
// Regenerate (callRegenerateRecipeImage stamps it onto `imageBrief`).
//
// `traceparent` (issue #362) rides on the payload; how and why are written once,
// at `withTraceparent` in callFunction.ts.
//
// NEVER throws (Rule 10): a failure crosses as a Failure so the caller can leave
// the user's existing brief untouched and say so.
export async function callDescribeRecipeScene(
  input: DescribeRecipeSceneInput,
  traceparent?: string,
): Promise<ReadResult<DescribeRecipeSceneOutput, DomainError>> {
  return callFunction<DescribeRecipeSceneInput, DescribeRecipeSceneOutput>({
    name: 'describeRecipeScene',
    input,
    traceparent,
    // The function declares 90 s (`cloud-functions/src/index.ts:325`) against
    // the callable client's 70 s default (#928, B2-010).
    timeoutMs: 90_000,
  });
}

// SSRF-hardened URL import. Sends a URL, receives a fully-assembled, metric +
// British recipe draft (source.type='url') and whether the server's write of it
// landed (issue #1601 — the flag is always sent; see `readAuthoredAnswer`). On
// failure returns the specific UrlImportFailureCode so the caller can show the
// right copy.
// `traceparent` (issue #362) rides on the payload; see `withTraceparent`.
export async function callExtractRecipeFromUrl(
  input: Omit<ExtractRecipeFromUrlInput, 'reportPersistence'>,
  traceparent?: string,
): Promise<ReadResult<AuthoredRecipe, UrlImportFailure>> {
  // `invokeCallable` rather than `callFunction`: this answers with its OWN
  // failure vocabulary, which the web copy map keys off, so the catch cannot be
  // the shared one. Region, payload and the absent timeout still come from the
  // one place.
  try {
    const data = await invokeCallable<
      ExtractRecipeFromUrlInput,
      RecipeDoc | AuthoredRecipeEnvelope
    >({
      name: 'extractRecipeFromUrl',
      input: { ...input, reportPersistence: true },
      traceparent,
      // The function declares 120 s (`cloud-functions/src/index.ts:471`) against
      // the callable client's 70 s default. Fetching and reading a page is the
      // slowest thing this callable does and the one most likely to overrun
      // (#928, B2-010).
      timeoutMs: 120_000,
    });
    return success(readAuthoredAnswer(data));
  } catch (err) {
    return failure(classifyUrlImportError(err));
  }
}

// Map the callable's HttpsError code → the PHOTO-import failure vocabulary
// (issue #649). Its own closed set, not the URL one: invalid-url / blocked-url /
// fetch-failed are meaningless when the input is a photograph. The CF entrypoint
// maps each PhotoImportError code to a distinct gRPC code (see
// apps/cloud-functions/src/index.ts:mapPhotoImportFailure), so the reverse
// mapping here is exact.
//
// Same shape as classifyUrlImportError since #740, and for the same reason: a
// signed-out photo import used to fall through to `import-failed`, telling the
// user "the recipe reader had trouble with those photos" when their photographs
// were never read. Auth and transport cross as DomainError so the §7.6 category
// gate can see them; only genuine photo outcomes keep a bespoke code. The two
// code sets remain separate taxonomies — only the union's shape is shared.
function classifyPhotoImportError(err: unknown): PhotoImportFailure {
  // Offline FIRST, before any code is read (issue #916) — see
  // classifyUrlImportError. A failed fetch must not be reported as a verdict on
  // the user's photographs.
  if (isBrowserOffline()) return { kind: 'NetworkError', reason: 'offline' };
  const code = (err as { code?: string }).code ?? '';
  switch (code) {
    case 'functions/invalid-argument':
      // A payload the wire schema refused: no images, more than four, an
      // unsupported content type, or empty bytes.
      return { kind: 'ImportError', code: 'invalid-photos' };
    case 'functions/failed-precondition':
      // Blurry/dark photo OR a page with no recipe on it — the server genuinely
      // cannot tell these apart, so one code carries both.
      return { kind: 'ImportError', code: 'unreadable-photos' };
    case 'functions/deadline-exceeded':
    case 'functions/internal':
      // The recipe reader itself failed: "that didn't work, try again" rather
      // than a claim about their photographs.
      return { kind: 'ImportError', code: 'import-failed' };
    case 'functions/unauthenticated':
      return { kind: 'AuthError', reason: 'unauthenticated' };
    case 'functions/permission-denied':
      return { kind: 'AuthError', reason: 'forbidden' };
    default:
      // Never reached the reader (transport, cancellation). Honestly unknown, so
      // it defers to the shared callable mapper (issue #916) rather than
      // asserting "transient" over a code nobody has classified.
      return classifyCallableError(err);
  }
}

// Import a recipe from photographs of a cookbook page (issue #649). Sends 1–4
// page images as base64, receives a fully-assembled, metric + British recipe
// draft (source.type='book') that the server has ALREADY persisted with
// needs_approval. On failure returns a PhotoImportFailure — a bespoke photo code
// when the photographs are genuinely the story, an ordinary DomainError when they
// are not — so the caller can show the right copy. NEVER throws (Rule 10).
//
// The explicit `timeoutMs` is load-bearing, not decoration: the Firebase callable
// client defaults to 70s, so without it a slow multi-page extraction would fail
// on the client while the function was still working. PHOTO_IMPORT_TIMEOUT_SECONDS
// is the SAME constant the CF passes as its `timeoutSeconds`, so the two cannot
// drift apart.
//
// `traceparent` (issue #362) rides on the payload; see `withTraceparent`.
export async function callExtractRecipeFromPhoto(
  input: Omit<ExtractRecipeFromPhotoInput, 'reportPersistence'>,
  traceparent?: string,
): Promise<ReadResult<AuthoredRecipe, PhotoImportFailure>> {
  // `invokeCallable` for the same reason as the URL import: its own closed
  // failure vocabulary, so its own catch. The persistence flag is sent and read
  // back exactly as the URL import does (issue #1601).
  try {
    const data = await invokeCallable<
      ExtractRecipeFromPhotoInput,
      RecipeDoc | AuthoredRecipeEnvelope
    >({
      name: 'extractRecipeFromPhoto',
      input: { ...input, reportPersistence: true },
      traceparent,
      timeoutMs: PHOTO_IMPORT_TIMEOUT_SECONDS * 1000,
    });
    return success(readAuthoredAnswer(data));
  } catch (err) {
    return failure(classifyPhotoImportError(err));
  }
}
