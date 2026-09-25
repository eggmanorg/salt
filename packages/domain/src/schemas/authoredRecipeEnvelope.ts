import { z } from 'zod';
import { RecipeSchema } from './recipe.js';
import { PersistenceOutcomeSchema } from './persistenceOutcome.js';

// The three authoring callables — `extractRecipeFromUrl`, `extractRecipeFromPhoto`
// and `authorRecipe` — write the recipe they produce on the server
// (`persistAuthoredRecipe`), and since issue #1601 they can say whether that
// write landed. Declared ONCE here and consumed by all three schemas.
//
// OPT-IN, not a new default: a caller that sends `reportPersistence: true` gets
// the envelope; a caller that does not gets the bare recipe exactly as before. A
// PWA tab left open across a deploy reads `.id` straight off the bare recipe, so
// wrapping unconditionally would send it to `/recipes/undefined`. And the outcome
// cannot ride ON the recipe object: the client stashes that object and the first
// edit writes it whole, so the key would land in the family's `recipes`
// collection on exactly the failure path it exists for.
export const ReportPersistenceSchema = z.literal(true).optional();

export const AuthoredRecipeEnvelopeSchema = z.object({
  recipe: RecipeSchema,
  persistence: PersistenceOutcomeSchema,
});

export type AuthoredRecipeEnvelope = z.infer<typeof AuthoredRecipeEnvelopeSchema>;

// Either arm, picked by the input's `reportPersistence`.
export const AuthoredRecipeOutputSchema = z.union([RecipeSchema, AuthoredRecipeEnvelopeSchema]);
