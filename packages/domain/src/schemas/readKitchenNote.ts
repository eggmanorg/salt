import { z } from 'zod';

// The chef's `readKitchenNote` tool (issue #1377) — the second half of the
// two-step read, beside `findKitchenNotes.ts` and for the same reasons: the shape
// is named by the Cloud Function and read by the model. The word the model sees
// for these pages is "the Library" and "a page" — issue #1476 reversed #1377's
// call here; `findKitchenNotes.ts` carries the reasoning.
//
// Every `.describe()` below is PROMPT TEXT Genkit shows the model, not
// documentation. Edit it as prompt work.

export const ReadKitchenNoteInputSchema = z.object({
  id: z
    .string()
    .describe(
      'The id of a Library page, exactly as findKitchenNotes returned it. You cannot guess or ' +
        'construct one — if you have not seen the page come back from a search, search first.',
    ),
});

export type ReadKitchenNoteInput = z.infer<typeof ReadKitchenNoteInputSchema>;

export const ReadKitchenNoteOutputSchema = z.object({
  /**
   * False for a page that could not be read.
   *
   * THREE different causes reach it — the page is gone, the document is corrupt,
   * or the read itself failed — so it is not "this page has been deleted", and the
   * tool description must not tell the model it is. One transient read failure
   * would otherwise have the chef announce that a page the household is looking at
   * on screen no longer exists.
   */
  found: z.boolean().describe('False when the page could not be opened. Say so; do not invent it.'),
  title: z.string().nullable().describe('Null when found is false.'),
  body: z
    .string()
    .nullable()
    .describe('The whole page as the household wrote it, in Markdown. Null when found is false.'),
});

export type ReadKitchenNoteOutput = z.infer<typeof ReadKitchenNoteOutputSchema>;
