import { z } from 'zod';

// Guided plan document schema (issue #751, Phase 1). One document per recipe at
// `guidedPlans/{recipeId}` — a DETERMINISTIC id, and a SEPARATE, FAMILY-SHARED
// collection rather than fields on the recipe.
//
// Why its own collection: a guided plan is a human-reviewable RENDERING of a
// recipe — what the recipe assumes you already know — not part of the recipe.
// Keeping it out of `recipes` means the recipe schema gains nothing, a plan can
// be rewritten without touching (or LWW-clobbering) the dish, and a recipe with
// no plan carries no empty scaffolding. Nothing about it is personal, so it is
// family-shared with no `ownerUid` — the rules block mirrors `recipes`.
//
// It holds two things:
//
//  1. `prep` — mise en place as a list of JOBS, each with the container the
//     result goes into ("dice the carrots, onion and celery → small bowl").
//     Things used together are prepped together into one named container.
//  2. `stepNotes` — additions AROUND the recipe's existing steps. The step text
//     itself is never touched: a note may say which prepped container the step
//     wants, how the hob is set, what the cook should hear or see, and — on a step
//     that already carries a timer — reminders partway through. Two of its fields
//     (`lookahead`, `getAhead`) are read a step EARLY rather than underneath; see
//     them below.

// One reminder partway through a step that already has a timer. Phase 3 owns the
// runtime side (arming, notifying); Phase 1 only stores and edits these.
//
// The schema can only check that `atMinutes` is a positive number: whether it
// falls INSIDE the step's timer is a question about the RECIPE, which this
// document does not contain. That cross-check lives at authoring time, in the
// plan editor, where the recipe is in hand.
export const GuidedCheckInSchema = z.object({
  atMinutes: z.number().positive(),
  text: z.string(),
});

// ─── The authored content (what the AI writes, and what a human then edits) ───
//
// These two schemas are the FIELD LIST for their stored counterparts below,
// which extend them — so the wire shape and the stored shape cannot drift apart
// by a field. They deliberately carry NO `.default()`: they are handed to Gemini
// as a structured-output schema, and the doc-read defaults are a READ contract
// for documents already in Firestore, not something to ask a model to honour.

export const GuidedPrepEntryContentSchema = z.object({
  // One instruction. "Dice the carrots, onion and celery into 5mm pieces."
  text: z.string(),
  // Where the result is set aside. Null when there is nothing to put anywhere
  // ("open the tin of tomatoes").
  container: z.string().nullable(),
  // Which recipe ingredients this job prepares. LOAD-BEARING: in guided mode the
  // prep list REPLACES the ingredient checklist, so an ingredient named in no
  // prep entry is one the cook never sees. Every ingredient in the recipe must
  // appear in exactly one entry — the prompt demands it and the editor warns
  // when it is not true.
  ingredientIds: z.array(z.string()),
});

export const GuidedStepNoteContentSchema = z.object({
  // The recipe step this annotates. A note whose step no longer exists renders
  // as NOTHING — never an error, and never re-attached to a neighbouring step.
  stepId: z.string(),
  // Which prepped container this step wants. Null when the step needs none.
  container: z.string().nullable(),
  // How the station is set: "small hob burner, medium-low".
  setup: z.string().nullable(),
  // The sensory test that says it is going right: "you should hear a very gentle
  // sizzle, not a crackle". Null wherever there is no genuine test — an invented
  // cue is worse than no cue, so the prompt is explicit about leaving it out.
  cue: z.string().nullable(),
  checkIns: z.array(GuidedCheckInSchema),
  // ─── Read WHILE ON this step, about what comes after it (issue #769) ───────
  //
  // Both of these are shown at the bottom of THIS step's screen, where plain cook
  // mode fades in the top of the next step's raw text. They are written on the
  // step the cook is standing on, NOT on the step they describe.
  //
  // That direction was originally the other way round and it shipped wrong: the
  // reader took the NEXT step's note and numbered it correctly, so the cook got
  // "Next · 5" over a description of step 6, all the way down the recipe. The
  // model had been authoring them this way all along, and this way is right —
  // `getAhead` is about the spare time in the step you are ON, and what it gets
  // ahead of may be several steps away ("preheat the oven" belongs on the
  // ten-minute sauté, not one step before the oven is used).
  //
  // One clause on what the NEXT step does. Null renders as the plain fade, which
  // is the honest answer for a plan whose author had nothing to say here — not a
  // legacy state to be tolerated.
  lookahead: z.string().nullable(),
  // Something from a LATER step to start during this one: an oven that needs
  // fifteen minutes to come up, a steak that needs half an hour out of the fridge.
  // Null on almost every step — a step with nothing waiting on it has nothing to
  // say here, and the prompt is as explicit about that as it is for `cue`.
  getAhead: z.string().nullable(),
});

