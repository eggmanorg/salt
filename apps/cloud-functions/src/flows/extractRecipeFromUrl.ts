import { z } from 'genkit';
import { isHttpsScheme, parseImportUrl } from '@salt/domain';
import {
  ExtractRecipeFromUrlInputSchema,
  ExtractRecipeAIOutputSchema,
  ExtractRecipeFromUrlOutputSchema,
} from '@salt/domain/schemas';
import type { ExtractRecipeAIOutput, UrlImportFailureCode } from '@salt/domain/schemas';
import type { RecipeDoc } from '@salt/domain/schemas';
import { setActiveSpanName } from '@salt/observability/server';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { ssrfGuardedFetch, SsrfFetchError } from '../adapters/ssrfFetch.js';
import { extractRecipeJsonLd, type JsonLdRecipe } from '../adapters/jsonLdRecipe.js';
import { assembleRecipeDraft } from './assembleRecipeDraft.js';
import { authoredAnswer, persistAuthoredRecipe } from './persistAuthoredRecipe.js';
import { flowModel } from '../ai/fakeModel.js';
import { recipeFieldRules } from './recipeFieldRules.js';

// SSRF-hardened URL import (recipe URL import epic, Phases 1 & 3).
//
// Pipeline: validate URL → SSRF-guarded fetch (raw HTML) → prefer schema.org/
// Recipe JSON-LD parsed straight from the page (Phase 3) and feed its structured
// fields to Gemini for unit/spelling conversion; otherwise fall back to handing
// the cleaned HTML to Gemini to both find AND convert the recipe → reuse parse/
// canonicalise flows for ingredient matching → assemble a RecipeDoc draft with
// source.type='url'.
//
// The flow throws a UrlImportError tagged with a failure code; the onCall
// entrypoint maps each code to the right HttpsError + user-facing copy.

// When no JSON-LD Recipe is present we forward the raw page HTML to the model.
// Cap it so a huge page can't blow the prompt budget; recipes always appear well
// within the first chunk.
const MAX_HTML_CHARS = 200_000;

// How much AI-extracted content counts as "rich enough" to be a real recipe when
// the page carried NO JSON-LD Recipe. With JSON-LD absent AND the model returning
// barely anything, we treat the page as not-a-recipe rather than a thin draft.
const MIN_INGREDIENTS_NO_JSON_LD = 2;
const MIN_STEPS_NO_JSON_LD = 1;

export type { UrlImportFailureCode };

export class UrlImportError extends Error {
  constructor(
    readonly code: UrlImportFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'UrlImportError';
  }
}

