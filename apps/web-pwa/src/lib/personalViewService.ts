import {
  dayForDate,
  daysBetween,
  firstIncompleteStepId,
  heatWantsAttention,
  isCheckInTimerId,
  progressOver,
  timerHeat,
  upcomingChefDays,
  type Recipe,
} from '@salt/domain';
import type { Day } from '@salt/domain';
import type {
  ChatSessionDoc,
  CookActiveTimerDoc,
  CookSessionDoc,
  KitchenTimerDoc,
} from '@salt/domain/schemas';
import { derived, readable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { recipes, recipesById } from './recipeService.js';
import { resolveRecipeIds } from './attachedRecipes.js';
import { myCookSessions } from './cookSessionService.js';
import { kitchenTimers } from './kitchenTimerService.js';
import { sessions } from './chatService.js';
import { kitchenAnchorDate, kitchenWeeks } from './mealPlanService.js';
import { currentMember } from './membersService.js';

// Personal view composition (issues #634, #682, #755). "Kitchen" is not a
// dashboard and not an inbox — it answers what of mine is RUNNING right now, what
// is coming at me, and what needs a look.
//
// #682 cut it back to the first and last of those. Tonight, Your week and Needs
// you were all restating the planner and the shopping list, which say it better
// on their own pages, so they and their domain helpers went. What #755 adds back
// is deliberately not a restatement: WHICH NIGHTS ARE MINE, across however many
// weeks that run of days spans, is a projection the planner cannot render,
// because the planner renders weeks and a personal run of nights does not stop at
// the end of one. The rest is my timers — from a cook, or from nobody's cook at
// all (issue #842) — my open cooks, the standing queue
// of entries flagged `needs_approval`, and — last, and out of the badge — a short
// list of recent chats, which is a shortcut rather than something waiting on you.
//
// COST. Most of this is free: timers, cooks, the review queue and the chats all
// read stores already subscribed app-wide from App.svelte, which is what makes
// the nav badge free from any page. `upcomingChefNights` is NOT free, and it is
// the only thing here that is not: it projects over one or two meal-plan week
// documents that `subscribeKitchenWeeks()` opens while the page is mounted (the
// planner is usually holding at least one of them already, in which case the
// subscription is shared and the extra read is nil). Nothing in the badge depends
// on it, so a page that is not open costs nothing.
//
// This module issues no writes of its own; the commands the page fires (dismiss a
// timer, cancel a cook, mark a recipe reviewed) go through cookSessionService,
// kitchenTimerService and recipeService, which report per the observability gate
// (docs/salt-architecture.md §7.6).

// ─── 1. Timers ───────────────────────────────────────────────────────────────

interface MineTimerBase {
  /** Stable across ticks, and unique across BOTH kinds — the keyed list's key. */
  readonly id: string;
  /** The timer's own name, already resolved: every kind has one by the time it gets here. */
  readonly label: string;
  /**
   * The duration the timer was actually started for, for the progress fill.
   * Falls back to the step's own duration for legacy cook entries that stored
   * none; null once there is no duration to be had (the step is gone, or was
   * never one). A standalone timer always has one.
   */
  readonly durationMs: number | null;
}

/** A timer belonging to a cook — it has a recipe, and somewhere to go. */
export interface MineCookTimer extends MineTimerBase {
  readonly kind: 'cook';
  readonly session: CookSessionDoc;
  readonly recipe: Recipe;
  readonly timer: CookActiveTimerDoc;
}

/** A timer belonging to nobody's cook (issue #842) — mine, and going nowhere. */
export interface MineKitchenTimer extends MineTimerBase {
  readonly kind: 'kitchen';
  readonly timer: KitchenTimerDoc;
}

/**
 * One timer on My Kitchen, of either kind.
 *
 * A DISCRIMINATED UNION rather than a cook timer with its recipe fields made
 * optional. The two kinds differ in exactly one way the page has to act on —
 * one has a cook to open and to write back to, the other has neither — and a
 * union makes the compiler ask about it at every branch. Optional fields would
 * let `t.recipe.title` past the type checker and blow up at the one moment the
 * kitchen is busiest.
 */
export type MineTimer = MineCookTimer | MineKitchenTimer;

/**
 * Every timer I have running, soonest-ending first — including the ones that have
 * already fired and not been dismissed.
 *
 * A fired timer is not a separate state in the document: it stays in
 * `activeTimers` until someone dismisses it, and "fired" is simply
 * `endsAt <= now`, derived against `timerNowMs` at the point of display. That is
 * the whole reason no schema field was needed here.
 *
 * The sort is on `endsAt` alone, so it needs no clock and yet still floats the
 * fired ones to the top: whatever ended earliest ended first.
 *
 * A session whose recipe was deleted is skipped, exactly as `liveCooks` does —
 * there is nowhere for "Go to recipe" to go.
 *
 * A guided check-in (issue #751) is skipped too. It rides `activeTimers` as an
 * ordinary entry, but this page asks "what of mine wants a hand?" and a check-in
 * never does: there is nothing to confirm, nothing to dismiss, and ignoring one is
 * allowed. Listing them would put a Dismiss button on a nudge and — once fired —
 * inflate the nav badge with something nobody has to act on.
 *
 * STANDALONE TIMERS (issue #842) are merged in here rather than listed
 * separately, and the merge happens at this level rather than in the page for
 * the same reason `firedTimers` reads `timerHeat`: everything downstream — the
 * sort, the fired filter, the nav badge — must treat the two kinds identically,
 * and the surest way to guarantee that is to give them one list to read. A
 * standalone timer is not a different species on screen; it simply has no cook
 * to go to.
 */
export const myTimers: Readable<readonly MineTimer[]> = derived(
  [myCookSessions, recipes, kitchenTimers],
  ([$sessions, $recipes, $kitchen]) => {
    const out: MineTimer[] = [];
    for (const timer of $kitchen?.timers ?? []) {
      out.push({
        kind: 'kitchen',
        // Namespaced so a standalone timer's id can never collide with a cook
        // timer's composite key, however either is minted.
        id: `kitchen::${timer.id}`,
        timer,
        label: timer.label,
        durationMs: timer.durationMinutes * 60_000,
      });
    }
    for (const session of $sessions) {
      const recipe = $recipes.find((r) => r.id === session.recipeId);
      if (!recipe) continue;
      for (const timer of session.activeTimers) {
        if (isCheckInTimerId(timer.id)) continue;
        // An ad-hoc timer belongs to no step, so there is nothing to look up; the
        // step lookup exists only to name and size LEGACY entries, written before
        // a timer carried its own label and duration.
        const stepIndex =
          timer.stepId === null ? -1 : recipe.steps.findIndex((s) => s.id === timer.stepId);
        const step = stepIndex >= 0 ? recipe.steps[stepIndex] : undefined;
        const minutes = timer.durationMinutes ?? step?.timer?.durationMinutes;
        out.push({
          kind: 'cook',
          id: `${session.id}::${timer.id}`,
          session,
          recipe,
          timer,
          label:
            timer.label ??
            step?.timer?.description ??
            (stepIndex >= 0 ? `Step ${stepIndex + 1}` : 'Timer'),
          durationMs: minutes ? minutes * 60_000 : null,
        });
      }
    }
    return out.sort((a, b) => Date.parse(a.timer.endsAt) - Date.parse(b.timer.endsAt));
  },
);

// Check-ins excluded for the same reason `myTimers` excludes them, plus a
// practical one: a fired check-in stays in `activeTimers` until its timer is
// dismissed, and counting it here would leave the badge's 1s interval running for
// hours over a cook with nothing left to show.
//
// Standalone timers arm the clock too (issue #842) — without them a kitchen
// whose only timer belongs to no cook would render a countdown that never
// moved, which is a worse failure than no countdown at all. Derived from the
// two source stores rather than from `myTimers` so the clock does not depend on
// the recipe collection having loaded: a cook timer waits on its recipe to be
// listed, but the seconds do not.
const anyTimerRunning: Readable<boolean> = derived(
  [myCookSessions, kitchenTimers],
  ([$sessions, $kitchen]) =>
    $sessions.some((s) => s.activeTimers.some((t) => !isCheckInTimerId(t.id))) ||
    ($kitchen?.timers.length ?? 0) > 0,
);

/**
 * A one-second clock, live only while a timer of mine actually exists.
 *
 * A countdown needs second resolution — the minute ticker this module used to
 * carry would make "4:37" sit still and then jump — but the nav badge subscribes
 * this from every page in the app, and an interval that fires every second for
 * ever to serve a badge that reads zero is pure waste. So the interval is armed
 * and disarmed by `anyTimerRunning`: nothing ticks at rest, which is the same
 * bargain cook mode's own `$effect` strikes.
 *
 * A fired-but-undismissed timer deliberately keeps the clock running: it is still
 * in `activeTimers`, and the badge counting it has to stay honest.
 */
export const timerNowMs: Readable<number> = readable(Date.now(), (set) => {
  let handle: ReturnType<typeof setInterval> | undefined;
  function stop(): void {
    if (handle !== undefined) clearInterval(handle);
    handle = undefined;
  }
  const unsub = anyTimerRunning.subscribe((running) => {
    stop();
    if (!running) return;
    set(Date.now());
    if (typeof setInterval !== 'function') return; // SSR guard
    handle = setInterval(() => set(Date.now()), 1000);
  });
  return () => {
    stop();
    unsub();
  };
});

/** Timers past their `endsAt` that nobody has dismissed — the things shouting. */
export const firedTimers: Readable<readonly MineTimer[]> = derived(
  [myTimers, timerNowMs],
  ([$timers, $now]) =>
    // Asked through the domain's heat scale rather than re-deriving "fired" from
    // `endsAt` here (issue #843). The badge and the card must agree about whether
    // a timer is shouting, and the surest way to guarantee that is for there to
    // be exactly one function that decides it.
    $timers.filter((t) => heatWantsAttention(timerHeat(Date.parse(t.timer.endsAt) - $now))),
);

// ─── 2. In-progress cooks ────────────────────────────────────────────────────

export interface LiveCook {
  readonly session: CookSessionDoc;
  readonly recipe: Recipe;
  /** 1-based position of the step to resume on. */
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly completedCount: number;
}

/**
 * Every cook I have on the go, newest first.
 *
 * ALL of them, not just the newest: a two-pan dinner is two open sessions, and a
 * view that showed one and silently hid the other would be lying about the state
 * of the kitchen. Bounded by the adapter's query limit, not by policy here.
 *
 * A session whose recipe was deleted is skipped rather than shown as a broken
 * card (the cook page cleans those up when it next opens one).
 */
export const liveCooks: Readable<readonly LiveCook[]> = derived(
  [myCookSessions, recipes],
  ([$sessions, $recipes]) => {
    const out: LiveCook[] = [];
    for (const session of $sessions) {
      const recipe = $recipes.find((r) => r.id === session.recipeId);
      if (!recipe) continue;
      const completed = new Set(session.completedStepIds);
      const nextStepId = firstIncompleteStepId(recipe.steps, completed);
      const index = nextStepId ? recipe.steps.findIndex((s) => s.id === nextStepId) : -1;
      // Count over the RECIPE, not the session's id list: a step edited out of the
      // recipe must not inflate progress. That is `progressOver`'s whole contract,
      // so this asks it rather than restating it.
      const completedCount = progressOver(
        recipe.steps.map((s) => s.id),
        completed,
      ).checked;
      out.push({
        session,
        recipe,
        // Every step done (or a recipe with no steps) resumes at the last step.
        stepNumber: index >= 0 ? index + 1 : recipe.steps.length,
        stepCount: recipe.steps.length,
        completedCount,
      });
    }
    return out;
  },
);

// ─── 3. Cooking soon ─────────────────────────────────────────────────────────

export interface UpcomingChefNight {
  /** The night's `YYYY-MM-DD` date key — also its planner deep link. */
  readonly date: string;
  readonly day: Day;
  /** Whole days from today: 0 is tonight, 1 tomorrow. Never negative. */
  readonly daysAway: number;
  /**
   * What is attached to the night, resolved live from the recipes store — never
   * denormalised, and a deleted entry simply drops out rather than rendering as
   * a dead title.
   */
  readonly recipes: readonly Recipe[];
}

/**
 * The nights from today onward that I am down to cook, soonest first.
 *
 * The window and the span are the decision, and they live in the pure domain
 * helper (`upcomingChefDays`); everything added here is resolution — the member
 * id to match on, the entries to name the meal, and the distance from today the
 * row phrases itself with.
 *
 * `today` comes from the meal-plan service rather than from a clock of its own,
 * so the day this filters on is exactly the day whose weeks are subscribed. Two
 * independently-read clocks could disagree across midnight and show a night from
 * a week we are no longer holding.
 *
 * No member resolved yet — the roster still loading, or a sign-in that matches
 * nobody on it — passes an empty id, and the helper answers with nothing. The
 * section is then absent, which is the honest rendering of "we do not know who
 * you are"; a list of everybody's nights would be worse.
 */
export const upcomingChefNights: Readable<readonly UpcomingChefNight[]> = derived(
  [kitchenWeeks, kitchenAnchorDate, currentMember, recipesById],
  ([$weeks, $today, $member, $recipesById]) =>
    upcomingChefDays($weeks, $member?.id ?? '', $today).map((night) => ({
      date: night.date,
      day: night.day,
      daysAway: daysBetween($today, night.date),
      recipes: resolveRecipeIds(night.day.recipeIds, $recipesById),
    })),
);

// ─── 3b. Tonight ─────────────────────────────────────────────────────────────

export interface TonightPlan {
  /** Today's `YYYY-MM-DD` key — also the planner deep link. */
  readonly date: string;
  /** What is attached, resolved live; a deleted entry drops out rather than 404ing. */
  readonly recipes: readonly Recipe[];
  /** The day's note, trimmed. Empty when there is none. */
  readonly note: string;
  /** Whether the signed-in member is down to cook it. */
  readonly isMine: boolean;
}

/**
 * What is planned for tonight — for ANYBODY, not just me.
 *
 * This is the quiet screen's headline (issue #843): when nothing is running, the
 * page's job stops being "what wants a hand" and becomes "what is this evening".
 * A kitchen with no timers going still has a dinner in it.
 *
 * Whose night it is changes the WORDS, never whether the card appears — see
 * `dayForDate` for why filtering by chef would blank the screen on precisely the
 * evenings someone else has covered.
 *
 * Costs nothing extra: it reads the same `kitchenWeeks` documents `upcomingChefNights`
 * already holds while the page is mounted, so there is no second subscription.
 *
 * `null` when today is unplanned or no week document covers it — the common case
 * for a week nobody has filled in, and the caller falls back to the plain
 * all-caught-up card rather than inventing a dinner.
 *
 * NOTHING here reads the shopping list, and nothing derived from it may be added.
 * A list records what somebody INTENDED to buy: it cannot see the top-up shop, the
 * jar already in the cupboard, or the thing bought and then eaten on Tuesday. A
 * card that says "you have everything" and is wrong sends you into a four-hour
 * braise you cannot finish — and once it is wrong twice it taints the sections
 * that ARE trustworthy, every one of which is a projection of a document that is
 * true by construction.
 */
export const tonight: Readable<TonightPlan | null> = derived(
  [kitchenWeeks, kitchenAnchorDate, currentMember, recipesById],
  ([$weeks, $today, $member, $recipesById]) => {
    const day = dayForDate($weeks, $today);
    if (!day) return null;
    const attached = resolveRecipeIds(day.recipeIds, $recipesById);
    const note = day.note.trim();
    // An empty night is not a headline. Nothing attached and nothing written down
    // means the plan says nothing about tonight, which the all-caught-up card
    // already says better.
    if (attached.length === 0 && !note) return null;
    return {
      date: $today,
      recipes: attached,
      note,
      isMine: $member ? day.chefs.includes($member.id) : false,
    };
  },
);

// ─── 4. Needs review ─────────────────────────────────────────────────────────

/**
 * Everything carrying the stored `needs_approval` flag, newest first — a standing
 * queue, not a notification.
 *
 * One concept, one signal (issue #755). The flag is set by the import flows on
 * raw AI output nobody has read, and it is the SAME flag the recipe page's
 * `review` banner and the list's pill read, so all three surfaces agree by construction
 * and clear together. It replaced a derived `updatedAt === createdAt` predicate,
 * which said "nobody has saved this" — true of hand-written entries too, and
 * unclearable without an editor round-trip.
 *
 * No window and no member filter: an import you forgot about three weeks ago is
 * the case most worth catching, and a recipe is family-shared, so "nobody has
 * checked this" is everybody's business. No `kind` gate either, and none is
 * wanted: only the import flows set the flag, and what they produce is a recipe.
 *
 * Deliberately OUT of the nav badge: a standing queue would pin a permanent
 * number to the tab.
 */
export const needsReviewRecipes: Readable<readonly Recipe[]> = derived(recipes, ($recipes) =>
  $recipes
    .filter((r) => r.needs_approval === true)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);

// ─── 5. Recent chats ─────────────────────────────────────────────────────────

/** How many conversations the page is willing to be a shortcut to. */
const RECENT_CHAT_LIMIT = 5;

/**
 * My last few chef conversations, most recently touched first.
 *
 * Free: `initChatSync` runs from App.svelte at auth time, so this is a projection
 * over a store that is already subscribed and costs no extra Firestore reads.
 * (`upcomingChefNights` is the one store here that is not — see the module
 * header.)
 *
 * Capped rather than paged: this is a shortcut back into a conversation you were
 * just having, and /chat is one tap away for the rest. Recipe-attached sessions
 * are included — a chat is a chat, and the recipe page listing it too (#707) is
 * accepted duplication rather than a rule about which chats are "personal".
 *
 * Sorted on `updatedAt`, matching the chat list itself, so the two surfaces can
 * never disagree about which conversation is the newest.
 *
 * Deliberately OUT of the nav badge: a chat that happened is not something
 * waiting on you, and a permanent five would say otherwise.
 */
export const recentChats: Readable<readonly ChatSessionDoc[]> = derived(sessions, ($sessions) =>
  [...$sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_CHAT_LIMIT),
);

// ─── Nav badge ───────────────────────────────────────────────────────────────

/**
 * What is waiting on me right now: every open cook, plus every timer that has
 * fired and not been dismissed.
 *
 * A COUNT OF WHAT IS OPEN, not "what changed since you last looked" — the latter
 * needs a per-user `lastSeenAt`, which means either browser storage (Rule 3) or a
 * fourth per-user collection, and it lies across devices. This needs no memory at
 * all, self-clears when the thing is resolved, and survives a cold launch
 * honestly.
 *
 * A timer still counting down is NOT in here. It is running to plan; the badge is
 * for things that want a hand.
 *
 * Both inputs are app-wide subscriptions, so the badge stays free from every
 * page. `upcomingChefNights` is deliberately not one of them — beyond it being a
 * plan rather than a summons, counting it would drag the kitchen's week
 * documents into every screen in the app.
 */
export const mineOpenCount: Readable<number> = derived(
  [liveCooks, firedTimers],
  ([$live, $fired]) => $live.length + $fired.length,
);
