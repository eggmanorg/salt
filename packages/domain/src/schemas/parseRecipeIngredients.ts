import { z } from 'zod';
import { QuantitySchema, IngredientGroupSchema } from './recipe.js';

export const ParseRecipeIngredientsInputSchema = z.object({
  rawText: z.string(),
});

// Slim AI-generated shape: no IDs or matchState — the flow adds those after generation.
const ParsedIngredientAISchema = z.object({
  rawText: z.string(),
  // The count of whole things the line states (issue #1643) — see
  // `ParsedIngredientSchema.statedCount`. Optional rather than required so a
  // stubbed model answer written before the field existed (the e2e
  // `_e2e_ai_stubs` fixtures) still validates; the flow writes an absent one as
  // null.
  //
  // DECLARED BEFORE `quantity`, deliberately: the model writes fields in this
  // order, and with the count down first it fills the metric estimate as
  // "count × per-unit weight" instead of leaving it null. Measured on 15 prod
  // lines × 3 runs (#1643 Phase 4): count AFTER quantity lost the metric amount
  // on 13–14 of 45 even with the prompt's "a count never stands alone" rule
  // (7 of 45 with it, and "½ cucumber" came back as ½ g); count first, 0 of 45.
  // Pinned in parseRecipeIngredients.test.ts.
  statedCount: QuantitySchema.nullable().optional(),
  quantity: QuantitySchema.nullable(),
  unit: z.enum(['g', 'ml']).nullable(),
  item: z.string(),
  preparation: z.array(z.string()),
  notes: z.string().nullable(),
  isOptional: z.boolean(),
  // Human-friendly original measure (e.g. "½ tsp"). null if source was already metric.
  displayText: z.string().nullable(),
});

const IngredientGroupAISchema = z.object({
  name: z.string().nullable(),
  items: z.array(ParsedIngredientAISchema),
});

export const ParseRecipeIngredientsAIOutputSchema = z.object({
  groups: z.array(IngredientGroupAISchema),
});

// The flow's callable output schema — full IngredientGroup[] with IDs.
export const ParseRecipeIngredientsOutputSchema = z.array(IngredientGroupSchema);