export const extractRecipeFromUrlFlow = ai.defineFlow(
  {
    name: 'extractRecipeFromUrl',
    inputSchema: ExtractRecipeFromUrlInputSchema,
    // Validated against the real recipe contract (issue #932, Phase 6). This was
    // `z.custom<RecipeDoc>()`, which — with no validator function — accepts any
    // value, so the declared output type was a claim Genkit never checked. The
    // swap is a deliberate behaviour change: a malformed draft that used to pass
    // straight through to the `recipes` collection now fails the flow instead.
    // Shipped on Phase 5's evidence — its observing `safeParse` reported no
    // mismatch across a URL import, a photo import and a chat-authored recipe,
    // run against real model output on staging.
    outputSchema: ExtractRecipeFromUrlOutputSchema,
  },
  async ({ url, reportPersistence }) => {
    // 1. Validate the URL shape + scheme before any I/O. The SSRF guard does
    //    the resolved-IP enforcement; here we reject garbage and non-https.
    const parsed = parseImportUrl(url);
    if (parsed === null) {
      throw new UrlImportError('invalid-url', 'unparseable url');
    }
    if (!isHttpsScheme(parsed.protocol)) {
      throw new UrlImportError('blocked-url', 'non-https scheme');
    }

    // Human-readable top-level span name for the end-to-end trace view. The flow
    // span is the active span inside an ai.defineFlow body; setActiveSpanName
    // renames it (caps at 80 chars, no-op when no span is active). The host is the
    // scannable identifier — never the full URL (path/query are noise here).
    setActiveSpanName(`Import recipe from ${parsed.hostname}`);

    // 2. SSRF-guarded fetch — raw HTML.
    let html: string;
    try {
      const fetched = await ssrfGuardedFetch(url);
      html = fetched.html;
    } catch (err) {
      if (err instanceof SsrfFetchError) {
        if (err.reason === 'blocked') {
          throw new UrlImportError('blocked-url', 'ssrf guard refused');
        }
        // dns / timeout / connection / http-status / too-large / wrong-content-type
        throw new UrlImportError('fetch-failed', `fetch failed: ${err.reason}`);
      }
      throw new UrlImportError('fetch-failed', 'fetch failed');
    }

    // 3. Prefer schema.org/Recipe JSON-LD if the page embeds it (Phase 3). It is
    //    untrusted input from an arbitrary page, so jsonLdRecipe validates every
    //    block with Zod (safeParse) before returning a normalised recipe. A hit
    //    gives us reliable structure; the model still converts units + spelling.
    const jsonLd = extractRecipeJsonLd(html);

    // 4. Gemini extraction + metric/British conversion. When we have JSON-LD we
    //    feed the model the already-structured fields to CONVERT (not to hunt for
    //    a recipe inside HTML); otherwise we fall back to handing it the page HTML
    //    to both find and convert the recipe.
    const { system, prompt } = jsonLd
      ? buildJsonLdPrompt(jsonLd, parsed.href)
      : buildHtmlPrompt(html, parsed.href);

    // Flash + temperature:0 — accuracy over creativity, mirrors the librarian flow.
    const extractModel = await flowModel('extractRecipeFromUrl');
    let extracted: ExtractRecipeAIOutput;
    try {
      extracted = await withAiTimeout(
        'extractRecipeFromUrl',
        async () => {
          const result = await ai.generate({
            model: extractModel,
            system,
            prompt,
            output: { schema: ExtractRecipeAIOutputSchema },
            config: { temperature: 0 },
          });
          // Validate INSIDE the retried op: an empty/malformed structured
          // response (Gemini occasionally returns one even at temperature:0, and
          // structured-output coercion can fail transiently) then gets a fresh
          // attempt rather than failing the whole import on a single flaky
          // generation. Only a persistent failure surfaces as ai-failed.
          const validated = ExtractRecipeAIOutputSchema.safeParse(result.output);
          if (!validated.success) {
            throw new Error(`extractor returned invalid structure: ${validated.error.message}`);
          }
          return validated.data;
        },
        { timeoutMs: 40_000, retries: 1 },
      );
    } catch (err) {
      // AI timeout / transport / model error / invalid output all surface as
      // ai-failed after the retry is exhausted.
      throw new UrlImportError('ai-failed', err instanceof Error ? err.message : 'ai error');
    }

    // 5. Did we actually find a recipe? JSON-LD is a strong positive signal: a
    //    validated schema.org/Recipe with ingredients means the page IS a recipe,
    //    so we only require the model to have emitted ingredient groups. With NO
    //    JSON-LD we lean on the model's own isRecipe flag PLUS content richness —
    //    a page with no JSON-LD Recipe and barely any extracted content is treated
    //    as not-a-recipe (same failure code, stronger signal).
    if (!hasUsableRecipe(extracted, jsonLd !== null)) {
      throw new UrlImportError('not-a-recipe', 'no recipe found on page');
    }

    // 6. Assemble the draft (reuses parse + canonicalise flows). Same assembler
    //    the librarian uses — the import only differs in its provenance and its
    //    unread-by-a-human flag (#616). Reconciling the three time fields is the
    //    assembler's job on every path now (#952), not an import-only option.
    const recipe = await assembleRecipeDraft(extracted, {
      source: { type: 'url', url: parsed.href },
      needsApproval: true,
    });

    // 7. Persist it here, server-side, flagged as not yet human-reviewed
    //    (issue #616) — see persistAuthoredRecipe for why, and for why a write
    //    failure must not fail the import.
    const persistence = await persistAuthoredRecipe(recipe, 'extractRecipeFromUrl');
    return authoredAnswer(recipe, persistence, reportPersistence);
  },
);

