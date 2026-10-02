import { z } from 'zod';
import { QuantitySchema, IngredientGroupSchema } from './recipe.js';

export const ParseRecipeIngredientsInputSchema = z.object({
  rawText: z.string(),
});

// Slim AI-generated shape: no IDs or matchState — the flow adds those after generation.
const ParsedIngredientAISchema = z.object({
  rawText: z.string(),
  quantity: QuantitySchema.nullable(),
  unit: z.enum(['g', 'ml']).nullable(),
  item: z.string(),
  preparation: z.array(z.string()),
  notes: z.string().nullable(),
  isOptional: z.boolean(),
  // Human-friendly original measure (e.g. "½ tsp"). null if source was already metric.
  displayText: z.string().nullable(),
  // The count of whole things the line states (issue #1643) — see
  // `ParsedIngredientSchema.statedCount`. Optional rather than required so a
  // stubbed model answer written before the field existed (the e2e
  // `_e2e_ai_stubs` fixtures) still validates; the flow writes an absent one as
  // null.
  statedCount: QuantitySchema.nullable().optional(),
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
