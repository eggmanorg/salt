import {
  subscribeBatches,
  subscribeBatch,
  saveBatch as saveBatchDoc,
  callProposeSchedule,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import type {
  BatchDoc,
  BatchStagePlace,
  EquipmentItemDoc,
  Formula,
  ProcessStage,
  ProposedStage,
  ProposeScheduleInput,
  ProposeScheduleOutput,
  ReferenceYield,
  SaltProduct,
} from '@salt/domain/schemas';
import type { FormulaFailure, FreezeBatchFailure, Recipe, ScheduleAnchor } from '@salt/domain';
import {
  CURE_SALT_PRODUCTS,
  flattenIngredients,
  freezeBatch,
  withBatchAbandoned,
  withBatchIngredientChecked,
  withBatchStepDone,
  withStageAdvanced,
  withStageSkipped,
  withStageStarted,
} from '@salt/domain';
import { auth } from './auth.svelte.js';
import { describeBoundViolation } from './boundViolation.js';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { ErrorCode, failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';

// Batch service (issue #812, phase 1 of epic #778). Stores over the firebase-sync
// subscriptions, and the ONE WRITE PATH for `batches/{batchId}`.
//
// It is also the SOLE ID-MINTER. A run's id is a random UUID and it is minted here,
// exactly once, at the moment the batch is frozen — the same split guidedPlanService
// makes for prep-entry ids and formulaService makes for stage ids. The domain is
// pure and cannot mint one; a screen that minted one could mint two. Phase 2 adds
// the second thing this mints and for the identical reason: a proposal authors
// STAGE CONTENT and no ids (`ProposedStageSchema`), so the stages of a restructured
// schedule get theirs here, on the way into the freeze. See `mintStage`.
//
// Everything that needs a CLOCK lives here too, and nowhere else in the feature.
// `freezeBatch` takes `now` and the anchor; `withStageAdvanced` takes the instant
// the stage finished; `persist` stamps `updatedAt`. The domain never reads a clock
// (CLAUDE.md Rule 1), which is what makes every one of its tests a fixed string.
//
// TWO SUBSCRIPTIONS, because the collection has two consumers with different needs:
// the in-flight surface wants every run at once, and a run's own screen wants one
// document and must survive that document being corrupt (see batchSync.ts). They
// are independent — a page opens whichever it needs and disposes the unsub it got.

// ─── Reactive stores ────────────────────────────────────────────────────────────

// The whole collection. TWO states only (`undefined` = not loaded, then an array):
// an empty list IS the loaded-and-nothing-running state, so there is no third case
// to distinguish.
const _batches = writable<BatchDoc[] | undefined>(undefined);
export const batches: Readable<BatchDoc[] | undefined> = _batches;

// One run. THREE states, the split guidedPlanService and formulaService use:
// `undefined` = not loaded yet, `null` = loaded and there is no such batch (a link
// to a deleted run), a doc = the run.
const _batch = writable<BatchDoc | null | undefined>(undefined);
export const batch: Readable<BatchDoc | null | undefined> = _batch;

/** Synchronous snapshot, for handlers that must read the freshest run. */
export function getBatchSnapshot(): BatchDoc | null | undefined {
  return get(_batch);
}

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Snapshot guards (single-doc store only) ────────────────────────────────────
//
// Newest `updatedAt` we have applied locally for the current run. A batch DOES carry
// `updatedAt` (unlike a formula), so it can take guidedPlanService's stale-echo
// guard as well as the pending-write one: an in-flight snapshot from before a local
// advance must not land afterwards and put the stage back.
let latestLocalEdit: { id: string; updatedAt: string } | null = null;

// Count of our own writes Firestore has not yet acknowledged. An ABSENCE cannot be
// trusted while one is outstanding: it may have been queued before the write reached
// the local cache, and applying it would tell the screen the run does not exist
// moments after it was started. The write supersedes the absence either way (on
// success Firestore re-emits the document; on failure the optimistic copy is kept so
// a dropped connection never silently un-marks a stage), so a swallowed absence is
// dropped rather than replayed.
let pendingWrites = 0;

function applySnapshot(incoming: BatchDoc | null): void {
  if (incoming === null) {
    if (pendingWrites > 0) return; // keep the optimistic copy; see above
    _batch.set(null);
    return;
  }
  const local = latestLocalEdit;
  if (local && local.id === incoming.id && incoming.updatedAt < local.updatedAt) {
    // Stale echo: our local copy is newer — ignore it.
    return;
  }
  latestLocalEdit = { id: incoming.id, updatedAt: incoming.updatedAt };
  _batch.set(incoming);
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

/**
 * Subscribe to every batch — the in-flight surface's store. Returns the unsub.
 *
 * No optimistic guard here: the list is a projection for reading, every write goes
 * through the single-document path, and a list snapshot that briefly lags a local
 * advance shows a stage boundary a second early rather than losing anything.
 */
export function initBatchesSync(): () => void {
  _batches.set(undefined);
  const errors = getErrorReporter();
  return subscribeBatches(
    (incoming) => _batches.set(incoming),
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );
}

/**
 * Subscribe to ONE run. Resets the store to the not-loaded state first so moving
 * between runs never shows the previous one.
 */
export function initBatchSync(batchId: string): () => void {
  _batch.set(undefined);
  latestLocalEdit = null;
  return subscribeBatch(
    batchId,
    (incoming) => applySnapshot(incoming),
    (err, rawError) => {
      // Includes the corruption case the adapter reports rather than swallowing.
      // The store is left exactly as it was, so the screen keeps whatever it was
      // showing instead of offering to start the run again.
      reportSubscriptionError(getErrorReporter(), err, rawError);
    },
  );
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// Stamp `updatedAt`, update the single-doc store optimistically, then persist the
// whole document. Private: every public command goes through here, which is what
// keeps the timestamp and the optimistic guard in one place.
async function persist(next: BatchDoc): Promise<ReadResult<BatchDoc, DomainError>> {
  const stamped: BatchDoc = { ...next, updatedAt: new Date().toISOString() };
  latestLocalEdit = { id: stamped.id, updatedAt: stamped.updatedAt };
  _batch.set(stamped);
  pendingWrites += 1;
  try {
    const result = reportIfFailed(getErrorReporter(), await saveBatchDoc(stamped));
    if (result.kind !== 'ok') return result;
    return success(stamped);
  } finally {
    pendingWrites -= 1;
  }
}

/**
 * Ask for a schedule that lands at a time (issue #812, phase 2 of epic #778).
 *
 * READ-ONLY, and the ONLY call in this feature that is. It writes nothing, mints
 * nothing and starts nothing: what comes back is a proposal to be reviewed as a
 * diff, and the user's Start is what creates a batch — so declining costs exactly
 * one wasted model call and leaves no trace anywhere.
 *
 * AND IT IS NOT KEPT ANYWHERE EITHER (issue #1428, epic #1417). The answer lives in
 * the sheet's component state, which survives a close — the sheet unmounts with the
 * recipe page, not with `open` (`RecipeViewPage.svelte:2870`) — so what actually
 * forgets it is a suspended phone, navigating away from the recipe, or the sheet's
 * own re-seed on the next open edge (`RecipeBakeBatchSheet.svelte`'s `seed()`), all
 * with no error and no trace. Deliberate, and not the fault #1416 fixed: Start is a
 * hard gate in `endAt` mode, so what a suspend costs is a suggestion and one capped
 * `pro` call (19–31 s) with the person still in front of
 * the button that re-asks — never work this app had already done on their behalf.
 * Hard rule 3 rules out browser storage anyway, and it would not survive an OS
 * killing the process. The reasoning is at the callable
 * (`apps/cloud-functions/src/index.ts`); the decision and its boundary are in
 * docs/formulas-schedules-batches.md → "Review a diff, store a snapshot".
 *
 * The model authors ONCE, here, before the batch exists. Nothing re-calls it while
 * the dough is proving and nothing re-calls it to re-render the review; the diff is
 * `diffProcess` over the answer already in hand. That is this epic's whole AI
 * posture (docs/formulas-schedules-batches.md) and it is why this function has no
 * business being reachable from a running run.
 *
 * `quietHours` is deliberately not passed: the flow defaults to 23:00–06:00 and
 * there is no settings surface for it, so sending nothing is sending the truth
 * rather than a client-side copy of a server-side default.
 *
 * The adapter never throws (Rule 10). A NetworkError is not reported to PostHog and
 * the categories that are, are — `reportIfFailed` decides, by category, exactly as
 * it does for every write here.
 */
export async function proposeSchedule(
  input: ProposeScheduleInput,
): Promise<ReadResult<ProposeScheduleOutput, DomainError>> {
  return reportIfFailed(getErrorReporter(), await callProposeSchedule(input));
}

export interface StartBatchInput {
  recipe: Recipe;
  formula: Formula;
  // What this run makes. Omitted → the formula's own reference yield, i.e. the
  // recipe as written.
  atYield?: ReferenceYield;
  // What tonight's run is being baked in, as the sheet worded it — "900 g loaf
  // tin". Omitted for the answers that name no vessel. Frozen onto the batch as a
  // snapshot note and read back by nothing: see `BatchSchema.vessel`.
  vessel?: string;
  // WHICH CURING SALT ACTUALLY WENT ON, when it was not the one the recipe asked for
  // (issue #1402, phase 3). Omitted for every run that used what the recipe named.
  //
  // THE FORMULA ABOVE IS ALREADY THE SUBSTITUTED ONE — the sheet runs
  // `withCureSaltSubstituted` and previews the result, so the percentages that reach
  // the freeze are the ones that were on screen. This field is the NOTE beside them,
  // plus the one thing the percentages cannot say: which product was replaced.
  cureSaltSubstitution?: { from: SaltProduct; to: SaltProduct };
  // Mixing now, or out of the oven at 07:30.
  anchor: ScheduleAnchor;
  // A reviewed proposal's RESTRUCTURED PROCESS (issue #812, phase 2). Omitted →
  // the formula's own reference process, which is phase 1 and still the common
  // case. When present it REPLACES the reference process for this run only: the
  // formula document is never touched, so the weekly loaf keeps its ninety-minute
  // bulk however many overnight runs are scheduled off it.
  //
  // Content-only and ID-LESS by construction (`ProposedStageSchema` carries no
  // `id`), which is why this is the layer that takes it — see `startBatch`.
  proposedStages?: readonly ProposedStage[];
  // Why the schedule is shaped the way it is, in the words the proposal used.
  // Phase 1 passes nothing and the field lands null: arithmetic has no opinion.
  rationale?: string | null;
  // WHERE EACH STAGE HAPPENS, as ids the sheet's pickers hold — positional over the
  // process this run will actually be frozen from (issue #1286). `null` at a
  // position means nowhere in particular, which is the counter and is a complete
  // answer: the counter is deliberately not an equipment entry.
  //
  // The sheet renders one picker per stage of that same effective process — the
  // formula's own, or a reviewed proposal's — so the alignment is the one the user
  // was looking at. Omitting the array entirely is what an untouched sheet means.
  stagePlaceIds?: readonly (string | null)[];
  // The equipment manifest to resolve those ids against, passed in rather than read
  // from `equipmentService` here. The store is already open app-wide (App.svelte),
  // the sheet is holding it to draw the pickers, and taking it as an argument keeps
  // this service's dependencies as they were and its resolution directly testable.
  equipment?: readonly EquipmentItemDoc[];
  // How warm the kitchen is, as the person starting the run typed it. Null when the
  // question was skipped, which is always allowed.
  ambientCelsius?: number | null;
}

/**
 * One picked id, resolved into the frozen snapshot the batch keeps.
 *
 * WHICH FIGURES ARE FROZEN follows `EquipmentControl`, and this is the one place
 * that decision is made: a `shared` chamber's setting belongs to the chamber, so
 * its `standing` is copied and the sheet offers no per-batch setpoint at all; a
 * `dedicated` place holds one job, so what the run dialled in is what the stage
 * itself asked for. See `BatchStagePlaceSchema` for why, and for the limit.
 *
 * AN UNRESOLVABLE ID IS DROPPED AND THE STAGE IS KEPT — an item deleted between the
 * sheet opening and Start, or an entry that is not a place at all. That is the same
 * one-way treatment `StageEnvironment.equipmentId` already states and the same shape
 * `mintStage` uses for `sourceStageId`: a reference this document does not own is
 * never allowed to fail a run.
 */
function resolvePlace(
  equipmentId: string | null,
  stage: ProcessStage,
  equipment: readonly EquipmentItemDoc[],
): BatchStagePlace | null {
  if (equipmentId === null) return null;
  const item = equipment.find((candidate) => candidate.id === equipmentId);
  const environment = item?.environment ?? null;
  if (item === undefined || environment === null) return null;
  if (environment.control === 'shared') {
    const standing = environment.standing;
    return {
      equipmentId: item.id,
      label: item.name,
      // Null when the chamber has no standing setting recorded: nobody knows what
      // it was at, and writing the figure the stage asked for would claim a
      // setpoint this run never controlled.
      temperature: standing === null ? null : { kind: 'fixed', celsius: standing.celsius },
      relativeHumidityPercent: standing?.relativeHumidityPercent ?? null,
    };
  }
  return {
    equipmentId: item.id,
    label: item.name,
    temperature: stage.environment?.temperature ?? null,
    relativeHumidityPercent: stage.environment?.relativeHumidityPercent ?? null,
  };
}

// A proposed stage becomes a real one HERE, and nowhere else: identity is minted by
// the write path, exactly as this service mints the batch's own id and as
// formulaService mints ids for extracted stages.
//
// `sourceStageId` is deliberately dropped. It is a CLAIM about where the stage came
// from, made so `diffProcess` could match the two sides for review — and the review
// is over by the time this runs. Freezing a provenance note onto a run would invite
// something later to follow it back to a reference process that has since been
// re-mapped, which is the one thing a frozen batch exists to prevent.
function mintStage(stage: ProposedStage): ProcessStage {
  return {
    id: crypto.randomUUID(),
    label: stage.label,
    kind: stage.kind,
    environment: stage.environment,
    duration: stage.duration,
    until: stage.until,
    stepId: stage.stepId,
    // Carried, not re-decided. `optional` is a fact about the RECIPE (issue #1275)
    // and a restructure is not a rewrite of the recipe: a milk wash the method
    // called optional is still optional after the bulk moves to the fridge.
    optional: stage.optional,
  };
}

/**
 * The formula a run started from an ACCEPTED PROPOSAL is actually frozen from: the
 * proposed stages minted into real ones, and the components' stage assignments
 * rewritten onto the new ids.
 *
 * WHY THE REWRITE EXISTS, and it is the one thing here that would fail silently
 * (issue #1405). `mintStage` gives every stage a brand-new id, so a component's
 * `stageId` — which names a stage of the REFERENCE process — points at nothing the
 * moment a proposal is accepted. Without this, every addition would quietly land at
 * the start on precisely the runs a cure is most likely to use, and it would be
 * invisible: "at the start" is exactly what a formula that never assigned anything
 * looks like. `tests/batchServiceStages.test.ts` is what goes red if this is removed.
 *
 * This USES `sourceStageId`; it does not freeze it. `mintStage`'s comment objects to
 * storing a provenance claim on a run, and nothing about that objects to reading one
 * during the write — the map is built and discarded here.
 *
 * THE FIRST CITATION WINS, and that is a real choice rather than a tidy-up.
 * `ProposedStageSchema`'s header is explicit that two proposed stages may cite the
 * same reference stage — a ninety-minute bulk becoming twenty on the counter and
 * eight in the fridge — so the map is not one-to-one. An ingredient is added once, so
 * it goes in at the EARLIEST of the stages that split out of the one it named, which
 * is when the cook would actually add it. Pinned, not merely stated.
 *
 * A stage the restructure DROPPED maps to nothing, and the component reads as at the
 * start — the same fallback as everywhere else in this feature.
 */
function restructured(formula: Formula, proposed: readonly ProposedStage[]): Formula {
  const minted = proposed.map(mintStage);
  const newIdBySourceId = new Map<string, string>();
  proposed.forEach((stage, index) => {
    const source = stage.sourceStageId;
    if (source !== null && !newIdBySourceId.has(source)) {
      newIdBySourceId.set(source, minted[index]!.id);
    }
  });
  return {
    ...formula,
    process: minted,
    components: formula.components.map((component) =>
      component.stageId === null
        ? component
        : { ...component, stageId: newIdBySourceId.get(component.stageId) ?? null },
    ),
  };
}

// Why a run could not be started, in words. The typed reason stays in the domain
// (`freezeBatch` returns it); what crosses to a screen is a ValidationError with a
// sentence, because every one of these is something the user can act on and none of
// them is worth reporting to PostHog.
function describeFreezeFailure(
  reason: FreezeBatchFailure,
  labels: Readonly<Record<string, string>>,
): string {
  switch (reason.kind) {
    case 'noProcess':
      return 'This recipe has no stages yet, so there is nothing to schedule. Add its process on the formula screen first.';
    case 'unsolvableFormula':
      return describeUnsolvableFormula(reason.reason, labels);
    case 'unschedulable':
      return 'That time could not be turned into a schedule.';
  }
}

// Why the freeze could not resolve the formula into weights.
//
// The BOUND VIOLATION wording moved to `lib/boundViolation.ts` (issue #1402), where
// the two screens can reach it: a cure salt outside its product's window refuses the
// save AND the start, and one safety sentence with three copies is three sentences.
// What stays here is the tail, which is genuinely this surface's — a bake sheet can
// suggest asking for a different time, and the formula screen is already where you
// would be sent.
//
// Nothing on the way here re-tests the bounds; the rail is `solveFormula`'s and this
// only reads its answer out loud.
function describeUnsolvableFormula(
  reason: FormulaFailure,
  labels: Readonly<Record<string, string>>,
): string {
  if (reason.kind !== 'boundViolation') {
    return `The formula could not be resolved into weights (${reason.kind}).`;
  }
  return `${describeBoundViolation(reason, (id) => labels[id])} Ask for a different time, or set the percentages yourself on the formula screen.`;
}

/**
 * Start a run. THE ONLY PLACE A BATCH IS CREATED.
 *
 * Mints the id, joins the recipe's words to the formula's numbers, and hands both
 * to the pure freeze. What lands in Firestore is a snapshot: re-map the formula
 * tomorrow, rename or delete the dish, and this run still says what it was.
 *
 * The labels are the recipe's own `rawText`, keyed by ingredient id — read once,
 * here, so no other caller has to know that the join exists.
 *
 * A reviewed proposal arrives as `proposedStages` and is substituted into the
 * formula ON THE WAY PAST — a local object, never a write. `freezeBatch` reads
 * `formula.process` and is left exactly as phase 1 wrote it, which keeps the
 * question "which process does this run use?" answered in one place instead of two.
 */
export async function startBatch(
  input: StartBatchInput,
): Promise<ReadResult<BatchDoc, DomainError>> {
  const labels: Record<string, string> = {};
  for (const ingredient of flattenIngredients(input.recipe)) {
    labels[ingredient.id] = ingredient.rawText;
  }

  // A SUBSTITUTED LINE IS LABELLED WITH WHAT WENT ON IT (issue #1402, phase 3).
  // "2.5 g Prague powder #1" is the recipe's word for a product this run did not
  // use, so the frozen quantity would otherwise read as 26 g of a cure #1 nobody
  // opened — every screen that shows a run's quantities reads this label, and the
  // weight beside it is the substitute's.
  //
  // FOUND BY THE PRODUCT, not by an id the caller also has to pass: the substituted
  // formula names `to` on exactly one component, because `withCureSaltSubstituted`
  // only ever produces one and refuses a formula carrying more than one curing salt.
  const substitution = input.cureSaltSubstitution;
  if (substitution !== undefined) {
    const swapped = input.formula.components.find(
      (component) => component.saltProduct === substitution.to,
    );
    if (swapped !== undefined)
      labels[swapped.ingredientId] = CURE_SALT_PRODUCTS[substitution.to].label;
  }

  const formula: Formula =
    input.proposedStages === undefined
      ? input.formula
      : restructured(input.formula, input.proposedStages);

  // Resolved HERE, against the manifest, so what reaches the pure freeze is labels
  // and figures rather than ids to follow — the same split the ingredient labels
  // above already make.
  const equipment = input.equipment ?? [];
  const stagePlaceIds = input.stagePlaceIds ?? [];
  const places: (BatchStagePlace | null)[] = (formula.process ?? []).map((stage, index) =>
    resolvePlace(stagePlaceIds[index] ?? null, stage, equipment),
  );

  const frozen = freezeBatch({
    id: crypto.randomUUID(),
    formula,
    ...(input.atYield === undefined ? {} : { atYield: input.atYield }),
    ...(input.vessel === undefined ? {} : { vessel: input.vessel }),
    ...(substitution === undefined ? {} : { cureSaltSubstitution: substitution }),
    anchor: input.anchor,
    recipeTitle: input.recipe.title,
    // What the dish WAS, frozen beside its title (issue #1404). Read off
    // `input.recipe` exactly as the title above is — the freeze is pure and holds
    // no recipe, so the join lives here.
    recipeKind: input.recipe.kind,
    cureCategory: input.recipe.cureCategory,
    // WHO TAPPED START (issue #1406) — read here for the reason every other live fact
    // is: the freeze is pure and holds no session. `?? null` rather than `?? ''`,
    // unlike `shoppingDayService`'s `setBy`, because "nobody recorded a starter" is a
    // real answer the weekly nudge has to be able to read, and an empty string would
    // be a second spelling of it. AUDIT ONLY, and never a gate on who may open, edit
    // or abandon this run — see `BatchSchema.startedBy`.
    startedBy: auth.user?.uid ?? null,
    labels,
    places,
    ambientCelsius: input.ambientCelsius ?? null,
    // Phase 1 schedules by arithmetic, and arithmetic has no reasoning to record.
    // A phase-2 proposal passes the words it used.
    rationale: input.rationale ?? null,
    now: new Date().toISOString(),
  });
  if (!frozen.ok) {
    return failure({
      kind: 'ValidationError',
      code: ErrorCode.BATCH_NOT_STARTABLE,
      message: describeFreezeFailure(frozen.reason, labels),
    });
  }

  // The new run becomes the single-doc store's value immediately, so the screen
  // that started it can navigate straight to it without waiting for a round trip.
  return persist(frozen.batch);
}

/**
 * Mark a stage done, now.
 *
 * The clock is read HERE and passed in, which is why the re-timing it triggers is a
 * pure function with a fixed answer. Marking a stage done re-times everything after
 * it — see `withStageAdvanced`.
 *
 * A no-op producer (unknown stage, batch not running) still persists, harmlessly:
 * the document written is the one already held, and refusing would mean this
 * service second-guessing a producer that is deliberately total.
 */
export async function advanceStage(
  current: BatchDoc,
  stageId: string,
): Promise<ReadResult<BatchDoc, DomainError>> {
  return persist(withStageAdvanced(current, stageId, new Date().toISOString()));
}

/**
 * Mark a stage STARTED, now — without marking it done (issue #1275).
 *
 * The oven goes on before the prove finishes, so both read as in progress and each
 * is marked done when it actually ends. RE-TIMES NOTHING: `withStageStarted` records
 * what happened and leaves the plan alone.
 *
 * The clock is read HERE and passed in, as it is for `advanceStage`, so the producer
 * stays pure with a fixed answer.
 */
export async function startStage(
  current: BatchDoc,
  stageId: string,
): Promise<ReadResult<BatchDoc, DomainError>> {
  return persist(withStageStarted(current, stageId, new Date().toISOString()));
}

/**
 * SKIP a stage, now, with an optional reason.
 *
 * Available on every stage, `optional` or not, and this service holds no opinion
 * about which: there is no gate here and no confirmation — Salt records what
 * happened in the kitchen. A skip pulls the rest of the schedule forward exactly as
 * marking the stage done would, through the same producer path and the same
 * whole-document write.
 *
 * `note` is optional and defaults to nothing; the producer trims it and stores the
 * empty string, never null.
 */
export async function skipStage(
  current: BatchDoc,
  stageId: string,
  note: string = '',
): Promise<ReadResult<BatchDoc, DomainError>> {
  return persist(withStageSkipped(current, stageId, new Date().toISOString(), note));
}

/**
 * Tick (or untick) one row of the batch cook page's weigh-out (issue #1327).
 *
 * NO CLOCK AND NO STAGE. Unlike the three commands above, this records nothing
 * about the run's progress through its schedule: it is the family's shared memory
 * of what is already on the bench. `persist` still stamps `updatedAt`, because
 * every write to this document does.
 *
 * IDENTITY MEANS NO WRITE, and it is checked here rather than left to the
 * producer's caller: a cook page re-rendering off a Firestore echo would otherwise
 * write the document it has just received straight back.
 */
export async function setIngredientChecked(
  current: BatchDoc,
  ingredientId: string,
  checked: boolean,
): Promise<ReadResult<BatchDoc, DomainError>> {
  const next = withBatchIngredientChecked(current, ingredientId, checked);
  if (next === current) return success(current);
  return persist(next);
}

/**
 * Mark (or unmark) one recipe step done on the run (issue #1327).
 *
 * The sibling of `setIngredientChecked`, and the same contract — including the
 * identity short-circuit. NOT the same thing as marking a STAGE done: a step of
 * the recipe's method is not a stage of the schedule, and the cook page calls
 * `advanceStage` as well when the step it ticks carries one.
 */
export async function setStepDone(
  current: BatchDoc,
  stepId: string,
  done: boolean,
): Promise<ReadResult<BatchDoc, DomainError>> {
  const next = withBatchStepDone(current, stepId, done);
  if (next === current) return success(current);
  return persist(next);
}

/**
 * Stop a run. A state, not a delete — the log of how far it got is the point.
 *
 * The clock is read HERE and passed in, as it is for `advanceStage` (issue #1280):
 * the run records WHEN it was abandoned, and `updatedAt` cannot answer that because
 * it moves on every later write.
 */
export async function abandonBatch(current: BatchDoc): Promise<ReadResult<BatchDoc, DomainError>> {
  return persist(withBatchAbandoned(current, new Date().toISOString()));
}
