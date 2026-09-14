import { z } from 'zod';

// The chef's `readEquipmentDetail` tool (issue #1373) — the THIRD tool, and the
// justification for it is that issue. Beside `readRecipe.ts` and
// `findRecipes.ts`, and for the same reason: the shape is named by the Cloud
// Function and read by the model, so a second declaration of it is a place for
// the two to drift.
//
// Every `.describe()` below is PROMPT TEXT Genkit shows the model, not
// documentation. Edit it as prompt work.
//
// WHY A STRING AND NOT A STRUCTURE. The detail is rendered prose — the record's
// own note, its rules, its entries with their notes, its environment — for the
// same reason `readRecipe` returns rendered text: the chef reads it, nothing
// parses it, and a shape here would be a second thing to keep in step with the
// renderer for no reader's benefit.

export const ReadEquipmentDetailInputSchema = z.object({
  name: z
    .string()
    .describe(
      'The name of a piece of equipment or a family of kit, as it appears in the kitchen list ' +
        'in your instructions — "Magimix Cook Expert", "Frying pans". Use the name as written; ' +
        'a name that matches nothing, or matches two things equally, comes back as found: false.',
    ),
});

export type ReadEquipmentDetailInput = z.infer<typeof ReadEquipmentDetailInputSchema>;

export const ReadEquipmentDetailOutputSchema = z.object({
  found: z
    .boolean()
    .describe('False when no single record answers to that name. Say so; do not invent one.'),
  detail: z
    .string()
    .nullable()
    .describe(
      'Everything the household has recorded about that record — what it contains or what ' +
        'accessories it has, what they have written about each one, their notes on the record ' +
        'itself, its household rules, and the temperature it holds if it holds one. Any entry ' +
        'marked "not owned" is one they do NOT have: never propose it. Null when found is false.',
    ),
});

export type ReadEquipmentDetailOutput = z.infer<typeof ReadEquipmentDetailOutputSchema>;
