import { z } from 'zod';

// The chef's `saveRecipe` tool (issue #1480) — the only tool in this codebase
// that asks for something and does nothing at all.
//
// RECOGNITION NEVER WRITES. The model's job here is to notice that someone asked
// for the conversation to be saved as a recipe; the SAVE itself runs in the
// browser, through `chatRecipeAuthor.ts` — the one implementation, with three
// doors onto it before this one — and through the `authorRecipe` flow beneath it.
// Nothing about saving moves server-side, and nothing may: Cloud Functions cannot
// import `@salt/firebase-sync` (CLAUDE.md Rule 2), and a second create path is
// the exact drift `chatRecipeAuthor.ts` was consolidated to end.
//
// So the worst a false positive can cost is a prompt or an unwanted recipe the
// person can delete — never a dish quietly rewritten. The handler in
// `chefChat.ts` is a pure function returning the constant below, and
// `chefChat.saveIntent.test.ts` goes red if it ever gains a `db`.
//
// WHY A TOOL AND NOT A WIDER OUTPUT SCHEMA. #1303 carried the chef's structured
// signal back beside the prose by splitting `outputSchema` from `streamSchema`,
// and #1310 reverted it in full: a browser on the older bundle wrote the whole
// `{ text, offered }` object into `message.text`, every later read then failed
// `text: z.string()`, and the conversation was dropped from the chat list for
// good (`unwrapWrappedReply` in `chatSession.ts` still repairs those documents).
// A tool leaves the wire contract exactly where it is — `ChefChatOutputSchema` is
// still `z.string()` and `generateStream` still gets no `output` option — so that
// failure mode cannot recur. The signal reaches the browser on the chat document
// the flow already writes (`ChatSessionSchema.pendingSaveIntent`), where an older
// browser simply has Zod strip a key it does not know.
//
// Every `.describe()` below is PROMPT TEXT Genkit shows the model.

/**
 * No input, deliberately.
 *
 * There is nothing the model could usefully say here that the save would act on:
 * the librarian reads the whole transcript and decides the title, the kind and
 * every field itself, exactly as it does for the button. A `title` parameter
 * would be a value the model spent tokens on and nothing ever read.
 */
export const SaveRecipeInputSchema = z.object({});

export type SaveRecipeInput = z.infer<typeof SaveRecipeInputSchema>;

export const SaveRecipeOutputSchema = z.object({
  requested: z
    .literal(true)
    .describe(
      'Always true. The app has been told they asked; it is doing the saving now, and it will ' +
        'take them to the recipe when it is done. Say one short line — they are about to watch ' +
        'the page change — and never list the recipe back out or claim to have written it yourself.',
    ),
});

export type SaveRecipeOutput = z.infer<typeof SaveRecipeOutputSchema>;
