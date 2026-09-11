import { z } from 'zod';
import { ProcessStageSchema, StageTemperatureSchema } from './process.js';

// Batch document schema (issue #812, phase 1 of epic #778) — ONE RUN of a formula
// at `batches/{batchId}`. Family-shared (no `ownerUid`), a random UUID id minted by
// `batchService`, whole-document last-write-wins.
//
// A batch is NOT a cook session and is deliberately not built on one: wrong
// ownership (a crock belongs to the household, not to whoever tapped Start), wrong
// lifetime (weeks or months, against one evening), wrong sharing. It is the object
// opened day to day; the formula is opened once a month.
//
// ─── EVERYTHING HERE IS FROZEN, AND THAT IS THE POINT ───────────────────────────
//
// The formula may be re-mapped tomorrow, the recipe retitled, an ingredient
// renamed, the whole dish deleted. A batch that read through to any of those would
// have its log rewritten under it — "batch nine at 78% hydration" would silently
// become whatever batch ten was mapped at, which makes the log worthless exactly
// when it is worth having. So the run freezes:
//
//   • the resolved quantities — ingredient id, LABEL, percent and grams;
//   • the resolved totals from the solve;
//   • the resolved schedule, stage by stage, with planned and actual times;
//   • the recipe's title;
//   • the worded rationale for the schedule (phase 2 authors it; phase 1 writes
//     null).
//
// LABELS AS WELL AS NUMBERS. "841 g of ing-7f3a" is not a record of anything a
// person can read a year later, so the recipe's own `rawText` is copied onto the
// quantity at freeze. A renamed or deleted recipe leaves the log intact.
//
// There is NO re-scaling and NO re-scheduling of a running batch, and no route to
// one anywhere in this feature. Freezing exists precisely to prevent versions: a
// batch you can rescale is a batch whose log no longer says what you did.
//
// Timestamps are ISO-8601 STRINGS throughout, matching `cookSession.endsAt` and
// `guidedPlan.createdAt` — not Firestore Timestamps (which would leak the SDK's
// type into the domain) and not epoch numbers (unreadable in the console).

// ─── The run's state ────────────────────────────────────────────────────────────
//
// TWO states, and the absences are deliberate.
//
// There is no `finished`: "every stage is done" is already answerable from the
// stages themselves (`currentStage` returns null), and a distinct terminal state
// only earns its place when something OTHER than the stage list decides it — a
// verdict, a yield, an observation that the cure hit 35%. That is phase 04's, and
// adding the literal here today would be a state nothing sets and every reader has
// to handle. Adding it later costs one line: `batches` is greenfield, and a widened
// enum parses every document already written.
//
// There is no `paused` either, for the same reason — nothing pauses a batch, and
// the honest way to stop one is to abandon it.
export const BatchStateSchema = z.enum(['running', 'abandoned']);

// ─── The frozen quantities ──────────────────────────────────────────────────────
//
// One entry per solved component, in the formula's own order. `percent` rides
// along beside `grams` because the percentage is what the baker reasons in ("70%
// hydration") and re-deriving it from grams later would depend on a basis this
// document does not carry.
export const BatchQuantitySchema = z.object({
  // FK into the recipe's `ingredients[].id` — kept so a live recipe can still be
  // joined against, never relied on for display.
  ingredientId: z.string(),
  // The recipe's `rawText` AS A LABEL, copied at freeze. "Strong white flour".
  // Empty when the ingredient had already left the recipe by the time the batch was
  // started: an empty label is honest, an invented one is not.
  label: z.string(),
  // Of the basis, as the formula stated it.
  percent: z.number().nonnegative(),
  // What you weigh, through the formula module's one rounding authority.
  grams: z.number().nonnegative(),
});

// What the dough divides into, echoed from the solve so a batch can still say
// "12 × 120 g" with no formula in hand. Null for a basis-driven solve: weighing the
// meat says nothing about how many of anything you end up with.
//
// No `label` and no baked figure (issue #1274). The label was there so a batch
// could name itself; `recipeTitle` already does that, from the recipe, without
// conflating what the thing IS with how much dough it took. The wire key `units`
// and the spelling `unitDoughGrams` are deliberately unchanged — see
// `DoughAmountSchema` for why deleting a field is read-compatible where renaming
// one is not.
export const BatchUnitsSchema = z.object({
  count: z.number().int().positive(),
  unitDoughGrams: z.number().positive(),
});

