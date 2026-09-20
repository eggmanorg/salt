// Cook-session module (cooking mode, issue #556). The pure session-state logic
// behind cook mode: mise-en-place ticking, guided-step completion, step timers,
// and the recipe-drift comparison — extracted out of `CookModePage.svelte` so it
// is testable without a browser.
//
// Every producer is IMMUTABLE (returns a new session; never mutates the input)
// and NONE of them stamp `updatedAt` — the persistence seam owns that, and
// duplicating it here would fight whole-document LWW.
//
// No clock reads anywhere (CLAUDE.md Rule 1): every timestamp — `nowIso`,
// `endsAt`, `nowMs` — is an injected parameter, which is also what makes the
// timer logic testable without faking time.
export { makeFreshSession } from './makeFreshSession.js';
export type { MakeFreshSessionArgs } from './makeFreshSession.js';
// The document id itself (issue #1145) — `${recipeId}_${uid}`, composed in one
// place so the two live call sites and the id scheme cannot drift apart.
export { cookSessionId } from './cookSessionId.js';
export { withStepDone } from './withStepDone.js';
export { withIngredientChecked } from './withIngredientChecked.js';
export { withPrepChecked } from './withPrepChecked.js';
export { withAllIngredientsChecked } from './withAllIngredientsChecked.js';
export { withGroupChecked } from './withGroupChecked.js';
export { withTimerStarted } from './withTimerStarted.js';
export { withTimerDismissed } from './withTimerDismissed.js';
// A guided plan's check-ins ride `activeTimers` as ordinary entries, so their
// identity has to be derived — see checkInTimerId.ts for why, and for the three
// places that derivation is the only handle anything has on them.
export { checkInTimerId, isCheckInTimerId, isCheckInOf } from './checkInTimerId.js';
export { firstUseByStep } from './firstUseByStep.js';
export { firstIncompleteStepId } from './firstIncompleteStepId.js';
export { miseProgress } from './miseProgress.js';
// The count itself (issue #994, Phase 3) — every "n of m ready" in the app runs
// through it, so a caller with its own list of ids (my open cooks' completed
// steps, in personalViewService) asks it directly rather than re-rolling a loop.
export { progressOver } from './progressOver.js';
export type { MiseProgress } from './progressOver.js';
// Guided cook (issue #751, Phase 2) — the same two questions asked of a guided
// prep list rather than of the recipe's ingredient checklist. Both are now asked
// of the BOARD (issue #767), which is the whole of what the prep screen shows.
export { guidedPrepBoard } from './guidedPrepBoard.js';
export type {
  GuidedPrepBoard,
  GuidedPrepCard,
  GuidedPrepJob,
  GuidedPrepTickRow,
} from './guidedPrepBoard.js';
export { guidedMiseProgress, guidedPrepCardProgress } from './guidedMiseProgress.js';
export { unpreppedIngredients } from './unpreppedIngredients.js';
// Guided cook amounts (issue #761, Phase 1) — guided mode never shows less than
// plain cook mode, so a prep job says how much it prepares, a named bowl says
// what is in it, and an ingredient that came out of no bowl is still printed at
// the step that first uses it. All three hang off the container-name join, whose
// one normaliser is exported so later phases group by the same answer.
export { normaliseContainerName } from './normaliseContainerName.js';
export { prepEntryForContainer } from './prepEntryForContainer.js';
export { prepEntryIngredients } from './prepEntryIngredients.js';
export { looseIngredientsForStep } from './looseIngredientsForStep.js';
// Guided plan authoring (issue #761, Phase 2) — the same container-name join read
// backwards, to say what is wrong with it while the plan is still being written.
// A REPORT, never a gate: nothing refuses to save or to cook on the strength of it.
export { guidedContainerProblems } from './guidedContainerProblems.js';
export type {
  GuidedContainerProblems,
  DuplicateContainerName,
  DanglingContainerName,
} from './guidedContainerProblems.js';
// The same join written FORWARDS (issue #1453, Phase 2) — a bowl renamed on the
// bench has to move on both halves at once, or renaming it is how it stops
// existing. Here rather than in the editor because the set of jobs and notes that
// move together is the set the matcher beside it already calls one bowl.
export { renameGuidedContainer } from './renameGuidedContainer.js';
// What is coming (issue #769) — the plan's answer to the question plain cook mode
// can only answer by fading in the next step's raw first clause, plus the part of
// that step which has to be started before you get to it.
export { nextStepLookahead } from './nextStepLookahead.js';
export type { NextStepLookahead } from './nextStepLookahead.js';
// A "Get out" STAGE (issue #761, Phase 3) used to live here — `containerGetOutList`,
// `guidedGetOutProgress` and `withContainerChecked`, a screen of every vessel the
// plan names, dismissed before the first cut. Issue #767 deleted all three: the
// container now LEADS each prep card, so one card per bowl is countable on the prep
// screen itself and a separate screen to dismiss first was a tap that bought
// nothing. The grouping it did survives in `guidedPrepBoard`.
//
// `hasRecipeChanged` used to live here. It now takes two timestamps rather than a
// session (issue #751 needed the same comparison for a guided plan's own stamp),
// so it belongs to the recipe module — see recipe/queries/hasRecipeChanged.ts.
export { formatClock } from './formatClock.js';
export { timerProgress } from './timerProgress.js';
// How hot a timer is (issue #843). The four states a countdown passes through,
// decided once so the dial's sweep, the card's stripe and the state word cannot
// disagree about what "imminent" means.
export { timerHeat, heatWantsAttention } from './timerHeat.js';
export type { TimerHeat } from './timerHeat.js';
// Meals (issue #752) — a meal's cook plan works every dish's start time backwards
// from one serve time. It lives here rather than in the recipe module because the
// serve time it reads is a cook-session field, and because it is the same shape as
// everything else in here: a small pure projection with the clock passed in.
export { scheduleFor } from './scheduleFor.js';
export type { ScheduledRow } from './scheduleFor.js';
