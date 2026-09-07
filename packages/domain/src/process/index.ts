// Process module (issue #806, phase 2 of epic #778) — the ordered stages a dough,
// a ferment or a cure goes through. The shape lives in `schemas/process.ts`; this
// module is the arithmetic and the edits over it.
//
// Flat lightweight variant of the domain module pattern (see
// docs/domain-implementation.md), matching `formula`, `shoppingDay` and `weather`:
// no entities/ports/commands/queries subfolders, because there is nothing to write
// and no infrastructure to abstract. This file is the module's only public
// surface.
//
// SCHEDULING HAS NOW ARRIVED (issue #812), and it is here rather than in `batch/`
// on purpose: placing an ordered process on a clock is a fact about the PROCESS,
// and the batch is only its first customer. There is still no notion of "now" — the
// anchor is passed in, from either end, exactly as the contract doc's placement
// table has it ("forward + backward schedule — pure; 'now' injected").
//
// `diffProcess` HAS NOW ARRIVED TOO, with its consumer exactly as promised: the
// proposal flow (#812 phase 2) restructures a process, and a restructure is only
// reviewable as a diff. It is pure in the strictest sense — BOTH sides are
// arguments, so it can never reach for "the current process" — and it produces the
// never-persisted render contract in `processDiff.ts` beside it.
export { withStageAdded, withStageRemoved, withStageUpdated, withStageMoved } from './stages.js';
export { totalDurationMinutes } from './totalDuration.js';
export type { DurationRange } from './totalDuration.js';
export { resolveSchedule } from './resolveSchedule.js';
export type {
  ScheduleAnchor,
  StageSchedule,
  ScheduleFailure,
  ResolveScheduleResult,
} from './resolveSchedule.js';
export { diffProcess } from './diffProcess.js';
export type { ProcessStageDiffEntry, ProcessStageChange, ProcessDiff } from './processDiff.js';
// Which stages are worth a notification (#812 phase 3). Here rather than in
// `batch/` for the same reason `resolveSchedule` is: it is a fact about the shape
// of a PROCESS — where the unattended periods end — and the batch is only its
// first customer. No clock, no schema field, and nothing about elapsed time.
export { remindableStages } from './remindableStages.js';
// The one spelling of a stage temperature (issue #1281) — four surfaces render it.
export { stageTemperatureText } from './stageTemperature.js';
// Whether a place covers what a stage asks for (issue #1286). A comparison, never a
// conversion — it produces a note on the bake sheet and nothing else.
export { placeReachesTemperature } from './placeReachability.js';