// The solve's headline figures, frozen. Rounded only: the exact floats exist so
// nothing re-derives and re-rounds mid-calculation, and there is no calculation
// left once the batch is written.
export const BatchTotalsSchema = z.object({
  basisGrams: z.number().nonnegative(),
  totalGrams: z.number().nonnegative(),
  usableGrams: z.number().nonnegative(),
  units: BatchUnitsSchema.nullable(),
});

// ─── The frozen schedule ────────────────────────────────────────────────────────
//
// A stage as the process declared it, PLUS where it lands on a clock. Extending
// `ProcessStageSchema` rather than restating four fields is what keeps the recipe's
// own claim intact on the run: a prove the recipe wrote as "45–60 minutes" still
// reads as 45–60 here, beside the single time the schedule had to commit to. See
// `resolveSchedule` for which end of a range that is, and why.
//
// PLANNED versus ACTUAL is the whole state machine. `planned*` is what the schedule
// said when it was resolved and is re-timed forward every time a stage is marked
// done early or late; `actual*` is what happened, and only ever what was observed —
// nothing here back-fills an actual from a planned time.
// A stage the cook decided not to do (issue #1275). A NULLABLE OBJECT rather than
// two loose fields, following `BatchObservationSchema.image`: a note is meaningless
// without a skip, and nesting makes that structural rather than a rule somebody has
// to remember (CLAUDE.md rule 12).
//
// `note` is the EMPTY STRING when there is none, never null — the same choice
// `BatchObservationSchema.note` already makes and for the same reason: a text
// input's absent state is already `''`, and a second absent value would mean every
// reader handling two spellings of "nothing typed".
//
// "Out of milk", "dough was already there", "second fold felt unnecessary". That
// sentence is what makes batch nine useful a year on, and it sits on the stage it
// explains rather than in the observation log, which is ordered by when a reading
// was observed and carries no stage reference.
export const StageSkipSchema = z.object({
  at: z.string(),
  note: z.string(),
});

// ─── Where a stage actually happened ────────────────────────────────────────────
//
// A FROZEN SNAPSHOT of the place the run used (issue #1286), following the rule the
// header states for quantities: the id AND the label, so renaming the dough proofer
// or deleting it outright leaves "batch nine proved in the dough proofer at 24 °C"
// readable a year later. `equipmentManifest/current` is a live document; a batch
// that read through to it would have its log rewritten under it.
//
// WHICH FIGURES ARE FROZEN depends on who owns the setting (`EquipmentControl`):
//
//   • `shared`    — the curing chamber holds three other things, so the setting
//     belongs to the CHAMBER. Its `standing` is copied here and the bake sheet
//     offers no per-batch setpoint at all. `temperature` is null when the chamber
//     has no standing setting recorded: nobody knows what it was at, and inventing
//     the figure the stage asked for would be a lie about a chamber the run did
//     not control.
//   • `dedicated` — the proofer holds one job, so the run dialled it in and what it
//     dialled in is the stage's own asked-for temperature.
//
// LIMIT, STATED (CLAUDE.md rule 12): this is a snapshot and nothing re-reads it.
// Moving a shared chamber from 12 °C to 14 °C mid-cure does NOT rewrite a running
// batch's frozen figure — a cure started at 12 still reads 12. The observation log
// is what carries reality; see `docs/formulas-schedules-batches.md`.
export const BatchStagePlaceSchema = z.object({
  // The `EquipmentItemDoc.id` this was resolved from. ONE-WAY, exactly as
  // `StageEnvironment.equipmentId` is: nothing follows it back, and an id whose
  // item has since been deleted still reads correctly because `label` is here too.
  equipmentId: z.string(),
  // The place's name at the moment the run started.
  label: z.string(),
  // What the place was set to, in the one spelling every surface renders
  // (`stageTemperatureText`) — fixed for a chamber standing at a figure, a range
  // when the stage asked for one. Null when nothing was known; see above.
  temperature: StageTemperatureSchema.nullable().default(null),
  relativeHumidityPercent: z.number().min(0).max(100).nullable().default(null),
});

