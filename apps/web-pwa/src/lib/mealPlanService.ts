import {
  subscribeMealPlanConfig,
  subscribeMealPlanTemplate,
  subscribeMealPlanWeek,
  loadMealPlanWeek,
  saveMealPlanConfig,
  saveMealPlanTemplate,
  saveMealPlanWeek,
} from '@salt/firebase-sync';
import {
  addCalendarDays,
  weekStartFor,
  emptyDay,
  emptyWeek,
  emptyTemplate,
  instantiateWeek,
  setDayNote,
  setDayChefs,
  setDayRecipes,
  setDayGuests,
  addAttendee,
  removeAttendee,
  setAttendeeHomeTime,
  setAttendeeNote,
  weekExtendsIntoNext,
  expandForPlanner,
  mergePlannerRecipeIds,
  type Attendee,
  type MealPlanConfig,
  type MealPlanTemplate,
  type MealPlanWeek,
  type Recipe,
  type Weekday,
} from '@salt/domain';
import { ErrorCode, failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { trackUsageEvent } from '@salt/observability';
import { writable, derived, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { subscriptionErrorHandler } from './errorReporting.js';
import { createWriteCoalescer } from './writeCoalescer.js';
import { todayIso } from './today.js';

// Meal planning service (issue #169). Subscribes to the two singletons (config +
// template) once and to the currently-selected week, re-subscribing as the user
// navigates. Domain commands compute new documents; the adapter persists them.
// See docs/meal-planning.md.
//
// The service can hold MORE THAN ONE week at a time (issue #639, phase 5): the
// primary week the user is on, plus an optional "extension" week the planner may
// scroll on into. Everything that is per-week — the loaded document, the
// stale-snapshot watermark, the subscription handle, the loading flag — is
// therefore keyed by week start date, and every mutation resolves its target
// document FROM ITS DATE KEY rather than from whatever happens to be displayed.
// That routing is the whole point: `MealPlanWeek.days` is a
// `Record<string, Day>`, so writing a foreign date key into the wrong week's
// document is not an error anywhere in the stack — it is silent corruption of
// production data.
//
// Since #755 there are THREE claims on that set, not two: the planner's primary
// and extension weeks, plus one or two weeks the kitchen page holds, anchored on
// today rather than on what the planner is showing. They overlap constantly, so
// the subscription set is a union and no claimant may close a week by name —
// see `pruneWeekSubscriptions`.

const DEFAULT_FIRST_DAY: Weekday = 'mon';

// Drop a key from a record without mutating it (returns the same object when
// the key is absent, so derived stores don't churn).
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

// ─── Reactive stores ──────────────────────────────────────────────────────────

const _config = writable<MealPlanConfig | null>(null);
const _template = writable<MealPlanTemplate | null>(null);
// Loaded week documents, keyed by start date. A key is present only while we
// hold a real document for that week; absent means "no doc" (the readers fall
// back to an unsaved empty week).
const _weeks = writable<Record<string, MealPlanWeek>>({});
// The anchor date the user is viewing; the displayed week is the one containing
// it under the current firstDayOfWeek.
const _anchorDate = writable<string>(todayIso());
// Start date of the PRIMARY week — the one `selectedStartDate` and `currentWeek`
// mean, and the one week navigation moves.
const _subscribedStart = writable<string>('');
// Start date of the optional SECOND week held alongside the primary one, or ''
// for none. Purely additive: it never changes what "the current week" means.
const _extensionStart = writable<string>('');
// Start dates of the weeks the KITCHEN page holds (issue #755), or [] when it is
// not mounted. A third, independent slot: anchored on TODAY rather than on
// `_anchorDate`, because "which nights are mine next" is a question about now,
// not about wherever the planner was last scrolled to. One or two entries — the
// second appears in the last days of a cycle, on the same `weekExtendsIntoNext`
// rule the planner extends on.
const _kitchenStarts = writable<readonly string[]>([]);
// The `today` the current kitchen set was computed for, or '' when there is
// none. Exported so `personalViewService` filters its nights against exactly the
// day these subscriptions were opened for, rather than reading a second clock of
// its own that could disagree with them across midnight.
const _kitchenToday = writable<string>('');
// Per-week loading flags, keyed by start date. Absent = not loaded yet.
const _loading = writable<Record<string, boolean>>({});

export const mealPlanTemplate: Readable<MealPlanTemplate | null> = _template;
export const selectedStartDate: Readable<string> = _subscribedStart;
/** Start date of the extension week, or '' when only one week is held. */
export const extensionStartDate: Readable<string> = _extensionStart;
export const isLoadingMealPlanWeek: Readable<boolean> = derived(
  [_loading, _subscribedStart],
  ([$l, $start]) => $l[$start] ?? true,
);
export const isLoadingExtensionWeek: Readable<boolean> = derived(
  [_loading, _extensionStart],
  ([$l, $start]) => ($start ? ($l[$start] ?? true) : false),
);

// firstDayOfWeek with a 'mon' fallback until the config doc loads.
export const firstDayOfWeek: Readable<Weekday> = derived(
  _config,
  ($c) => $c?.firstDayOfWeek ?? DEFAULT_FIRST_DAY,
);

// The displayed week — falls back to an unsaved empty week (only persisted on
// first edit / load-template) so the editor always has seven days to render.
export const currentWeek: Readable<MealPlanWeek> = derived(
  [_weeks, _subscribedStart],
  ([$w, $start]) => $w[$start] ?? emptyWeek($start || todayIso()),
);

/** The extension week, or null when only one week is held. */
export const extensionWeek: Readable<MealPlanWeek | null> = derived(
  [_weeks, _extensionStart],
  ([$w, $start]) => ($start ? ($w[$start] ?? emptyWeek($start)) : null),
);

/**
 * The week documents the kitchen slot is holding, in date order (issue #755).
 *
 * Only weeks a document actually exists for: unlike `currentWeek` there is no
 * empty-week fallback, because nobody is editing these. An unplanned week has no
 * chef nights in it, and fabricating seven blank days to say so would be noise.
 */
export const kitchenWeeks: Readable<readonly MealPlanWeek[]> = derived(
  [_weeks, _kitchenStarts],
  ([$w, $starts]) => $starts.map((s) => $w[s]).filter((w): w is MealPlanWeek => w !== undefined),
);

/** The date `kitchenWeeks` was computed for, or '' when the slot is empty. */
export const kitchenAnchorDate: Readable<string> = _kitchenToday;

// ─── Subscriptions / navigation ───────────────────────────────────────────────

let configUnsub: (() => void) | null = null;
let templateUnsub: (() => void) | null = null;
// One subscription handle per subscribed week, keyed by start date.
const weekUnsubs = new Map<string, () => void>();
// Newest `updatedAt` we've applied PER WEEK (from a local optimistic write or an
// accepted snapshot). Guards against an in-flight stale snapshot echo landing
// after a newer local edit and reverting it (e.g. select-then-deselect chef).
// Keyed by week, and that is load-bearing: a single shared watermark would let
// one week's newer edit silently discard the other week's perfectly good
// snapshot, since the two documents' timestamps are unrelated.
const latestWeekUpdatedAt = new Map<string, string>();

// The household's first day of the week, falling back to 'mon' until the config
// snapshot lands.
//
// One synchronous source of truth on purpose: subscription targets, mutation
// targets and the shop-day week clear all resolve through THIS function, so they
// can never disagree with each other about which document a date belongs to —
// whatever value it happens to be returning. The only residual window is config
// arriving between a day being rendered and that same day being edited, which
// moves the target document under a date key already on screen; `editWeekDay`
// catches exactly that case by refusing to write a week it has not read, rather
// than clobbering it.
function firstDay(): Weekday {
  return get(_config)?.firstDayOfWeek ?? DEFAULT_FIRST_DAY;
}

function setLoading(start: string, value: boolean): void {
  _loading.update((l) => ({ ...l, [start]: value }));
}

// Subscribe to one week document. Idempotent — an already-subscribed week is a
// no-op, so callers may re-assert the set of weeks they want freely.
function subscribeWeekDoc(start: string): void {
  if (!start || weekUnsubs.has(start)) return;
  setLoading(start, true);
  weekUnsubs.set(
    start,
    subscribeMealPlanWeek(
      start,
      (w) => {
        // Drop a stale snapshot that predates a newer local edit of THIS week.
        if (w && w.updatedAt < (latestWeekUpdatedAt.get(start) ?? '')) {
          setLoading(start, false);
          return;
        }
        if (w) latestWeekUpdatedAt.set(start, w.updatedAt);
        _weeks.update((weeks) => (w ? { ...weeks, [start]: w } : without(weeks, start)));
        setLoading(start, false);
      },
      subscriptionErrorHandler(() => setLoading(start, false)),
    ),
  );
}

// Drop a week entirely: stop listening and forget everything we knew about it,
// so navigating back to it shows the loading state and re-reads, exactly as a
// first visit does.
function unsubscribeWeekDoc(start: string): void {
  // A coalesced write still waiting on its timer must go out before we forget
  // the week (issue #940). The pending document is held by the coalescer, not
  // read from `_weeks`, so clearing the store below cannot strand it.
  void weekWrites.flush(start);
  weekUnsubs.get(start)?.();
  weekUnsubs.delete(start);
  latestWeekUpdatedAt.delete(start);
  _weeks.update((weeks) => without(weeks, start));
  _loading.update((l) => without(l, start));
}

// Keep the weeks SOMEBODY still wants: the primary, the (optional) extension, and
// whatever the kitchen slot is holding.
//
// The keep-set is a UNION, and that is the whole safety property. Two pages now
// ask for weeks independently and they routinely ask for the same one, so no
// caller may drop a week by name — leaving the planner would otherwise close the
// kitchen's subscription, and vice versa. Each caller clears its OWN claim and
// then re-asserts the union here.
function pruneWeekSubscriptions(): void {
  const keep = new Set(
    [get(_subscribedStart), get(_extensionStart), ...get(_kitchenStarts)].filter(Boolean),
  );
  for (const start of [...weekUnsubs.keys()]) {
    if (!keep.has(start)) unsubscribeWeekDoc(start);
  }
}

// (Re)subscribe to the week containing the anchor date under the current
// firstDayOfWeek. No-op when the start date is unchanged and already subscribed.
function syncWeekSubscription(): void {
  const start = weekStartFor(get(_anchorDate), firstDay());
  if (start !== get(_subscribedStart)) _subscribedStart.set(start);
  subscribeWeekDoc(start);
  pruneWeekSubscriptions();
}

/**
 * Hold a SECOND week alongside the primary one, or drop it with `null`.
 *
 * Additive by construction: `selectedStartDate`, `currentWeek` and week
 * navigation keep meaning the primary week. The extension week is a real
 * subscription with its own document, watermark and loading flag, so edits to
 * its dates route to its own document like any other.
 */
export function setExtensionWeek(start: string | null): void {
  const next = start ? weekStartFor(start, firstDay()) : '';
  if (next === get(_extensionStart)) return;
  _extensionStart.set(next);
  if (next) subscribeWeekDoc(next);
  pruneWeekSubscriptions();
}

// Is the kitchen page mounted? A plain boolean, and it is load-bearing: the
// config snapshot re-asserts the kitchen weeks (below), and without this flag a
// `firstDayOfWeek` change arriving while nobody is on that page would open week
// documents for a screen that does not exist.
let kitchenActive = false;

// The one or two weeks the kitchen page needs, anchored on today.
//
// The second week is the planner's own extension rule (`weekExtendsIntoNext`),
// reused rather than re-derived: what makes the last three days of a cycle the
// moment next week matters is a fact about the household's week, not about the
// planner, so both pages must agree by construction or one of them will start
// showing a Friday the other does not.
function kitchenStartsForToday(today: string): string[] {
  const day = firstDay();
  const start = weekStartFor(today, day);
  return weekExtendsIntoNext(start, today, day) ? [start, addCalendarDays(start, 7)] : [start];
}

// (Re)assert the kitchen's claim on its weeks. No-op unless the page is mounted.
function syncKitchenSubscriptions(): void {
  if (!kitchenActive) return;
  const today = todayIso();
  _kitchenToday.set(today);
  const starts = kitchenStartsForToday(today);
  _kitchenStarts.set(starts);
  for (const start of starts) subscribeWeekDoc(start);
  pruneWeekSubscriptions();
}

/**
 * Hold the week (or two) the kitchen page projects "Cooking soon" from, until the
 * returned teardown is called (issue #755).
 *
 * Page-owned rather than started at auth time, for the reason the planner's
 * extension is: these are real subscriptions on a module-level singleton, and a
 * second week document kept alive for a page nobody is looking at is exactly the
 * cost the planner already refuses to pay.
 *
 * The teardown drops the CLAIM and re-prunes; it never unsubscribes a week by
 * name. The planner may be holding the very same document, and only the union in
 * `pruneWeekSubscriptions` knows that.
 */
export function subscribeKitchenWeeks(): () => void {
  kitchenActive = true;
  syncKitchenSubscriptions();
  return () => {
    kitchenActive = false;
    _kitchenStarts.set([]);
    _kitchenToday.set('');
    pruneWeekSubscriptions();
  };
}

export function initMealPlanSync(): () => void {
  configUnsub = subscribeMealPlanConfig(
    (c) => {
      _config.set(c);
      // firstDayOfWeek may have changed which date this week starts on.
      syncWeekSubscription();
      // And with it which document today's nights live in. `firstDay()` answers
      // 'mon' until this snapshot lands, so on the common cold-launch ordering —
      // mount, subscribe under the fallback, config arrives saying 'fri' — the
      // kitchen's first guess was the wrong week identity entirely.
      syncKitchenSubscriptions();
    },
    // Config load errors leave the last-known config (or null) in place; the
    // handler reports the failure to the category gate before doing so, which is
    // all there is to do here.
    subscriptionErrorHandler(),
  );
  templateUnsub = subscribeMealPlanTemplate(
    (t) => {
      _template.set(t);
    },
    // As above — template errors leave the last-known template in place, and are
    // reported by the handler.
    subscriptionErrorHandler(),
  );
  syncWeekSubscription();
  return () => {
    configUnsub?.();
    templateUnsub?.();
    configUnsub = templateUnsub = null;
    _extensionStart.set('');
    kitchenActive = false;
    _kitchenStarts.set([]);
    _kitchenToday.set('');
    for (const start of [...weekUnsubs.keys()]) unsubscribeWeekDoc(start);
  };
}

export function goToWeek(date: string): void {
  _anchorDate.set(date);
  syncWeekSubscription();
}

export function thisWeek(): void {
  goToWeek(todayIso());
}

export function nextWeek(): void {
  goToWeek(addCalendarDays(get(_subscribedStart) || todayIso(), 7));
}

export function prevWeek(): void {
  goToWeek(addCalendarDays(get(_subscribedStart) || todayIso(), -7));
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function weekObjectFor(start: string): MealPlanWeek {
  return get(_weeks)[start] ?? emptyWeek(start);
}

function currentWeekObject(): MealPlanWeek {
  return weekObjectFor(get(_subscribedStart) || todayIso());
}

function currentTemplateObject(): MealPlanTemplate {
  return get(_template) ?? emptyTemplate();
}

// True once we can honestly claim to know what is in a week's document: either
// we hold a snapshot, or we have a live subscription that has told us (or is
// about to tell us) there is none.
//
// The kitchen slot WIDENS this set while that page is mounted, and that is
// correct: `addRecipeToDay` will then build on the held document instead of
// re-reading, which is safe precisely because a kitchen week has a live listener
// keeping it fresh. The thing forbidden by docs/meal-planning.md is caching a
// week nothing is listening to — a one-shot read left behind, which nothing would
// ever refresh.
function weekIsKnown(start: string): boolean {
  return weekUnsubs.has(start) || get(_weeks)[start] !== undefined;
}

/**
 * Apply a day-level edit to the document `dateKey` actually belongs in.
 *
 * The target is derived from the date key, never from what is displayed — with
 * two weeks on screen, "the subscribed week" is not an answer to "which document
 * does this day live in".
 *
 * The week must be one we know (see `weekIsKnown`). Persisting is a full-document
 * write under LWW, so writing a week we have never read would blow away its other
 * six days; refusing is the only safe answer. Reachable in principle only if
 * `firstDayOfWeek` arrives between a day being rendered and being edited — see
 * the note on `firstDay()`.
 */
function editWeekDay(
  dateKey: string,
  apply: (week: MealPlanWeek) => MealPlanWeek,
  // Coalesce the write, for a field typed a character at a time. Everything else
  // is one deliberate tap and writes at once — see `persistWeek` vs
  // `persistWeekNow` and the note on which mutators opt in (issue #940).
  coalesce = false,
): Promise<ReadResult<void, DomainError>> {
  const start = weekStartFor(dateKey, firstDay());
  if (!weekIsKnown(start)) {
    return Promise.resolve(
      failure({
        kind: 'ValidationError',
        code: ErrorCode.WEEK_NOT_LOADED,
        message: `Refusing to write ${start}: that week has not been loaded.`,
      }),
    );
  }
  const next = apply(weekObjectFor(start));
  return coalesce ? persistWeek(next) : persistWeekNow(next);
}

// ─── Write coalescing (issue #940) ────────────────────────────────────────────
//
// A planner note is typed a character at a time, and every keystroke used to
// issue a full-document `setDoc` of the whole seven-day week — nineteen writes
// for "Spaghetti bolognese", each one fanned out to every family device's
// realtime listener. The write is coalesced HERE, at the service, because the
// four note mutators are reached from two pages and a per-component fix covers
// whichever component remembered.
//
// ONLY THOSE FOUR COALESCE. Chef, attendee, guests, recipes and load-template
// write immediately: each is one deliberate tap, so there is no burst to merge,
// and deferring one means a reload inside the window silently discards an edit
// the user had finished making. `e2e/mealplan.spec.ts` asserts those survive a
// reload, and it is right to.
//
// The split that makes this safe: the OPTIMISTIC STORE APPLY stays synchronous
// and only the `setDoc` is deferred. Every week mutator rebuilds the document
// from `_weeks` (see `editWeekDay`), so a deferred apply would let two edits to
// different fields of the same day both build on the same stale week and the
// second silently discard the first.
//
// The mechanism itself lives in `./writeCoalescer.ts` — promoted out of this file
// by issue #1319, which needed the same writer in front of `persistRecipe`. Its
// header carries the guarantees, the limits, and the `pagehide`/`visibilitychange`
// flush that used to be registered at the foot of this section.

// The adapter functions are wrapped rather than passed by reference: reading the
// binding here would resolve it at MODULE LOAD, and several suites mock
// `@salt/firebase-sync` partially — a page that merely reaches this module
// transitively would then fail to import over an export it never calls.
const weekWrites = createWriteCoalescer((week: MealPlanWeek) => saveMealPlanWeek(week), {
  // Every week-level mutator funnels through here, so this one capture is the
  // whole "is the planner used, and by whom" signal (issue #684). Since #940 it
  // fires once per coalesced burst rather than once per keystroke — the volume
  // this event was always meant to have.
  onWritten: () => trackUsageEvent('plan.edited', { plan_scope: 'week' }),
});
// The template is a single document, so it needs a key only to reuse the same
// machinery — there is never more than one entry.
const TEMPLATE_KEY = 'template';
const templateWrites = createWriteCoalescer(
  (template: MealPlanTemplate) => saveMealPlanTemplate(template),
  { onWritten: () => trackUsageEvent('plan.edited', { plan_scope: 'template' }) },
);

/**
 * Write out every pending planner edit now.
 *
 * Called from the day sheet on blur and on teardown (issue #940): the debounce
 * alone would lose the last edit when the sheet is dismissed inside its window,
 * and blur alone would never fire for `page.fill()` in the e2e. Both, not either.
 */
export function flushMealPlanWrites(): Promise<void> {
  return Promise.all([weekWrites.flushAll(), templateWrites.flushAll()]).then(() => undefined);
}

// Nothing registers `pagehide`/`visibilitychange` here any more: `writeCoalescer`
// flushes EVERY coalescer it made on both events, so a planner edit is still
// written when the tab goes away, and there is no second registration to drift
// from the first.

// Stamp updatedAt and update the store optimistically — SYNCHRONOUSLY — then
// queue the document write. The target document is the week's own `startDate`;
// the object carries where it belongs.
//
// The apply must not be deferred: every week mutator rebuilds from `_weeks` (see
// `editWeekDay`), so deferring it would let interleaved edits build on the same
// stale week and discard one another. See the coalescer's header.
//
// The optimistic cache is for weeks we already know (see `weekIsKnown`) and only
// those. A week read one-shot purely in order to write it — `addRecipeToDay`
// from the recipe page — must not be left behind in `_weeks`: nothing is
// listening to it, so nothing would ever refresh it, yet its mere presence would
// make `weekIsKnown` answer true and let a much later full-document write be
// built on a snapshot that has since moved on.
function applyWeekOptimistically(week: MealPlanWeek): MealPlanWeek {
  const stamped: MealPlanWeek = { ...week, updatedAt: new Date().toISOString() };
  if (weekIsKnown(stamped.startDate)) {
    latestWeekUpdatedAt.set(stamped.startDate, stamped.updatedAt);
    _weeks.update((weeks) => ({ ...weeks, [stamped.startDate]: stamped }));
  }
  return stamped;
}

function persistWeek(week: MealPlanWeek): Promise<ReadResult<void, DomainError>> {
  const stamped = applyWeekOptimistically(week);
  return weekWrites.queue(stamped.startDate, stamped);
}

// Apply and write straight away, for a DISCRETE action whose caller awaits the
// result in order to report it — attaching a recipe, loading the template over a
// week. Debouncing those would only delay a spinner: they are one deliberate
// tap, not a stream of keystrokes, so there is nothing to coalesce.
function persistWeekNow(week: MealPlanWeek): Promise<ReadResult<void, DomainError>> {
  const result = persistWeek(week);
  void weekWrites.flush(week.startDate);
  return result;
}

function persistTemplate(
  template: MealPlanTemplate,
  coalesce = false,
): Promise<ReadResult<void, DomainError>> {
  _template.set(template);
  const result = templateWrites.queue(TEMPLATE_KEY, template);
  if (!coalesce) void templateWrites.flush(TEMPLATE_KEY);
  return result;
}

/**
 * Load the standard template into the week containing `date` (overwrites it back
 * to the standard, ready for exception-tweaking).
 *
 * Unlike the day mutators this deliberately needs no loaded document — it
 * replaces the whole week by design, so there is nothing to preserve.
 */
export function loadTemplateIntoWeek(date: string): Promise<ReadResult<void, DomainError>> {
  const start = weekStartFor(date, firstDay());
  const week = instantiateWeek(
    start,
    get(_config) ?? { firstDayOfWeek: firstDay(), schemaVersion: 1 },
    currentTemplateObject(),
  );
  return persistWeekNow(week);
}

/**
 * Does the week containing `date` already hold saved edits (issue #639, phase 7)?
 *
 * The load-template picker offers three weeks and warns against each one that
 * would lose work, so this must answer for weeks the planner is not showing.
 *
 * A week we HOLD is answered from the document we hold — that is the freshest
 * answer there is, since it includes an optimistic write that has not landed
 * yet. A week we do not hold is READ, one shot. Deliberately not inferred from
 * the absence of a document in memory: "we never loaded it" and "it has no
 * edits" are different facts, and confusing them overwrites a real plan without
 * warning. A read failure stays a `Failure` so the caller can say it could not
 * check, rather than implying safety (Rule 10).
 */
export async function weekHasEdits(date: string): Promise<ReadResult<boolean, DomainError>> {
  const start = weekStartFor(date, firstDay());
  const held = get(_weeks)[start];
  // `updatedAt` is stamped by every persist; the empty-week fallback carries ''.
  if (held) return success(held.updatedAt !== '');
  const read = await loadMealPlanWeek(start);
  if (read.kind !== 'ok') return read;
  return success(read.value !== null && read.value.updatedAt !== '');
}

/**
 * Attach one recipe to one day from OUTSIDE the planner (the recipe page's
 * "Add to planner").
 *
 * Every other day mutator refuses to write a week it has not read, because a
 * full-document write built on a week we never saw would blow away its other six
 * days. That refusal is right for the planner, where the days on screen are
 * always the days it is subscribed to — but this caller can name ANY date, and
 * "pick a date three weeks out" is the normal case, not the edge one. So the
 * week is READ before it is written rather than declined. A read failure stays a
 * `Failure`: the alternative is overwriting a plan we could not see.
 *
 * Takes the whole RECIPE, not its id (issue #752, Phase 2): a meal expands to
 * itself plus its components, and that expansion is a pure function of the
 * document. The only production caller already holds the recipe, so asking for it
 * is free — and it keeps this service from acquiring a dependency on the recipes
 * store purely to look an id back up.
 *
 * Idempotent, per id, on what the day already holds. `'already-there'` means
 * NOTHING NEW LANDED — which is also the honest answer when a meal was already
 * on the night; when only some of its dishes were, the rest are added and the
 * answer is `'added'`, so the caller's toast can still tell the truth.
 */
export async function addRecipeToDay(
  dateKey: string,
  recipe: Recipe,
): Promise<ReadResult<'added' | 'already-there', DomainError>> {
  const start = weekStartFor(dateKey, firstDay());
  let week: MealPlanWeek;
  if (weekIsKnown(start)) {
    week = weekObjectFor(start);
  } else {
    const read = await loadMealPlanWeek(start);
    if (read.kind !== 'ok') return read;
    week = read.value ?? emptyWeek(start);
  }
  // A stored week holds the seven date keys that were current when it was
  // written; move `firstDayOfWeek` afterwards and a date can belong to a week
  // whose document has no entry for it. Seed the day rather than let the day
  // mutator spread `undefined` into a half-formed one.
  if (!week.days[dateKey]) {
    week = { ...week, days: { ...week.days, [dateKey]: emptyDay() } };
  }
  const attached = week.days[dateKey]!.recipeIds;
  const next = mergePlannerRecipeIds(attached, expandForPlanner(recipe));
  if (next.length === attached.length) return success('already-there');
  const saved = await persistWeekNow(setDayRecipes(week, dateKey, next));
  return saved.kind === 'ok' ? success('added') : saved;
}

// — Week day/attendee mutators —
// Each routes to the document its `dateKey` belongs in; see `editWeekDay`.
export function setWeekDayNote(dateKey: string, note: string) {
  return editWeekDay(dateKey, (w) => setDayNote(w, dateKey, note), true);
}
export function setWeekDayChefs(dateKey: string, chefs: readonly string[]) {
  return editWeekDay(dateKey, (w) => setDayChefs(w, dateKey, chefs));
}
export function setWeekDayRecipes(dateKey: string, recipeIds: readonly string[]) {
  return editWeekDay(dateKey, (w) => setDayRecipes(w, dateKey, recipeIds));
}
export function setWeekDayGuests(dateKey: string, guests: number) {
  return editWeekDay(dateKey, (w) => setDayGuests(w, dateKey, guests));
}
export function addWeekAttendee(dateKey: string, attendee: Attendee) {
  return editWeekDay(dateKey, (w) => addAttendee(w, dateKey, attendee));
}
export function removeWeekAttendee(dateKey: string, memberId: string) {
  return editWeekDay(dateKey, (w) => removeAttendee(w, dateKey, memberId));
}
export function setWeekAttendeeHomeTime(
  dateKey: string,
  memberId: string,
  homeTime: string | null,
) {
  return editWeekDay(dateKey, (w) => setAttendeeHomeTime(w, dateKey, memberId, homeTime));
}
export function setWeekAttendeeNote(dateKey: string, memberId: string, note: string) {
  return editWeekDay(dateKey, (w) => setAttendeeNote(w, dateKey, memberId, note), true);
}

// — Config —
export function saveFirstDayOfWeek(day: Weekday): Promise<ReadResult<void, DomainError>> {
  return saveMealPlanConfig({ firstDayOfWeek: day, schemaVersion: 1 });
}

// — Template day/attendee mutators (keyed by weekday) —
export function setTemplateDayNote(weekday: Weekday, note: string) {
  return persistTemplate(setDayNote(currentTemplateObject(), weekday, note), true);
}
export function setTemplateDayChefs(weekday: Weekday, chefs: readonly string[]) {
  return persistTemplate(setDayChefs(currentTemplateObject(), weekday, chefs));
}
export function setTemplateDayGuests(weekday: Weekday, guests: number) {
  return persistTemplate(setDayGuests(currentTemplateObject(), weekday, guests));
}
export function addTemplateAttendee(weekday: Weekday, attendee: Attendee) {
  return persistTemplate(addAttendee(currentTemplateObject(), weekday, attendee));
}
export function removeTemplateAttendee(weekday: Weekday, memberId: string) {
  return persistTemplate(removeAttendee(currentTemplateObject(), weekday, memberId));
}
export function setTemplateAttendeeHomeTime(
  weekday: Weekday,
  memberId: string,
  homeTime: string | null,
) {
  return persistTemplate(setAttendeeHomeTime(currentTemplateObject(), weekday, memberId, homeTime));
}
export function setTemplateAttendeeNote(weekday: Weekday, memberId: string, note: string) {
  return persistTemplate(setAttendeeNote(currentTemplateObject(), weekday, memberId, note), true);
}

// ─── Test / e2e helpers ───────────────────────────────────────────────────────

export function __resetMealPlanServiceForTest(): void {
  configUnsub?.();
  templateUnsub?.();
  configUnsub = templateUnsub = null;
  kitchenActive = false;
  for (const unsub of weekUnsubs.values()) unsub();
  weekUnsubs.clear();
  // Cancel debounced writes rather than issuing them: a timer surviving teardown
  // would fire a `saveMealPlanWeek` into the NEXT test's mocks (issue #940).
  weekWrites.discardAll();
  templateWrites.discardAll();
  latestWeekUpdatedAt.clear();
  _config.set(null);
  _template.set(null);
  _weeks.set({});
  _anchorDate.set(todayIso());
  _subscribedStart.set('');
  _extensionStart.set('');
  _kitchenStarts.set([]);
  _kitchenToday.set('');
  _loading.set({});
}

export function seedMealPlanConfig(config: MealPlanConfig | null): void {
  _config.set(config);
}

export function seedMealPlanTemplate(template: MealPlanTemplate | null): void {
  _template.set(template);
}

// Seed a concrete week as the displayed one (used by tests / e2e).
export function seedMealPlanWeek(week: MealPlanWeek): void {
  _anchorDate.set(week.startDate);
  _subscribedStart.set(week.startDate);
  seedMealPlanWeekDoc(week);
}

// Seed a week WITHOUT making it the displayed one — the second week of a
// two-week planner, so a test can prove an edit lands in the right document.
export function seedMealPlanWeekDoc(week: MealPlanWeek): void {
  latestWeekUpdatedAt.set(week.startDate, week.updatedAt);
  _weeks.update((weeks) => ({ ...weeks, [week.startDate]: week }));
  setLoading(week.startDate, false);
}

export function getMealPlanWeekSnapshot(): MealPlanWeek {
  return currentWeekObject();
}
