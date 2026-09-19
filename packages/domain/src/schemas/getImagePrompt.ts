import { z } from 'zod';

// Wire contract for the getImagePrompt callable (issue #892, Phase 1): a
// read-only window onto the exact words that draw one generated picture.
//
// THE PROMPT IS RE-DERIVED ON DEMAND, never persisted. Every family's prompt is
// already a pure function of code constants plus fields that live on the
// document, so the callable can load the document and call the SAME builder the
// generator calls. That buys retroactive coverage for every picture already
// drawn and costs no schema change on four production collections. The honest
// caveat — for an old image this is "the prompt that would be sent now", not the
// literal bytes that produced it — is small in a repo where prompt changes are
// code changes shipped by PR, and the dialog says so in as many words.
//
// One deliberate omission: the one-shot `iconHint`. It is deleted after use by
// design (requestIconRegeneration), so a re-derived prompt that reinstated it
// would reverse that decision as a side effect of a read-only feature. What
// comes back is the prompt for this item AS IT STANDS.

// The six image families minus weather, which is seventeen committed static
// assets generated once offline — there is no runtime prompt to fetch.
export const IMAGE_PROMPT_FAMILIES = [
  'canon',
  'productForm',
  'kitchenTool',
  'equipment',
  'recipe',
] as const;

export type ImagePromptFamily = (typeof IMAGE_PROMPT_FAMILIES)[number];

export const GetImagePromptInputSchema = z.object({
  family: z.enum(IMAGE_PROMPT_FAMILIES),
  // The document id within that family's collection. For `equipment` this is the
  // `equipmentIcons` document id, not a separate icon id — an equipment ITEM id,
  // or since #1465 Phase 2 the accessory id of one of its ENTRIES, which owns a
  // document in that same collection.
  id: z.string().min(1),
});

export type GetImagePromptInput = z.infer<typeof GetImagePromptInputSchema>;

// Parsed at the client boundary (a callable result is `unknown` until proven
// otherwise), which is why the result has a schema at all rather than a bare type.
export const GetImagePromptResultSchema = z.object({
  // The complete assembled prompt — house style, steers, prohibitions and all.
  prompt: z.string(),
  // The Gemini image model this family resolves to right now (per-flow override
  // → role → code default), so the words and the machine are read together.
  model: z.string(),
  // The committed style-seed image this prompt is conditioned on, by filename;
  // `null` for recipe heroes, which are prompt-only with no reference seed.
  seedFile: z.string().nullable(),
});

export type GetImagePromptResult = z.infer<typeof GetImagePromptResultSchema>;
