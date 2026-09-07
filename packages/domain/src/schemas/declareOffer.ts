import { z } from 'zod';
import { ChefOfferSchema } from './chatSession.js';

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

export const DeclareOfferInputSchema = z.object({
  offers: z
    .array(ChefOfferSchema)
    .describe(
      'What this reply puts on the table. "dish-change" — you have suggested changing the ' +
        'recipe this conversation is attached to. "new-dish" — you have described a dish worth ' +
        'keeping in its own right, whether a whole new recipe or something to serve alongside. ' +
        'Both, when your reply does both. Never a kind you did not actually offer.',
    ),
});

export type DeclareOfferInput = z.infer<typeof DeclareOfferInputSchema>;

export const DeclareOfferOutputSchema = z.object({
  recorded: z
    .boolean()
    .describe('Always true. Nothing is written and nothing is shown to the user; carry on.'),
});

export type DeclareOfferOutput = z.infer<typeof DeclareOfferOutputSchema>;
