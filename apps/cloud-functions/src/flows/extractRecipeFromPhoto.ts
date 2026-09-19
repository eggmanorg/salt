import { z } from 'genkit';
import {
  ExtractRecipeFromPhotoInputSchema,
  ExtractRecipeFromPhotoAIOutputSchema,
  ExtractRecipeFromPhotoOutputSchema,
} from '@salt/domain/schemas';
import type {
  ExtractRecipeFromPhotoAIOutput,
  PhotoImportFailureCode,
  RecipeDoc,
  RecipePagePhoto,
  RecipeSourceDoc,
} from '@salt/domain/schemas';
import { setActiveSpanName } from '@salt/observability/server';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { assembleRecipeDraft } from './assembleRecipeDraft.js';
import { persistAuthoredRecipe } from './persistAuthoredRecipe.js';
import { flowModel } from '../ai/fakeModel.js';
import { recipeFieldRules } from './recipeFieldRules.js';

// Import a recipe from photographs of a cookbook page (issue #649, Phase 3).
//
// Pipeline: 1–4 page images → ONE multimodal Gemini call that returns structured
// recipe JSON (already metric + British) → the same assembleRecipeDraft the URL
// import and the librarian use → persist with source.type='book' and
// needs_approval.
//
// There is deliberately NO OCR / text-extraction stage. The page goes to the
// model as media prompt parts; flattening it to a text blob first would throw
// away the column layout, the ingredient grouping, the fraction glyphs and the
// headnote/step distinction that the extraction depends on. The bytes are
// request-scoped — read, sent, discarded. Nothing is written to Storage, they
// never become `recipe.image`, and the draft lands with `image: null` so
// onRecipeWritten generates its AI hero exactly as it does for a URL import.
//
// The flow throws a PhotoImportError tagged with a failure code; the onCall
// entrypoint maps each code to the right HttpsError + user-facing copy.

// How rich the extracted content must be to count as a real recipe. There is no
// photo equivalent of the URL path's JSON-LD corroboration — a page image is all
// the evidence there is — so this mirrors that path's NO-JSON-LD thresholds.
const MIN_INGREDIENTS = 2;
const MIN_STEPS = 1;

// One extraction attempt's deadline. Materially longer than the URL import's 40s
// because the prompt carries 1–4 full-page images rather than text, and a
// multimodal generation over that much input is slower. Two attempts (60s + a
// retry) plus the assemble stage — which makes further AI calls of its own for
// ingredient parsing and canonicalisation — must all fit inside the function's
// PHOTO_IMPORT_TIMEOUT_SECONDS budget, which is why that is set as high as it is.
//
// PROVISIONAL: no real book photographs exist yet, so this is a defensible
// starting point rather than a calibrated one. Retune once there are real
// timings.
const PHOTO_EXTRACT_TIMEOUT_MS = 60_000;

export type { PhotoImportFailureCode };

export class PhotoImportError extends Error {
  constructor(
    readonly code: PhotoImportFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoImportError';
  }
}