// Tighten the not-a-recipe decision now that JSON-LD gives a stronger signal.
// - hadJsonLd: a validated schema.org/Recipe was present on the page. That alone
//   is strong evidence the page IS a recipe, so we accept as long as the model
//   produced at least one ingredient.
// - no JSON-LD: fall back to the model's own isRecipe flag AND require the
//   extracted content to be more than trivially thin (a stray ingredient list in
//   a blog post shouldn't pass as a recipe). This keeps the failure taxonomy
//   intact — it only fires not-a-recipe on a stronger combined signal.
function hasUsableRecipe(extracted: ExtractRecipeAIOutput, hadJsonLd: boolean): boolean {
  // A recipe with no title is a broken extraction — never assemble an untitled
  // draft. Checked here (not at the schema) so an isRecipe=false response, which
  // legitimately leaves the title empty, still maps to not-a-recipe rather than
  // ai-failed.
  if (extracted.title.trim().length === 0) {
    return false;
  }
  const ingredientCount = extracted.ingredientGroups.reduce(
    (sum, g) => sum + g.ingredients.length,
    0,
  );
  if (hadJsonLd) {
    return ingredientCount > 0;
  }
  return (
    extracted.isRecipe &&
    ingredientCount >= MIN_INGREDIENTS_NO_JSON_LD &&
    extracted.steps.length >= MIN_STEPS_NO_JSON_LD
  );
}

// Build the prompt for the JSON-LD path: hand the model the already-structured
// recipe so it converts units → metric and names/spelling → British WITHOUT
// having to locate the recipe inside noisy HTML. isRecipe is effectively given.
function buildJsonLdPrompt(
  recipe: JsonLdRecipe,
  sourceUrl: string,
): {
  system: string;
  prompt: string;
} {
  const lines: string[] = [];
  lines.push(`Title: ${recipe.title}`);
  if (recipe.description !== null) lines.push(`Description: ${recipe.description}`);
  if (recipe.servings !== null) lines.push(`Servings: ${recipe.servings}`);
  // Labelled as the PAGE's numbers, not ours. The faithfulness rule now exempts
  // the times (issue #952), and a bare "Prep time (minutes): 5" reads like a
  // field to copy across; "as stated by the page" reads like the hint it is.
  if (recipe.totalTimeMinutes !== null)
    lines.push(`Total time as stated by the page (minutes): ${recipe.totalTimeMinutes}`);
  if (recipe.prepTimeMinutes !== null)
    lines.push(`Prep time as stated by the page (minutes): ${recipe.prepTimeMinutes}`);
  if (recipe.cookTimeMinutes !== null)
    lines.push(`Cook time as stated by the page (minutes): ${recipe.cookTimeMinutes}`);
  if (recipe.tags.length > 0) lines.push(`Keywords: ${recipe.tags.join(', ')}`);
  lines.push('');
  lines.push('Ingredients:');
  for (const ing of recipe.ingredients) lines.push(`- ${ing}`);
  lines.push('');
  lines.push('Method:');
  recipe.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return {
    system: EXTRACT_SYSTEM_JSON_LD,
    prompt: `Source URL: ${sourceUrl}\n\nStructured recipe data (schema.org/Recipe):\n${lines.join('\n')}`,
  };
}

