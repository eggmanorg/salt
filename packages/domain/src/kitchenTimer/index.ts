// Kitchen-timer module (issue #842). The pure state logic behind a timer that
// belongs to nobody's cook — started from My Kitchen, living in its own
// per-user document rather than inside a cook session.
//
// Two producers and nothing else. Everything a standalone timer DOES beyond
// starting and stopping is already answered by the cook-session module's pure
// queries — `timerHeat`, `timerProgress` and `formatClock` all read an `endsAt`
// and a duration, and a standalone timer has both. Re-exporting timer-shaped
// copies of them here would give the two surfaces two chances to disagree about
// what "imminent" means, which is the exact drift `timerHeat` was extracted to
// prevent.
//
// Both producers are IMMUTABLE (return a new document; never mutate the input)
// and neither reads a clock (CLAUDE.md Rule 1): `endsAt` is computed by the
// page, which is where the clock already lives, and `nowMs` is injected.
export { withKitchenTimerStarted } from './withKitchenTimerStarted.js';
export { withKitchenTimerDismissed } from './withKitchenTimerDismissed.js';
// Not a producer — an id scheme, and the only one this collection has. It sits
// here beside the producers for the reason `checkInTimerId` sits beside the cook
// session's: the rule it encodes ("one live timer per step of a batch") is
// enforced entirely by `withKitchenTimerStarted`'s replace-by-id, so the two are
// one mechanism read from either end (issue #1327).
export { batchStepTimerId } from './batchStepTimerId.js';
