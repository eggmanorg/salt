import { z } from 'zod';

// Process — ordered stages, each with a temperature and a duration (issue #806,
// phase 2 of epic #778). A ferment is this model with one long stage, a cure with
// three, bread with six short ones.
//
// Stored as an OPTIONAL BARE ARRAY on the formula document (`FormulaSchema.process`),
// not as a wrapper object: the process IS the ordered stages and holds nothing
// else today, and a wrapper is a container waiting for a tenant. `ProcessSchema`
// exists as the alias so the noun has a name.
//
// WHAT IS DELIBERATELY NOT HERE YET. docs/formulas-schedules-batches.md says
// stages must be able to carry ADDITIONS (a cure rubs at stage one, cases at stage
// three) and REMOVALS (kefir strains its grains back out). Neither is modelled
// here, and that is not an oversight: nothing in this phase produces or consumes
// either, and empty scaffolding is a field every reader must handle for no one's
// benefit. What the contract actually requires is that the shape not PRECLUDE
// them, and a flat ordered array of stages with stable ids does not — adding
// `additions?: …` later touches nothing, because `process` is an optional field on
// a greenfield collection with no migration. Phase 03 (ferments) and phase 04
// (cures) own that addition.
//
// Also not here, and not anywhere: scheduling, a clock, or any notion of "now".
// A stage says how long it takes, never when it starts. Phase 02 of the epic owns
// the schedule, on the batch, and it is a different document.

// ─── active vs wait ─────────────────────────────────────────────────────────────
//
// THIS DEFINITION IS THE POINT OF THE FIELD, and it is stated here and repeated
// verbatim in the extraction prompt so the two cannot drift. The spike labelled the
// bake differently on each of three bread recipes precisely because nothing said
// which side the oven falls on.
//
//   A `wait` is UNATTENDED CHANGE — the dough, the ferment or the oven changes on
//   its own and the cook can leave the room: bulk fermentation, proving, a fridge
//   retard, resting, curing, and an oven coming up to temperature.
//
//   An `active` stage is one the cook CARRIES OUT AND IS PRESENT FOR: mixing,
//   folding, shaping, and the bake itself.
//
//   THE BAKE IS `active`. THE PREHEAT IS `wait`.
//
// The list carries actives as well as waits because a schedule needs the active
// time BETWEEN the waits to land anywhere real — but a process with no waits at
// all is not worth storing, and the extraction flow returns nothing for one.
export const ProcessStageKindSchema = z.enum(['active', 'wait']);

// A DISCRIMINATED UNION, copying `StageDurationSchema` below rather than inventing
// a min/max pair (issue #1281). "Prove at 20 °C" was always a fiction — the real
// instruction is "somewhere between 22 and 26" — but a 240 °C oven means 240, and
// a range that collapses to a midpoint has thrown the recipe's own claim away for
// good, exactly as a 45–60 minute prove stored as 52.5 has.
export const StageTemperatureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), celsius: z.number() }),
  z.object({
    kind: z.literal('range'),
    minCelsius: z.number(),
    maxCelsius: z.number(),
  }),
]);

// Where the stage happens: counter 20 °C, fridge 4 °C, chamber 12 °C at 75% RH.
// `relativeHumidityPercent` is optional because only a curing chamber has an
// opinion about it; bread never sets it.
//
// NO LEGACY BRANCH for the pre-#1281 bare `{ celsius: n }`, and no migration
// either. A `z.union` carrying the old shape forever is code every future reader
// must understand; a migration script is code that runs once and then misleads.
// Neither was worth it here, because there was nothing to carry: the bread feature
// has never been released (it is behind the `bread` gate, see web-pwa's
// `featureGate.ts`), and the five documents that existed — one formula, three
// batches and one observation, all Daniel's own trials — were deleted from
// production on 2026-09-07 rather than migrated. `formulas` and `batches` were
// verified empty in prod, staging and dev at that point, so no stored document
// anywhere carries the bare-number shape and nothing needs to read it.
//
// This is why the ordering rule that governed #1122 does NOT apply to this branch:
// there is no "run the script first". If a bare `{ celsius: n }` ever turns up, it
// was hand-written after this date and belongs in a fixture, not in a union.
export const StageEnvironmentSchema = z.object({
  temperature: StageTemperatureSchema,
  relativeHumidityPercent: z.number().min(0).max(100).optional(),
  // The PLACE this stage is suggested to happen in — an `EquipmentItemDoc.id` from
  // `equipmentManifest/current`, or null for "at whatever the kitchen is". The
  // counter is not an equipment entry, so "nothing chosen" and "deliberately the
  // counter" are the same answer and behave identically.
  //
  // ONE-WAY, exactly as `stepId` is: an id here is a reference to a document this
  // one does not own, so a reader that cannot resolve it renders the temperature
  // alone and nothing breaks. The extraction flow drops an id the manifest does
  // not have rather than inventing an item.
  //
  // `.default(null)` because it is additive over the same documents the temperature
  // migration touches, and a stage authored before places existed named none.
  equipmentId: z.string().nullable().default(null),
});

