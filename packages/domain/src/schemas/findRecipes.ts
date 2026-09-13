import { z } from 'zod';
import { RecipeKindSchema, RecipeSchema } from './recipe.js';

// The chef's `findRecipes` tool (issue #840) — the first Genkit tool in this
// codebase, and the wire contract between the model, the Cloud Function handler
// and the pure ranking function in `recipe/queries/searchRecipes.ts`.
//
// Here rather than in `apps/cloud-functions` because the shape crosses an @salt
// boundary twice over: the CF names it and so does the domain search it wraps,
// and a second declaration of either half is a place for the two to drift.
//
// EVERY `.describe()` BELOW IS PROMPT TEXT. Genkit turns this schema into the
// JSON schema the model is shown, so these sentences are read by Gemini on every
// turn and are the difference between a chef that searches when it should and one
// that searches instead of answering. Edit them as prompt work, not as comments.

export const FindRecipesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Words that would appear in the dish you are looking for — its name, what is in it, ' +
        'how it is cooked. Turn the vibe into keywords first: "something warming for a cold ' +
        'night" is a search for words like "stew braise soup roast". ' +
        'LEAVE THIS OUT ENTIRELY to browse the whole library, which is what you want when ' +
        'asked to plan a week or to see what is saved.',
    ),
  kind: RecipeKindSchema.optional().describe(
    'Restrict to one kind of entry. "recipe" is a dish to cook, "cocktail" a drink, ' +
      '"special" a meal that needs no recipe card — a takeaway, a night out, or a dish the ' +
      'household cooks so often it was never written down (all legitimate answers to "what ' +
      'is for dinner"). ' +
      'Leave out to search everything the household could actually eat — "placeholder" is a ' +
      'stock photograph for a night planned in a sentence, never a dish, and is only ever ' +
      'returned if you ask for it by name here.',
  ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Narrow to entries carrying ALL of these tags. This is a strict filter, so use it only ' +
        'for words the household would actually have tagged with ("vegetarian", "quick") — ' +
        'for anything fuzzy use query instead.',
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'How many dishes to return. Leave it out: a search defaults to the best 25 and a ' +
        'browse returns the whole library. Anything above 60 is capped at 60.',
    ),
});

export type FindRecipesInput = z.infer<typeof FindRecipesInputSchema>;

/**
 * One dish as the chef sees it before deciding to look closer — a title, what it
 * is, and the numbers that decide whether tonight is possible.
 *
 * NO ingredients and NO method: those never leave Firestore for a search (the
 * handler projects four fields), and reading a dish properly is its own step.
 */
export const FindRecipesMatchSchema = z.object({
  id: z.string().describe('Use this to link the dish: [Title](#/recipes/<id>).'),
  title: z.string(),
  kind: RecipeKindSchema,
  tags: z.array(z.string()),
  description: z.string().nullable().describe('Trimmed to its opening; may be cut mid-sentence.'),
  servings: z.number().nullable(),
  elapsedMinutes: z
    .number()
    .nullable()
    .describe('Wall clock start to serving. Null when this dish has never been timed.'),
  handsOnMinutes: z.number().nullable().describe('Minutes of actual attention, of the above.'),
});

export const FindRecipesOutputSchema = z.object({
  matches: z.array(FindRecipesMatchSchema),
  /**
   * How many entries the library holds in total, before the query narrowed it.
   *
   * Free (the handler has the array in hand) and load-bearing: it is how the chef
   * tells "we have nothing like that" from "we have almost nothing", which is what
   * "propose a week out of what exists, and invent where the library is thin"
   * needs to know.
   */
  totalInLibrary: z.number(),
});

export type FindRecipesOutput = z.infer<typeof FindRecipesOutputSchema>;

/**
 * The four fields a search reads off a `recipes/{id}` document, and nothing else.
 *
 * DERIVED FROM `RecipeSchema` by `.pick()` rather than restated, so the search
 * projection cannot drift from the document it reads. `kind` keeps its
 * `.default('recipe')` through the pick, which is what lets the ~59 documents
 * written before #637 parse here exactly as they do everywhere else.
 *
 * The absentees are the point: `ingredients` and `steps` are not in this list, so
 * a `select()` built from it cannot fetch them. See the handler.
 */
export const RecipeSearchProjectionSchema = RecipeSchema.pick({
  title: true,
  description: true,
  kind: true,
  metadata: true,
});

export type RecipeSearchProjection = z.infer<typeof RecipeSearchProjectionSchema>;

/**
 * The field names above, as the array Firestore's `select()` takes.
 *
 * Read off the schema's own keys rather than typed out beside it: a fifth field
 * added to the projection above widens the query in the same edit, and — the half
 * that matters — a projection that grew `ingredients` could not do so silently.
 */
export const RECIPE_SEARCH_PROJECTION_FIELDS = Object.keys(
  RecipeSearchProjectionSchema.shape,
) as (keyof RecipeSearchProjection)[];
