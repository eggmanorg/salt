import type {
  BatchDoc,
  BatchQuantityDoc,
  BatchStageDoc,
  BatchStagePlace,
  BatchTotalsDoc,
} from '../schemas/index.js';
import type { Formula, ReferenceYield } from '../schemas/index.js';
import type { FormulaFailure } from '../formula/index.js';
import { solveFormula } from '../formula/index.js';
import type { ScheduleAnchor, ScheduleFailure } from '../process/index.js';
import { resolveSchedule } from '../process/index.js';

// Starting a run (issue #812, phase 1 of epic #778) — the one place a batch
// document is ever brought into existence.
//
// It is a FREEZE, not a read-through. The two live things a run depends on — the
// formula's percentages and the recipe's words — are resolved here, once, and
// copied onto the document: grams, totals, schedule, labels, title. Afterwards the
// batch answers for itself. Re-map the formula, rename the dish, delete the recipe
// outright: batch nine still says what batch nine was, which is the only reason a
// log of runs is worth keeping.
//
// PURE (CLAUDE.md Rule 1). Three things a pure function cannot produce are
// injected: the batch `id` (minted by `batchService`, the sole id-minter), the
// anchor, and `now`. Nothing here reads a clock or a random source.
//
// TOTAL: a formula that will not solve and a time that will not schedule are
// ordinary flow — somebody typed the percentages — so they come back as a typed
// failure in `solveFormula`'s register, never a throw.

export type FreezeBatchFailure =
  // A formula with no process has no stages, and a run with no stages has nothing
  // to run, nothing to remind about and nothing to show on the in-flight surface.
  // A fresh sausage is a formula you scale; it is not a batch you watch. This is
  // where that line is drawn, once, rather than in each screen.
  | { kind: 'noProcess' }
  // The percentages do not resolve into weights — an unnormalised basis, a bound
  // violation, an impossible yield. `solveFormula`'s own reason travels with it so
  // the caller can say which.
  | { kind: 'unsolvableFormula'; reason: FormulaFailure }
  // The stages will not sit on a clock at the anchor given.
  | { kind: 'unschedulable'; reason: ScheduleFailure };

export type FreezeBatchResult =
  { ok: true; batch: BatchDoc } | { ok: false; reason: FreezeBatchFailure };

export interface FreezeBatchInput {
  // Minted by the write path, never here: an id is identity, and identity is the
  // service's to hand out. Same split as `guidedPlanService` minting prep-entry ids.
  id: string;
  formula: Formula;
  // What this run makes — twelve rolls, or 2.4 kg of unwrapped meat. Defaults to
  // the formula's own reference yield, so "a batch of the recipe as written" and "a
  // batch of twelve rolls" are the same call with a different argument.
  atYield?: ReferenceYield;
  // What the run is being baked in, in the words the sheet built — "900 g loaf
  // tin". Copied onto the document UNTOUCHED and read by nothing: see
  // `BatchSchema.vessel`. Omitted for the two answers that name no vessel (a count
  // of pieces, a plain weight of dough).
  vessel?: string;
  // Where the run is nailed to the clock: mixing now, or out of the oven at 07:30.
  anchor: ScheduleAnchor;
  // Frozen onto the document. The title so the log survives a rename or a delete;
  // the labels — the recipe's own `rawText`, keyed by ingredient id — so the
  // quantities read as "Strong white flour 841 g" rather than as ids and numbers.
  recipeTitle: string;
  labels: Readonly<Record<string, string>>;
  // The schedule's worded reasoning, when a proposal authored it. Phase 1 passes
  // nothing and the field lands null: arithmetic has no opinion to record.
  rationale?: string | null;
  // WHERE EACH STAGE HAPPENS, already resolved against the equipment manifest by
  // the write path — the label and the figures, never an id to follow (issue
  // #1286). This function knows nothing about `equipmentManifest/current` and
  // cannot read it; resolution is `batchService`'s, exactly as the ingredient
  // labels are.
  //
  // POSITIONAL, aligned with `formula.process`, and that is safe by construction
  // rather than by convention: `resolveSchedule` places an ordered process on a
  // clock and returns one entry per stage IN ORDER (it fills
  // `new Array(stages.length)` by index), so entry `i` here is the stage the caller
  // meant. `tests/batch/freezeBatch.test.ts` pins the alignment.
  //
  // Shorter than the process, or omitted entirely, means the rest chose nowhere in
  // particular — which is what an untouched bake sheet means and what every run
  // before this field existed meant.
  places?: readonly (BatchStagePlace | null)[];
  // How warm the kitchen was, as the person starting the run typed it. Copied onto
  // the document and computed with by nothing — see `BatchSchema.ambientCelsius`.
  ambientCelsius?: number | null;
  // Injected ISO instant for `createdAt`/`updatedAt`.
  now: string;
}

