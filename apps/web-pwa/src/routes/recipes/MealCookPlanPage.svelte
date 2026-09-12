<script lang="ts">
  import { onMount } from 'svelte';
  import { readable } from 'svelte/store';
  import { push } from 'svelte-spa-router';
  import {
    Button,
    Card,
    EmptyState,
    Icon,
    Progress,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Spinner,
    DetailPage,
  } from '@salt/ui-components';
  import {
    cookSessionId,
    formatClock,
    hasComponents,
    isCookable,
    latestHomeTimeFor,
    makeFreshSession,
    resolveComponents,
    scheduleFor,
    timerProgress,
    withTimerDismissed,
    type Recipe,
  } from '@salt/domain';
  import { goBack } from '../../lib/nav.js';
  import { recipes, isLoadingRecipes } from '../../lib/recipeService.js';
  import { auth } from '../../lib/auth.svelte.js';
  import {
    cookSession,
    initCookSessionSync,
    persistCookSession,
  } from '../../lib/cookSessionService.js';
  import {
    liveCooks,
    myTimers,
    type LiveCook,
    type MineCookTimer,
  } from '../../lib/personalViewService.js';
  import {
    kitchenAnchorDate,
    kitchenWeeks,
    subscribeKitchenWeeks,
  } from '../../lib/mealPlanService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import { phaseMinutes } from './recipeTiming.js';
  import { kindOf } from './recipeKind.js';
  import { quarterHourOptions } from '../../lib/timeOptions.js';

  // The cook plan (issue #752, phase 4) — `/recipes/:id/cook-plan`.
  //
  // A DASHBOARD FOR THE EVENING, not a recipe. It answers the one question a meal
  // asks that no single dish does: what goes on when, so everything lands together.
  //
  // Explicitly NOT a merged timeline. Nothing here interleaves the components'
  // steps into one sequence — that would be an aggregation, and this feature's
  // governing invariant is that NOTHING AGGREGATES AND NOTHING RECURSES. Each row
  // is a whole dish with its own cook mode behind it; the plan says when to start
  // each one and then gets out of the way.
  //
  // An ORDINARY AppShell route, deliberately not full-viewport (CLAUDE.md Rule 7).
  // Cook mode is a modal single-task deck you are in for an hour; this is a hub you
  // bounce in and out of all evening, so it keeps the nav under it.
  //
  // ─── The whole model ────────────────────────────────────────────────────────
  //
  // ONE serve time, and every dish finishes at it: `start = serve − cook time`.
  // That is all of `scheduleFor`, and it is why the plan is readable — the bird
  // going in at 17:30 and the gravy at 18:50 falls straight out of their cook
  // times, with nothing to configure per dish.

  let { params }: { params?: { id?: string } } = $props();

  const mealId = $derived(params?.id ?? '');
  const recipe = $derived($recipes.find((r) => r.id === mealId) ?? null);
  const uid = $derived(auth.user?.uid ?? null);
  /** The MEAL's own session — deterministic id, exactly as cook mode builds it. */
  const sessionId = $derived(uid ? cookSessionId(mealId, uid) : null);

  // ─── Reads: what costs a listener, and what is already paid for ─────────────
  //
  // THE MEAL'S OWN SESSION GETS A LISTENER, and this is the non-obvious part of the
  // page. `serveAt` lives on `cookSessions/{mealId}_{uid}`, and "the serve time
  // survives a reload and a device switch" has to be actually true — so it is read
  // by deterministic id, like every other cook page. Leaning on `myCookSessions`
  // for it would be wrong: that query is capped at the five most recently updated
  // sessions, and a serve time set on Sunday morning would silently vanish from the
  // page by the time the potatoes went on.
  //
  // THE COMPONENTS' SESSIONS COST NOTHING EXTRA. Their progress and their timers
  // are filters of `liveCooks` / `myTimers`, which are plain projections over
  // stores App.svelte already subscribes app-wide. A per-component
  // `initCookSessionSync` would be one listener per dish for data already in
  // memory.
  let unsub: (() => void) | null = null;
  $effect(() => {
    const sid = sessionId;
    if (!sid) return;
    unsub?.();
    unsub = initCookSessionSync(sid);
    return () => {
      unsub?.();
      unsub = null;
    };
  });

  // One or two meal-plan week documents, held only while this page is open — the
  // same page-owned claim MinePage takes, and for the same reason. It buys exactly
  // one thing: the serve time's default (below).
  onMount(() => subscribeKitchenWeeks());

  // ─── The rows ───────────────────────────────────────────────────────────────
  //
  // The meal first, then its components in STORED order — which is the running
  // order, because that is the order the user dragged them into. Nothing re-sorts.
  const components = $derived(recipe ? resolveComponents(recipe, $recipes) : []);

  // The meal is a row only when it has a method of its own. A Sunday roast that is
  // purely "these three dishes" has nothing to start, and a row you cannot act on
  // is noise at the top of the list. Capability-gated, never kind-gated.
  const mealIsARow = $derived(
    recipe !== null && isCookable(kindOf(recipe)) && recipe.steps.length > 0,
  );
  const rowRecipes = $derived<readonly Recipe[]>(
    recipe && mealIsARow ? [recipe, ...components] : components,
  );

  // ─── The clock ──────────────────────────────────────────────────────────────
  //
  // The page owns its OWN one-second clock, deliberately not `timerNowMs`. That one
  // is armed only while a timer is running, which is right for the nav badge and
  // wrong here: this page's countdowns are the whole point and have to tick with no
  // timer anywhere in the meal. Started on subscribe and cleared on unsubscribe, so
  // it stops dead when the page unmounts.
  const nowMs = readable(Date.now(), (set) => {
    set(Date.now());
    if (typeof setInterval !== 'function') return; // SSR guard
    const handle = setInterval(() => set(Date.now()), 1000);
    return () => clearInterval(handle);
  });

  // ─── Serve time ─────────────────────────────────────────────────────────────

  /** Where a serve time falls back to when the plan has nothing to say. */
  const DEFAULT_SERVE_TIME = '19:00';
  // Quarter hours across the plausible dinner window: 16:00–22:45. A picker, not
  // a free-text box — there is nothing to parse and nothing to get wrong.
  //
  // The same GENERATOR as the planner's home-time picker, but deliberately not
  // the same window: that one runs 17:00–22:45 in 24 entries. The difference is
  // in the arguments where a reader can see it, which is the point of sharing
  // the arithmetic rather than the list (issue #1055).
  const TIME_OPTIONS = quarterHourOptions(16, 28);

  const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const serveAtMs = $derived($cookSession?.serveAt ? Date.parse($cookSession.serveAt) : null);
  const serveAtLabel = $derived(serveAtMs === null ? null : CLOCK_FORMAT.format(serveAtMs));

  // What the picker opens on before anything is set: the last person home on the
  // night this meal is planned for, else 19:00. The household has already agreed a
  // time; asking for it twice would be the app not listening.
  const defaultServeTime = $derived(
    latestHomeTimeFor($kitchenWeeks, mealId, $kitchenAnchorDate) ?? DEFAULT_SERVE_TIME,
  );

  /** "HH:mm" → the absolute instant it names TODAY, in the device's own timezone. */
  function instantForToday(hhmm: string): string {
    const [h, m] = hhmm.split(':');
    const at = new Date();
    at.setHours(Number(h), Number(m), 0, 0);
    return at.toISOString();
  }

  let savingServeTime = $state(false);

  // SETTING A SERVE TIME IS WHAT CREATES THE MEAL'S SESSION — opening this page
  // writes nothing at all. A session created on a mere visit would advertise the
  // user as "Cooking now" in Kitchen for having looked at a plan.
  async function setServeTime(hhmm: string): Promise<void> {
    if (!recipe || !uid || !sessionId || savingServeTime) return;
    savingServeTime = true;
    const nowIso = new Date().toISOString();
    const base =
      $cookSession ??
      makeFreshSession({
        id: sessionId,
        ownerUid: uid,
        recipeId: mealId,
        recipeUpdatedAtAtStart: recipe.updatedAt,
        nowIso,
      });
    const result = await persistCookSession({ ...base, serveAt: instantForToday(hhmm) });
    savingServeTime = false;
    if (result.kind !== 'ok') addToast("Couldn't set the serve time.", 'destructive');
  }

  // ─── The schedule ───────────────────────────────────────────────────────────
  //
  // All the arithmetic is in the pure domain helper; what is left here is words.
  const startById = $derived(
    new Map(scheduleFor(rowRecipes, serveAtMs).map((row) => [row.recipeId, row.startAtMs])),
  );

  const liveByRecipeId = $derived(
    new Map(
      $liveCooks
        .filter((c) => rowRecipes.some((r) => r.id === c.recipe.id))
        .map((c) => [c.recipe.id, c] as const),
    ),
  );

  /** Has this dish's moment arrived? A row already being cooked never shouts. */
  function shouldStartNow(recipeId: string, now: number): boolean {
    const startAt = startById.get(recipeId) ?? null;
    if (startAt === null) return false;
    if (liveByRecipeId.has(recipeId)) return false;
    return now >= startAt;
  }

  // What this dish takes, on its plan row (issue #1122): the phase sum, and after
  // issue #1213 nothing else — the stored-cook-time fallback under it is gone.
  // Same rule as the recipe page, the component rows and the list chip
  // (`recipeTiming.ts`).
  //
  // The START CLOCK beside it is worked back from the same figure — `scheduleFor`
  // moved onto the phase sum in issue #1233, and so did the "Made from" ordering
  // — so the line, the clock and the running order cannot disagree.
  function dishTimeLabel(row: Recipe): string {
    const minutes = phaseMinutes(row);
    return minutes === null ? 'No timing yet' : formatMinutes(minutes);
  }

  /** "in 40 min" / "in 1 h 20 min", rounded up so a countdown never reads "in 0 min". */
  function untilLabel(startAtMs: number, now: number): string {
    return `in ${formatMinutes(Math.max(1, Math.ceil((startAtMs - now) / 60_000)))}`;
  }

  function openRow(row: Recipe): void {
    // A dish already on the go goes straight back into its cook mode; one not
    // started goes to the recipe, where Cook is the first thing on the page.
    push(liveByRecipeId.has(row.id) ? `/recipes/${row.id}/cook` : `/recipes/${row.id}`);
  }

  // ─── Timers ─────────────────────────────────────────────────────────────────
  //
  // Every timer running anywhere in this meal, in one place. A filter of `myTimers`
  // — no new read — using the same shape as `firedTimers`.
  //
  // KNOWN BOUND, deliberately not fixed here: `myCookSessions` is capped at the
  // five most recently updated sessions, so "every timer across the whole meal" is
  // bounded by that. Raising the cap is a shared personal-view decision with its own
  // blast radius, not something this page gets to do on its own.
  //
  // Standalone kitchen timers (issue #842) ride the same list and are filtered
  // out here by kind: a timer that belongs to nobody's cook belongs to no meal
  // either, and this page is a meal's timers. My Kitchen is where those live.
  const mealTimers = $derived(
    $myTimers.filter(
      (t): t is MineCookTimer => t.kind === 'cook' && rowRecipes.some((r) => r.id === t.recipe.id),
    ),
  );

  // Cancel and Dismiss are ONE write, exactly as they are in Kitchen and in cook
  // mode's own timer bar: `withTimerDismissed` drops the entry either side of
  // `endsAt`. There is no second timer mechanism on this page.
  async function dismissTimer(t: MineCookTimer): Promise<void> {
    const result = await persistCookSession(withTimerDismissed(t.session, t.timer.id));
    if (result.kind !== 'ok') addToast("Couldn't update that timer.", 'destructive');
  }

  // KNOWN GAP, also deliberately out of scope: the app-wide cook-timer alert
  // watcher follows only the single `cookSession` a cook page has open, so this
  // page does not chime for a component's timer it is not itself driving. Listing
  // them here is what it can honestly offer.

  function stepLabel(cook: LiveCook): string {
    return cook.stepCount > 0 ? `Step ${cook.stepNumber} of ${cook.stepCount}` : 'Mise en place';
  }

  const loading = $derived($isLoadingRecipes);
