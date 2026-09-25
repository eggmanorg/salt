import { z } from 'zod';
import { MessageSchema } from './chatSession.js';
import { AuthoredRecipePhasesSchema, AuthoredTimingSummarySchema } from './recipe.js';
import { AuthoredRecipeOutputSchema, ReportPersistenceSchema } from './authoredRecipeEnvelope.js';
import {
  AuthoredCureCategorySchema,
  AuthoredRecipeKindSchema,
  ExtractedIngredientGroupSchema,
  ExtractedStepSchema,
} from './extractRecipeFromUrl.js';

// Input to the librarian (authorRecipe) flow: the full conversation that the
// user wants to turn into a recipe (issue #206, Phase 4).
export const AuthorRecipeInputSchema = z.object({
  messages: z.array(MessageSchema),
  existingTags: z.array(z.string()).optional().default([]),
  // Edit mode: when set, the flow reads this existing recipe from Firestore and
  // grounds the librarian on it, returning the COMPLETE recipe with the
  // conversation's changes applied. Omitted/null = author a fresh recipe from
  // the conversation alone (create mode).
  recipeId: z.string().nullable().optional(),
  // Variation mode (issue #763): the recipe this conversation started from. The
  // flow reads it to GROUND the prose — so the draft carries forward everything
  // the conversation never mentioned — but still assembles in create mode, so
  // the new recipe gets its own identity: no `producesCanonId` carried, no image
  // shared with the original, and a title authored from the conversation rather
  // than force-preserved. `recipeId` wins if both are somehow set; a variation
  // chat has no `recipeId` until it claims the recipe it produced.
  basedOnRecipeId: z.string().nullable().optional(),
  // Who is saving it, as a display NAME (issue #1431). The flow writes the recipe
  // it authors on the create path, so the attribution has to travel with the call:
  // `createdBy`/`lastEditedBy` used to be stamped in the browser on the statement
  // after the `await`, which is precisely the statement a locked phone never runs.
  // Applied through `stampAttribution` from `@salt/domain`, the same function the
  // browser applies to every other recipe write.
  //
  // A name, never a uid: uids appear nowhere in the family-shared data model, and
  // both fields are snapshots of `Member.name`. It GRANTS NOTHING — `recipes` is
  // family-shared, every member can already write any `createdBy` they like
  // straight to `recipes/{id}`, and the field is audit only: never checked on a
  // read, never pinned on an update, never a gate.
  //
  // OPTIONAL, and that is load-bearing for the same reason `speaker` is on
  // `ChefChatInputSchema`: a browser left on an older bundle after a deploy sends
  // no name and must get a working recipe rather than a rejected call. Absent —
  // and equally when the roster has not loaded — both fields are left exactly as
  // the assembler produced them (blank on a create), never a placeholder.
  authorName: z.string().optional(),
  // Same opt-in as the two imports (issue #1601). Edit mode writes nothing, so it
  // answers `persistence: 'skipped'` when asked.
  reportPersistence: ReportPersistenceSchema,
});

export type AuthorRecipeInput = z.infer<typeof AuthorRecipeInputSchema>;

// What the librarian flow returns: a complete, persistable recipe document.
// The canonical RecipeSchema, exactly as the two extractor flows use it — a
// draft that does not satisfy it is not a recipe, whichever path authored it —
// bare, or inside the persistence envelope when asked (issue #1601).
export const AuthorRecipeOutputSchema = AuthoredRecipeOutputSchema;

// The shape the AI model emits inside the flow (never leaves the CF boundary).
// The model uses 0-based step ordinals for ingredient links; the flow resolves
// them to step IDs before returning the final RecipeDoc to the client.
//
// The sub-shapes are the EXTRACTOR's (issue #932, B3-003 structural half).
// `LibrarianIngredientSchema` / `LibrarianGroupSchema` / `LibrarianStepSchema`
// were byte-identical restatements of `ExtractedIngredientSchema` /
// `ExtractedIngredientGroupSchema` / `ExtractedStepSchema`, so this consumes
// those directly — one declaration per shape. `LibrarianStepSchema` came back in
// #1178, but as an `.extend` of the extractor's step carrying one amend-only
// field, not as a restatement: see its declaration below.
//
// The four top-level numeric fields carry the EXTRACTOR's constraints — the three
// time fields since #952, `servings` since #1123 — so the two schemas accept and
// reject the same numbers. `authorRecipe.schema.test.ts` runs one value matrix
// through both and asserts they agree, because "they match" is otherwise a
// sentence nothing falsifies when one of them is edited alone.
// The librarian's step shape: the extractor's, plus the one field only an AMEND
// can answer (issue #1178). In edit mode the prompt renders each existing step as
// `N. [<id>] text` and asks the model to cite, verbatim, the id of the step each
// returned step was rewritten FROM — null for a step it is adding. That citation
// is what lets `diffRecipe`'s id-equality pass recognise a reworded step as one
// edit rather than a deletion beside an addition.
//
// `.extend` rather than a second declaration of the whole shape: #932 deleted the
// librarian's byte-identical restatements of the extractor sub-shapes precisely so
// the two could not drift, and one named addition on top keeps that. It is NOT on
// `ExtractedStepSchema` itself because the URL and photo importers have no existing
// recipe to cite — the field could only ever be null there.
//
// `.nullable().optional()` is load-bearing back-compat: a model that ignores the
// instruction, an older response, and every `FUNCTIONS_AI_FAKE` fixture all still
// parse. And the field NEVER PERSISTS — `assembleRecipeDraft` consumes it to decide
// which id a step gets and discards it, so no recipe document gains a field and no
// migration exists.
export const LibrarianStepSchema = ExtractedStepSchema.extend({
  sourceStepId: z.string().nullable().optional(),
});

export const LibrarianOutputSchema = z.object({
  title: z.string(),
  // Which kind of entry the conversation described (issue #765) — the extractor's
  // field, for the extractor's reason, so `assembleRecipeDraft` reads one name off
  // whichever of the two shapes it was handed. Bounded to the authorable kinds and
  // floored at `'recipe'`; see `AuthoredRecipeKindSchema`.
  //
  // Load-bearing on THIS path specifically: the librarian has no retry, so a kind
  // the model got wrong must degrade rather than throw away the conversation.
  kind: AuthoredRecipeKindSchema,
  // Which of the five kinds of cure (issue #1404) — the extractor's field again,
  // for the extractor's reason, so `assembleRecipeDraft` reads one name off
  // whichever shape it was handed. Degrades to `null` rather than throwing; see
  // `AuthoredCureCategorySchema`.
  cureCategory: AuthoredCureCategorySchema,
  description: z.string().nullable(),
  // The extractor's constraint, for the extractor's reason (issue #739): a recipe
  // that serves nobody is a model glitch, not an answer. It is also the one of
  // these four numbers that anything DIVIDES by — a stored 0 scaled a shopping
  // list by Infinity (issue #1123) — so this path was the last one able to mint
  // that state.
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
  // to `[]` rather than failing this parse — load-bearing here specifically,
  // because the librarian has no retry (issue #1122 review, blocking 3).
  phases: AuthoredRecipePhasesSchema.optional(),
  timingSummary: AuthoredTimingSummarySchema.optional(),
  tags: z.array(z.string()),
  ingredientGroups: z.array(ExtractedIngredientGroupSchema),
  steps: z.array(LibrarianStepSchema),
  notes: z.string().nullable(),
});

export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;