/**
 * Resolve a formula and its process into a batch, and freeze the result.
 *
 * The stages are the formula's REFERENCE process, placed on the clock by
 * `resolveSchedule` — from the front if the anchor is a start, back-solved from the
 * end if it is a finish, in which case the last stage ends on the anchor to the
 * minute by construction.
 *
 * No actual times are stamped. A freeze records a plan; what actually happened is
 * observed later, one stage at a time, through `withStageAdvanced`.
 */
export function freezeBatch(input: FreezeBatchInput): FreezeBatchResult {
  const {
    id,
    formula,
    atYield,
    vessel,
    anchor,
    recipeTitle,
    labels,
    rationale,
    places,
    ambientCelsius,
    now,
  } = input;

  const process = formula.process ?? [];
  if (process.length === 0) return { ok: false, reason: { kind: 'noProcess' } };

  const solved = solveFormula(formula, atYield ?? formula.referenceYield);
  if (!solved.ok)
    return { ok: false, reason: { kind: 'unsolvableFormula', reason: solved.reason } };

  const scheduled = resolveSchedule(process, anchor);
  if (!scheduled.ok)
    return { ok: false, reason: { kind: 'unschedulable', reason: scheduled.reason } };

  const quantities: BatchQuantityDoc[] = solved.solution.components.map((component) => ({
    ingredientId: component.ingredientId,
    // An ingredient that has already left the recipe gets an empty label rather
    // than its id: a blank reads as "we no longer know what this was", which is
    // true, where an id reads as gibberish and a guess reads as a fact.
    label: labels[component.ingredientId] ?? '',
    percent: component.percent,
    grams: component.grams,
  }));

  const totals: BatchTotalsDoc = {
    basisGrams: solved.solution.basisGrams,
    totalGrams: solved.solution.totalGrams,
    usableGrams: solved.solution.usableGrams,
    units:
      solved.solution.units === null
        ? null
        : {
            count: solved.solution.units.count,
            unitDoughGrams: solved.solution.units.unitDoughGrams,
          },
  };

  // Nothing has been observed yet, and nothing has been decided against: a fresh run
  // starts with every stage not started (see `stageStatus`).
  const stages: BatchStageDoc[] = scheduled.stages.map((stage, index) => ({
    ...stage,
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    // Frozen, positionally, from what the caller resolved. Nothing here reads the
    // stage's own `environment.equipmentId`: an id on the process is a SUGGESTION
    // the recipe made, and the place a run actually used is the caller's answer.
    place: places?.[index] ?? null,
  }));

  return {
    ok: true,
    batch: {
      id,
      schemaVersion: 1,
      recipeId: formula.recipeId,
      recipeTitle,
      // Omitted rather than nulled when no vessel was named, so the field is simply
      // absent on the document — `BatchSchema.vessel` is optional, not nullable.
      ...(vessel === undefined ? {} : { vessel }),
      state: 'running',
      abandonedAt: null,
      quantities,
      totals,
      stages,
      rationale: rationale ?? null,
      ambientCelsius: ambientCelsius ?? null,
      // Nothing is weighed out and nothing is cooked yet (issue #1327). Written
      // explicitly rather than left to the schema's read default: this is the one
      // place a batch document is CONSTRUCTED, and a default is what a document
      // written before the field existed gets, not what a new one is born with.
      checkedIngredientIds: [],
      completedStepIds: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}
