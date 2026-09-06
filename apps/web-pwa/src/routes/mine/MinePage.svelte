<script lang="ts">
  import {
    Button,
    Card,
    Dial,
    Icon,
    Progress,
    RadioGroup,
    RadioGroupItem,
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    Switch,
  } from '@salt/ui-components';
  import type { IconName } from '@salt/ui-components';
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import {
    recipeHeroUrl,
    formatClock,
    isChatReadOnly,
    timerHeat,
    timerProgress,
    withKitchenTimerDismissed,
    withKitchenTimerStarted,
    withTimerDismissed,
    type Recipe,
    type TimerHeat,
  } from '@salt/domain';
  import { kitchenLabel } from '../../lib/membersService.js';
  import {
    liveCooks,
    myTimers,
    needsReviewRecipes,
    recentChats,
    timerNowMs,
    tonight,
    upcomingChefNights,
    type LiveCook,
    type MineKitchenTimer,
    type MineTimer,
    type UpcomingChefNight,
  } from '../../lib/personalViewService.js';
  import { subscribeKitchenWeeks } from '../../lib/mealPlanService.js';
  import { persistCookSession, removeCookSession } from '../../lib/cookSessionService.js';
  import { getKitchenTimersSnapshot, persistKitchenTimers } from '../../lib/kitchenTimerService.js';
  import { persistRecipe, recipes } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { primeChime } from '../../lib/chime.js';
  import {
    AD_HOC_TIMER_LABEL,
    AD_HOC_TIMER_MINUTES,
    shouldNotifyFor,
  } from '../../lib/timerDefaults.js';
  import CookTimerSheet from '../recipes/CookTimerSheet.svelte';
  import {
    kitchenPrefs,
    type KitchenDensity,
    type KitchenSection,
  } from '../../lib/kitchenDashboardPrefs.svelte.js';

  // "My Kitchen" (issues #634, #682, #755, #843, #842) — what of mine is running
  // right now, what is coming at me, and what needs a look. Five sections, in
  // order:
  //
  //   1. Timers       — running and fired-but-undismissed, in one list, from a
  //                     cook or from nobody's cook at all; plus Start a timer
  //   2. Cooking now  — my open cook sessions
  //   3. Cooking soon — the nights from today onward that I am chef on
  //   4. Needs review — entries flagged `needs_approval`
  //   5. Recent chats — a quiet footer, the only thing here not waiting on you
  //
  // Cooking soon is the one section that reads plan data, and it is not a
  // restatement of the planner: which nights are YOURS is a run of days forward
  // from today that does not stop at the end of a cycle, and the planner renders
  // weeks. Every card is a projection of a document that exists at this moment:
  // it appears when true and disappears when resolved. No read state, no
  // dismissals, nothing stored per user.
  //
  // NOTHING on this page reads the shopping list, and nothing derived from one
  // may be added. See the `tonight` header in personalViewService for the full
  // argument; the short version is that a list records intent, not what is in the
  // cupboard, so any "you have / you need" claim here would be a confident guess
  // that poisons the sections which are actually reliable.

  // Cooking soon needs one or two meal-plan week documents, which nothing else
  // holds on this page's behalf. Page-owned for the reason the planner's own
  // extension week is: a live subscription kept alive for a screen nobody is
  // looking at is the failure mode. The teardown only drops this page's CLAIM —
  // the planner may be holding the same week (see `pruneWeekSubscriptions`).
  onMount(() => subscribeKitchenWeeks());

  // ─── Workbench ──────────────────────────────────────────────────────────────
  // In-memory only (kitchenDashboardPrefs.svelte.ts) — CLAUDE.md Rule 3 forbids
  // persisting this to browser storage, so it resets on reload.
  let customizeOpen = $state(false);

  const SECTION_TOGGLES: ReadonlyArray<{
    key: KitchenSection;
    label: string;
    description: string;
  }> = [
    {
      key: 'timers',
      label: 'Timers',
      description: 'Running and finished timers, and the button that starts one.',
    },
    { key: 'live', label: 'Cooking now', description: 'Cooks you have open right now.' },
    { key: 'upcoming', label: 'Cooking soon', description: 'Nights from today you are chef on.' },
    { key: 'review', label: 'Needs review', description: "AI imports nobody's read yet." },
    { key: 'chats', label: 'Recent chats', description: 'A shortcut back into a conversation.' },
  ];

  function onDensityChange(value: string): void {
    kitchenPrefs.setDensity(value as KitchenDensity);
  }

  const outerGap = $derived(kitchenPrefs.density === 'compact' ? 'gap-3' : 'gap-4');
  const listGap = $derived(kitchenPrefs.density === 'compact' ? 'gap-1.5' : 'gap-2');
  const cardPad = $derived(kitchenPrefs.density === 'compact' ? 'p-3' : 'p-4');

  // ─── Imagery ────────────────────────────────────────────────────────────────
  // Photography appears in exactly one place: a cook that is actually under way.
  // Everywhere else an image is wanted, an icon does it instead. A stack of hero
  // banners on a page opened many times a day is a lot of bytes to say very
  // little, and a 46px thumbnail of a generated image is mostly mud — whereas the
  // dish you are three steps into is worth looking at.
  //
  // Cache-busted the same way every other hero is, which since issue #933 means
  // literally the same function: `recipeHeroUrl` in `@salt/domain`.

  // ─── Heat ───────────────────────────────────────────────────────────────────
  // The word and the colour both come from the domain's single decision
  // (`timerHeat`), so the dial's sweep, the state word and the card's tint can
  // never disagree about what "imminent" means. Colour is NEVER the only carrier
  // — every heat renders its word too (ui-spec-v02 §7).
  const HEAT_WORD: Record<TimerHeat, string> = {
    resting: 'Resting',
    soon: 'Soon',
    imminent: 'Imminent',
    ringing: 'Finished',
  };

  // Mapped to CSS custom properties rather than passed into `Dial`: the primitive
  // owns no opinion about timers (ui-spec-v08 §8.22.5), so the vocabulary stays
  // here and the ring stays a ring.
  //
  // The ring and the word take DIFFERENT steps of the same role on purpose,
  // because they are held to different contrast floors against the page: a
  // stroke is a graphical object needing 3:1, where `review` sits at 3.36:1,
  // while the word is small text needing 4.5:1, which only `review-text` clears
  // (5.97:1). Same state, same meaning, two shades — swapping either one for
  // "consistency" breaks one of the two. Since #993 that split is the token
  // family's own structure rather than two hand-picked palette steps.
  const HEAT_VAR: Record<TimerHeat, string> = {
    resting: 'var(--color-primary)',
    soon: 'var(--color-review)',
    imminent: 'var(--color-destructive)',
    ringing: 'var(--color-destructive)',
  };

  const HEAT_TEXT: Record<TimerHeat, string> = {
    resting: 'text-primary',
    soon: 'text-review-text',
    imminent: 'text-destructive',
    ringing: 'text-destructive',
  };

  // ─── Cooking soon ─────────────────────────────────────────────────────────
  // "Tonight" and "Tomorrow" are worth naming; past that a weekday reads faster
  // than a countdown. Formatted in UTC because a date key is a calendar day, not
  // an instant — parsing it as local midnight would shift it a day west of GMT.
  const NIGHT_FORMAT = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  function nightLabel(night: UpcomingChefNight): string {
    if (night.daysAway === 0) return 'Tonight';
    if (night.daysAway === 1) return 'Tomorrow';
    return NIGHT_FORMAT.format(new Date(`${night.date}T00:00:00.000Z`));
  }

  function nightMeal(night: UpcomingChefNight): string {
    if (night.recipes.length > 0) return night.recipes.map((r) => r.title).join(' · ');
    if (night.day.note.trim()) return night.day.note.trim();
    return 'Nothing planned yet';
  }

  function openNight(night: UpcomingChefNight): void {
    const first = night.recipes[0];
    push(first ? `/recipes/${first.id}` : `/mealplan/${night.date}`);
  }

  // ─── Timers ───────────────────────────────────────────────────────────────
  // `endsAt` is absolute, so the countdown is pure arithmetic against a shared
  // clock — the one in personalViewService, which only ticks while a timer of mine
  // exists. Same derivation and the same Cancel → Dismiss flip as cook mode's own
  // timer bar; the two surfaces must never disagree about what a timer is doing.
  const remainingMs = (t: MineTimer, now: number) => Date.parse(t.timer.endsAt) - now;

  // Cancel and Dismiss are the SAME write for both kinds: the producer drops the
  // timer's entry unconditionally, so the two labels are one operation seen from
  // either side of `endsAt`. Whole-document LWW, exactly as cook mode persists
  // it. Which DOCUMENT is written is the only thing the kind decides — a cook
  // timer lives in its session, a standalone one in my kitchen-timers doc.
  async function dismissTimer(t: MineTimer): Promise<void> {
    const result =
      t.kind === 'cook'
        ? await persistCookSession(withTimerDismissed(t.session, t.timer.id))
        : await dismissKitchenTimer(t.timer.id);
    if (result.kind !== 'ok') addToast("Couldn't update that timer.", 'destructive');
  }

  async function dismissKitchenTimer(timerId: string) {
    const doc = getKitchenTimersSnapshot();
    // Signed out mid-gesture. Nothing to write and nothing to say — the page is
    // about to go with the session.
    if (!doc) return { kind: 'ok' as const, value: undefined };
    return persistKitchenTimers(withKitchenTimerDismissed(doc, timerId));
  }

  // ─── Standalone timers (issue #842) ───────────────────────────────────────
  // A timer that belongs to nobody's cook. It renders in the list above beside
  // the cook timers and is not marked out as a different species — the only
  // visible difference is that it has no cook to go to.
  //
  // The SHEET is cook mode's own (`../recipes/CookTimerSheet.svelte`), imported
  // rather than copied: it already takes a name and a number and hands back a
  // name and a number, knowing nothing about ids, sessions or — as it turns out
  // — cooks. Minting the id, reading the clock and writing the document stay
  // here, which is exactly the contract its header states.
  interface TimerSheetTarget {
    id: string;
    label: string;
    durationMinutes: number;
    running: boolean;
  }
  let timerSheetOpen = $state(false);
  let timerSheetTarget = $state<TimerSheetTarget | null>(null);
  const timerSheetPrefill = $derived({
    label: timerSheetTarget?.label ?? AD_HOC_TIMER_LABEL,
    durationMinutes: timerSheetTarget?.durationMinutes ?? AD_HOC_TIMER_MINUTES,
  });

  // A brand-new timer. Its id is minted here because there is no step and no
  // session to borrow one from.
  function openNewTimerSheet(): void {
    timerSheetTarget = {
      id: crypto.randomUUID(),
      label: AD_HOC_TIMER_LABEL,
      durationMinutes: AD_HOC_TIMER_MINUTES,
      running: false,
    };
    timerSheetOpen = true;
  }

  // One already counting down. Prefilled with what is LEFT on it, not what it was
  // originally set for — which is the opposite of cook mode's own running-timer
  // sheet, deliberately, because the two are re-timing different things.
  //
  // There, the number is a STEP's duration and the gesture is "run that step
  // again"; here there is no step, and the gesture is "give it a bit longer".
  // Confirming always sets `endsAt = now + minutes`, so a timer with six minutes
  // left that is nudged to eleven has been given another five — whereas prefilling
  // the original twenty would have turned a nudge into a jump from six minutes
  // remaining to twenty-five.
  //
  // Rounded UP to the whole minute, so nudging never silently shaves seconds off.
  // Once it has fired there is nothing left to carry over, and the length it was
  // set for is the only sensible offer: tapping a finished timer runs it again.
  function openRunningTimerSheet(t: MineKitchenTimer): void {
    const remaining = Date.parse(t.timer.endsAt) - Date.now();
    timerSheetTarget = {
      id: t.timer.id,
      label: t.timer.label,
      durationMinutes: remaining > 0 ? Math.ceil(remaining / 60_000) : t.timer.durationMinutes,
      running: true,
    };
    timerSheetOpen = true;
  }

  function confirmTimerSheet(next: { label: string; durationMinutes: number }): void {
    const target = timerSheetTarget;
    if (!target) return;
    const doc = getKitchenTimersSnapshot();
    if (!doc) return;
    // Unlock the audio context on this user gesture so the app-level watcher can
    // chime when the timer ends, even on iOS Safari (which blocks audio not tied
    // to a gesture). Starting a timer is the only gesture guaranteed to precede
    // a chime, which is why this sits here and the chime itself does not.
    primeChime();
    const now = Date.now();
    // `endsAt` is computed HERE, never in the domain producer, which reads no
    // clock (CLAUDE.md Rule 1). Replacing any entry with the same id is the
    // producer's job — which is also all "re-time a running timer" is. `notify`
    // re-derives from the duration actually being started, so one stretched over
    // the floor gains its push backstop and one cut under it loses it.
    void persistKitchenTimers(
      withKitchenTimerStarted(
        doc,
        {
          id: target.id,
          // An emptied name is no name, and a standalone timer has no step to
          // fall back to — so it falls back to the same default the sheet
          // offered in the first place.
          label: next.label === '' ? AD_HOC_TIMER_LABEL : next.label,
          endsAt: new Date(now + next.durationMinutes * 60_000).toISOString(),
          durationMinutes: next.durationMinutes,
          notify: shouldNotifyFor(next.durationMinutes),
        },
        now,
      ),
    );
  }

  // ─── Cooking now ──────────────────────────────────────────────────────────
  let cancellingId = $state<string | null>(null);

  async function cancelCook(cook: LiveCook): Promise<void> {
    if (cancellingId) return;
    cancellingId = cook.session.id;
    const result = await removeCookSession(cook.session.id);
    cancellingId = null;
    if (result.kind !== 'ok') addToast("Couldn't cancel that cook.", 'destructive');
  }

  // ─── Needs review ─────────────────────────────────────────────────────────
  let reviewingId = $state<string | null>(null);

  async function markReviewed(recipe: Recipe): Promise<void> {
    if (reviewingId) return;
    // Re-read the LIVE document, never the row we rendered from: `persistRecipe`
    // writes the whole doc, so saving a stale copy would roll back whatever the
    // onRecipeWritten trigger wrote alongside us (`image`, `imageBrief`).
    const current = $recipes.find((r) => r.id === recipe.id);
    if (!current) return;
    reviewingId = recipe.id;
    const { needs_approval: _wasUnreviewed, ...reviewed } = current;
    const persisted = await persistRecipe(reviewed);
    reviewingId = null;
    if (persisted.kind !== 'ok') addToast("Couldn't mark that as reviewed.", 'destructive');
  }

  // ─── Empty state ──────────────────────────────────────────────────────────
  // Driven from the underlying stores, never from the workbench toggles: hiding a
  // section you don't want to see must not paint a false "all caught up" over
  // work that is still there.
  //
  // Recent chats is deliberately NOT in this sum: a kitchen with nothing but old
  // conversations in it is still all-clear.
  const allClear = $derived(
    $myTimers.length === 0 &&
      $liveCooks.length === 0 &&
      $upcomingChefNights.length === 0 &&
      $needsReviewRecipes.length === 0,
  );

  // What tonight's headline says, when there is one. Recipe-derived facts only —
  // never a claim about what is in the kitchen.
  const tonightTitle = $derived(
    $tonight
      ? $tonight.recipes.length > 0
        ? $tonight.recipes.map((r) => r.title).join(' · ')
        : $tonight.note
      : '',
  );
  const tonightHero = $derived(
    $tonight?.recipes.map((r) => recipeHeroUrl(r)).find((u) => u !== null) ?? null,
  );

  // ─── Glance strip ─────────────────────────────────────────────────────────
  // A quick read of the same sections below — never a restatement of anything off
  // this page. Each chip scrolls to the section it counts, so the strip is a table
  // of contents rather than a second copy of the numbers.
  interface StatTile {
    readonly key: KitchenSection;
    readonly icon: IconName;
    readonly label: string;
    readonly target: string;
  }
  const statTiles = $derived(
    (
      [
        { key: 'timers', icon: 'Timer', count: $myTimers.length, noun: 'timer' },
        { key: 'live', icon: 'CookingPot', count: $liveCooks.length, noun: 'cooking' },
        { key: 'upcoming', icon: 'CalendarDays', count: $upcomingChefNights.length, noun: 'ahead' },
        { key: 'review', icon: 'Sparkles', count: $needsReviewRecipes.length, noun: 'to review' },
      ] as const
    )
      .filter((t) => kitchenPrefs.sections[t.key] && t.count > 0)
      .map((t): StatTile => ({
        key: t.key,
        icon: t.icon,
        target: `mine-section-${t.key}`,
        label:
          t.noun === 'cooking' || t.noun === 'to review'
            ? `${t.count} ${t.noun}`
            : `${t.count} ${t.noun}${t.count === 1 ? '' : 's'}`,
      })),
  );

  // Honours reduced-motion via `scroll-behavior` in CSS rather than a branch here;
  // `focus()` moves the keyboard caret too, so the chip is a real skip-link and not
  // just a scroll for people using a mouse.
  function jumpTo(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }
</script>

<!-- The two lines inside a timer card, shared by both kinds so a standalone timer
     is not marked out as a different species. Only the tail differs: a cook timer
     names its recipe, a standalone one names what tapping it does. -->
{#snippet timerBody(label: string, heat: TimerHeat, tail: string)}
  <p class="text-sm font-semibold text-foreground" data-testid="mine-timer-label">
    {label}
  </p>
  <p class="mt-0.5 truncate text-xs text-muted-foreground">
    <span
      class="font-mono text-xs font-semibold uppercase tracking-wider {HEAT_TEXT[heat]}"
      data-testid="mine-timer-state"
    >
      {HEAT_WORD[heat]}
    </span>
    <span aria-hidden="true"> · </span>{tail}
  </p>
{/snippet}

<section class="flex flex-col {outerGap} p-4 sm:p-6" data-testid="mine-page">
  <header class="flex flex-col gap-3">
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-0.5">
        <h1 class="text-xl font-semibold tracking-tight text-foreground">
          {$kitchenLabel}
        </h1>
        <!-- The sub-line only speaks when the glance strip is silent. With chips
             up, a count sentence says exactly what the chips already say. -->
        {#if statTiles.length === 0}
          <p class="text-sm text-muted-foreground" data-testid="mine-subhead">
            {allClear ? "Nothing's waiting on you." : "What's running, and what needs a look."}
          </p>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="icon"
        ariaLabel="Customize this page"
        title="Customize"
        onclick={() => (customizeOpen = true)}
        data-testid="mine-customize-open"
      >
        <Icon name="SlidersHorizontal" size={18} />
      </Button>
    </div>

    {#if statTiles.length > 0}
      <div class="flex flex-wrap gap-2" data-testid="mine-stats">
        {#each statTiles as tile (tile.key)}
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={() => jumpTo(tile.target)}
            data-testid="mine-stat-chip"
          >
            <Icon name={tile.icon} size={13} />
            <span>{tile.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </header>

  <!-- 1. Timers — running and finished together, soonest first, and from a cook
       or from nobody's cook at all. The dial IS the progress: no bar underneath.
       A finished timer stays until dismissed.

       The section renders whenever the kitchen is BUSY, not merely when a timer
       exists, because it carries the "Start a timer" action — which has to be
       reachable whether or not anything is running. When the kitchen is quiet
       the quiet screen below carries the same action, larger. -->
  {#if kitchenPrefs.sections.timers && !allClear}
    <div
      class="flex scroll-mt-4 flex-col {listGap}"
      id="mine-section-timers"
      tabindex="-1"
      data-testid="mine-timers"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-medium text-muted-foreground">Timers</h2>
        <Button
          variant="outline"
          size="sm"
          onclick={openNewTimerSheet}
          data-testid="mine-timer-start"
        >
          {#snippet leading()}<Icon name="Timer" size={14} />{/snippet}
          Start a timer
        </Button>
      </div>
      {#each $myTimers as t (t.id)}
        {@const remaining = remainingMs(t, $timerNowMs)}
        {@const heat = timerHeat(remaining)}
        {@const fired = heat === 'ringing'}
        {@const elapsed = timerProgress(t.timer, t.durationMs, $timerNowMs)}
        <Card class={fired ? 'border-destructive/50 bg-destructive/5' : ''}>
          <div class="flex items-center gap-3 {cardPad}" style="--salt-dial-heat: {HEAT_VAR[heat]}">
            <Dial value={elapsed === null ? 0 : 1 - elapsed} size="lg" tone="heat" ariaLabel={null}>
              <span data-testid="mine-timer-time">
                {fired ? '—' : formatClock(remaining)}
              </span>
            </Dial>
            {#if t.kind === 'cook'}
              <div class="min-w-0 flex-1">
                {@render timerBody(t.label, heat, t.recipe.title)}
              </div>
            {:else}
              <!-- A standalone timer is adjusted by tapping it — rename it,
                   stretch it, cut it short, while it is running. The text region
                   IS the control: with no cook to go to there is no second
                   button for it to compete with, and the state line has a slot
                   free where a cook timer names its recipe. -->
              <button
                type="button"
                class="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onclick={() => openRunningTimerSheet(t)}
                aria-label={`Adjust ${t.label}`}
                data-testid="mine-timer-edit"
              >
                {@render timerBody(t.label, heat, 'Tap to adjust')}
              </button>
            {/if}
            <div class="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant={fired ? 'solid' : 'ghost'}
                ariaLabel={fired ? `Dismiss ${t.label}` : `Cancel ${t.label}`}
                title={fired ? 'Dismiss' : 'Cancel'}
                onclick={() => dismissTimer(t)}
                data-testid="mine-timer-dismiss"
              >
                <Icon name={fired ? 'Check' : 'X'} size={17} />
              </Button>
              {#if t.kind === 'cook'}
                <Button
                  size="icon"
                  variant="outline"
                  ariaLabel={`Open the cook for ${t.recipe.title}`}
                  title="Open cook"
                  onclick={() => push(`/recipes/${t.recipe.id}/cook`)}
                  data-testid="mine-timer-goto"
                >
                  <Icon name="ArrowRight" size={17} />
                </Button>
              {/if}
            </div>
          </div>
        </Card>
      {/each}
    </div>
  {/if}

  <!-- 2. Cooking now — all of them: a two-pan dinner is two open cooks. This is
       the ONE place photography appears, because it is the one dish actually in
       front of you. The Progress bar here is untouched (ui-spec-v08 §8.22.2). -->
  {#if kitchenPrefs.sections.live && $liveCooks.length > 0}
    <div
      class="flex scroll-mt-4 flex-col {listGap}"
      id="mine-section-live"
      tabindex="-1"
      data-testid="mine-live"
    >
      <h2 class="text-sm font-medium text-muted-foreground">
        Cooking now{$liveCooks.length > 1 ? ` · ${$liveCooks.length} on the go` : ''}
      </h2>
      {#each $liveCooks as cook (cook.session.id)}
        {@const banner = kitchenPrefs.imagery ? recipeHeroUrl(cook.recipe) : null}
        <Card class="overflow-hidden border-primary/40">
          {#if banner}
            <img
              src={banner}
              alt=""
              loading="lazy"
              class="h-28 w-full object-cover"
              data-testid="mine-live-banner"
            />
          {/if}
          <div class="flex flex-col gap-3 {cardPad}">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-base font-semibold text-foreground">
                  {cook.recipe.title}
                </p>
                <p class="text-sm text-muted-foreground" data-testid="mine-live-step">
                  {cook.stepCount > 0
                    ? `Step ${cook.stepNumber} of ${cook.stepCount}`
                    : 'Mise en place'}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  loading={cancellingId === cook.session.id}
                  disabled={cancellingId !== null}
                  ariaLabel={`Cancel the cook for ${cook.recipe.title}`}
                  title="Cancel cook"
                  onclick={() => cancelCook(cook)}
                  data-testid="mine-live-cancel"
                >
                  <Icon name="X" size={17} />
                </Button>
                <Button
                  size="icon"
                  ariaLabel={`Go to ${cook.recipe.title}`}
                  title="Go to cook"
                  onclick={() => push(`/recipes/${cook.recipe.id}/cook`)}
                  data-testid="mine-live-resume"
                >
                  <Icon name="ArrowRight" size={17} />
                </Button>
              </div>
            </div>
            {#if cook.stepCount > 0}
              <Progress
                value={cook.completedCount}
                max={cook.stepCount}
                ariaLabel={`Cook progress: ${cook.recipe.title}`}
              />
            {/if}
          </div>
        </Card>
      {/each}
    </div>
  {/if}

  <!-- 3. Cooking soon — icons, not photographs: a night is a date, and a 40px
       crop of a generated hero says less than a calendar glyph. -->
  {#if kitchenPrefs.sections.upcoming && $upcomingChefNights.length > 0}
    <div
      class="flex scroll-mt-4 flex-col {listGap}"
      id="mine-section-upcoming"
      tabindex="-1"
      data-testid="mine-upcoming"
    >
      <h2 class="text-sm font-medium text-muted-foreground">Cooking soon</h2>
      {#each $upcomingChefNights as night (night.date)}
        <Card class="overflow-hidden">
          <button
            type="button"
            class="flex w-full items-center gap-3 p-3 text-left"
            onclick={() => openNight(night)}
            data-testid="mine-upcoming-open"
          >
            <Icon name="CalendarDays" size={18} class="shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p
                class="truncate text-sm font-medium text-foreground"
                data-testid="mine-upcoming-when"
              >
                {nightLabel(night)}
              </p>
              <p class="truncate text-xs text-muted-foreground" data-testid="mine-upcoming-meal">
                {nightMeal(night)}
              </p>
            </div>
            <Icon name="ChevronRight" size={16} class="shrink-0 text-muted-foreground" />
          </button>
        </Card>
      {/each}
    </div>
  {/if}

  <!-- 4. Needs review — imported by AI, not read by a human yet. Icons here too:
       an unreviewed import's hero is itself unreviewed. -->
  {#if kitchenPrefs.sections.review && $needsReviewRecipes.length > 0}
    <div
      class="flex scroll-mt-4 flex-col {listGap}"
      id="mine-section-review"
      tabindex="-1"
      data-testid="mine-needs-review"
    >
      <h2 class="text-sm font-medium text-muted-foreground">Needs review</h2>
      <p class="text-xs text-muted-foreground" data-testid="mine-needs-review-hint">
        These were written by AI and nobody's read them yet. Open one to fix anything that's off, or
        mark it reviewed if it looks right.
      </p>
      {#each $needsReviewRecipes as recipe (recipe.id)}
        <Card class={cardPad}>
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2.5">
              <Icon name="Sparkles" size={18} class="shrink-0 text-primary" />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-foreground">{recipe.title}</p>
                <p class="text-xs text-muted-foreground">Not reviewed yet</p>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                loading={reviewingId === recipe.id}
                disabled={reviewingId !== null}
                ariaLabel={`Mark ${recipe.title} as reviewed`}
                title="Mark reviewed"
                onclick={() => markReviewed(recipe)}
                data-testid="mine-needs-review-clear"
              >
                <Icon name="Check" size={17} />
              </Button>
              <Button
                size="icon"
                variant="outline"
                ariaLabel={`Open ${recipe.title}`}
                title="Open"
                onclick={() => push(`/recipes/${recipe.id}`)}
                data-testid="mine-needs-review-open"
              >
                <Icon name="ArrowRight" size={17} />
              </Button>
            </div>
          </div>
        </Card>
      {/each}
    </div>
  {/if}

  <!-- The quiet screen. Most visits land here, so it is the page's main view
       rather than its fallback: when there is a dinner tonight it says so, large,
       and when there is not it says you are caught up. Everything on it comes
       from the plan and the recipe — never the shopping list. -->
  {#if allClear}
    {#if $tonight}
      <Card class="relative overflow-hidden">
        {#if tonightHero}
          <img src={tonightHero} alt="" class="absolute inset-0 h-full w-full object-cover" />
          <div
            class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/55 to-black/20"
            aria-hidden="true"
          ></div>
        {/if}
        <div
          class="relative flex flex-col gap-3 p-5 {tonightHero ? 'pt-28' : ''}"
          data-testid="mine-tonight"
        >
          <p
            class="text-xs font-semibold uppercase tracking-widest {tonightHero
              ? 'text-white/85'
              : 'text-primary'}"
            data-testid="mine-tonight-kicker"
          >
            {$tonight.isMine ? "Tonight · you're cooking" : 'Tonight'}
          </p>
          <p
            class="text-xl font-semibold leading-tight tracking-tight {tonightHero
              ? 'text-white'
              : 'text-foreground'}"
            data-testid="mine-tonight-title"
          >
            {tonightTitle}
          </p>
          {#if $tonight.recipes.length > 0 && $tonight.note}
            <p class={tonightHero ? 'text-sm text-white/80' : 'text-sm text-muted-foreground'}>
              {$tonight.note}
            </p>
          {/if}
          <div class="flex flex-wrap gap-2">
            {#if $tonight.recipes[0]}
              <Button
                onclick={() => push(`/recipes/${$tonight?.recipes[0]?.id}/cook`)}
                data-testid="mine-tonight-cook"
              >
                Start cooking
              </Button>
            {/if}
            <Button
              variant="outline"
              onclick={() => push(`/mealplan/${$tonight?.date}`)}
              data-testid="mine-tonight-plan"
            >
              See the plan
            </Button>
            <!-- Present on the quiet screen whether or not there is a dinner on
                 it: the commonest reason to want a timer is that nothing is
                 cooking. -->
            <Button variant="outline" onclick={openNewTimerSheet} data-testid="mine-timer-start">
              {#snippet leading()}<Icon name="Timer" size={16} />{/snippet}
              Start a timer
            </Button>
          </div>
        </div>
      </Card>
    {:else}
      <Card class="p-4">
        <div class="flex flex-col gap-3" data-testid="mine-empty">
          <div class="flex items-center gap-3">
            <Icon name="CircleCheck" size={20} class="text-primary" />
            <div>
              <p class="text-sm font-medium text-foreground">You're all caught up</p>
              <p class="text-xs text-muted-foreground">
                No timers, no cook on the go, no nights of yours coming up, nothing to review.
              </p>
            </div>
          </div>
          <!-- The main offer on a genuinely quiet screen. "Boil an egg" is a
               thing to want from a kitchen with nothing else in it, and until now
               it needed a cook to hang itself on. -->
          <div>
            <Button onclick={openNewTimerSheet} data-testid="mine-timer-start">
              {#snippet leading()}<Icon name="Timer" size={16} />{/snippet}
              Start a timer
            </Button>
          </div>
        </div>
      </Card>
    {/if}
  {/if}

  <!-- 5. Recent chats — last, because it is a shortcut back into a conversation
       rather than something waiting on you. -->
  {#if kitchenPrefs.sections.chats && $recentChats.length > 0}
    <div class="flex flex-col {listGap}" data-testid="mine-chats">
      <h2 class="text-sm font-medium text-muted-foreground">Recent chats</h2>
      {#each $recentChats as chat (chat.id)}
        <Card class="overflow-hidden">
          <button
            type="button"
            class="flex w-full items-center gap-3 p-3 text-left"
            onclick={() => push(`/chat/${chat.id}`)}
            data-testid="mine-chat-open"
          >
            <Icon name="ChefHat" size={18} class="shrink-0 text-muted-foreground" />
            <span
              class="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              data-testid="mine-chat-title"
            >
              {chat.title}
            </span>
            {#if isChatReadOnly(chat, new Date())}
              <span class="shrink-0 text-xs text-muted-foreground">Read-only</span>
            {/if}
            <Icon name="ChevronRight" size={16} class="shrink-0 text-muted-foreground" />
          </button>
        </Card>
      {/each}
    </div>
  {/if}
</section>

<!-- Cook mode's own timer sheet, imported across routes rather than copied or
     promoted to @salt/ui-components: it is app-specific domain UI, not a
     primitive, and it already knows nothing about the session it was written
     beside. -->
<CookTimerSheet
  bind:open={timerSheetOpen}
  prefill={timerSheetPrefill}
  running={timerSheetTarget?.running ?? false}
  onConfirm={confirmTimerSheet}
/>

<Sheet bind:open={customizeOpen} side="bottom">
  <SheetContent class="flex flex-col gap-4 overflow-y-auto">
    <SheetHeader>
      <SheetTitle>Customize your kitchen</SheetTitle>
    </SheetHeader>

    <div class="flex flex-col gap-3">
      <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sections</h3>
      {#each SECTION_TOGGLES as toggle (toggle.key)}
        <div data-testid={`mine-customize-section-${toggle.key}`}>
          <Switch
            checked={kitchenPrefs.sections[toggle.key]}
            onCheckedChange={() => kitchenPrefs.toggleSection(toggle.key)}
            label={toggle.label}
            description={toggle.description}
          />
        </div>
      {/each}
    </div>

    <div class="flex flex-col gap-3">
      <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Imagery</h3>
      <div data-testid="mine-customize-imagery">
        <Switch
          checked={kitchenPrefs.imagery}
          onCheckedChange={(v) => kitchenPrefs.setImagery(v)}
          label="Show the dish you're cooking"
          description="A photo on any cook that's under way. Nothing else on the page uses one."
        />
      </div>
    </div>

    <div class="flex flex-col gap-3" data-testid="mine-customize-density">
      <RadioGroup
        label="Layout"
        value={kitchenPrefs.density}
        onValueChange={onDensityChange}
        orientation="vertical"
      >
        <RadioGroupItem value="comfortable" label="Comfortable" />
        <RadioGroupItem value="compact" label="Compact" />
      </RadioGroup>
    </div>

    <SheetFooter>
      <Button
        variant="ghost"
        onclick={() => kitchenPrefs.reset()}
        data-testid="mine-customize-reset"
      >
        Reset to defaults
      </Button>
      <Button onclick={() => (customizeOpen = false)} data-testid="mine-customize-done">
        Done
      </Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
