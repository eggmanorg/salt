// Personal-view module (issues #634, #682, #755) — the policy behind "Kitchen",
// the per-user view over family-shared data. This file is the ONLY thing other
// domain modules and adapters import from personalView; anything not re-exported
// here is private.
//
// Everything in here is a PROJECTION: a pure function from documents that already
// exist to what one member should be shown. There is no per-user storage behind
// it — no inbox, no read state, no `lastSeenAt`. A projection may be over a
// family-shared collection whose rows are resolved by DELETION (`kitchenTasks`
// over `defrosts`, issue #1685): somebody taps Got it out, the document goes, and
// the row goes for everybody — a household act, not a per-user dismissal.
//
// The module was deleted outright by #755 phase 1, once its last tenant collapsed
// into a field comparison, and re-created by phase 3 for `upcomingChefDays`. That
// is the intended rhythm: a domain module is kept alive by a decision, not by the
// name over the door. See docs/domain-implementation.md §8.
export { upcomingChefDays } from './upcomingChefDays.js';
export type { ChefNight } from './upcomingChefDays.js';
// What is happening on one date, for anybody (issue #843) — the quiet screen's
// headline. Sibling of upcomingChefDays, not a special case of it: see the header.
export { dayForDate } from './dayForDate.js';
// What Kitchen asks somebody to do (issue #1685) — the one projection Kitchen
// renders and the 09:00 push (#1683) scans.
export { kitchenTasks } from './kitchenTasks.js';
export type { KitchenTask, KitchenTaskSources, DefrostTask } from './kitchenTasks.js';