export const BatchStageSchema = ProcessStageSchema.extend({
  plannedStartAt: z.string(),
  plannedEndAt: z.string(),
  // Null until observed. Stamped on the FOLLOWING stage when one is advanced (its
  // predecessor ending is it starting), and stamped DIRECTLY by `withStageStarted`
  // when the cook puts the oven on before the prove is finished (issue #1275). The
  // inferred stamp must never overwrite an observed one.
  actualStartAt: z.string().nullable(),
  // Null until the stage is marked done. This — not a `done` boolean — is what
  // says a stage is finished: one field, carrying both the fact and the time.
  actualEndAt: z.string().nullable(),
  // Null until the stage is skipped. Carries both the fact and the time, exactly as
  // `actualEndAt` does, plus the reason if one was given.
  //
  // ─── THE PRECEDENCE, STATED ONCE ────────────────────────────────────────────
  //
  //   skipped       != null  →  skipped
  //   actualEndAt   != null  →  done
  //   actualStartAt != null  →  in progress
  //   otherwise              →  not started
  //
  // There is deliberately NO stored `status` enum beside these three fields. Four
  // conditions fall out of them, and an enum would be a second source of truth that
  // a re-timing or a correction can contradict. `stageStatus` in
  // `batch/transitions.ts` is the one derivation, so no surface re-derives it.
  //
  // A read default, so every `batches/{batchId}` document written before this field
  // existed parses unchanged (CLAUDE.md, production data back-compat).
  skipped: StageSkipSchema.nullable().default(null),
  // WHERE THIS STAGE HAPPENED, frozen at start (issue #1286), and null for "at
  // whatever the kitchen is" — which is also what an unresolvable choice lands as,
  // because the counter is not an equipment entry and "nowhere in particular" is a
  // complete answer rather than a missing one.
  //
  // A read default, so every `batches/{batchId}` document written before this field
  // existed parses unchanged (CLAUDE.md, production data back-compat) — the same
  // shape `skipped` above has.
  place: BatchStagePlaceSchema.nullable().default(null),
});

export const BatchSchema = z.object({
  // Random UUID, equal to the doc id at `batches/{batchId}`. RANDOM, not derived
  // from the recipe: a recipe has many runs, which is the entire difference between
  // this collection and `formulas/{recipeId}`.
  id: z.string(),
  schemaVersion: z.literal(1),
  // FK to the recipe. May dangle — see `recipeTitle`.
  recipeId: z.string(),
  // The recipe's title, frozen. The log survives the dish being renamed or deleted.
  recipeTitle: z.string(),
  // WHAT THIS RUN WAS BAKED IN, as the person starting it described it — "900 g
  // loaf tin", "30 × 40 cm tray" (issue #1274). A SNAPSHOT NOTE and nothing else:
  // nothing parses it, nothing computes from it, and it never round-trips back
  // into an input. `recipeTitle` is the precedent.
  //
  // It lives here rather than inside `totals`, and it exists on a batch where it
  // deliberately does NOT exist on a formula. A formula's grams stay editable, so
  // a vessel stored beside them is a second number free to drift into a lie; a
  // batch's are stamped once by `freezeBatch` and never re-derived, so the vessel
  // and the grams it resolved to cannot disagree. `tests/batch/transitions.test.ts`
  // is what keeps that true as producers are added.
  //
  // ABSENT, not empty, when the run named no vessel: "1.4 kg of dough" is a
  // complete answer and an empty string would read as a vessel nobody described.
  vessel: z.string().optional(),
  state: BatchStateSchema,
  // WHEN the run was stopped, and null while it is still running (issue #1280).
  //
  // The run's OWN transition time, not `updatedAt`. `updatedAt` is the write path's
  // ordering token and moves every time anything on the document is written, so a
  // stage marked done an hour after the run was abandoned would carry the later
  // instant and the log would say the run stopped then. This field is stamped once,
  // by `withBatchAbandoned`, and nothing else touches it.
  //
  // Nothing back-fills it. A run abandoned before this field existed reads `null`,
  // and the log says nothing about when — which is the honest answer, because the
  // document never recorded one.
  //
  // A read default, so every `batches/{batchId}` document written before this field
  // existed parses unchanged and there is no migration (CLAUDE.md, production data
  // back-compat) — the same shape `BatchStageSchema.skipped` and
  // `BatchObservationSchema.stageId` both have.
  abandonedAt: z.string().nullable().default(null),
  quantities: z.array(BatchQuantitySchema),
  totals: BatchTotalsSchema,
  stages: z.array(BatchStageSchema),
  // The schedule's worded reasoning, as the proposal flow put it ("the retard is
  // long because you want the bake at 07:30, so the counter prove is cut to 20
  // minutes"). NULLABLE and always null in phase 1: nothing authors prose yet, and
  // a schedule resolved by pure arithmetic has no opinion to record.
  rationale: z.string().nullable(),
  // HOW WARM THE KITCHEN WAS when the run was started, as the person starting it
  // typed it (issue #1286). The one figure nobody can derive: Salt has an outdoor
  // forecast and no way at all to turn it into an indoor temperature without
  // inventing an offset, which is the same class of made-up coefficient the
  // fermentation-model ban exists to stop.
  //
  // It lives on the RUN rather than in a household setting because it is a fact
  // about a February evening, and a stored household figure would quietly still be
  // February's in July. Nothing computes with it: it is a fact on the record, and
  // an input to the schedule proposal the user reviews as a diff.
  //
  // Null when the question was skipped, which is always allowed.
  ambientCelsius: z.number().nullable().default(null),
  // ─── WHAT THE COOK HAS TICKED OFF, ON THE RUN (issue #1327) ─────────────────
  //
  // The batch cook page's two check-off lists: which of the frozen `quantities`
  // (and recipe-only ingredients) have been weighed out, and which of the LIVE
  // recipe's steps have been done.
  //
  // ON THE BATCH, NOT ON A COOK SESSION, AND DELIBERATELY FAMILY-SHARED. Two
  // people can have hands on one bake, and "the flour is weighed" is a fact about
  // the batch rather than about whoever weighed it — the same argument that
  // already put stage done/skip here. Everyone on the run sees everyone's ticks;
  // that is the intended behaviour, not a tolerated one. A `cookSessions`
  // document would be the wrong owner and the wrong lifetime
  // (docs/formulas-schedules-batches.md, "a batch is not a cook session").
  //
  // IDS ONLY, AND NOTHING VALIDATES THEM against the recipe or the quantities. An
  // ingredient edited out of the recipe leaves a tick behind, and a count is taken
  // over the rows ON SCREEN (`progressOver`), never over these lists — which is
  // what stops a stale tick inflating "6 of 5 weighed".
  //
  // Read defaults, so every `batches/{batchId}` document written before these
  // fields existed parses unchanged and there is no migration (CLAUDE.md,
  // production data back-compat) — the same shape `skipped`, `place` and
  // `abandonedAt` all have.
  checkedIngredientIds: z.array(z.string()).default([]),
  completedStepIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  // The ordering token for the write path's stale-echo guard, and the only reason
  // this document carries timestamps at all where `formulas` does not.
  updatedAt: z.string(),
});

