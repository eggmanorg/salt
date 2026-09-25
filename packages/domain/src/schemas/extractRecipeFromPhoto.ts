import { z } from 'zod';
import { ExtractRecipeAIOutputSchema } from './extractRecipeFromUrl.js';
import { AuthoredRecipeOutputSchema, ReportPersistenceSchema } from './authoredRecipeEnvelope.js';

// Import a recipe from photographs of a cookbook page (issue #649, Phase 3).
//
// Input: 1–4 cropped page photographs of ONE recipe (a recipe routinely spans a
// spread — ingredients left, method right). Output: a fully-assembled recipe
// draft with `source.type = 'book'`, already persisted server-side and flagged
// `needs_approval`, exactly as a URL import is.
//
// The page images are REQUEST-SCOPED: they go to Gemini as media prompt parts,
// the structured recipe comes back, and the bytes are discarded. There is no
// Storage write, no `sharp` re-encode, and no OCR/text-extraction stage —
// flattening a page to a text blob would lose the column layout, ingredient
// grouping, fraction glyphs and headnote/step distinction the extraction
// depends on.

// The image formats the capture UI may send. A closed allowlist rather than a
// free string: these bytes become a `data:` URI handed straight to the model, so
// the content type is part of the prompt, not a hint. WebP is what the capture
// path actually produces (1600px max edge, q0.92); JPEG/PNG are accepted so a
// share-sheet or file-picker origin does not need a re-encode purely to satisfy
// this schema.
export const RECIPE_PAGE_PHOTO_CONTENT_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

// Upper bound on pages per import. A recipe spans at most a spread in practice;
// four allows a long method that runs over the page turn. The cap is what keeps
// the payload inside the callable's 10 MB limit — at 1600px/q0.92 a page is
// ≈400–670 KB of base64, so four is comfortably clear of it.
export const MAX_RECIPE_PAGE_PHOTOS = 4;

export const RecipePagePhotoSchema = z.object({
  // Base64 payload WITHOUT the `data:` prefix — the flow re-forms the data URI.
  base64: z.string().min(1),
  contentType: z.enum(RECIPE_PAGE_PHOTO_CONTENT_TYPES),
});

export type RecipePagePhoto = z.infer<typeof RecipePagePhotoSchema>;

export const ExtractRecipeFromPhotoInputSchema = z.object({
  // Pages of ONE recipe, in reading order. The prompt tells the model to treat
  // them as a single recipe and to ignore a facing page carrying a different one.
  images: z.array(RecipePagePhotoSchema).min(1).max(MAX_RECIPE_PAGE_PHOTOS),
  // Same opt-in as the URL import (issue #1601).
  reportPersistence: ReportPersistenceSchema,
});

export type ExtractRecipeFromPhotoInput = z.infer<typeof ExtractRecipeFromPhotoInputSchema>;

// The flow returns a complete recipe draft, same as the URL import.
export const ExtractRecipeFromPhotoOutputSchema = AuthoredRecipeOutputSchema;

// How long the client must be willing to wait, and how long the function is
// given. ONE constant so the two cannot drift: the Firebase callable client
// defaults to a 70 s timeout, so a server budget longer than that is silently
// truncated client-side unless the wrapper passes an explicit
// `HttpsCallableOptions.timeout` — which is exactly what happens on the URL path
// today. The adapter multiplies this by 1000; the CF passes it as
// `timeoutSeconds`.
//
// PROVISIONAL, pending calibration on real book photographs (none exist yet).
// The ceiling has to cover: two multimodal extraction attempts (60 s each — a
// 1–4 page image prompt is materially slower than the URL path's text) plus the
// assemble stage, which makes further AI calls of its own (ingredient parse +
// canonicalisation). It is a ceiling, not the expected path; a normal import
// returns in seconds.
export const PHOTO_IMPORT_TIMEOUT_SECONDS = 300;

// The closed set of user-facing failure modes for photo import. Deliberately its
// OWN taxonomy — `UrlImportFailureCode` is not widened, because none of its
// codes (invalid-url, blocked-url, fetch-failed) mean anything here.
//
// Only three, because only three are things the server can actually tell apart:
//   - invalid-photos: the payload itself was rejected (no images, more than
//     MAX_RECIPE_PAGE_PHOTOS, an unsupported content type, empty bytes). Raised
//     at the callable entrypoint by the wire safeParse, never by the flow.
//   - unreadable-photos: the model came back with nothing usable. A photo too
//     blurry or dark to read and a page with no recipe on it are INDISTINGUISHABLE
//     server-side — the AI output schema carries no "I couldn't see it" signal
//     separate from isRecipe=false — so they share one code, whose copy has to
//     cover both.
//   - import-failed: the recipe reader itself failed — AI timeout, transport
//     error, unparseable model output, or an unexpected server fault. The one
//     reportable code (see the observability policy in the root CLAUDE.md).
export const PHOTO_IMPORT_FAILURE_CODES = [
  'invalid-photos',
  'unreadable-photos',
  'import-failed',
] as const;

export type PhotoImportFailureCode = (typeof PHOTO_IMPORT_FAILURE_CODES)[number];

// ─── AI extraction output ─────────────────────────────────────────────────────
// EXTENDS ExtractRecipeAIOutputSchema rather than forking it, so the recipe half
// of the contract — and therefore the metric/British conversion the whole
// pipeline downstream relies on — is literally the same schema the URL import
// uses and cannot drift from it. The extension is the one thing a photograph can
// carry that a web page cannot: the book's own provenance, printed on the page.
//
// Nullable, not optional, and each part independently so: running heads and page
// numbers are usually in shot but any of the three can be missing, and the model
// must say "not legible" rather than invent one. Nullable matches every other
// field of the base schema — Gemini's structured output is materially more
// reliable with required-and-nullable than with optional. The flow drops the
// nulls when it stamps `source.book`.
export const ExtractedBookSourceSchema = z.object({
  title: z.string().nullable(),
  author: z.string().nullable(),
  page: z.number().int().positive().nullable(),
});

export const ExtractRecipeFromPhotoAIOutputSchema = ExtractRecipeAIOutputSchema.extend({
  // null when nothing about the book is legible on the pages supplied.
  book: ExtractedBookSourceSchema.nullable(),
});

export type ExtractRecipeFromPhotoAIOutput = z.infer<typeof ExtractRecipeFromPhotoAIOutputSchema>;