// Strip the parts of a page that carry no recipe signal but burn tokens before
// we forward HTML to the model: <script> (often hundreds of KB of bundles),
// <style>, <head>, <noscript>, <template>, <svg> (icon paths), HTML comments,
// and inline base64 `data:` URIs (which can each be tens of KB). A recipe page's
// actual content survives intact. This runs on the fallback path only — most
// mainstream sites carry JSON-LD and never reach here. Dependency-free regex,
// consistent with jsonLdRecipe (no cheerio/jsdom — issue-gated).
function stripHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript[^>]*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template[^>]*>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg[^>]*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head[^>]*>/gi, ' ')
    .replace(/\bsrc\s*=\s*["']data:[^"']*["']/gi, 'src=""')
    .replace(/[ \t\f\v]{2,}/g, ' ')
    .replace(/(\s*\n\s*){2,}/g, '\n');
}

// Build the prompt for the HTML fallback path (no JSON-LD found): the model both
// finds the recipe in the page and converts it. We strip script/style/svg noise
// FIRST, then cap — so the budget is spent on real content, not bundles.
function buildHtmlPrompt(html: string, sourceUrl: string): { system: string; prompt: string } {
  const cleaned = stripHtmlNoise(html);
  const trimmedHtml = cleaned.length > MAX_HTML_CHARS ? cleaned.slice(0, MAX_HTML_CHARS) : cleaned;
  return {
    system: EXTRACT_SYSTEM,
    prompt: `Source URL: ${sourceUrl}\n\nPage HTML:\n${trimmedHtml}`,
  };
}

// The conversion + field rules live in ./recipeFieldRules.js — the photo import
// (issue #649) and the librarian (issue #785) need the identical wording, and a
// second copy is one edit away from the authoring paths disagreeing. A URL is a
// DOCUMENT source: converting someone else's units is the entire point of an
// import, hence `measures: 'metricate'` on both prompts below.
const IMPORT_RULES = recipeFieldRules({ measures: 'metricate' });

const EXTRACT_SYSTEM = `You are a precise recipe extraction assistant. You are given the raw HTML \
of a web page and its source URL. Extract a single complete recipe from the page and convert it \
fully to UK conventions.

## Is it a recipe?
- Set isRecipe=false (and leave the other fields at sensible empties) ONLY when the page contains no \
cooking recipe at all (e.g. a news article, a product listing, a 404). If a recipe is present, \
isRecipe=true.

${IMPORT_RULES}

Extract only what is present on the page. Do not invent ingredients or steps — though splitting one \
of the page's own instructions across consecutive steps, per the one-operation rule above, invents \
nothing. Ignore page navigation, ads, comments, and unrelated content.`;

// JSON-LD path: the recipe has already been located and structured for us by the
// page's schema.org/Recipe data, so the model's job is conversion + tidy-up, not
// hunting through HTML. isRecipe is therefore true.
const EXTRACT_SYSTEM_JSON_LD = `You are a precise recipe extraction assistant. You are given a single \
recipe already extracted as structured schema.org/Recipe data (title, ingredients, method, times). \
Your job is to faithfully convert it to UK conventions and return it in the required shape. The input \
is genuine recipe data, so set isRecipe=true.

## Faithfulness
- Use ONLY the ingredients, steps and servings given. Do not invent, add, drop or reorder \
content. Keep every ingredient and every instruction. Preserve any ingredient groupings/headings if \
present in the data.
- The TIMING is the one exception (issue #952). The page's stated prep/cook/total are a HINT, not a \
floor: build the phase strip yourself against the definition below, and expect the page's prep time to \
be the low, already-weighed-counter kind. Content faithfulness is unaffected — this licence covers \
the timing and nothing else.
- You MAY, and should, SPLIT a source step that bundles several operations into consecutive steps, per \
the one-operation rule below. That re-divides the given instructions; it does not add, drop or reorder \
content, so it is not a breach of the rule above. Never MERGE two source steps into one.

${IMPORT_RULES}`;