export const extractRecipeFromPhotoFlow = ai.defineFlow(
  {
    name: 'extractRecipeFromPhoto',
    inputSchema: ExtractRecipeFromPhotoInputSchema,
    // Validated against the real recipe contract (issue #932, Phase 6). This was
    // `z.custom<RecipeDoc>()`, which — with no validator function — accepts any
    // value, so the declared output type was a claim Genkit never checked. The
    // swap is a deliberate behaviour change: a malformed draft that used to pass
    // straight through to the `recipes` collection now fails the flow instead.
    // Shipped on Phase 5's evidence — its observing `safeParse` reported no
    // mismatch across a URL import, a photo import and a chat-authored recipe,
    // run against real model output on staging.
    outputSchema: ExtractRecipeFromPhotoOutputSchema,
  },
  async ({ images }): Promise<RecipeDoc> => {
    // Human-readable top-level span name for the end-to-end trace view. There is
    // no URL or title to name it by until the extraction has run, so the page
    // count is the only honest identifier available at this point.
    setActiveSpanName(
      `Import recipe from ${images.length} page photo${images.length === 1 ? '' : 's'}`,
    );

    // Flash + temperature:0 — accuracy over creativity, same as the URL import.
    const extractModel = await flowModel('extractRecipeFromPhoto');

    let extracted: ExtractRecipeFromPhotoAIOutput;
    try {
      extracted = await withAiTimeout(
        'extractRecipeFromPhoto',
        async () => {
          const result = await ai.generate({
            model: extractModel,
            system: EXTRACT_SYSTEM,
            prompt: buildPhotoPrompt(images),
            output: { schema: ExtractRecipeFromPhotoAIOutputSchema },
            config: { temperature: 0 },
          });
          // Validate INSIDE the retried op so a transiently empty/malformed
          // structured response gets a fresh attempt rather than failing the
          // whole import; only a persistent failure surfaces as import-failed.
          // Mirrors extractRecipeFromUrl.
          const validated = ExtractRecipeFromPhotoAIOutputSchema.safeParse(result.output);
          if (!validated.success) {
            throw new Error(`extractor returned invalid structure: ${validated.error.message}`);
          }
          return validated.data;
        },
        { timeoutMs: PHOTO_EXTRACT_TIMEOUT_MS, retries: 1 },
      );
    } catch (err) {
      // AI timeout / transport / model error / invalid output all surface as
      // import-failed once the retry is exhausted. This is the one code the
      // entrypoint reports — it means the recipe reader broke, not that the
      // user's photograph was poor.
      throw new PhotoImportError('import-failed', err instanceof Error ? err.message : 'ai error');
    }

    // Did we actually read a recipe? A photo too blurry or dark to read and a
    // page with no recipe on it are INDISTINGUISHABLE here — the model has no
    // channel to say "I couldn't see it" other than isRecipe=false and thin
    // output — so both land on the one honest code.
    if (!hasUsableRecipe(extracted)) {
      throw new PhotoImportError('unreadable-photos', 'no readable recipe in the page photos');
    }

    // Assemble the draft (reuses parse + canonicalise flows), stamped with the
    // book provenance the model could actually read off the page. A printed
    // recipe states prep and cook far more often than a total; the assembler
    // derives one from the parts on every path (#952).
    const recipe = await assembleRecipeDraft(extracted, {
      source: buildBookSource(extracted),
      needsApproval: true,
    });

    // Persist server-side, flagged as not yet human-reviewed (issue #616): the
    // recipe exists the moment the extraction finishes, whatever the client does
    // next — which matters more here than anywhere, since the user has just been
    // holding a phone over a book and the page photos are gone.
    await persistAuthoredRecipe(recipe, 'extractRecipeFromPhoto');
    return recipe;
  },
);

// Provenance from what the page actually SHOWED. Each part is dropped when the
// model reported it as not legible, and `book` is omitted entirely when none of
// the three came back — an empty `{}` would claim we recorded something.
function buildBookSource(extracted: ExtractRecipeFromPhotoAIOutput): RecipeSourceDoc {
  const raw = extracted.book;
  const book = {
    ...(raw?.title?.trim() ? { title: raw.title.trim() } : {}),
    ...(raw?.author?.trim() ? { author: raw.author.trim() } : {}),
    ...(typeof raw?.page === 'number' ? { page: raw.page } : {}),
  };
  return Object.keys(book).length > 0 ? { type: 'book', book } : { type: 'book' };
}

