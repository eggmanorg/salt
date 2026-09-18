import { z } from 'zod';
import { RecipeKitEntrySchema } from './recipe.js';
import { EquipmentItemSchema } from './equipmentManifest.js';

// Input/output for the identifyRecipeKit flow (issue #882) — "what do I need to
// get out?" answered from the WHOLE stored recipe.
//
// It is a SEPARATE flow rather than an extra field on the librarian or the URL
// extractor, and that is a scope rule rather than a preference: those two are
// temperature-0 TRANSCRIBERS (docs/ai-kitchen-assistant.md § Scope boundaries) and
// must never be handed anything that licenses them to rewrite a recipe. Kit is
// INFERENCE — "mash the potatoes" needs a masher the recipe never names — so it
// runs afterwards, over what was actually saved, exactly as describeRecipeScene
// does for the hero.
//
// THE LOAD-BEARING DECISION: `label` is FREE TEXT, and there is deliberately no
// `z.enum` over the drawn vocabulary anywhere in this file. A constrained enum
// would force the model to return a member of the list, so a recipe needing a
// potato masher would come back asking for a fork — confidently, and wrongly. The
// vocabulary is resolved against these words at DISPLAY time; a label nothing
// matches renders as words with no picture, which is the correct answer and costs
// nothing. Growing the vocabulary later fixes the picture without touching a
// single recipe.
export const IdentifyRecipeKitInputSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  // Ingredient DISPLAY lines (rawText), flattened out of their groups — the flow
  // wants what the dish is made of, not how the list is arranged. They matter
  // because they carry form as well as content: "300g floury potatoes" and "a
  // block of parmesan" each imply a tool the method may never name.
  ingredients: z.array(z.string()),
  // The steps WITH their ids, which is the one place this input differs from
  // describeRecipeScene's. The flow has to say which steps
  // use each piece of kit, so it needs the ids the recipe document actually
  // carries — it can neither invent them nor be handed ordinals to map back.
  steps: z.array(z.object({ id: z.string(), text: z.string() })),
  // The household's equipment manifest, STRUCTURED (issue #1465) where it used to
  // be the prompt text `renderEquipmentManifest` had already produced (#954). It
  // is what lets a label say WHICH food processor — the manifest holds four, and
  // "food processor" identifies none of them.
  //
  // It is the items themselves, not their rendering, because this flow now has to
  // answer with a HANDLE per item and per owned entry and have that handle mapped
  // back to manifest ids server-side. Building the prompt text and the handle map
  // from one source is what stops the two drifting; handing the flow a finished
  // string would make that impossible. `renderEquipmentManifest` is untouched and
  // still serves the other four flows byte for byte.
  //
  // Optional with a `[]` default, and that is the fail-open contract rather than
  // tidiness: `readEquipmentItems` returns `[]` for a missing, corrupt or
  // unreadable manifest, and `[]` has to mean "infer kit exactly as before" —
  // never "skip inference". A household with no manifest gets the pre-#954 prompt
  // byte for byte.
  equipment: z.array(EquipmentItemSchema).optional().default([]),
});

export type IdentifyRecipeKitInput = z.infer<typeof IdentifyRecipeKitInputSchema>;

// What the model emits — and since issue #1465 it is NO LONGER the document's own
// shape. This is the trust boundary (`.safeParse` at the AI seam), and everything
// it returns is then SANITISED before it is written (hallucinated step ids
// dropped, blank labels dropped, duplicates collapsed, and now unknown handles
// dropped). See `sanitiseRecipeKit`.
export const IdentifyRecipeKitAIEntrySchema = z.object({
  label: z.string(),
  stepIds: z.array(z.string()),
  // The HANDLE of the thing this line names, copied from the kitchen list in the
  // prompt — `k3`, or `k3.2` for one of that item's entries — or null for an
  // ordinary tool nobody itemises.
  //
  // A SHORT PER-CALL HANDLE, NEVER THE MANIFEST'S UUID. A uuid in a prompt is 36
  // characters of noise the model has to copy exactly and can plausibly corrupt;
  // a handle is two or three. The map from handle back to
  // `{ itemId, accessoryId }` is built beside the rendering that emitted it and
  // never leaves the server, so a handle the model invents resolves to nothing
  // and is dropped rather than writing a link to a thing that does not exist.
  //
  // `.nullable().default(null)`: a model that omits the key entirely means the
  // same thing as one that answers null — this line names nothing you own.
  ref: z.string().nullable().default(null),
});

export const IdentifyRecipeKitAIOutputSchema = z.object({
  kit: z.array(IdentifyRecipeKitAIEntrySchema),
});

// The flow's output: the DOCUMENT's shape, sanitised against the recipe it was
// asked about and with every surviving handle translated back into a
// `RecipeKitEquipmentLink`. Named separately from the AI output for the reason
// parseRecipeIngredients names its pair — and since #1465 the two genuinely do
// differ, which is what the seam was kept for.
export const IdentifyRecipeKitOutputSchema = z.object({
  kit: z.array(RecipeKitEntrySchema),
});

export type IdentifyRecipeKitAIEntry = z.infer<typeof IdentifyRecipeKitAIEntrySchema>;