// ─── The observation log ────────────────────────────────────────────────────────
//
// A SIBLING of BatchSchema, not a field on it: one document per observation at
// `batches/{batchId}/observations/{observationId}` — Salt's first purpose-built
// subcollection (the only precedent is `shoppingLists/{listId}/items`). Two facts
// force it, and neither is style:
//
//   • the log is APPEND-ONLY OVER WEEKS. A 90-day cure weighed twice a week is
//     ~26 entries on a document that is otherwise written only when a stage is
//     marked done;
//   • two people logging a weight on the same day MUST NOT clobber each other.
//     Salt is last-write-wins per document (see the data-model conventions), so an
//     array field means the second phone to sync silently erases the first
//     partner's entry. A subcollection makes that collision impossible: separate
//     documents, separate writes, no merge logic anywhere.
//
// FAMILY-SHARED like its parent — no `ownerUid`. The per-user collections are the
// short, closed list in CLAUDE.md's data-model conventions, and a reading off the
// household's own crock is not on it: either partner weighs the crock, and either
// partner needs to see what the other found.
//
// WHAT AN OBSERVATION IS: a measurement of a run at an instant. Weight, pH,
// temperature, a note, a photograph — the five the contract doc names, and nothing
// beyond them. Every measurement is NULLABLE and independently so, because a real
// log entry is usually one of them: "1,240 g" on Tuesday, "smells right, no mould"
// on Thursday. An entry carrying none of the five is still valid — the photograph
// or the note is usually the point — and nothing here judges that.
//
// It also carries WHICH PART OF THE RUN it is about (`stageId`, issue #1276). That
// is context for the reading and not a sixth measurement: "1,240 g" means one thing
// against the cure's second week and another against the day it comes out.
//
// WHAT IT IS NOT: an opinion. There is no "on track", no projected finish, no
// weight-loss percentage. Percentage-off-green-weight is arithmetic over the log
// and belongs to whatever renders it; a fermentation model is explicitly out
// (docs/formulas-schedules-batches.md, "what not to build").
export const BatchObservationImageSchema = z.object({
  // The Firebase Storage download URL of the photo, written by the
  // setObservationImageUpload callable. Never a data URL: the bytes go to Storage
  // through an auth-gated callable (the Admin SDK writes the object; storage.rules
  // stay `write: if false`), and only the URL lands in Firestore.
  url: z.string(),
  // Always 'upload' today, and a LITERAL rather than a bare marker so it reads the
  // same as `recipe.image.source`. An observation photo is one a person took in
  // their own kitchen; nothing generates one, and if anything ever does, the enum
  // is where it says so.
  source: z.literal('upload'),
});

