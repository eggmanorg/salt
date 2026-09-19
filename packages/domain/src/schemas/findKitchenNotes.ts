import { z } from 'zod';

// The chef's `findKitchenNotes` tool (issue #1377, epic #1372) — the cheap first
// step of a two-step read over the household's own Library of written-down pages.
//
// Here rather than in `apps/cloud-functions` for the same reason `findRecipes.ts`
// is: the shape is named by the Cloud Function handler and by the pure filter in
// `library/searchLibraryPages.ts`, so a second declaration of it is a place for
// the two to drift.
//
// THE WORD IS "LIBRARY", AND IT MEANS THESE PAGES. This comment used to say the
// opposite — "the word is NOTES, never LIBRARY", because `LIBRARY_FRAMING` in
// `chefChat.ts` spent it on the household's saved RECIPES. Issue #1476 reversed
// that: the app's navigation calls `#/library` "Library" and `#/recipes`
// "Recipes", so the chef's old vocabulary named two surfaces no user could find.
// The recipes side moved instead. The collision it was avoiding is still real —
// only one of the two may hold the word, and it is this one.
//
// EVERY `.describe()` BELOW IS PROMPT TEXT. Genkit turns this schema into the JSON
// schema the model is shown, so these sentences are read by Gemini on every turn.
// Edit them as prompt work, not as comments.

export const FindKitchenNotesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Words that would appear in the page you are looking for — what it is about, the kit or ' +
        'the ingredient it covers. Every word you give must appear somewhere in the page, so ' +
        'give the two or three that matter and not a sentence. ' +
        'LEAVE THIS OUT ENTIRELY to see what pages their Library holds at all.',
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many pages to return. Leave it out: the default is 10, and 25 is the most.'),
});

export type FindKitchenNotesInput = z.infer<typeof FindKitchenNotesInputSchema>;

/**
 * One Library page as the chef sees it BEFORE deciding to open it.
 *
 * The summary is derived from the body at call time — see `libraryPageSummary` —
 * and is often the whole answer, which is the point of the two-step shape.
 */
export const KitchenNoteMatchSchema = z.object({
  id: z.string().describe('Pass this to readKitchenNote to open the page in full.'),
  title: z.string(),
  tags: z.array(z.string()),
  summary: z
    .string()
    .describe(
      'The opening of the page, formatting stripped and cut short. Often enough to answer from ' +
        'or to tell you this is the wrong page; may be cut mid-sentence.',
    ),
});

export const FindKitchenNotesOutputSchema = z.object({
  /**
   * False only when the SEARCH ITSELF failed — a Firestore error, not an empty
   * Library. `readKitchenNoteForChef` already faces this shape of problem: three
   * different causes (gone, corrupt, read threw) all have to collapse into one
   * signal the chef can act on, and there it is `found: false`. Here the
   * equivalent collapse — a catch returning empty matches — is indistinguishable
   * from a household that has genuinely written nothing, and `ok` is what keeps
   * the two apart so the chef is never handed a failure dressed as an empty
   * Library.
   */
  ok: z
    .boolean()
    .describe(
      'False when the search itself could not run. matches and totalNotes are both empty either ' +
        'way, so this is the only field that tells "the lookup failed" apart from "they have ' +
        'written nothing" — two very different things to say out loud.',
    ),
  matches: z.array(KitchenNoteMatchSchema),
  /**
   * How many pages the household has written in total, before the query narrowed
   * it. Free (the handler has the array in hand) and it is how the chef tells
   * "they have written nothing about that" from "they have barely written
   * anything" — two different things to say out loud.
   */
  totalNotes: z
    .number()
    .describe('How many pages their Library holds in total, before your query narrowed it.'),
});

export type FindKitchenNotesOutput = z.infer<typeof FindKitchenNotesOutputSchema>;
