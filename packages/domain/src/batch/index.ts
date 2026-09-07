// Batch module (issue #812, phase 1 of epic #778) — ONE RUN of a formula: what was
// weighed, when each stage lands, and how far it has got.
//
// The load-bearing decision of the whole epic is that this is first-class. Skip it
// and bread scaling degenerates into optional fields on a recipe with nowhere for
// the day-to-day UX to live; build it and the ferments and cures of phases 03/04
// are the same document with a longer clock.
//
// Flat lightweight variant of the domain module pattern (see
// docs/domain-implementation.md), matching `formula`, `process`, `shoppingDay` and
// `weather`: no entities/ports/commands/queries subfolders, because there is
// nothing to abstract — this module holds a resolver and three producers. This file
// is its only public surface.
//
// Pure, and every instant is INJECTED (CLAUDE.md Rule 1): `freezeBatch` takes the
// anchor and `now`, `withStageAdvanced` takes the instant the stage finished.
// Nothing here reads a clock, mints an id, or decides that time has passed.
//
// DELIBERATELY ABSENT:
//
//   • Rescaling and rescheduling. There is no producer that changes a quantity or
//     re-anchors a running batch, and that is the feature: freezing exists to stop
//     a run growing versions, and a batch you can rescale no longer records what
//     you did.
//   • A producer for OBSERVATIONS, which phase 04 has now built — and deliberately
//     built without one. An observation is a document in a subcollection
//     (`batches/{batchId}/observations/{id}`, see BatchObservationSchema), so there
//     is no batch document to return a new version of, and the only candidate
//     producer — "append this entry to the log I am holding" — is `[...log, entry]`
//     with a domain import in front of it. docs/domain-implementation.md is explicit
//     that a module earns its place by holding a DECISION; appending to an array is
//     not one. The one real decision in the neighbourhood is what ORDER the log is
//     in, and that is answered where the log is read: `subscribeBatchObservations`
//     orders by `at` — WHEN IT WAS OBSERVED, never when it arrived — with a Firestore
//     `orderBy`, which costs nothing, needs no index, and cannot be bypassed by a
//     caller that forgets to sort. Ordering arithmetic over the log (weight loss
//     against the green weight, say) would be a real domain function; it is not this
//     phase's, and nothing here precludes it.
//   • The `finished` state a cure's weight-loss criterion would decide. Named in the
//     contract doc, still with nothing to set it: `BatchStateSchema` stays
//     `running | abandoned`, and widening it would mean revisiting every reader of
//     `state` — `currentStage` here, and the "can this be abandoned / what happens
//     next" derivations on both batch surfaces.
//   • Any fermentation model. What a longer retard does to a dough is an opinion,
//     and the contract doc's "what not to build" says so outright. The maths here
//     is addition and subtraction of minutes.
export { freezeBatch } from './freezeBatch.js';
export type { FreezeBatchInput, FreezeBatchResult, FreezeBatchFailure } from './freezeBatch.js';
export {
  currentStage,
  stageStatus,
  withStageAdvanced,
  withStageStarted,
  withStageSkipped,
  withBatchAbandoned,
} from './transitions.js';
export type { StageStatus } from './transitions.js';