// ─── The stored document ──────────────────────────────────────────────────────
//
// Every field a plan might not carry is `.default(null)` / `.default([])` rather
// than `.optional()`, following the `producesCanonId` idiom on RecipeSchema:
// READERS SEE A CONCRETE `string | null` / array, never `undefined`. That is the
// whole reason, and it is worth stating without the usual second one: guided mode
// has never shipped past staging, so `guidedPlans` is greenfield and this document
// carries no installed base to be backward-compatible WITH. It is absent from
// CLAUDE.md's production-data list for the same reason.
//
// So changing the shape of a plan is free — re-run it. Do not add migration notes,
// tolerance for old shapes, or "existing plans read as null" reasoning here; the
// defaults exist to spare every reader an `undefined` check, not to protect data
// that does not exist.

export const GuidedPrepEntrySchema = GuidedPrepEntryContentSchema.extend({
  // Local to this document, minted when the entry is created (the AI does not
  // author ids — it authors content, and whoever writes the document mints the
  // identity). On a generation that is the flow; on a hand-added entry, the editor.
  id: z.string(),
  container: z.string().nullable().default(null),
  ingredientIds: z.array(z.string()).default([]),
});

export const GuidedStepNoteSchema = GuidedStepNoteContentSchema.extend({
  container: z.string().nullable().default(null),
  setup: z.string().nullable().default(null),
  cue: z.string().nullable().default(null),
  checkIns: z.array(GuidedCheckInSchema).default([]),
  lookahead: z.string().nullable().default(null),
  getAhead: z.string().nullable().default(null),
});

export const GuidedPlanSchema = z.object({
  // Deterministic: the recipe's id. One plan per recipe.
  id: z.string(),
  schemaVersion: z.literal(1),
  recipeId: z.string(),
  // Snapshot of the recipe's `updatedAt` as it stood when this plan was last
  // written. Mirrors `cookSession.recipeUpdatedAtAtStart`, and is compared the
  // same way (`hasRecipeChanged`) to raise the "the recipe has changed since this
  // plan was written" banner.
  //
  // RE-STAMPED ON EVERY HUMAN SAVE, not just on generation. A save is a review of
  // the plan against the recipe as it now stands — the same reasoning that lets a
  // save clear `needs_approval` — so reconciling a plan by hand clears the banner
  // without a re-run. Without that, the only way out of a stale banner would be
  // re-running the flow, which throws away every hand-corrected line.
  recipeUpdatedAtAtSave: z.string(),
  // Used-but-flagged, exactly as on RecipeSchema / CanonItem / ProductForm: the
  // plan is fully live regardless; the flag ONLY records that no human has read
  // it. Set by the `generateGuidedPlan` flow — the one assignment of it in the
  // codebase — and dropped (never written `false`) by a save.
  // `.optional()` — a control field, and ABSENT MEANS REVIEWED, so a plan
  // authored entirely by hand is never flagged.
  needs_approval: z.boolean().optional(),
  prep: z.array(GuidedPrepEntrySchema).default([]),
  stepNotes: z.array(GuidedStepNoteSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── The generateGuidedPlan flow ──────────────────────────────────────────────

// The callable takes only the recipe id: the flow reads the recipe SERVER-SIDE
// via the Admin SDK, like the canon flows do, so the client cannot hand the model
// a recipe that is not the one in Firestore.
export const GenerateGuidedPlanInputSchema = z.object({
  recipeId: z.string().min(1),
});

// What the MODEL returns: content only. It authors no ids, no timestamps and no
// control fields — those are the flow's to stamp, immediately below, and a schema
// that let the model supply them would let it decide whether its own plan had been
// reviewed.
export const GenerateGuidedPlanAIOutputSchema = z.object({
  prep: z.array(GuidedPrepEntryContentSchema),
  stepNotes: z.array(GuidedStepNoteContentSchema),
});

// What the CALLABLE returns: the whole document, exactly as the flow wrote it to
// `guidedPlans/{recipeId}` (issue #1416).
//
// It is not a second copy the client has to reconcile — the flow writes first and
// returns what it wrote, so the value on the wire IS the document. The client takes
// it because the alternative is a blank editor for as long as the realtime snapshot
// takes to arrive, at the end of a wait that can already run to three minutes.
//
// Why the flow writes rather than the browser: the browser may not be there. The
// call outlives a locked phone, and everything the client did after the `await`
// used to be lost with the page (#1416, the same loss #616 fixed for imports).
export const GenerateGuidedPlanOutputSchema = GuidedPlanSchema;

export type GuidedCheckInDoc = z.infer<typeof GuidedCheckInSchema>;
export type GuidedPrepEntryDoc = z.infer<typeof GuidedPrepEntrySchema>;
export type GuidedStepNoteDoc = z.infer<typeof GuidedStepNoteSchema>;
export type GuidedPlanDoc = z.infer<typeof GuidedPlanSchema>;
export type GenerateGuidedPlanInput = z.infer<typeof GenerateGuidedPlanInputSchema>;
export type GenerateGuidedPlanOutput = z.infer<typeof GenerateGuidedPlanOutputSchema>;
