import { z } from 'zod';

// The chef's `declareOffer` tool (issue #1299) — its THIRD, and the justification
// is written into `docs/ai-kitchen-assistant.md`'s design principle #1: the only
// alternative was a second AI call per turn, to recover one bit the model already
// knows. Beside `findRecipes.ts` and `readRecipe.ts`, and for the same reason:
// the shape is named by the Cloud Function and read by the model, so a second
// declaration of it is a place for the two to drift.
//
// Every `.describe()` below is PROMPT TEXT Genkit shows the model, not
// documentation. Edit it as prompt work.
//
// It is the one tool that touches NOTHING. No Firestore read, no write, no
// second model call — its implementation returns a constant. Calling it is the
// whole effect: the flow reads the request back off the drained response and
// hands it to the client, which is how the buttons under a reply come to exist.

// A LIST OF PLAIN STRINGS, not of the two known kinds, and the difference is a
// whole failure mode (PR #1303 review). Genkit validates a model-authored tool
// input BEFORE the implementation runs and THROWS on a rejection — nothing in the
// tool loop catches it — so with the enum here, a chef reaching for "dish_change"
// would fail the turn and have the client roll the user's own message out of the
// transcript. The two kinds are still named in the description below, which is
// the prompt text the model reads, and `declaredOffers` in `chefChat.ts` narrows
// each string: that is where an unknown kind is dropped for a missing button.
export const DeclareOfferInputSchema = z.object({
  offers: z
    .array(z.string())
    .describe(
      'The list of what this reply puts on the table, e.g. ["new-dish"]. "dish-change" — you ' +
        'have suggested changing the recipe this conversation is attached to. "new-dish" — you ' +
        'have described a dish worth keeping in its own right, whether a whole new recipe or ' +
        'something to serve alongside. ["dish-change", "new-dish"] when your reply does both. ' +
        'Never a kind you did not actually offer, and never a word other than those two.',
    ),
});

export type DeclareOfferInput = z.infer<typeof DeclareOfferInputSchema>;

export const DeclareOfferOutputSchema = z.object({
  recorded: z
    .boolean()
    .describe('Always true. Nothing is written and nothing is shown to the user; carry on.'),
});

export type DeclareOfferOutput = z.infer<typeof DeclareOfferOutputSchema>;
