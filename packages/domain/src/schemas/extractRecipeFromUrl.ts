import { z } from 'zod';
import { AuthoredRecipePhasesSchema, AuthoredTimingSummarySchema, RecipeSchema } from './recipe.js';
import { AUTHORABLE_RECIPE_KINDS } from '../recipe/queries/capabilities.js';

// SSRF-hardened URL import (recipe URL import epic, Phase 1).
//
// Input: a single user-supplied web address. Output: a fully-assembled recipe
// draft (the same shape as a stored recipe document) with `source.type = 'url'`.
// The client adds nothing — it hydrates the editor straight from this draft.

export const ExtractRecipeFromUrlInputSchema = z.object({
  // Validated again inside the flow against the SSRF guard; here we only assert
  // it is a non-empty string. The flow rejects non-https / private hosts.
  url: z.string().min(1),
});

export type ExtractRecipeFromUrlInput = z.infer<typeof ExtractRecipeFromUrlInputSchema>;

// The flow returns a complete recipe draft. Reuse the canonical RecipeSchema so
// the draft is guaranteed to be a valid, persistable recipe document.
export const ExtractRecipeFromUrlOutputSchema = RecipeSchema;

// The closed set of user-facing failure modes for URL import. The CF flow tags
// each failure with one of these; the callable wrapper re-derives it from the
// HttpsError code so the client can show the right copy without leaking SSRF
// internals. Defined here (pure type) so the CF, the wrapper, and the web copy
// map all agree on the same vocabulary.
//   - invalid-url: not a valid web address.
//   - blocked-url: refused by the SSRF guard (non-https / private / internal).
//   - fetch-failed: DNS / connect / timeout / non-200 / too-large / wrong type.
//   - not-a-recipe: page fetched but no recipe found.
//   - ai-failed: AI timeout or unparseable/invalid model output.
export const URL_IMPORT_FAILURE_CODES = [
  'invalid-url',
  'blocked-url',
  'fetch-failed',
  'not-a-recipe',
  'ai-failed',
] as const;

export type UrlImportFailureCode = (typeof URL_IMPORT_FAILURE_CODES)[number];

// ─── AI extraction output ─────────────────────────────────────────────────────
// The shape Gemini emits inside the flow (never leaves the CF boundary). The
// model extracts the recipe AND converts everything to metric + British
// spelling/terms/ingredient names. Ingredient `rawText` is the British/metric
// line that then feeds the existing parse/canonicalise flows. Step ordinals are
// resolved to step IDs by the flow before the RecipeDoc is assembled — mirrors
// the librarian (authorRecipe) flow.

export const ExtractedIngredientSchema = z.object({
  // The ingredient line, already converted to metric + British spelling/terms.
  rawText: z.string(),
  isOptional: z.boolean(),
  // 0-based index into the steps array for the first step that uses this
  // ingredient. null = no specific step assignment.
  firstUsedInStepOrdinal: z.number().int().nullable(),
});

export const ExtractedIngredientGroupSchema = z.object({
  name: z.string().nullable(),
  ingredients: z.array(ExtractedIngredientSchema),
});

export const ExtractedStepSchema = z.object({
  text: z.string(),
  timerMinutes: z.number().int().nullable(),
  // Short human label for the step's timer (e.g. "Simmer the sauce"), or null
  // when the step has no timer / no sensible label. Maps to StepTimer.description
  // on the assembled recipe (issue #554). Null when timerMinutes is null.
  timerLabel: z.string().nullable(),
  note: z.string().nullable(),
});

// WHAT KIND OF THING did the model just read (issue #765) — a dish you eat, or a
// drink you mix? Shared by both AI authoring shapes: `ExtractRecipeAIOutputSchema`
// below and `LibrarianOutputSchema`, so the URL import, the photo import and the
// chat librarian all answer one question against one definition, and
// `assembleRecipeDraft` can read `raw.kind` off either of them.
//
// BOUNDED to `AUTHORABLE_RECIPE_KINDS`, not to `RecipeKindSchema`: `special` and
// `placeholder` are never even offered to the model, so it cannot mint an entry
// whose `takesIngredients` is `false` and then write an ingredient list onto it.
// The set is read off the capability table, so this bound moves only when that
// table's `isAuthorable` column does.
//
// `.catch('recipe')` is the FLOOR, and it is the schema's job rather than the
// prompt's. A missing field, a null, a typo, `"Cocktail"`, `"special"` — every one
// of them degrades to `'recipe'` and NONE of them fails the parse. That matters
// because a failed parse here is a failed import: on the extractor paths it costs
// the user their retry, and on the librarian path (which has no retry at all) it
// throws away a whole conversation. It also encodes the asymmetry the issue
// argues: a cocktail filed under Recipes still works, a dinner filed under
// Cocktails can never be planned, so the fallback leans to the recoverable one.
export const AuthoredRecipeKindSchema = z.enum(AUTHORABLE_RECIPE_KINDS).catch('recipe');

export const ExtractRecipeAIOutputSchema = z.object({
  // false when the page is not a recipe at all → maps to the not-a-recipe
  // failure. true with a populated recipe otherwise.
  isRecipe: z.boolean(),
  // The SECOND classification, and a different question from `isRecipe` (issue
  // #765): given that this IS a recipe, is it a drink you mix or something you
  // eat? It sits here because the two are read together — #739's reasoning about
  // a cocktail as the zero-cook-time case is the same page of the same argument.
  kind: AuthoredRecipeKindSchema,
  title: z.string(),
  description: z.string().nullable(),
  // A positive integer or null — null is the "not stated" sentinel, and is what an
  // isRecipe=false response uses, which is why it is not required.
  //
  // 0 is REJECTED here (issue #739): a recipe nobody can eat is a model glitch,
  // and this is the number things divide by — a stored 0 scaled a shopping list by
  // Infinity (issue #1123). That rejection was once the strict half of a
  // deliberate asymmetry, against times where 0 was a real answer for anything
  // assembled rather than cooked; those fields went with #1211, and a phase of 0
  // hands-on now carries that meaning on the strip below.
  servings: z.number().int().positive().nullable(),
  // The recipe's timing as an ordered strip (issue #1122), and since #1211 the
  // whole of what this path says about it. Shared shape rather than a fourth
  // hand-written copy: the librarian, both extractors and the re-estimator answer
  // one question against one definition (`PHASE_RULES`), and a per-file constraint
  // is how three of them come to mean three different things (#785, #952).
  //
  // `.optional()` on both so a model that omits them yields no strip rather than
  // failing the whole import on a field the prompt asks for and it forgot. The
  // assembler turns absent into an empty list on the way to the document.
  // `AuthoredRecipePhasesSchema` carries the matching guard for a strip the model
  // DID return but got wrong (a seventh block, a fractional minute): it degrades
  // to `[]` rather than failing this parse (issue #1122 review, blocking 3).
  phases: AuthoredRecipePhasesSchema.optional(),
  timingSummary: AuthoredTimingSummarySchema.optional(),
  tags: z.array(z.string()),
  ingredientGroups: z.array(ExtractedIngredientGroupSchema),
  steps: z.array(ExtractedStepSchema),
  notes: z.string().nullable(),
});

export type ExtractRecipeAIOutput = z.infer<typeof ExtractRecipeAIOutputSchema>;