// A DISCRIMINATED UNION rather than a min/max pair with fixed as the degenerate
// case, mirroring `ReferenceYieldSchema` in the same feature: this epic is careful
// about not silently collapsing a range. "Prove for 45–60 minutes" must still read
// as 45–60 an hour later, and a midpoint stored as a fixed 52.5 has thrown that
// away for good.
export const StageDurationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), minutes: z.number().positive() }),
  z.object({
    kind: z.literal('range'),
    minMinutes: z.number().positive(),
    maxMinutes: z.number().positive(),
  }),
]);

// ─── The stage ──────────────────────────────────────────────────────────────────
//
// The content half — what the extraction flow authors. No `id`: ids are
// document-local identity, minted by the write path (formulaService), exactly as
// `generateGuidedPlan` → `guidedPlanService` does for prep entries.
export const ProcessStageContentSchema = z.object({
  // "Bulk ferment", "Shape", "Preheat the oven", "Bake".
  label: z.string(),
  kind: ProcessStageKindSchema,
  // NULLABLE because a mix has no meaningful temperature, and a stage nobody
  // measured must not be given an invented one.
  environment: StageEnvironmentSchema.nullable(),
  // NULLABLE: a stage may be entirely observational ("until doubled").
  duration: StageDurationSchema.nullable(),
  // The observational completion criterion — "until doubled", "until it tastes
  // right", "until 30% weight loss". Nullable.
  until: z.string().nullable(),
  // The recipe step this stage came from. OPTIONAL AND ONE-WAY (see the epic doc):
  // nullable because an AI-added fridge retard corresponds to no step and a
  // hand-added rest corresponds to none either; one-way because two-way and the
  // batch starts writing back into the recipe.
  stepId: z.string().nullable(),
  // THE RECIPE'S OPINION, AND IT GATES NOTHING (issue #1275). True when the method
  // itself says the step may be left out — "optionally, brush the top with milk".
  // It is information: a run shows it as a chip so a year later you can tell the
  // stages the recipe sanctioned leaving out from the ones you decided about
  // yourself. EVERY stage is skippable regardless of this flag, and nothing
  // anywhere may branch on it to decide whether something is allowed. The obvious
  // inference — "optional ⇒ skippable, therefore required ⇒ not skippable" — is
  // wrong, and it is written here because it is the one a reader will make.
  //
  // A READ DEFAULT, not `.optional()`: live `formulas/{recipeId}` documents were
  // written without the key and must keep parsing (CLAUDE.md, production data
  // back-compat). `BatchStageSchema` inherits it through `ProcessStageSchema`, so
  // a batch frozen from a process carries the flag with no edit there.
  optional: z.boolean().default(false),
});

// NOTE the absence of a `.refine` forcing `duration` OR `until` to be present. It
// is tempting and it would be wrong: `formulas/{recipeId}` is read as ONE
// document, so a single stage left vague by a human would fail validation and take
// the whole formula screen down as a corruption Failure. Far too harsh a
// punishment for "I'll time it by eye". The duration helper simply skips a stage
// that has neither.
export const ProcessStageSchema = ProcessStageContentSchema.extend({
  // Document-local identity, minted by the write path. Load-bearing: it keys the
  // review rows, and it is what a future `additions` array would reference.
  id: z.string(),
});

export const ProcessSchema = z.array(ProcessStageSchema);

// ─── The extractProcessStages flow ──────────────────────────────────────────────

// The callable takes only the recipe id: the flow reads the recipe SERVER-SIDE via
// the Admin SDK, so the client cannot hand the model a recipe that is not the one
// in Firestore. Same posture as `generateGuidedPlan`.
export const ExtractProcessStagesInputSchema = z.object({
  recipeId: z.string().min(1),
});

// Content only — no ids, no timestamps. See `ProcessStageContentSchema`.
export const ExtractProcessStagesAIOutputSchema = z.object({
  stages: z.array(ProcessStageContentSchema),
});

export const ExtractProcessStagesOutputSchema = ExtractProcessStagesAIOutputSchema;

export type ProcessStageKind = z.infer<typeof ProcessStageKindSchema>;
export type StageTemperature = z.infer<typeof StageTemperatureSchema>;
export type StageEnvironment = z.infer<typeof StageEnvironmentSchema>;
export type StageDuration = z.infer<typeof StageDurationSchema>;
export type ProcessStage = z.infer<typeof ProcessStageSchema>;
export type Process = z.infer<typeof ProcessSchema>;
export type ExtractProcessStagesInput = z.infer<typeof ExtractProcessStagesInputSchema>;
export type ExtractProcessStagesOutput = z.infer<typeof ExtractProcessStagesOutputSchema>;
