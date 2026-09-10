<script lang="ts">
  import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    ListPage,
    RadioGroup,
    RadioGroupItem,
  } from '@salt/ui-components';
  import { onMount } from 'svelte';
  import { ChevronLeft, ChevronRight, ShoppingCart } from '@lucide/svelte';
  import {
    weekDates,
    dayIndexInWeek,
    weekExtendsIntoNext,
    templateWeekStarts,
    addCalendarDays,
    takesIngredients,
    type Attendee,
    type Day,
    type Recipe,
  } from '@salt/domain';
  import type { ShoppingDayDoc, ShoppingSlot } from '@salt/domain/schemas';
  import type { DomainError, ReadResult } from '@salt/shared-types';
  import MealDayEditor from './MealDayEditor.svelte';
  import MealDayDetail from './MealDayDetail.svelte';
  import WeekShopSheet from './WeekShopSheet.svelte';
  import RecipeAddToListSheet from '../recipes/RecipeAddToListSheet.svelte';
  import { kindOf } from '../recipes/recipeKind.js';
  import { formatDayKey } from '../../lib/dateFormat.js';
  import { todayIso } from '../../lib/today.js';
  import { SPLIT_QUERY, createMediaQuery } from '../../lib/mediaQuery.svelte.js';
  import { createDeck } from '../../lib/deck.svelte.js';
  import type { DeckThresholds } from '../../lib/cookDeck.js';
  // `people`, never `members` (issue #1300): the attendee/chef row is a
  // people-picker, and a system account is never offered as a person.
  import { people } from '../../lib/membersService.js';
  import { recipes, recipesById } from '../../lib/recipeService.js';
  import { defaultListId } from '../../lib/shoppingListService.svelte.js';
  import {
    currentWeek,
    selectedStartDate,
    isLoadingMealPlanWeek,
    firstDayOfWeek,
    extensionWeek,
    extensionStartDate,
    setExtensionWeek,
    nextWeek,
    prevWeek,
    thisWeek,
    goToWeek,
    loadTemplateIntoWeek,
    weekHasEdits,
    setWeekDayNote,
    setWeekDayChefs,
    setWeekDayRecipes,
    setWeekDayGuests,
    addWeekAttendee,
    removeWeekAttendee,
    setWeekAttendeeHomeTime,
    setWeekAttendeeNote,
  } from '../../lib/mealPlanService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { weatherForecast, ensureFreshForecast } from '../../lib/weatherService.js';
  import {
    weekShopDay,
    extensionWeekShopDay,
    setShopDay,
    clearShopDay,
  } from '../../lib/shoppingDayService.js';
  import { resolveRecipeIds } from '../../lib/attachedRecipes.js';

  // Optional `/mealplan/:date` — the week containing this date is opened instead
  // of the current one (issue #629): the shopping list's shop-day chip deep-links
  // to the week it is stocking for, which may be next week's.
  interface Props {
    params?: { date?: string } | undefined;
  }
  let { params }: Props = $props();

  // The week store is a module-level singleton, so it retains whatever week was
  // last viewed. Reset to the current week each time the planner is opened —
  // unless the route named a date to land on.
  onMount(() => {
    const routeDate = params?.date;
    if (routeDate) goToWeek(routeDate);
    else thisWeek();
    // On-access weather refresh (issue #382, Phase 3): silently refetch the
    // forecast when the cache is stale (>1h or the home location moved) and a home
    // location is set. No-ops otherwise; never blocks — the cache subscription
    // updates the day cells in place when the new doc arrives.
    void ensureFreshForecast();
    // The extension (below) is a second live subscription on a module-level
    // singleton, so leaving the planner must drop it — otherwise the app keeps a
    // second week document and a second shop-day range read alive for a page
    // nobody is looking at.
    return () => setExtensionWeek(null);
  });

  const dates = $derived(weekDates($selectedStartDate));

  // Today, as the same local `YYYY-MM-DD` the week is keyed by. Read once per
  // mount, and deliberately a plain `const` rather than a `$derived`: the planner
  // is remounted on every visit, and a week view that ticks over at midnight
  // while open is not worth a timer.
  const todayDate = todayIso();

  // ─── Land on today (#639, Phase 2) ────────────────────────────────────────
  // The week OPENS ON TODAY: today's row is put directly under the sticky app
  // header on load, rather than the week starting on Friday and today landing
  // wherever it falls. The earlier days of the week are still there, full size,
  // immediately above — nothing is folded away or hidden behind a control, you
  // simply scroll up. They render a step quieter, so scrolling up reads as
  // looking backwards.
  //
  // `todayIndex` is the whole state machine: -1 means the displayed week does
  // not contain today, so we land at the top instead of anchoring; otherwise it
  // is today's row.
  const todayIndex = $derived(dayIndexInWeek($selectedStartDate, todayDate));

  // ─── Next week appears from Tuesday (#639, Phase 6) ───────────────────────
  // You shop on Friday or Saturday and plan by Thursday, so for the last three
  // days of every cycle the week you need is the one you are NOT looking at. From
  // then on the whole of next week is appended beneath a dated mark — one
  // continuous scroll of twelve to fourteen days from today, with both weeks' shop
  // rules in it.
  //
  // The trigger is "the last `WEEK_EXTENSION_DAYS` of the cycle", never the literal
  // weekday: Tuesday is only the answer because `firstDayOfWeek` is 'fri', and that
  // is a configurable setting. The predicate is pure and lives in domain (there is
  // no clock there, so today is passed in).
  //
  // The extension belongs to TODAY's week only. Navigating anywhere else drops it
  // — `weekExtendsIntoNext` is false for any week that does not contain today —
  // and prev/next still mean exactly one week.
  const extendsIntoNext = $derived(
    weekExtendsIntoNext($selectedStartDate, todayDate, $firstDayOfWeek),
  );

  // Ask the service to hold the second week (or to drop it). Everything else about
  // the extension follows from `extensionStartDate`: the week document, its
  // loading flag, and — with no wiring here at all — its shop marker.
  $effect(() => {
    const wanted = extendsIntoNext ? addCalendarDays($selectedStartDate, 7) : null;
    // Never ask for the week we are already showing: the service would hold one
    // subscription under two names and the deck would render the days twice.
    setExtensionWeek(wanted && wanted !== $selectedStartDate ? wanted : null);
  });

  const extensionDates = $derived($extensionStartDate ? weekDates($extensionStartDate) : []);

  // ─── The deck (#639, Phase 4) ─────────────────────────────────────────────
  // The week is a DECK, not a scroller: dragging moves the list under the thumb
  // 1:1 and on release it settles onto a day with a spring, resisting past either
  // end — the same machinery cook mode pages its steps with, extracted in Phase 3.
  //
  // The page therefore owns its own scrolling surface, which is what `fill` on
  // ListPage is for (ui-spec-v05 §1): it hands the page the shell's leftover
  // height so the deck viewport has something definite to size against, and a
  // page that exactly fills `<main>` leaves it nothing to scroll. No pixel
  // arithmetic against the shell chrome, and no browser storage — scroll position
  // is never persisted (Rule 3).
  let rowEls = $state<Record<string, HTMLElement | null>>({});

  // Cook mode's thresholds assume a section fills the screen. A day card is
  // ~200px, so `screen * 0.22` would be most of a card and a normal drag would
  // almost never commit — the ratio is a fraction of the VIEWPORT, so a smaller
  // one is what shortens the throw. 0.08 of a ~700px viewport ≈ 56px, about a
  // third of a card. The fling threshold drops with it so a light flick still
  // turns a day; projection and overhang slack keep cook mode's values.
  // `leadPx` is the row gap (`gap-6`): a day that snaps flush against the top of
  // the viewport reads as cramped, because its first pixel is the screen's first
  // pixel. Landing a gap early puts the previous day's bottom edge just above the
  // fold, so the card arrives with the air it is laid out with.
  const PLANNER_THRESHOLDS: DeckThresholds = {
    commitRatio: 0.08,
    flingPxPerMs: 0.35,
    leadPx: 24,
  };

  // The deck's stops are BOTH weeks' rows in visual order (#639, Phase 6). One
  // deck, one gesture: next week is scrolled into, not paged to.
  const deck = createDeck({
    sections: () =>
      [...dates, ...extensionDates].map((d) => rowEls[d]).filter((el): el is HTMLElement => !!el),
    thresholds: PLANNER_THRESHOLDS,
  });

  // The cue appears once the deck has moved off the top — the same "you are not
  // at the beginning" fact the scroll listener used to report.
  const scrolled = $derived(deck.offset > 8);

  // Plain (untracked) on purpose: the anchor is a one-shot per displayed run of
  // days, and reading it must not make the effect below depend on it.
  let anchoredWeek: string | null = null;

  // The offset the anchor last placed. It is how the re-anchor below tells "the
  // deck is still exactly where we put it" from "the user has moved it" without
  // listening to a single gesture. -1 = nothing placed yet, which is why it is not
  // 0: 0 is a real resting place (the top of the week).
  let anchoredOffset = -1;

  function anchorTo(next: number, key: string): void {
    deck.place(next);
    anchoredOffset = next;
    anchoredWeek = key;
  }

  // Anchor once per displayed run of days. The rows only exist once the week's
  // data has arrived, so this re-runs until today's row is actually in the DOM.
  // `place` rather than `animateTo`: this is where the deck STARTS, not somewhere
  // it travels to, so there is nothing for reduced motion to short-circuit.
  $effect(() => {
    // Keyed by BOTH weeks: gaining or losing the extension changes how far the
    // deck can travel, so it is a new anchor, not the same one.
    const key = `${$selectedStartDate}|${$extensionStartDate}`;
    const lastExtensionRow = extensionDates.length ? rowEls[extensionDates[6]!] : null;
    const todayRow = todayIndex >= 0 ? rowEls[todayDate] : null;
    if (anchoredWeek === key) return;
    if (todayIndex < 0) {
      // Some other week: land at the top, not wherever the last week was left.
      anchorTo(0, key);
      return;
    }
    if (!todayRow) return;
    // Wait for next week's rows before measuring. `offsetOf` clamps to the end of
    // the list, and the extension fires exactly when today is near the END of its
    // week — so without the appended days below it, today's row cannot reach the
    // top and would land clamped some way down instead.
    if (extensionDates.length && !lastExtensionRow) return;
    // `offsetOf` clamps to the end of the list, so a day late in the week lands
    // as high as the list allows rather than dragging blank space up behind it.
    anchorTo(deck.offsetOf(todayRow) ?? 0, key);
  });

  // …and keep it anchored while the list is still growing under it.
  //
  // The rows the anchor first measures are NOT the rows the week ends up with: a
  // day whose recipe is attached grows a 1.6:1 photograph the moment the recipes
  // store delivers, and the rail gains its forecast on the weather doc's own
  // snapshot. `offsetOf` clamps against the content height it can see at that
  // instant, so on a cold load it measured a list barely taller than the viewport,
  // clamped today's offset to nearly nothing, landed at the top of the week — and
  // latched. Today was then several hundred pixels below the fold and never
  // reached. Re-entering the planner with the stores already warm anchored
  // correctly, which is exactly why this survived review.
  //
  // So: re-place on every content resize, and stop for good the moment the deck is
  // somewhere the user put it. Reading the deck inside the observer registers no
  // dependency (the callback runs outside effect tracking), so this observes the
  // list rather than fighting it.
  $effect(() => {
    const el = deck.contentEl;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (deck.offset !== anchoredOffset) return;
      const todayRow = todayIndex >= 0 ? rowEls[todayDate] : null;
      if (!todayRow) return;
      const next = deck.offsetOf(todayRow) ?? 0;
      if (next === anchoredOffset) return;
      deck.place(next);
      anchoredOffset = next;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  function rangeOf(ds: string[], withYear: boolean): string {
    if (ds.length !== 7) return '';
    const end: Intl.DateTimeFormatOptions = withYear
      ? { day: 'numeric', month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short' };
    return `${formatDayKey(ds[0]!, { day: 'numeric', month: 'short' })} – ${formatDayKey(ds[6]!, end)}`;
  }

  // The header range stays the PRIMARY week's even when next week is appended:
  // prev/next still move one week, so relabelling it to span both would be a lie
  // about what the arrows do. Next week names itself, on its own mark, in place.
  const rangeLabel = $derived(rangeOf(dates, true));
  const extensionRangeLabel = $derived(rangeOf(extensionDates, false));

  // ─── Add a day's recipe to the shopping list (Phase 4, #469) ──────────────
  // The RecipeAddToListSheet is lifted to the page (kept OUT of the shared, recipe-
  // free MealDayEditor). A row's "Add to shop" hands its full Recipe up here; we
  // guard exactly as RecipeViewPage does — a missing default list shows the same
  // friendly toast and never opens the sheet — then mount the familiar review sheet.
  let addShopRecipe = $state<Recipe | null>(null);
  let addShopOpen = $state(false);

  function openRecipeAddToList(recipe: Recipe): void {
    if (!$defaultListId) {
      addToast('No shopping list found. Create one first.', 'destructive');
      return;
    }
    addShopRecipe = recipe;
    addShopOpen = true;
  }

  // ─── Shop the week (issue #724, Phase 1) ──────────────────────────────────
  // The weekly shop is the single most repeated thing the planner is used for,
  // and until now it was the one thing the planner made you do a day at a time.
  // The header's cart offers the whole week's recipes at once; confirming drives
  // the EXISTING review sheet once per pick, in day order, each committing as you
  // confirm it. No new shopping-list write path, no merging, no de-duplication:
  // it is what you would get by pressing "Add to shop" four times yourself, and
  // the list's own display-time combining still names each item's contributors.

  // WHICH WEEK is the week you are looking at, which is the week the deck is
  // snapped to — from the last three days of the cycle the page holds thirteen or
  // fourteen days in one scroll, and by then the shop you are doing is usually for
  // the week you cannot see the top of. The days in deck order; the deck is handed
  // the same list, and this one is derived separately so the anchor never reaches
  // into the deck's own configuration.
  const deckDates = $derived([...dates, ...extensionDates]);

  // The day the deck has come to rest on: the LAST row whose stop is at or above
  // the current offset — i.e. the last one that has reached the top of the
  // viewport. Ties go to the FIRST row sharing a stop, which is what makes the two
  // degenerate cases honest: at the very bottom of the deck several trailing rows
  // clamp to the same maximum offset (the row actually under the header is the
  // first of them), and where nothing is laid out at all every stop is 0 and the
  // answer is the first day of the week rather than the last.
  //
  // Pixels, measured at the moment the button is pressed — this is read from the
  // click handler and nowhere else, so a lazily-evaluated `$derived` costs the
  // deck's own gesture nothing. Viewport geometry stays in the app layer (Rule 1),
  // exactly as `cookDeck` states and #639 re-affirmed.
  const anchorDate = $derived.by(() => {
    let anchor: string | null = deckDates[0] ?? null;
    let anchorStop = -1;
    for (const date of deckDates) {
      const el = rowEls[date];
      const stop = el ? deck.offsetOf(el) : null;
      if (stop === null || stop > deck.offset + 1 || stop <= anchorStop) continue;
      anchor = date;
      anchorStop = stop;
    }
    return anchor;
  });

  // The week the sheet was opened on, frozen at the press. The deck cannot move
  // behind a modal sheet, so this only ever differs from `anchorDate` in that it
  // does not re-measure — which keeps the deck's offset out of the sheet's own
  // reactivity. Everything else about a row (its recipe's title, its picture)
  // stays live, resolved from the stores below.
  let shopWeekAnchor = $state<string | null>(null);
  let showShopWeek = $state(false);

  // What the sheet offers: every recipe planned for that week from today onward.
  //
  // Days hold ids only, so the full recipe is resolved through the one shared
  // helper (`lib/attachedRecipes.ts`), which silently skips an id with no
  // matching document. The eligibility predicate is a SEPARATE step below rather
  // than fused into that filter, so each reads as the one question it answers.
  // Eligibility is the capability predicate, never a `kind ===` comparison — so a
  // takeaway and a note-only placeholder are absent and a cocktail is present,
  // and a fifth kind decides for itself in the domain table.
  //
  // Days already behind us are left out entirely rather than listed unticked:
  // there is no point shopping for a dinner that has been and gone, and the
  // shortest possible list is most of the point of this. A week wholly in the past
  // therefore yields nothing, and the sheet says so.
  const shopWeekEntries = $derived.by(() => {
    const anchor = shopWeekAnchor;
    if (!anchor) return [];
    const isNext = extensionDates.includes(anchor);
    const dateList = isNext ? extensionDates : dates;
    const days = isNext ? ($extensionWeek?.days ?? {}) : $currentWeek.days;
    return dateList
      .filter((date) => date >= todayDate)
      .flatMap((date) =>
        resolveRecipeIds(days[date]?.recipeIds ?? [], $recipesById)
          .filter((r) => takesIngredients(kindOf(r)))
          .map((recipe) => ({ date, recipe })),
      );
  });

  // The default-list guard runs ONCE, here, before the selection sheet — not per
  // recipe. Same friendly toast as every other way into the review sheet; with no
  // list to write to, nothing opens at all.
  function openShopWeek(): void {
    if (!$defaultListId) {
      addToast('No shopping list found. Create one first.', 'destructive');
      return;
    }
    shopWeekAnchor = anchorDate;
    showShopWeek = true;
  }

  // ─── The review queue ─────────────────────────────────────────────────────
  // In memory only (Rule 3), like every other "where am I in this glance at the
  // planner" fact on this page. Nothing about the sequence is written anywhere:
  // what has been confirmed is already on the list, and what has not is a decision
  // still to make.
  let shopQueue = $state<{ date: string; recipe: Recipe }[]>([]);
  let shopQueueIndex = $state(0);
  let shopQueueOpen = $state(false);
  const shopQueueEntry = $derived(shopQueue[shopQueueIndex] ?? null);
  // What the run has actually written so far, so the end can say it once instead
  // of four near-identical toasts in a row. Not `$state`: nothing renders it.
  let shopQueueAdded = 0;

  // The selection sheet closes and the first review sheet opens in the same
  // render, so the two never stack — `Sheet` and `Dialog` share the one `z-dialog`
  // rung and there is no sanctioned overlay-over-overlay pattern to mint.
  function startShopWeek(picked: readonly { date: string; recipe: Recipe }[]): void {
    showShopWeek = false;
    if (picked.length === 0) return;
    shopQueue = [...picked];
    shopQueueIndex = 0;
    shopQueueAdded = 0;
    shopQueueOpen = true;
  }

  // ─── The one thing the planner knows that the recipe page does not ────────
  // How many people are actually eating that night: the attendees marked on the
  // day plus any guests. Undefined when nobody has been marked, which is not a
  // headcount of zero — it is an unanswered question, and the sheet then opens at
  // the recipe's own servings exactly as it does everywhere else. `dayAt`, so a
  // night in the appended week is read from the week that holds it.
  function shopQueueServings(entry: { date: string }): number | undefined {
    const day = dayAt(entry.date);
    const eating = (day?.attendees.length ?? 0) + (day?.guests ?? 0);
    return eating > 0 ? eating : undefined;
  }

  // A closed review sheet means "done with this one" whichever way it closed:
  // confirmed, or dismissed and therefore skipped. That symmetry is the design —
  // stop halfway and what you confirmed is on the list, and nothing is held back
  // waiting for you to finish. A FAILED commit closes nothing: the sheet keeps
  // itself open behind its destructive toast, so the sequence stops there rather
  // than rolling silently on to the next recipe (Rule 10).
  function advanceShopQueue(): void {
    if (shopQueueIndex + 1 >= shopQueue.length) {
      shopQueue = [];
      shopQueueIndex = 0;
      shopQueueOpen = false;
      // One toast for the whole errand, in the same words a single add uses —
      // including when nothing was confirmed, which is a run of skips and worth
      // saying out loud rather than ending in silence.
      addToast(
        shopQueueAdded === 0
          ? 'Nothing added to the list.'
          : `Added ${shopQueueAdded} item${shopQueueAdded === 1 ? '' : 's'} to the list.`,
        'success',
      );
      return;
    }
    shopQueueIndex += 1;
    shopQueueOpen = true;
  }

  // ─── Shop day (issue #629, moved to the week by #640 Phase 4) ─────────────
  // The shop marker sits INSIDE the week wherever it falls — `firstDayOfWeek` and
  // the layout above are completely untouched, so the shop can move freely week to
  // week without disturbing anything. The service owns the one-shop-per-week rule
  // (marking a day clears any other in the same week) and keys its markers BY WEEK,
  // so with two weeks on screen each draws its own rule and marking next week's
  // shop never clears this week's.
  //
  // WHICH day you shop is a fact about the WEEK, so it is now set at the week's
  // own altitude: one control under the week nav, not a block inside one day's
  // sheet. Before, you opened Thursday to say "we shop Thursday" and the answer
  // then appeared as a rule across the list, somewhere else entirely.
  async function changeShopSlot(date: string, slot: ShoppingSlot | null): Promise<void> {
    const result = slot === null ? await clearShopDay(date) : await setShopDay(date, slot);
    if (result.kind !== 'ok') addToast('Failed to save the shopping day.', 'destructive');
  }

  // The picker follows the page's own header idiom (the same shape as "Load
  // template"): a small button that says the current answer, opening a dialog that
  // holds the whole choice. A Select of fourteen day×slot pairs would say the same
  // thing in a list you have to scroll on a phone; here every day of the week is on
  // screen at once and ONE tap sets both the day and the slot.
  let showShopPicker = $state(false);

  // Only rendered when the week has no shop day, so it names the action rather
  // than the (absent) answer — the answer, once there is one, is the rule itself.
  const shopLabel = 'Set a shop day';

  // One tap = the whole answer, so the dialog closes on it. Closing first keeps the
  // write off the dismissal path: the toast on failure (Rule 10) is the report, and
  // it is not worth holding the dialog open behind a Firestore round trip.
  function pickShopDay(date: string, slot: ShoppingSlot | null): void {
    showShopPicker = false;
    void changeShopSlot(date, slot);
  }

  // ─── Load template: which week? (#639, Phase 7) ───────────────────────────
  // The button used to fill whichever week happened to be displayed, silently,
  // behind a generic "are you sure". It now ASKS, offering three weeks anchored
  // on today — this one, next, and the one after that ("week commencing") — each
  // with its dates, and each carrying its OWN overwrite warning. One dialog: the
  // caution belongs against the week you are about to overwrite, not in a second
  // dialog that can only speak generally.
  const OFFER_TITLES = ['This week', 'Next week', 'Week commencing'];

  // What we know about a week's contents. `checking` and `unknown` are states we
  // say out loud rather than resolve optimistically: a week we could not read is
  // not a week we can promise is empty, and this dialog's only job is to be
  // specific about what would be lost.
  type WeekEdits = 'checking' | 'edits' | 'clear' | 'unknown';

  let showLoadPicker = $state(false);
  let pickedWeek = $state('');
  let weekEdits = $state<Record<string, WeekEdits>>({});
  let loadBusy = $state(false);
  // Discriminates the probes of one dialog opening from the last one's, so a slow
  // answer to a dismissed question can never paint a warning on a new question.
  let probeRun = 0;

  const offeredWeeks = $derived(templateWeekStarts(todayDate, $firstDayOfWeek));

  function requestLoadTemplate(): void {
    const weeks = offeredWeeks;
    // Default to the week you are looking at when it is one of the three, so the
    // old behaviour is still one tap away; otherwise this week.
    pickedWeek = weeks.includes($selectedStartDate) ? $selectedStartDate : weeks[0]!;
    weekEdits = Object.fromEntries(weeks.map((w) => [w, 'checking' as WeekEdits]));
    showLoadPicker = true;

    // Only one of these weeks is subscribed, so the rest are read (the service
    // answers from a held document when it has one). Errors never throw — they
    // land as `unknown` and the option says it could not be checked (Rule 10).
    const run = ++probeRun;
    for (const week of weeks) {
      void weekHasEdits(week).then((result) => {
        if (run !== probeRun) return;
        weekEdits = {
          ...weekEdits,
          [week]: result.kind !== 'ok' ? 'unknown' : result.value ? 'edits' : 'clear',
        };
      });
    }
  }

  async function doLoadTemplate(): Promise<void> {
    const target = pickedWeek;
    if (!target || loadBusy) return;
    loadBusy = true;
    const result = await loadTemplateIntoWeek(target);
    loadBusy = false;
    showLoadPicker = false;
    if (result.kind !== 'ok') {
      addToast('Failed to load the template.', 'destructive');
      return;
    }
    // Show the week that just changed. Filling a week you are not looking at and
    // staying put would leave the planner looking as though nothing happened.
    if (target !== $selectedStartDate) goToWeek(target);
  }

  // ─── Which day is open (#640, Phase 1) ────────────────────────────────────
  // The day opens in a bottom sheet, and the PAGE owns which one — one `$state`
  // for the whole run of days, so only one is ever open and the answer survives
  // the row re-rendering when a Firestore snapshot lands. Purely in memory: it is
  // a fact about this glance at the planner, never persisted (Rule 3). Dates are
  // unique across both weeks, so one field covers the extension too.
  //
  // Since #663 Phase 2 this same field is also WHICH DAY THE DOCKED PANE SHOWS on
  // a screen with room for two columns. Still one field: "the day you are looking
  // at" is one fact, and whether it is presented as a sheet over the week or as a
  // pane beside it is a fact about the screen, not about the day.
  let openDay = $state<string | null>(null);

  // ─── Day-editor handlers (bound to a concrete date) ───────────────────────
  // Every day mutator routes to the document its DATE belongs in (Phase 5), so a
  // day in next week saves to next week with no week argument here. What that
  // routing can do is REFUSE — a week it has never read is not a week it can
  // safely overwrite — and with two weeks on screen a silent refusal would look
  // exactly like a saved edit. So results are surfaced, not discarded (Rule 10).
  async function save(op: Promise<ReadResult<void, DomainError>>): Promise<void> {
    const result = await op;
    if (result.kind !== 'ok') addToast('Failed to save the day.', 'destructive');
  }

  // The day being edited may belong to either week, so read it from whichever one
  // holds that date — `currentWeek.days` alone would report next week's days as
  // empty and silently reset them.
  function dayAt(date: string): Day | undefined {
    return $currentWeek.days[date] ?? $extensionWeek?.days[date];
  }

  function toggleChef(date: string, memberId: string): void {
    const chefs = dayAt(date)?.chefs ?? [];
    const next = chefs.includes(memberId)
      ? chefs.filter((c) => c !== memberId)
      : [...chefs, memberId];
    void save(setWeekDayChefs(date, next));
  }

  function toggleAttendee(date: string, memberId: string): void {
    const attending = dayAt(date)?.attendees.some((a) => a.memberId === memberId);
    if (attending) {
      void save(removeWeekAttendee(date, memberId));
    } else {
      // Home time starts blank; the picker seeds 18:30 when first opened.
      const attendee: Attendee = { memberId, homeTime: null, note: '' };
      void save(addWeekAttendee(date, attendee));
    }
  }

  // ─── Side by side, once there is room (#663, Phase 2) ─────────────────────
  // On a screen that can hold both — the target is a Pixel 9 Pro Fold, unfolded —
  // the week and the open day sit SIDE BY SIDE: the run of dated day cards on the
  // left at exactly the size a phone gives them, and the day you are looking at
  // docked on the right. Tapping another day swaps the pane; nothing slides over
  // the week, and the week never moves.
  //
  // The LAYOUT is entirely CSS (the `split` variant, declared in app.css). Only
  // two BEHAVIOURS need the answer in script — seeding which day the pane opens
  // on, and suppressing the sheet — so the page holds one reactive boolean rather
  // than a second copy of the gate in markup.
  //
  // ⚠ The query is the SAME one as `@custom-variant split` in `src/app.css`. A
  // Tailwind variant cannot be read from JS, so the seam is spelled twice and the
  // two MUST move together. This page no longer holds either spelling — the JS
  // one is `SPLIT_QUERY` in `lib/mediaQuery.svelte.ts` (issue #933), and
  // `tests/sharedHelperGuard.test.ts` fails if a third appears anywhere in `src`.
  // The reasoning behind the two numbers (and why this is not `md:`, and why it
  // is not the nav's `lg` seam) is on the variant, which is where a reader
  // looking at the layout will land.
  //
  // That constant is written in RANGE syntax, which is what Tailwind v4 actually
  // emits for the variant (`@media (width>=700px) and (height>=480px)`), rather
  // than the `min-width:`/`min-height:` form the variant is authored in. It has
  // to be the form the browser sees, not the form we typed: on an engine too old
  // for range syntax the emitted CSS is inert, and a `min-width:` query would answer
  // "yes, split" to a page that is still one column — suppressing the sheet with
  // no pane to replace it, which is a planner where tapping a day does nothing.
  // Same syntax, same parser, so the two agree in both directions; an unparseable
  // query is `not all`, i.e. `false`, which is exactly the phone path.
  // The read itself, and the four ways it can fail, are
  // `lib/mediaQuery.svelte.ts` — which generalises the shape `isCoarsePointer`
  // in `lib/swipe.svelte.ts` already used, and which this page's own comment
  // called the house pattern for a live media read.
  const split = createMediaQuery(SPLIT_QUERY);
  const isSplit = $derived(split.matches);

  // The pane opens on TODAY, the same day the deck itself lands on, so arriving
  // with the phone unfolded shows tonight without a tap.
  //
  // It is also the repair: paging to another week leaves `openDay` pointing at a
  // date that is no longer in the deck, and a blank pane beside a full week is
  // worse than the week's first day. Still one field, still in memory only (Rule
  // 3) — this only ever rewrites it when the day it holds has left the screen.
  //
  // Nothing here runs below the gate: `isSplit` is false, the effect returns, and
  // the planner is byte-for-byte the single column and bottom sheet it is today.
  $effect(() => {
    if (!isSplit) return;
    if (openDay !== null && (dates.includes(openDay) || extensionDates.includes(openDay))) return;
    openDay = todayIndex >= 0 ? todayDate : (dates[0] ?? null);
  });

  // What the pane shows. `dayAt`, not `$currentWeek.days`, for the reason given on
  // that function: from the last three days of the cycle the deck also holds next
  // week, and those days live in a second document.
  const paneDate = $derived(isSplit ? openDay : null);
  const paneDay = $derived(paneDate ? dayAt(paneDate) : undefined);
</script>

<!-- One week's worth of rows, rendered identically for the week you are on and for
     next week appended beneath it (#639, Phase 6). Everything that differs between
     the two is a parameter: which document the days come from, which shop marker
     applies, and whether "already behind us" can mean anything (it cannot in next
     week — all of it is ahead). Deliberately NOT a component: it is this page's
     own markup, and the rows must stay direct children of the deck column so the
     one gesture spans both weeks. -->
{#snippet weekRows(
  dateList: string[],
  days: Record<string, Day>,
  shop: ShoppingDayDoc | null,
  isExtension: boolean,
)}
  {#each dateList as date, i (date)}
    {@const day = days[date]}
    {@const isEarlier = !isExtension && todayIndex > 0 && i < todayIndex}
    {#if day}
      <!-- The row the docked pane is showing (#663, Phase 2). Only above the gate:
           on a phone the SHEET is the selected state, and nothing in the list is
           allowed to change. -->
      {@const isSelected = isSplit && openDay === date}
      <!-- The wrapper is the page's grip on the row: it is what we anchor the
           scroll to, what carries the quieter treatment for days already behind
           us, and what marks a row as belonging to next week. MealDayEditor
           itself is untouched (it is shared with the template editor, which has
           no notion of "today"). Today is excluded from the next-week rail
           treatment on purpose: today outranks which week it falls in, and keeps
           its filled teal disc wherever it is. -->
      <!-- Its own testid, because the wrapper is the DECK'S SECTION and the day's
           card is not: a day carrying a mark starts with that mark, so the card
           sits well below the place the deck actually snaps to. A geometry test
           addressing the card would silently measure the wrong box. -->
      <!-- The selected treatment must cost the row NO LAYOUT: this element is the
           deck's section, and the deck measures its geometry to decide where a day
           comes to rest. So the mark is an absolutely-positioned overlay, out of
           flow entirely — never padding, a border or a margin on the row itself.
           `data-selected` is the same fact stated plainly, so a test can assert
           selection without depending on a class string. -->
      <div
        bind:this={rowEls[date]}
        data-testid={`day-${date}-row`}
        data-selected={isSelected ? 'true' : undefined}
        class="{isEarlier ? 'opacity-60' : ''} {isExtension && date !== todayDate
          ? 'planner-next-week-row'
          : ''} {isSelected ? 'relative' : ''}"
      >
        {#if isSelected}
          <!-- THE RAIL LIGHTS UP beside the day the pane is showing: a 4px bar down
               the row's left edge, sitting exactly on the week's own rail stem.
               It marks the day in the RAIL rather than around the row, and both
               halves of that are the point. An outline around the row was tried
               first and is wrong twice over: most of the row is the rail's empty
               margin, so a box there encloses nothing and reads as a stray
               container; and the half worth looking at is the photograph, where a
               hairline of any colour disappears into the picture. It could not be
               drawn outside the row either — the row fills the deck's column edge
               to edge and the deck viewport is `overflow-hidden`, so a ring with an
               offset loses its left and right sides entirely.
               The bar answers all of it: it is in the empty margin where nothing
               competes with it, it is inside the row's bounds so nothing clips it,
               and it composes with today's filled teal disc instead of fighting it
               — which matters, because today is the day the pane opens on.
               Absolute, so the deck cannot tell the selected row from any other. -->
          <span
            class="pointer-events-none absolute inset-y-0 left-0 w-1 rounded-full bg-tertiary-variant"
            aria-hidden="true"
          ></span>
        {/if}
        {#if isExtension && i === 0}
          <!-- The dated mark. Same rule-across-the-list grammar as the shop day,
               dashed and terracotta, and it names the dates so "next week" is a
               fact rather than a direction. Inside the first day of next week for
               the same reason the shop rule is inside its own day: it is the one
               thing you need on screen when you arrive there, and a mark above the
               deck's section is the one thing snapping to it scrolls away. A week
               boundary is not really a fact about a day — this is the cost of
               keeping it visible when it matters. -->
          <div class="mb-4 flex items-center gap-2 pl-3" data-testid="next-week-mark">
            <span
              class="shrink-0 text-sm font-semibold uppercase leading-none tracking-wider"
              style="color: var(--planner-rail-ink)"
            >
              Next week · {extensionRangeLabel}
            </span>
            <span
              class="flex-1 border-t-2 border-dashed"
              style="border-color: var(--planner-rail-ink)"
            ></span>
          </div>
        {/if}
        {#if shop?.date === date}
          <!-- The shop day is a RULE ACROSS THE LIST, not a badge on a row: a
               cart and the slot, then a hairline running to the edge, so the
               week visibly divides into "before the shop" and "after" wherever
               the shop happens to fall. The slot is copy only — both nudge at the
               same hour the evening before — and stays lower-case in the DOM,
               with the caps done in CSS. Both weeks draw their own, so this
               week's shop and next week's are visible in the same scroll. -->
          <!-- INSIDE the day's wrapper, not a sibling above it: the wrapper is
               the deck's section, so a marker outside it is the one thing that
               snapping to the shop day pushes off the top of the screen. It is
               the day's own rule now — it travels with it, and landing on the
               shop day lands on the fact that it IS the shop day. `mb-4` keeps
               the 16px the old `-mb-2` bought against the column's `gap-6`; the
               24px above it is that same gap, now measured to the wrapper. -->
          <!-- Sage, not terracotta: terracotta already means "next week" in this
               list, and a second rule in the same ink would read as another week
               boundary. The label INTERRUPTS its rule rather than sitting above
               it — the same grammar as the next-week mark directly above, and the
               two marks are the same kind of thing (a labelled division of the
               list), so they are drawn the same way and differ only in ink and in
               dash. Tapping it opens the same picker the header used to — the rule
               is now the control, which is why the header no longer carries one. -->
          <button
            type="button"
            class="mb-4 flex w-full items-center gap-2 pl-3 text-left"
            onclick={() => (showShopPicker = true)}
            data-testid={`day-${date}-shop-marker`}
          >
            <!-- `leading-none` is what actually centres the cart against the words:
                 `items-center` centres the two BOXES, and an uppercase line box is
                 taller than its glyphs (all that unused descender space), so the
                 icon reads a shade high beside it until the text box hugs its
                 letters. -->
            <span
              class="flex shrink-0 items-center gap-1.5 text-sm font-semibold uppercase leading-none tracking-wider text-secondary"
            >
              <!-- Sized and weighted against the WORDS, not against the nominal
                   text size: the cart is drawn inside its box with room to spare,
                   so at the text's own 16px it reads smaller than the caps beside
                   it, and lucide's default 2px stroke is lighter than a semibold
                   uppercase stem. 18px at 2.5 matches both. -->
              <ShoppingCart class="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden="true" />
              Shop · {shop.slot}
            </span>
            <span class="flex-1 border-t-2 border-secondary"></span>
          </button>
        {/if}
        <!-- Docked, the sheet is SUPPRESSED, not hidden (#663, Phase 2) — hence the
             `!isSplit` in the `open` getter below. A modal dialog's scrim, focus
             trap and scroll lock are real whether or not you can see it, and covered
             chrome that is still focusable is exactly the bug #641 was about, so the
             day never opens as a dialog at all while there is a pane to show it in.
             MealDayEditor gains no prop and no second mode: the page already owned
             this binding, and tapping a row still means "this is the day I am
             looking at" — only the presentation differs. -->
        <MealDayEditor
          label={formatDayKey(date, { weekday: 'short' })}
          sublabel={formatDayKey(date, { day: 'numeric' })}
          sheetTitle={formatDayKey(date, { weekday: 'long', day: 'numeric', month: 'long' })}
          bind:open={
            () => !isSplit && openDay === date,
            (v) => {
              // Opening a day closes whichever was open; closing only clears the
              // field when this row still owns it, so a stale close can never
              // shut the day somebody just opened.
              if (v) openDay = date;
              else if (openDay === date) openDay = null;
            }
          }
          {day}
          members={$people}
          recipes={$recipes}
          recipesById={$recipesById}
          testid={`day-${date}`}
          isToday={date === todayDate}
          weather={$weatherForecast?.days[date]}
          dateKey={date}
          onNoteChange={(note) => void save(setWeekDayNote(date, note))}
          onRecipesChange={(ids) => void save(setWeekDayRecipes(date, ids))}
          onRecipeAddToList={openRecipeAddToList}
          onChefToggle={(id) => toggleChef(date, id)}
          onAttendeeToggle={(id) => toggleAttendee(date, id)}
          onAttendeeHomeTime={(id, t) => void save(setWeekAttendeeHomeTime(date, id, t))}
          onAttendeeNote={(id, n) => void save(setWeekAttendeeNote(date, id, n))}
          onGuestsChange={(g) => void save(setWeekDayGuests(date, g))}
        />
      </div>
    {/if}
  {/each}
{/snippet}

<!-- One week's days as shop options: the day written out, then AM and PM. The
     order is `weekDates`, so the list runs in the household's own week order
     (`firstDayOfWeek`) rather than a hard-coded Mon–Sun. "No shop day" appears
     only for a week that HAS one — there is nothing to clear otherwise, and an
     always-present clear would be the loudest thing in a list of days. -->
{#snippet shopWeekOptions(dateList: string[], shop: ShoppingDayDoc | null, heading: string | null)}
  {#if heading}
    <p class="pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {heading}
    </p>
  {/if}
  {#each dateList as d (d)}
    {@const isShop = shop?.date === d}
    <div class="flex items-center gap-2" data-testid={`week-shop-row-${d}`}>
      <span
        class="min-w-0 flex-1 truncate text-sm {isShop
          ? 'font-medium text-foreground'
          : 'text-muted-foreground'}"
      >
        {formatDayKey(d, { weekday: 'long', day: 'numeric', month: 'short' })}
      </span>
      <Button
        variant={isShop && shop?.slot === 'am' ? 'solid' : 'outline'}
        size="sm"
        onclick={() => pickShopDay(d, 'am')}
        aria-pressed={isShop && shop?.slot === 'am'}
        data-testid={`week-shop-${d}-am`}
      >
        AM
      </Button>
      <Button
        variant={isShop && shop?.slot === 'pm' ? 'solid' : 'outline'}
        size="sm"
        onclick={() => pickShopDay(d, 'pm')}
        aria-pressed={isShop && shop?.slot === 'pm'}
        data-testid={`week-shop-${d}-pm`}
      >
        PM
      </Button>
    </div>
  {/each}
  {#if shop}
    {@const marked = shop.date}
    <button
      type="button"
      class="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
      onclick={() => pickShopDay(marked, null)}
      data-testid={`week-shop-clear-${dateList[0]}`}
    >
      No shop day
    </button>
  {/if}
{/snippet}

<ListPage title="Meal plan" isLoading={$isLoadingMealPlanWeek} fill class="p-4 sm:p-6">
  {#snippet actions()}
    <!-- Shop the week (#724). Icon-only, and measured rather than preferred: the
         planner's header already carries "Meal plan" and "Load template", and on
         the 393px phone this page is pinned to in e2e there is no room left for a
         second worded button. The cart is the word — it is the same pictogram the
         shop-day rule and the shopping nav already use — and the action is named
         in full for anyone who cannot see it.
         Always present and always enabled: a week with nothing to shop for opens
         the sheet onto its empty state rather than hiding the control, because a
         control that comes and goes is hardest to find on exactly the unplanned
         week where someone is looking for it. -->
    <Button
      variant="outline"
      size="sm"
      onclick={openShopWeek}
      aria-label="Shop the week"
      data-testid="shop-week-trigger"
    >
      <ShoppingCart class="h-4 w-4" aria-hidden="true" />
    </Button>
    <Button size="sm" onclick={requestLoadTemplate} data-testid="load-template">
      Load template
    </Button>
  {/snippet}

  {#snippet children()}
    <!-- Side by side, once there is room (#663, Phase 2) ─────────────────────
         Below the gate this is one flex COLUMN holding exactly what it holds
         today — the week nav, the shop header, the deck — so a phone (and the
         fold's cover screen) is untouched. Above it the same three become the
         LEFT column and the docked day appears beside them, and the week never
         moves: nothing slides over it, so tapping another day only ever swaps
         what the pane is showing.
         The two columns are equal halves with a 40px gutter between them, which
         is the whole mechanism that keeps the gutter OVER THE FOLD'S CREASE — not
         the CSS Viewport Segments API, which this device does not report (it says
         it has one segment, so that code path would never run on the only
         hardware this targets).
         `justify-center` matters only between the `split` gate and `lg`, where the
         540px ceiling below still binds: the pair stops growing and sits centred
         with even space each side, while "Meal plan" and "Load template" stay
         exactly where they are on every other page — they are ListPage's header,
         above this box. Above `lg` the ceiling no longer applies (see the two
         columns below), so both are unbounded `flex-1` and fill the row; there is
         no free space left to distribute and `justify-center` is inert. It stays
         because it is what centres the pair on the fold, which is the size it was
         written for.
         Wrapping the three existing children in one flex column is layout-neutral
         below the gate: ListPage's content box is already `flex flex-1 flex-col
         min-h-0` with no gap of its own (the spacing is the children's `mt-*`). -->
    <div class="flex min-h-0 flex-1 flex-col split:flex-row split:justify-center split:gap-10">
      <!-- The week, at exactly the size a phone gives it. `max-w-[540px]` is the
           ceiling it shares with the pane, so between the fold and `lg` the week
           does not stretch into something the day cards were never drawn for.
           `max-lg:` stops that ceiling at `lg` (#1143, Phase 2). The cap exists to
           hold the 40px gutter over a Pixel 9 Pro Fold's crease and to keep day
           cards at phone width; above `lg` there is no crease and no fold, so the
           reason for it does not apply and the reclaimed width would otherwise
           become centring margin — most visibly when the side navigation is
           collapsed, which would then look like a control that does nothing on this
           one page.
           It is spelled as a NARROWED `split:` rather than as a separate
           `lg:max-w-none` override, and that is not a style preference. Tailwind
           emits the `split:` utilities AFTER the `lg:` ones, and both are
           single-class selectors, so at a width matching both media queries the
           `split:` rule wins on source order — an `lg:` override of a `split:`
           class is silently dead. That is not a new breakpoint: `max-lg` is the
           standard `lg` seam read from the other side, and below `lg` this compiles
           to exactly the media query it compiled to before, which is why
           `mealplan-split.spec.ts` at 755px cannot see the change. -->
      <div
        class="flex min-h-0 flex-1 flex-col split:min-w-0 split:max-lg:max-w-[540px]"
        data-testid="week-column"
      >
        <div class="flex items-center justify-between gap-2" data-testid="week-nav">
          <Button variant="outline" size="sm" onclick={prevWeek} aria-label="Previous week">
            <ChevronLeft class="h-4 w-4" />
          </Button>
          <div class="flex flex-col items-center">
            <span class="text-sm font-medium" data-testid="week-range">{rangeLabel}</span>
            <button
              class="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onclick={thisWeek}
              data-testid="this-week"
            >
              This week
            </button>
          </div>
          <Button variant="outline" size="sm" onclick={nextWeek} aria-label="Next week">
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>

        <!-- The week's shop day (#640, Phase 4, since reduced). Once a shop day
             is set, the rule across the list IS the control — it says the answer in
             place and opens the picker when tapped, so a permanent header row saying
             the same thing was the most expensive line on the page. What the rule
             cannot do is exist when there is no shop day, so the header keeps exactly
             that case: an unset week still has somewhere to say so from. -->
        {#if !$weekShopDay}
          <div class="mt-1 flex justify-center" data-testid="week-shop">
            <Button
              variant="ghost"
              size="sm"
              class="gap-1.5 text-muted-foreground"
              onclick={() => (showShopPicker = true)}
              data-testid="week-shop-trigger"
            >
              <ShoppingCart class="h-[15px] w-[15px]" aria-hidden="true" />
              {shopLabel}
            </Button>
          </div>
        {/if}

        <!-- The deck. The viewport is the clipping box — it takes the height ListPage's
             `fill` hands down — and the column inside it is moved by a transform, so
             this page owns the gesture end to end rather than sharing a scroller with
             the shell. The cue overlay is a SIBLING of the viewport, not a child of the
             moving column: `sticky` means nothing inside a transformed element, and an
             overlay that travelled with the days would defeat the point of pinning it. -->
        <div class="relative mt-4 flex min-h-0 flex-1 flex-col">
          <!-- A native scroller is focusable and arrow-key operable for free, and this
               element replaces one, so the tabindex and the key handler are how that
               behaviour is KEPT rather than dropped — the same trade cook mode makes.
               Cook mode can use a bare <main> for its viewport because it is a
               full-viewport page; here the shell already owns the <main>, so the role
               is stated explicitly rather than nesting a second landmark. Named after
               the week it holds, so the region announces what it contains. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            bind:this={deck.viewportEl}
            class="relative min-h-0 flex-1 touch-pinch-zoom overflow-hidden salt-focus-ring-inset"
            role="region"
            tabindex="0"
            aria-label="Week of {rangeLabel}"
            data-testid="week-deck"
            onpointerdown={deck.handlePointerDown}
            onpointermove={deck.handlePointerMove}
            onpointerup={deck.handlePointerUp}
            onpointercancel={deck.handlePointerUp}
            onwheel={deck.handleWheel}
            onkeydown={deck.handleKeyDown}
          >
            <!-- The week as one list of dated days, 24px apart (#639): each row is its
                 own object, held together by its rail and the air around it. From the
                 last three days of the cycle a SECOND week follows in the same column
                 (Phase 6) — one continuous deck of twelve to fourteen days, not two
                 lists and not a second scroller. -->
            <div
              bind:this={deck.contentEl}
              class="flex flex-col gap-6 pb-2 will-change-transform"
              style="transform: translate3d(0, {-deck.offset}px, 0)"
            >
              <!-- This week. Its rail's stem is the DEFAULT state of the same element
                   next week recolours: one continuous line down the whole run of days,
                   in the empty left margin of the rail column, so there is an edge to
                   run the eye down (#639, "a continuous dated rail"). Solid and in the
                   border ink — the shop rule's hairline weight — because next week's
                   job is to differ from this, not the other way round. Decorative: the
                   dates beside it say everything it says. -->
              <div class="relative flex flex-col gap-6">
                <!-- `left-0`: the stem belongs to the DATED COLUMN it runs beside,
                     not to the page. #647 exiled it 10px into the gutter (with a
                     matching viewport bleed) to keep it off the marks it used to run
                     through — but the marks now start at `pl-[3px]`, which is what
                     actually clears it, and out in the gutter it read as page chrome
                     rather than as the rail's own spine. The shop rule and the
                     next-week mark butt against it instead: a branch off the rail,
                     which is the structure they describe. -->
                <span
                  class="pointer-events-none absolute inset-y-0 left-0 w-0 border-l-2 border-border"
                  data-testid="this-week-rail"
                  aria-hidden="true"
                ></span>

                {@render weekRows(dates, $currentWeek.days, $weekShopDay, false)}
              </div>

              {#if extensionDates.length}
                <!-- Next week. Its rail is burnt terracotta and dashed — a HUE SHIFT at
                     the same weight, never a lighter tint, because "quieter" already
                     means "behind you" in this list and a recessive next week would
                     read as past. The colour is set once here, week-scoped, and read
                     by the mark, the stem and (via the scoped rule below) each row's
                     rail; MealDayEditor takes no new prop for it. -->
                <div
                  class="planner-next-week relative flex flex-col gap-6"
                  style="--planner-rail-ink: var(--color-tertiary-variant)"
                  data-testid="next-week-block"
                >
                  <!-- The rail's stem: one dashed line down the whole run of days, in
                       the empty left margin of the rail column so it never crosses the
                       dates it belongs to. Decorative — the mark below says it in words. -->
                  <span
                    class="pointer-events-none absolute inset-y-0 left-0 w-0 border-l-2 border-dashed"
                    style="border-color: var(--planner-rail-ink)"
                    aria-hidden="true"
                  ></span>

                  {@render weekRows(
                    extensionDates,
                    $extensionWeek?.days ?? {},
                    $extensionWeekShopDay,
                    true,
                  )}
                </div>
              {/if}
            </div>
          </div>

          <!-- The scroll-up cue (#639, Phase 2). Landing mid-list gives no clue there
               is anything above, so once the deck has moved a shadow appears under the
               sticky app header. Zero-height and pinned to the top of the viewport, so
               it costs the list no space and today's row still sits flush under the
               header; `-mx-4 sm:-mx-6` cancels this page's own ListPage padding so the
               shadow runs edge to edge. The shadow is the whole cue: the pill that
               used to name the earlier days sat over the first card and said what the
               shadow and one swipe already do.
               `split:mx-0` (#663, Phase 2): once the week is a column beside the pane
               it no longer touches the page's edges, so cancelling the page padding
               would bleed the shadow into the gutter — over the crease, which is the
               one place nothing may be drawn. -->
          {#if scrolled}
            <div
              class="pointer-events-none absolute inset-x-0 top-0 z-10 -mx-4 sm:-mx-6 split:mx-0"
            >
              <div
                class="h-3 w-full bg-gradient-to-b from-foreground/10 to-transparent"
                data-testid="scroll-shadow"
              ></div>
            </div>
          {/if}
        </div>
      </div>

      <!-- The docked day (#663, Phase 2). It is a PANE, not a dialog: no scrim, no
           focus trap, no scroll lock — which is exactly why the row's sheet is
           SUPPRESSED rather than painted over while this is showing. It lives
           INSIDE the page's own filled box and is never `fixed inset-0`, so the
           bottom navigation bar keeps its space and stays reachable (Rule 7, issue
           #641); at this size the SideNav has not appeared yet and must not.
           It owns its own `overflow-y-auto` and carries `min-h-0`, which is the
           consuming-page contract for a `fill` ListPage (ui-spec-v05 §1.4). No new
           `@salt/ui-components` surface is added — this is one page's layout.
           The <aside> is the LAYOUT box and the card inside it is the PRESENTATION
           box, deliberately: `flex-1` shares free space between CONTENT boxes, so a
           flex child carrying its own border and padding ends up exactly that much
           wider than its bare sibling — and equal halves are what put the gutter on
           the crease. Chrome on the inner div costs the outer box nothing.
           `max-lg:` stops the shared 540px ceiling at `lg`, in step with the week
           column (#1143, Phase 2) — above `lg` there is no crease to hold the gutter
           over, and narrowing only one of the pair would break the equal halves the
           gutter depends on below it. See the week column for why the ceiling is
           narrowed in place rather than overridden by a later `lg:` class. -->
      <aside
        class="hidden min-h-0 split:flex split:min-w-0 split:flex-1 split:flex-col split:max-lg:max-w-[540px]"
        aria-label="Selected day"
        data-testid="day-pane"
      >
        <!-- Contents only when there is a day to show, so a phone mounts NOTHING in
             here — the day's detail exists exactly once on the page, in the sheet,
             rather than a second copy sitting behind `display: none`. -->
        {#if paneDate && paneDay}
          <div
            class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-lg border bg-card p-4"
          >
            <!-- The pane names its day, in the same words the sheet's own title
                 uses. A detail with no date on it would be a regression against the
                 sheet, which always says which day it opened. -->
            <h2 class="text-base font-semibold text-foreground" data-testid="day-pane-title">
              {formatDayKey(paneDate, { weekday: 'long', day: 'numeric', month: 'long' })}
            </h2>

            <!-- `testid="day-pane"`, never the day's own: this renders the SAME
                 detail the sheet does, so reusing `day-<date>-*` would give every
                 field in it a duplicate under strict-mode queries. -->
            <MealDayDetail
              day={paneDay}
              members={$people}
              recipes={$recipes}
              recipesById={$recipesById}
              testid="day-pane"
              weather={$weatherForecast?.days[paneDate]}
              dateKey={paneDate}
              onNoteChange={(note) => void save(setWeekDayNote(paneDate, note))}
              onRecipesChange={(ids) => void save(setWeekDayRecipes(paneDate, ids))}
              onRecipeAddToList={openRecipeAddToList}
              onChefToggle={(id) => toggleChef(paneDate, id)}
              onAttendeeToggle={(id) => toggleAttendee(paneDate, id)}
              onAttendeeHomeTime={(id, t) => void save(setWeekAttendeeHomeTime(paneDate, id, t))}
              onAttendeeNote={(id, n) => void save(setWeekAttendeeNote(paneDate, id, n))}
              onGuestsChange={(g) => void save(setWeekDayGuests(paneDate, g))}
            />
          </div>
        {/if}
      </aside>
    </div>
  {/snippet}
</ListPage>

<!-- Which week? (#639, Phase 7). The warning is INSIDE the option it is about —
     part of that radio's own label, so it is read out with the week it would
     overwrite — rather than one line of general caution under the group. -->
<Dialog open={showLoadPicker} onOpenChange={(v) => (showLoadPicker = v)}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="load-template-picker">
      <DialogHeader>
        <DialogTitle>Load the standard template</DialogTitle>
        <DialogDescription>
          Choose a week to fill. Its days are replaced with the standard template.
        </DialogDescription>
      </DialogHeader>
      <RadioGroup
        label="Week to fill"
        value={pickedWeek}
        onValueChange={(v: string) => (pickedWeek = v)}
      >
        {#each offeredWeeks as start, i (start)}
          <RadioGroupItem value={start} class="items-start" disabled={loadBusy}>
            <span class="flex flex-col gap-0.5">
              <span class="text-sm font-medium text-foreground">{OFFER_TITLES[i]}</span>
              <span class="text-xs text-muted-foreground">{rangeOf(weekDates(start), false)}</span>
              {#if weekEdits[start] === 'edits'}
                <span
                  class="text-xs text-destructive"
                  data-testid={`load-template-warning-${start}`}
                >
                  Already has edits — they will be lost.
                </span>
              {:else if weekEdits[start] === 'unknown'}
                <span
                  class="text-xs text-destructive"
                  data-testid={`load-template-unknown-${start}`}
                >
                  Couldn't check this week for edits — it may have some.
                </span>
              {:else if weekEdits[start] === 'checking'}
                <span class="text-xs text-muted-foreground">Checking for edits…</span>
              {/if}
            </span>
          </RadioGroupItem>
        {/each}
      </RadioGroup>
      <DialogFooter>
        <Button variant="outline" onclick={() => (showLoadPicker = false)} disabled={loadBusy}>
          Cancel
        </Button>
        <Button
          onclick={doLoadTemplate}
          loading={loadBusy}
          disabled={loadBusy}
          data-testid="load-template-confirm-btn"
        >
          Load template
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Which day do we shop? (#640, Phase 4). The whole week is on screen at once and
     one tap answers both halves of the question — the day and the slot — so the
     dialog closes on it. When next week is appended to the deck it is offered here
     too, under its own heading: at the end of a cycle the week you are provisioning IS
     next week, and the service scopes "one shop per week" by the DATE's week, so
     marking one week's shop never disturbs the other's. -->
<Dialog open={showShopPicker} onOpenChange={(v) => (showShopPicker = v)}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="week-shop-picker">
      <DialogHeader>
        <DialogTitle>Shopping day</DialogTitle>
        <DialogDescription>
          One shop a week. AM or PM is a note to each other — the reminder comes the evening before
          either way.
        </DialogDescription>
      </DialogHeader>
      <div class="flex max-h-[60dvh] flex-col gap-1.5 overflow-y-auto">
        {@render shopWeekOptions(dates, $weekShopDay, extensionDates.length ? 'This week' : null)}
        {#if extensionDates.length}
          {@render shopWeekOptions(extensionDates, $extensionWeekShopDay, 'Next week')}
        {/if}
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (showShopPicker = false)}
          data-testid="week-shop-done"
        >
          Done
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Add a day's recipe to the shopping list: the same review sheet the recipe page
     uses (issue #185), mounted once and driven by the selected recipe. Gated on a
     default list existing — mirrors RecipeViewPage exactly. -->
{#if addShopRecipe && $defaultListId}
  <RecipeAddToListSheet recipe={addShopRecipe} listId={$defaultListId} bind:open={addShopOpen} />
{/if}

<!-- Shop the week (#724): pick the nights… -->
<WeekShopSheet bind:open={showShopWeek} entries={shopWeekEntries} onConfirm={startShopWeek} />

<!-- …then review each in turn, in the sheet the recipe page and the day panel
     already use, driven once per pick.
     `{#key}` on the queue position is what makes each recipe a genuinely NEW
     sheet: the review sheet seeds its servings on the open transition, so handing
     the same instance a second recipe without unmounting it would leave the last
     one's servings on screen. Keyed, the old instance is destroyed and the next
     one mounts open in the same render — "the next recipe's sheet opens in its
     place", and never two overlays at once. -->
{#if shopQueueEntry && $defaultListId}
  {#key shopQueueIndex}
    <RecipeAddToListSheet
      recipe={shopQueueEntry.recipe}
      listId={$defaultListId}
      servings={shopQueueServings(shopQueueEntry)}
      sequence={{ index: shopQueueIndex + 1, total: shopQueue.length }}
      onSettled={(added) => (shopQueueAdded += added)}
      bind:open={
        () => shopQueueOpen,
        (v) => {
          shopQueueOpen = v;
          if (!v) advanceShopQueue();
        }
      }
    />
  {/key}
{/if}

<style>
  /* Next week's rail ink (#639, Phase 6).
   *
   * MealDayEditor's collapsed summary is SHARED with the template editor and is
   * settled markup, so the colour arrives as a week-scoped custom property on the
   * week block above rather than as a new prop — this rule is the only thing that
   * reaches into the row, and it reaches only for the two rail spans.
   *
   * `:global` deliberately: the selector is rooted at a class this page alone
   * writes, and Svelte's scoping cannot see through a conditional class
   * expression to keep the rule alive.
   *
   * `:nth-child(-n + 2)` is the rail's weekday word and its date, and stops short
   * of the third child — the evening forecast, which keeps its own
   * temperature-band colour. Today's row never carries this class (today outranks
   * which week it is in), so its filled teal disc is untouched. */
  :global(
    .planner-next-week-row [data-testid$='-summary'] > div:first-child > span:nth-child(-n + 2)
  ) {
    color: var(--planner-rail-ink);
  }
</style>
