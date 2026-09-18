import { z } from 'zod';
import {
  MatchOrCreateCanonInputSchema,
  MatchOrCreateCanonOutputSchema,
} from './matchOrCreateCanonInput.js';

// One ingredient to canonicalise. This is exactly a single-item canon match
// without the manual `forceCreate` override, so it is DERIVED rather than
// restated (issue #932, B3-013): the two declared the same three fields —
// `rawName`, `rawText`, `selectedAisleId` — and could drift apart silently.
//
// `ingredientId` is IDENTITY FOR PERSISTENCE, not matching input (issue #1434):
// nothing in the matching pipeline reads it. It names the row inside
// `recipes/{recipeId}` that this item's result is folded onto, so the Cloud
// Function can record the match itself instead of handing it back to a browser
// tab that may be gone. Added by EXTENDING the derived shape rather than
// restating its three fields, which is the drift `.omit(...)` was introduced to
// close.
export const CanonicaliseRecipeIngredientsItemSchema = MatchOrCreateCanonInputSchema.omit({
  forceCreate: true,
}).extend({
  ingredientId: z.string().optional(),
});

export const CanonicaliseRecipeIngredientsInputSchema = z.object({
  // The recipe whose rows these ingredients are, when there is one.
  //
  // OPTIONAL, and the two arms are different jobs rather than a convenience:
  // present means "match these AND record the results on that recipe"; absent
  // means CONTENT ONLY — match them, write the canon documents, return the
  // results and write no recipe. `assembleRecipeDraft` invokes this flow
  // in-process for a recipe that does not exist in Firestore yet, so it has no
  // document to name; an old cached PWA tab that predates this field lands on
  // the same arm and keeps its own browser-side write.
  recipeId: z.string().optional(),
  items: z.array(CanonicaliseRecipeIngredientsItemSchema).min(1),
});

export type CanonicaliseRecipeIngredientsInput = z.infer<
  typeof CanonicaliseRecipeIngredientsInputSchema
>;

// One result per input item, in order — the same envelope a single canon match
// returns.
export const CanonicaliseRecipeIngredientsOutputSchema = z.array(MatchOrCreateCanonOutputSchema);
