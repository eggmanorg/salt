import { z } from 'zod';

// The chef's `findKitchenNotes` tool (issue #1377, epic #1372) — the cheap first
// step of a two-step read over the household's own written-down notes.
//
// Here rather than in `apps/cloud-functions` for the same reason `findRecipes.ts`
// is: the shape is named by the Cloud Function handler and by the pure filter in
// `library/searchLibraryPages.ts`, so a second declaration of it is a place for
// the two to drift.
//
// THE WORD IS "NOTES", NEVER "LIBRARY". `LIBRARY_FRAMING` in `chefChat.ts` already
// teaches the chef that "their library" means the household's saved RECIPES; a
// second thing called the library in the same system prompt is a collision for the
// model and for the next person to read the file. The collection, the schema and
// the app's own routes keep the `library` names they have — it is only the words
// the model reads that must not collide.
//
// EVERY `.describe()` BELOW IS PROMPT TEXT. Genkit turns this schema into the JSON
// schema the model is shown, so these sentences are read by Gemini on every turn.
// Edit them as prompt work, not as comments.

export const FindKitchenNotesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Words that would appear in the note you are looking for — what it is about, the kit or ' +
        'the ingredient it covers. Every word you give must appear somewhere in the note, so ' +
        'give the two or three that matter and not a sentence. ' +
        'LEAVE THIS OUT ENTIRELY to see what notes exist at all.',
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many notes to return. Leave it out: the default is 10, and 25 is the most.'),
});

export type FindKitchenNotesInput = z.infer<typeof FindKitchenNotesInputSchema>;

/**
 * One note as the chef sees it BEFORE deciding to open it.
 *
 * The summary is derived from the body at call time — see `libraryPageSummary` —
 * and is often the whole answer, which is the point of the two-step shape.
 */
export const KitchenNoteMatchSchema = z.object({
  id: z.string().describe('Pass this to readKitchenNote to open the note in full.'),
  title: z.string(),
  tags: z.array(z.string()),
  summary: z
    .string()
    .describe(
      'The opening of the note, formatting stripped and cut short. Often enough to answer from ' +
        'or to tell you this is the wrong note; may be cut mid-sentence.',
    ),
});

export const FindKitchenNotesOutputSchema = z.object({
  matches: z.array(KitchenNoteMatchSchema),
  /**
   * How many notes the household has written in total, before the query narrowed
   * it. Free (the handler has the array in hand) and it is how the chef tells
   * "they have written nothing about that" from "they have barely written
   * anything" — two different things to say out loud.
   */
  totalNotes: z.number().describe('How many notes exist in total, before your query narrowed it.'),
});

export type FindKitchenNotesOutput = z.infer<typeof FindKitchenNotesOutputSchema>;
