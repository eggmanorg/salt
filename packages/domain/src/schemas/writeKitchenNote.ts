import { z } from 'zod';
import { LIBRARY_PAGE_BODY_MAX, LIBRARY_PAGE_TITLE_MAX } from './libraryPage.js';

// The chef's `writeKitchenNote` tool (issue #1377, phase 2) — the one tool in
// this codebase that WRITES a household document on the model's say-so.
//
// WHY THIS IS ALLOWED HERE when #1373 refused it for equipment: see the comment
// at the tool's declaration in `chefChat.ts`. In short, a page is a document
// someone opens and reads and it carries a visible revision history with restore
// (#1375), which is the review surface equipment lacks.
//
// WHAT THIS SCHEMA DOES NOT ENFORCE, deliberately: the title and body limits are
// stated in the `.describe()` text and checked in the HANDLER, not with `.max()`
// here. Genkit validates tool input against this schema before the handler runs,
// so a `.max()` turns an over-long draft into a schema error inside the model's
// tool loop — where the chef cannot say anything useful about it. Checked in the
// handler it becomes an ordinary refusal the chef can read out and act on
// (CLAUDE.md Rule 10). The NUMBERS are still imported rather than restated, so
// there is one source for each of them.
//
// Every `.describe()` below is PROMPT TEXT Genkit shows the model. The word is
// "note", never "library" — see `findKitchenNotes.ts`.

export const WriteKitchenNoteInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'The id of an existing note to REPLACE, exactly as findKitchenNotes returned it. ' +
        'LEAVE THIS OUT to start a new note. Never guess one: an id you have not seen come ' +
        'back from a search will simply fail.',
    ),
  title: z
    .string()
    .describe(
      `What the note is called — a line, not a paragraph, and at most ${LIBRARY_PAGE_TITLE_MAX} characters. ` +
        'When replacing a note, give its existing title again unless you were asked to rename it.',
    ),
  body: z
    .string()
    .describe(
      'The WHOLE note, in Markdown — headings, tables and lists all render. ' +
        `At most ${LIBRARY_PAGE_BODY_MAX} characters. ` +
        'This REPLACES everything the note currently holds, so when you are adding to one, ' +
        'read it first and send the old text back with your addition in it. Sending only the ' +
        'new part deletes the rest.',
    ),
});

export type WriteKitchenNoteInput = z.infer<typeof WriteKitchenNoteInputSchema>;

export const WriteKitchenNoteOutputSchema = z.object({
  saved: z.boolean().describe('False when nothing was written. `problem` says why.'),
  id: z
    .string()
    .nullable()
    .describe(
      'The note’s id. Null when nothing was written. Tell them the note is in the library.',
    ),
  created: z
    .boolean()
    .describe('True for a new note, false for one that was replaced. Null-safe: false on failure.'),
  problem: z
    .string()
    .nullable()
    .describe(
      'A plain sentence saying what stopped the write, or null. Say it out loud as your own — ' +
        'never claim a note was written when saved is false.',
    ),
});

export type WriteKitchenNoteOutput = z.infer<typeof WriteKitchenNoteOutputSchema>;