</script>

{#if loading}
  <div class="flex justify-center p-8"><Spinner /></div>
{:else if !recipe}
  <div class="p-6">
    <EmptyState title="Recipe not found" description="It may have been deleted." />
  </div>
{:else if !hasComponents(recipe)}
  <!-- Gated on the DOCUMENT having components, in the same idiom the formula and
       guided-plan screens use for their own preconditions. A meal is not a kind —
       it is a recipe that points at other recipes — so there is nothing to ask
       `kindOf` here. -->
  <div class="p-6" data-testid="cook-plan-not-a-meal">
    <EmptyState
      title="This isn't a meal"
      description="A cook plan schedules the dishes a meal is made from, and this one isn't built from any. Open the recipe, press Edit, and add some to its “Made from” list."
    />
  </div>
{:else}
  <DetailPage
    title="Cook plan"
    subtitle={recipe.title}
    onBack={() => goBack(`/recipes/${recipe.id}`)}
    backLabel="Back"
    class="p-4 sm:p-6"
  >
    {#snippet actions()}
      <!-- The serve time is the page's one setting, so it lives in the header
           where the plan is read from. The trigger says what is set; until
           something is, it asks — the picker itself opens on the plan's own
           answer, so agreeing costs one tap. -->
      <Select value={serveAtLabel ?? defaultServeTime} onValueChange={(v) => void setServeTime(v)}>
        <SelectTrigger
          class="h-9 w-40 justify-center tabular-nums"
          aria-label="Serve time"
          data-testid="cook-plan-serve-trigger"
        >
          {serveAtLabel ? `serving ${serveAtLabel}` : 'Set serve time'}
        </SelectTrigger>
        <SelectContent>
          {#each TIME_OPTIONS as t (t)}
            <SelectItem value={t}>{t}</SelectItem>
          {/each}
        </SelectContent>
      </Select>
    {/snippet}

    <div class="flex flex-col gap-4" data-testid="cook-plan">
      {#if serveAtMs === null}
        <p class="text-sm text-muted-foreground" data-testid="cook-plan-no-serve-time">
          Set a serve time and every dish gets a start time, counted back from it.
        </p>
      {/if}

      <!-- ─── The running order ───────────────────────────────────────────── -->
      <ul class="flex flex-col gap-2" data-testid="cook-plan-rows">
        {#each rowRecipes as row (row.id)}
          {@const startAt = startById.get(row.id) ?? null}
          {@const cook = liveByRecipeId.get(row.id)}
          {@const now = $nowMs}
          {@const startNow = shouldStartNow(row.id, now)}
          <li>
            <Card
              class={startNow ? 'overflow-hidden border-primary bg-primary/10' : 'overflow-hidden'}
            >
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-x-3 gap-y-2 p-3 text-left"
                onclick={() => openRow(row)}
                data-testid="cook-plan-row"
                data-recipe-id={row.id}
              >
                <div class="min-w-0 flex-1">
                  <p
                    class="truncate text-sm font-medium text-foreground"
                    data-testid="cook-plan-row-title"
                  >
                    {row.title}
                  </p>
                  <p
                    class="truncate text-xs text-muted-foreground"
                    data-testid="cook-plan-row-cook-time"
                  >
                    {dishTimeLabel(row)}
                  </p>
                </div>
                <span
                  class="shrink-0 font-mono text-sm tabular-nums text-muted-foreground"
                  data-testid="cook-plan-row-start"
                >
                  {startAt === null
                    ? 'start when you like'
                    : `start ${CLOCK_FORMAT.format(startAt)}`}
                </span>
                <span class="shrink-0 text-xs font-medium" data-testid="cook-plan-row-when">
                  {#if startNow}
                    <span class="inline-flex items-center gap-1 text-primary">
                      <Icon name="Flame" size={14} />
                      START NOW
                    </span>
                  {:else if startAt !== null && !cook}
                    <span class="text-muted-foreground">{untilLabel(startAt, now)}</span>
                  {/if}
                </span>
                <Icon name="ChevronRight" size={16} class="shrink-0 text-muted-foreground" />
              </button>
              <!-- Already cooking: the row says where the dish has got to and goes
                   back into its own cook mode rather than to the recipe. -->
              {#if cook}
                <div class="flex flex-col gap-1 px-3 pb-3">
                  <p class="text-xs text-muted-foreground" data-testid="cook-plan-row-step">
                    {stepLabel(cook)}
                  </p>
                  {#if cook.stepCount > 0}
                    <Progress
                      value={cook.completedCount}
                      max={cook.stepCount}
                      ariaLabel={`Cook progress: ${row.title}`}
                    />
                  {/if}
                </div>
              {/if}
            </Card>
          </li>
        {/each}
      </ul>

      {#if rowRecipes.length === 0}
        <EmptyState
          title="Nothing to schedule"
          description="The dishes this meal was built from are no longer in the library."
        />
      {/if}

      <!-- ─── Every timer in the meal ─────────────────────────────────────── -->
      {#if mealTimers.length > 0}
        <div class="flex flex-col gap-2" data-testid="cook-plan-timers">
          <h2 class="text-sm font-medium text-muted-foreground">Timers</h2>
          {#each mealTimers as t (t.id)}
            {@const remaining = Date.parse(t.timer.endsAt) - $nowMs}
            {@const fired = remaining <= 0}
            {@const progress = timerProgress(t.timer, t.durationMs, $nowMs)}
            <Card
              class={fired ? 'overflow-hidden border-primary bg-primary/10' : 'overflow-hidden'}
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <Icon
                  name={fired ? 'BellRing' : 'Timer'}
                  size={18}
                  class={fired ? 'text-primary' : 'text-muted-foreground'}
                />
                <div class="min-w-0 flex-1">
                  <p
                    class="truncate text-sm font-medium {fired
                      ? 'text-primary'
                      : 'text-foreground'}"
                    data-testid="cook-plan-timer-label"
                  >
                    {t.label}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">{t.recipe.title}</p>
                </div>
                <span
                  class="shrink-0 font-mono text-base tabular-nums {fired
                    ? 'font-semibold text-primary'
                    : ''}"
                  data-testid="cook-plan-timer-time"
                >
                  {fired ? 'Finished' : formatClock(remaining)}
                </span>
                <Button
                  size="sm"
                  variant={fired ? 'solid' : 'ghost'}
                  onclick={() => dismissTimer(t)}
                  data-testid="cook-plan-timer-dismiss"
                >
                  {fired ? 'Dismiss' : 'Cancel'}
                </Button>
              </div>
              {#if progress !== null}
                <div class="h-1 w-full bg-muted-foreground/15" aria-hidden="true">
                  <div
                    class="h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none {fired
                      ? 'bg-primary'
                      : 'bg-warning'}"
                    style="width: {progress * 100}%"
                  ></div>
                </div>
              {/if}
            </Card>
          {/each}
        </div>
      {/if}
    </div>
  </DetailPage>
{/if}