export const BatchObservationSchema = z.object({
  // Random UUID, equal to the doc id — minted by the write path, never here
  // (CLAUDE.md Rule 1: the domain mints no ids).
  id: z.string(),
  schemaVersion: z.literal(1),
  // WHEN IT WAS OBSERVED, not when it was typed. This is the log's ORDER, and the
  // distinction is the whole reason it is a stored field rather than a server
  // timestamp: a weight read at eight in the morning and entered at nine belongs
  // where it was read. Arrival order would put a back-filled Tuesday reading after
  // Thursday's and quietly make the curve wrong.
  at: z.string(),
  // WHICH STAGE THE READING IS ABOUT, and `null` for one about the run as a whole —
  // the ordinary end-of-run entry ("108 g, good crumb") belongs to no single stage,
  // so "no stage" is a real answer here and not a missing one.
  //
  // THE ID, NOT THE LABEL. `BatchQuantitySchema` freezes an ingredient's `label`
  // because it points at a LIVE recipe that can be renamed or deleted under it. A
  // stage cannot: `batch.stages` is frozen on the very document this subcollection
  // hangs under, so resolving the label against it is a join that cannot go stale,
  // and copying the string would be a second source of truth for something the
  // freeze has already pinned.
  //
  // Nothing validates that the id names a stage of this run. It is a plain FK to a
  // frozen array, resolved at render, and an id that no longer resolves renders as
  // no stage rather than as an error — the same posture `recipeId` takes.
  //
  // A read default, so every observation written before this field existed parses
  // unchanged and there is no migration (CLAUDE.md, production data back-compat) —
  // the same shape `BatchStageSchema.skipped` has.
  stageId: z.string().nullable().default(null),
  // Grams on the scale — the cure's whole story, and the number a weight-loss
  // criterion would one day read. Null when the entry is a note or a photo.
  weightGrams: z.number().nonnegative().nullable(),
  // Bounded to the scale that exists: a strip or a probe cannot read outside 0–14,
  // so a value beyond it is a typo, not a measurement.
  ph: z.number().min(0).max(14).nullable(),
  // Degrees Celsius, and DELIBERATELY unbounded below zero — a freezer, a garage in
  // January and a chamber at 12 °C are all real places a batch sits.
  //
  // Carried since the log was built and written null until #1286, when the sheet
  // finally grew a box for it. Nothing about the field changed; it simply started
  // being answered.
  temperatureC: z.number().nullable(),
  // The humidity at the same instant (issue #1286), typed in by hand like the
  // temperature beside it. Nothing in the kitchen reports to a phone: if a Home
  // Assistant integration ever writes readings it writes observations exactly as a
  // person does, and nothing here changes.
  //
  // A bake rarely wants either figure; a cure wants both every week, which is why
  // they arrived together rather than humidity alone — a humidity box beside no
  // temperature box would be the odd half of a pair.
  //
  // A read default, so every observation written before this field existed parses
  // unchanged (CLAUDE.md, production data back-compat) — the same shape `stageId`
  // above has.
  relativeHumidityPercent: z.number().min(0).max(100).nullable().default(null),
  // Free text: "smells sweet, no mould", "cased today". Empty string, not null —
  // this is a text field whose absent state a text input already spells ''.
  note: z.string(),
  // Null until a photo is attached. The client writes the observation FIRST and the
  // callable stamps this on afterwards with a partial update, so the bytes never
  // travel through the document.
  image: BatchObservationImageSchema.nullable(),
});

export type BatchQuantityDoc = z.infer<typeof BatchQuantitySchema>;
export type BatchTotalsDoc = z.infer<typeof BatchTotalsSchema>;
export type StageSkip = z.infer<typeof StageSkipSchema>;
export type BatchStagePlace = z.infer<typeof BatchStagePlaceSchema>;
export type BatchStageDoc = z.infer<typeof BatchStageSchema>;
export type BatchDoc = z.infer<typeof BatchSchema>;
export type BatchObservationDoc = z.infer<typeof BatchObservationSchema>;