// The not-a-recipe decision for the photo path. Unlike the URL import there is no
// corroborating signal (no JSON-LD) — the photograph is the whole of the
// evidence — so we require the model's own isRecipe flag AND non-trivial content.
// A page that is too blurry to read produces exactly the same shape as a page
// with no recipe on it, and both are correctly refused here.
function hasUsableRecipe(extracted: ExtractRecipeFromPhotoAIOutput): boolean {
  // An untitled recipe is a broken extraction — never assemble one. Checked here
  // rather than at the schema so an isRecipe=false response, which legitimately
  // leaves the title empty, lands on unreadable-photos rather than import-failed.
  if (extracted.title.trim().length === 0) {
    return false;
  }
  const ingredientCount = extracted.ingredientGroups.reduce(
    (sum, g) => sum + g.ingredients.length,
    0,
  );
  return (
    extracted.isRecipe && ingredientCount >= MIN_INGREDIENTS && extracted.steps.length >= MIN_STEPS
  );
}

// The multimodal prompt: every page as a media part, each announced by a text
// part so the model knows the reading order, then the instruction.
//
// The images arrive as a bare base64 payload + content type; Genkit's media part
// wants a URL, so they are re-formed into `data:` URIs — the same shape
// generateCanonIcon feeds its committed seed image.
type PromptPart = { text: string } | { media: { url: string; contentType: string } };

function buildPhotoPrompt(images: RecipePagePhoto[]): PromptPart[] {
  const parts: PromptPart[] = [];
  images.forEach((image, i) => {
    parts.push({ text: `Page ${i + 1} of ${images.length}:` });
    parts.push({
      media: {
        url: `data:${image.contentType};base64,${image.base64}`,
        contentType: image.contentType,
      },
    });
  });
  parts.push({ text: EXTRACT_INSTRUCTION });
  return parts;
}

const EXTRACT_INSTRUCTION = `Extract the single recipe shown on these pages and convert it fully to \
UK conventions, following the rules you were given.`;

// A cookbook page is a DOCUMENT source — a finished recipe in someone else's
// units — so the shared field rules are asked for with `measures: 'metricate'`,
// exactly as the URL import asks for them (issue #785).
const EXTRACT_SYSTEM = `You are a precise recipe extraction assistant. You are given photographs of \
the pages of a cookbook, magazine or recipe card. Read them and extract a single complete recipe, \
converting it fully to UK conventions.

## One recipe, across all the pages
- Every image you are given is a page of THE SAME recipe. A recipe routinely spans a spread — \
ingredients on the left page, method on the right — and a long method can run over a page turn. \
Read the pages together, in the order given, and return ONE recipe assembled from all of them.
- If a page also shows a DIFFERENT recipe (a facing page, a second recipe below the fold, a \
"variation" that is really its own recipe with its own ingredient list), IGNORE it entirely. Do not \
merge its ingredients or steps into the recipe you return. The recipe you want is the one the pages \
are centred on — the one whose title, ingredient list and method run across the images.
- Preserve the book's own ingredient grouping and headings ("For the sauce", "For the topping"). \
Those groupings are the author's and carry meaning; do not flatten them into one list.

## Is it a recipe? Can you read it?
- Set isRecipe=false (and leave the other fields at sensible empties) when the pages contain no \
cooking recipe at all, or when they are too blurry, dark, skewed or cropped for you to read the \
recipe reliably. A half-read recipe is worse than none: do NOT guess at an ingredient or a quantity \
you cannot actually read. If a recipe is present and legible, isRecipe=true.

## The book it came from
- book: the provenance printed on the pages themselves — the running head or title page (title), the \
author if shown, and the printed page number. Fill ONLY what is genuinely visible in these images; \
set any part you cannot read to null, and set book itself to null when none of it is legible. NEVER \
guess or infer a book title, author or page number from the recipe's style, contents or your own \
knowledge — an invented provenance is worse than a missing one.

${recipeFieldRules({ measures: 'metricate' })}

Extract only what the pages show. Do not invent ingredients or steps — though splitting one of the \
book's own instructions across consecutive steps, per the one-operation rule above, invents nothing. \
Ignore headnotes, serving suggestions, photograph captions, page furniture and anything belonging to \
a different recipe. A headnote may inform the description; it is not a method step.`;
