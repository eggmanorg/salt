<script lang="ts">
  import { Button, CanonIcon, EmptyState, Icon, Spinner } from '@salt/ui-components';
  import { onDestroy, onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import {
    cookSession,
    persistCookSession,
    getCookSessionSnapshot,
  } from '../../lib/cookSessionService.js';
  // The session lifecycle — subscribe, bootstrap, ended-elsewhere, orphan, restart,
  // finish, close, keep-awake — shared with plain cook mode (issue #994), because
  // both screens are the same cook on the same session document.
  import { createCookLifecycle } from '../../lib/cookLifecycle.svelte.js';
  // The step timers — projection, tick, start/dismiss/progress and the sheet — also
  // shared with plain cook mode (issue #994). The plan's check-ins are the one thing
  // this screen hands it; see the timer section below.
  import { createCookTimers } from '../../lib/cookTimers.svelte.js';
  import { guidedPlan, initGuidedPlanSync } from '../../lib/guidedPlanService.js';
  // The ingredient picture and the press-and-hold "add to the list" — shared with
  // plain cook mode (issue #994), because both screens draw the same rows.
  //
  // Every row here that names an INGREDIENT uses them: "Also get out", the
  // amounts under a prep job, a bowl's contents, and a step's loose ingredients
  // (#761). A prep JOB itself still has none — it is an instruction, not an
  // ingredient, and has no canon item to picture.
  import {
    ingredientIcons,
    ingredientLabel,
    addIngredientToShoppingList,
  } from '../../lib/cookIngredientIcons.js';
  import { kitIcons } from '../../lib/kitIcons.js';
  import { createCheckOffHold } from '../../lib/checkOffHold.svelte.js';
  import { longpress } from '../../lib/longpress.svelte.js';
  import { tick as hapticTick } from '../../lib/haptics.js';
  // The push floor, shared with plain cook mode and My Kitchen (issue #994) so a timer
  // behaves the same whichever screen started it. A check-in is armed here rather than
  // in `$lib/cookTimers`, so this page reads the floor for itself.
  import { shouldNotifyFor } from '../../lib/timerDefaults.js';
  // The step deck — element registry, pager, probe, peek, advancing and the landing —
  // shared with plain cook mode (issue #994). The pure viewport arithmetic under it
  // stays in `$lib/cookDeck`, whose numbers the markup below still reads.
  import { createStepDeck } from '../../lib/stepDeck.svelte.js';
  import {
    sectionMinHeight,
    fadeFitsLookahead,
    LOOKAHEAD_VEIL_PX,
    PEEK_MAX_PX,
  } from '../../lib/cookDeck.js';
  import IngredientText from './IngredientText.svelte';
  import CookTimerSheet from './CookTimerSheet.svelte';
  // The regions this screen draws byte-for-byte the same way plain cook mode does
  // (issue #994). Composition, not a design-system primitive: they are app-level
  // arrangements of `@salt/ui-components` parts with exactly two call sites, and
  // promoting one into the package would need a ui-spec of its own.
  //
  // The one that carries a per-mode difference is `CookStepCollapsed`, and it takes
  // that difference as two class props written out below — never as a mode flag.
  import CookLoadingOrphan from './CookLoadingOrphan.svelte';
  import CookTimeline from './CookTimeline.svelte';
  import CookRecipeChangedBanner from './CookRecipeChangedBanner.svelte';
  import CookTimersBar from './CookTimersBar.svelte';
  import CookStepCollapsed from './CookStepCollapsed.svelte';
  import CookStepKit from './CookStepKit.svelte';
  import CookStepTimer from './CookStepTimer.svelte';
  import CookStepDoneControls from './CookStepDoneControls.svelte';
  import {
    withPrepChecked,
    firstUseByStep,
    kitByStep,
    guidedPrepBoard,
    guidedMiseProgress,
    guidedPrepCardProgress,
    progressOver,
    prepEntryForContainer,
    prepEntryIngredients,
    looseIngredientsForStep,
    nextStepLookahead,
    hasRecipeChanged,
    checkInTimerId,
  } from '@salt/domain';
  import type { CookActiveTimerDoc, IngredientDoc } from '@salt/domain/schemas';

  // Guided cook (issue #751, Phase 2) — `/recipes/:id/cook/guided`.
  //
  // Cook mode with a lens on it. Same pager, same swipe, same timers, same
  // keep-awake, and — load-bearing — THE SAME SESSION DOCUMENT, so step progress
  // and timers are shared with plain cook mode and a device switch resumes either
  // one. Two things differ:
  //
  //  1. Mise en place is the plan's PREP LIST, grouped by the container each job
  //     fills (issue #767): one card per bowl, reading get this bowl → do these
  //     things → these amounts go in it. It ticks into `checkedPrepIds`, a second
  //     list beside `checkedIngredientIds` — "I diced the soffritto" and "the
  //     carrots are on the bench" are different facts, and switching modes must
  //     not read one as the other.
  //  2. Each step carries the plan's notes UNDER the recipe's own words. The step
  //     text is never touched, never reworded, never reordered.
  //
  // A "Get out" stage (issue #761) used to come first: every vessel the plan names,
  // ticked off before the first cut. Issue #767 removed it. With the container
  // LEADING each prep card the bowls are countable on the prep screen itself, so a
  // separate screen to dismiss was a tap that bought nothing — and its tick list,
  // `checkedContainerNames`, went with it.
  //
  // A SIBLING PAGE rather than a mode flag on CookModePage, deliberately. What
  // differs is not a slot but the whole mise stage — its data model, its tick
  // field, its progress function, its sections (there are none) and an extra
  // section of its own. What does NOT differ is shared as code rather than as a
  // shell component: the session lifecycle in `$lib/cookLifecycle` and the step
  // timers in `$lib/cookTimers` (issue #994), `createDeck` in `$lib/deck`, the pure
  // geometry in `$lib/cookDeck`, the timer defaults in `$lib/timerDefaults`, the
  // ingredient rows in `$lib/cookIngredientIcons`, and the producers in
  // `@salt/domain/cookSession`.
  //
  // FULL-VIEWPORT, the second such route (ui-spec-v05 §2, amended by this issue).
  // Its obligations are met exactly as CookModePage meets them: the route is
  // declared in `routes/fullViewport.ts` so App.svelte does not RENDER the chrome
  // (never paints over it), focus is pulled into the page on mount, and there is
  // no `role="dialog"`, no `aria-modal` and no focus trap.
  //
  // CHECK-INS (Phase 3) are armed here and NOWHERE ELSE. Starting a step's timer
  // in this mode also arms the plan's partway reminders for that step, as ordinary
  // `activeTimers` entries on the same write — the existing Cloud Tasks → push path
  // carries them with no server change at all. Plain cook mode arms none, which is
  // what keeps "the same session, two modes" honest: the reminders belong to the
  // plan, and the plan is only in hand here.

  interface Props {
    params: { id: string };
  }
  let { params }: Props = $props();

  // ─── Session lifecycle ─────────────────────────────────────────────────────────
  // The whole of it — subscribe, bootstrap, ended-elsewhere, orphan, restart,
  // finish, close, keep-awake — is plain cook mode's, from `$lib/cookLifecycle`
  // (issue #994). The ONE thing this screen passes in is the ready-guard: the
  // opening stage must not be settled until the plan has landed, because until it
  // does there is no prep board to be past and a session that arrives first would
  // read as "nothing done yet".
  const lifecycle = createCookLifecycle({
    recipeId: () => params.id,
    ready: () => plan !== undefined,
  });

  const recipe = $derived(lifecycle.recipe);
  const { wakeLockSupported, handleRestart, handleComplete, handleClose, toggleWakeLock } =
    lifecycle;
  const restarting = $derived(lifecycle.restarting);
  const completing = $derived(lifecycle.completing);
  const keepAwake = $derived(lifecycle.keepAwake);

  // The plan itself. Its store has THREE states — `undefined` not loaded, `null`
  // loaded and there is no plan, a document — and all three matter here: the
  // "there is no plan" screen must never flash over a plan that is one frame away.
  $effect(() => {
    const id = params.id;
    if (!id) return;
    return initGuidedPlanSync(id);
  });
  const plan = $derived($guidedPlan);

  // ─── Guided mise en place ──────────────────────────────────────────────────────
  // The whole prep screen as one pure shape (issue #767): the plan's jobs grouped
  // under the container each fills, the ingredients inside them as the rows the
  // cook ticks, and — because the prep list REPLACES the ingredient checklist —
  // the remainder the plan accounts for nowhere, rendered as "Also get out". That
  // last part is what makes plan drift able to hide GUIDANCE but never an
  // INGREDIENT: for a plan in sync the section is empty and nothing shows; for a
  // stale one it degrades to exactly the rows plain mise would have given.
  const checkedPrepIds = $derived(new Set($cookSession?.checkedPrepIds ?? []));
  const prepEntries = $derived(plan?.prep ?? []);
  const board = $derived.by(() =>
    recipe ? guidedPrepBoard(recipe, prepEntries) : { cards: [], alsoGetOut: [] },
  );
  // Counted over what is ON SCREEN, never over the session's id list — same
  // direction, and same reason, as `miseProgress`.
  const mise = $derived(guidedMiseProgress(board, checkedPrepIds));

  // A finished card folds to a single done line, so the bench clears as the cook
  // works. Derived from the ticks rather than stored, with ONE override: tapping
  // the done line reopens the card, and tapping the reopened header folds it back
  // — the same shape as the steps stage's `peekedStepId`, and for the same reason
  // (looking at finished work must never be able to change it). Keyed by the
  // container, so a plan edited from another device mid-cook can at worst leave the
  // override pointing at nothing.
  let peekedCardKey = $state<string | null>(null);

  function toggleCardPeek(key: string, open: boolean): void {
    peekedCardKey = open ? key : null;
  }

  // ─── The tick ──────────────────────────────────────────────────────────────────
  // The same beat plain cook mode and the shopping list give a check-off: a haptic
  // tick on the way in and a sage wash on the whole row, held by a transient
  // "just ticked" set that expires on its own and no-ops under reduced motion. The
  // hold deliberately outlasts the animation, because the classes only land once
  // the tick is back through the session store.
  const TICK_BEAT_MS = 600;
  const justTicked = createCheckOffHold(TICK_BEAT_MS);
  onDestroy(() => justTicked.dispose());

  // Focus entry for the full-viewport mode (ui-spec-v05 §2.4). The chrome that had
  // focus is unmounted as this route activates, so without this the next Tab
  // restarts at the top of the document. No restore on the way out, for the same
  // reason as cook mode: this route is always entered from a page that unmounts.
  let pageEl = $state.raw<HTMLElement | null>(null);
  onMount(() => pageEl?.focus({ preventScroll: true }));

  function celebrateTick(id: string, checking: boolean): void {
    if (!checking) {
      justTicked.release([id]);
      return;
    }
    hapticTick();
    justTicked.begin([id]);
  }

  // One tick, through a domain producer on a FRESH snapshot — never a field patch.
  // `persistCookSession` rewrites the whole document (LWW), so both tick lists
  // travel together and neither may be written from a stale copy. The write is
  // never gated on the celebration: leave mid-pop and the tick is still recorded.
  //
  // The id is a `GuidedPrepTickRow`'s: an INGREDIENT's where the job names one, the
  // JOB's where it names none. Both land in `checkedPrepIds` — a row is a row, and
  // the cook should not have to care which kind they just ticked.
  function togglePrep(id: string): void {
    const s = getCookSessionSnapshot();
    if (!s) return;
    celebrateTick(id, !checkedPrepIds.has(id));
    void persistCookSession(withPrepChecked(s, id));
  }

  // ─── Stages ────────────────────────────────────────────────────────────────────
  // Which one this opens on is the lifecycle's one-shot resume, held off by the
  // ready-guard above until the plan has landed.
  const stage = $derived(lifecycle.stage);

  const totalSteps = $derived(recipe?.steps.length ?? 0);
  const showTimeline = $derived(stage === 'steps' && totalSteps > 0);

  // ─── The plan's notes, by step ─────────────────────────────────────────────────
  // Looked up BY STEP ID against the RECIPE's step list, which is what makes a note
  // whose step no longer exists render as NOTHING: it is never found, never shown,
  // and never re-attached to a neighbouring step.
  //
  const noteByStep = $derived(new Map((plan?.stepNotes ?? []).map((n) => [n.stepId, n] as const)));

  // ─── Amounts (issue #761) ──────────────────────────────────────────────────────
  // Guided mode never shows less than plain cook mode. Plain mode prints an amount
  // twice — on the mise checklist and again beside the step that first uses it —
  // and guided mode printed it nowhere: a prep job is a SENTENCE with the
  // quantities deliberately stripped out of it (an amount baked into prose cannot
  // be corrected or re-scaled), and a step named a bowl without ever saying what
  // was in it. The link was always there; only the rendering was missing.
  //
  // ONE first-use map for the whole cook, computed here rather than per step —
  // `firstUseByStep` is the only first-use calculation there is, and a second one
  // inside the each-block would be both waste and an answer waiting to disagree
  // with plain cook mode's.
  const firstUseMap = $derived(firstUseByStep(recipe?.ingredients ?? []));

  // ─── Kit, by step (issue #882) ─────────────────────────────────────────────────
  // Same rule as the amounts above, and for the same reason: guided mode may never
  // show LESS than plain cook mode (docs/ai-kitchen-assistant.md principle 5).
  // Plain mode now names the kit each step reaches for, so this screen does too —
  // ONE map for the whole cook, from the ONE domain query, so the run rule cannot
  // come out differently on the two screens a cook switches between mid-dish.
  //
  // It is not the same thing as the plan's container line below it: the container
  // is what the PLAN says about this bowl and what went into it; this is what the
  // RECIPE needs got out.
  const kitStartingAtStep = $derived(kitByStep(recipe?.kit ?? [], recipe?.steps ?? []));

  // ─── The step deck ─────────────────────────────────────────────────────────────
  // All of it — the element registry, the gesture-owned pager, the probe that says
  // which step the footer acts on, the bottom fade, ticking, the peek, the
  // pending-scroll handshake that advances, and where the deck lands on entry — is in
  // `$lib/stepDeck` (issue #994), shared verbatim with plain cook mode.
  //
  // Verbatim is exact: there is no parameter below that this screen passes
  // differently. Both hand it the live recipe's steps, the lifecycle's stage and a
  // way to open or close a peek. What guided mode adds is not a flag into the deck —
  // it is the look-ahead derived from the PLAN just below, off the deck's own
  // `currentStep`, on the page that holds the plan.
  //
  // The peeked id stays in this file because the markup assigns to it directly, and an
  // assignment needs a variable rather than a getter — the same seam the timer sheet's
  // open flag has below.
  let peekedStepId = $state<string | null>(null);
  const stepDeck = createStepDeck({
    steps: () => recipe?.steps ?? [],
    stage: () => lifecycle.stage,
    setStage: (next) => {
      lifecycle.stage = next;
    },
    setPeeked: (id) => {
      peekedStepId = id;
    },
  });

  // Bound to the names the markup already uses.
  const deck = stepDeck.deck;
  const {
    stepAnchor,
    peekStep,
    untickStep,
    handleStepDone,
    handleResume,
    jumpToStep,
    goToSteps,
    goToMise,
  } = stepDeck;
  const completedStepIds = $derived(stepDeck.completedStepIds);
  // Counted over the RECIPE's step ids, never over the session's completed set —
  // `progressOver`'s contract, and here it is what makes a cook whose completed
  // steps were edited away read "Start cooking" again rather than "Continue".
  const completedStepCount = $derived(
    progressOver(
      (recipe?.steps ?? []).map((s) => s.id),
      completedStepIds,
    ).checked,
  );
  const fadeHeight = $derived(stepDeck.fadeHeight);
  const currentStep = $derived(stepDeck.currentStep);
  const currentStepDone = $derived(stepDeck.currentStepDone);
  const nextIncompleteStep = $derived(stepDeck.nextIncompleteStep);
  const nextIncompleteNumber = $derived(stepDeck.nextIncompleteNumber);

  // What the plan says about the step BELOW this one (issue #769) — the caption on
  // the gap at the bottom of the screen, in place of plain cook mode's faded first
  // clause of the next step.
  //
  // Off `currentStep`, which tracks `visibleStepId` but has an answer before the
  // first probe has run. Reading the raw id instead would leave the panel absent
  // for a frame on entry and then pop in, which on a deck that also springs is a
  // second piece of movement saying nothing.
  //
  // Null whenever the plan says nothing about the next step, which falls back to
  // the plain faded peek. That is the honest answer for a plan whose author had
  // nothing to say here, not a legacy shape being tolerated — guided mode has
  // never shipped past staging, so there is no installed base of plans.
  const lookahead = $derived(
    recipe ? nextStepLookahead(recipe, plan?.stepNotes ?? [], currentStep?.id ?? null) : null,
  );

  // ─── Step timers ───────────────────────────────────────────────────────────────
  // Carried unchanged from plain cook mode, because they are the same timers on the
  // same session document: an `activeTimers` entry with an ABSOLUTE `endsAt`, so a
  // reload or a device switch reconstructs the remaining time with no extra client
  // state, and a timer started in one mode is live in the other. All of it — the
  // projection, the 1s tick, start / dismiss / progress and the one sheet — is in
  // `$lib/cookTimers` (issue #994), shared with CookModePage.
  //
  // What this screen adds, and the ONLY thing it adds, is below: the plan's check-ins,
  // handed to the factory as the function that arms them. It is a parameter rather
  // than a mode, which is what makes "check-ins are guided-only" structural — plain
  // cook mode does not pass one, so it has no way to arm a reminder at all.

  // A check-in with nothing typed in it. The editor lets the minutes stand alone,
  // and a reminder that arrives blank is still better than one that silently never
  // arrives, so it goes out under a name rather than being dropped.
  const UNNAMED_CHECK_IN = 'Check in';

  // The plan's reminders for this timer, as ordinary timer entries anchored to the
  // START INSTANT the caller passes in. Absolute, exactly like the main timer's
  // `endsAt`, which is what makes them survive a reload and — the point of the
  // whole design — makes extending the main timer leave them untouched.
  //
  // `durationMinutes` is the check-in's OWN run (`atMinutes` from the same start),
  // not the main timer's: it is what the entry was actually started for, so the
  // progress fill reads as "how far into the wait for this nudge".
  function checkInEntriesFor(
    timerId: string,
    stepId: string | null,
    startMs: number,
  ): CookActiveTimerDoc[] {
    if (stepId === null) return [];
    return (noteByStep.get(stepId)?.checkIns ?? []).map((c) => ({
      id: checkInTimerId(timerId, c.atMinutes),
      stepId,
      label: c.text.trim() === '' ? UNNAMED_CHECK_IN : c.text.trim(),
      durationMinutes: c.atMinutes,
      endsAt: new Date(startMs + c.atMinutes * 60_000).toISOString(),
      // The same delivery-precision floor the main timer uses — a check-in is the
      // same kind of thing, delivered the same way.
      notify: shouldNotifyFor(c.atMinutes),
    }));
  }

  // Everything else about a timer is plain cook mode's, from `$lib/cookTimers`. The
  // sheet's open flag stays here because the markup binds it, and `bind:` needs a
  // variable it can assign to; everything the sheet is opened WITH is in the factory.
  let timerSheetOpen = $state(false);
  const timers = createCookTimers({
    steps: () => recipe?.steps ?? [],
    showSheet: () => {
      timerSheetOpen = true;
    },
    armCheckIns: checkInEntriesFor,
  });

  // Bound to the names the markup already uses.
  const timerByStep = $derived(timers.timerByStep);
  const barTimers = $derived(timers.barTimers);
  const now = $derived(timers.now);
  const timerSheetPrefill = $derived(timers.sheetPrefill);
  const timerSheetTarget = $derived(timers.sheetTarget);
  const {
    startTimer,
    dismissTimer,
    timerProgressFor,
    openStepTimerSheet,
    openRunningTimerSheet,
    openAdHocTimerSheet,
    confirmTimerSheet,
  } = timers;

  // ─── Recipe-changed banner ─────────────────────────────────────────────────────
  const recipeChanged = $derived(
    hasRecipeChanged($cookSession?.recipeUpdatedAtAtStart ?? null, recipe?.updatedAt ?? null),
  );

  // Restart, Finish, Close and the keep-awake toggle all live on the shared
  // lifecycle, bound at the top of this script.
</script>

<!-- `z-dialog` (50), not a raw z-50: a full-viewport route shares the dialog rung of
   the ladder in ui-spec-v02 §4.1 — above the nav (z-10) and any chrome-replacing bar
   (z-30), below toasts, which must stay legible while cooking. tabindex="-1" exists
   only to make the container a programmatic focus target (see onMount above); it is
   not a tab stop. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={pageEl}
  tabindex="-1"
  class="z-dialog fixed inset-0 flex h-dvh flex-col bg-background focus:outline-none"
  data-testid="guided-cook-page"
>
  {#if recipe === null}
    <CookLoadingOrphan />
  {:else if plan === undefined}
    <!-- The plan's not-loaded state, kept distinct from "there is no plan" so the
       screen below never flashes over a plan one frame from arriving. -->
    <div class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <Spinner size={20} />
      <p class="text-sm text-muted-foreground">Loading the plan…</p>
    </div>
  {:else if plan === null}
    <!-- Never an error: plain cook mode is right there, and it works on the very
       same session, so nothing already ticked or done is lost.

       No longer an edge case (issue #776). It used to be reachable only by typing
       the URL or by the plan being deleted from another device mid-cook; now
       someone whose default IS guided is offered this door on every recipe that
       has no plan, so the screen has to answer "then write me one" rather than
       pointing at a page and leaving them to find it. -->
    <div class="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        title="There's no guided plan for this recipe"
        description="Write one now, or cook it the ordinary way."
        data-testid="guided-cook-no-plan"
      >
        {#snippet icon()}<Icon name="ListChecks" size={28} />{/snippet}
        {#snippet actions()}
          <!-- Writing the plan leads first, because it is the thing the cook came
               here for. The editor is an ordinary shell route, so this leaves the
               full-viewport cook mode — which is right: writing a plan is desk work,
               not something you do with your hands full. -->
          <div class="flex flex-wrap items-center justify-center gap-2">
            <Button
              onclick={() => push(`/recipes/${params.id}/guided`)}
              data-testid="guided-cook-write-plan"
            >
              {#snippet leading()}<Icon name="ListChecks" size={16} />{/snippet}
              Write the plan
            </Button>
            <Button
              variant="outline"
              onclick={() => push(`/recipes/${params.id}/cook`)}
              data-testid="guided-cook-fallback"
            >
              {#snippet leading()}<Icon name="CookingPot" size={16} />{/snippet}
              Cook it anyway
            </Button>
            <Button variant="ghost" onclick={handleClose} data-testid="guided-cook-no-plan-back">
              {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
              Back
            </Button>
          </div>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <!-- Top bar -->
    <header class="flex shrink-0 items-center gap-3 px-4 py-3 {showTimeline ? '' : 'border-b'}">
      <Button
        variant="ghost"
        size="icon"
        onclick={handleClose}
        ariaLabel="Close cook mode"
        title="Close"
        data-testid="cook-mode-close"
      >
        {#snippet leading()}<Icon name="ArrowLeft" size={20} />{/snippet}
      </Button>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-base font-semibold" data-testid="cook-mode-title">
          {recipe.title}
        </span>
        {#if stage === 'mise'}
          <span class="text-xs text-muted-foreground" data-testid="guided-prep-progress">
            Prep · {mise.checked}/{mise.total} done
          </span>
        {:else}
          <!-- The one place the steps stage says which mode you are in. The mise
             stage says it by being a prep list rather than an ingredient list. -->
          <span class="text-xs text-muted-foreground">Guided</span>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onclick={openAdHocTimerSheet}
        ariaLabel="Start a timer"
        title="Start a timer"
        data-testid="cook-mode-timer"
      >
        {#snippet leading()}<Icon name="Timer" size={20} class="text-muted-foreground" />{/snippet}
      </Button>
      {#if wakeLockSupported}
        <Button
          variant="ghost"
          size="icon"
          onclick={toggleWakeLock}
          ariaLabel="Keep screen awake"
          title={keepAwake ? 'Screen stays awake' : 'Keep screen awake'}
          aria-pressed={keepAwake}
          data-testid="cook-mode-wakelock"
          data-active={keepAwake}
        >
          {#snippet leading()}
            <span
              class="relative inline-flex transition-colors {keepAwake
                ? 'text-amber-500'
                : 'text-muted-foreground'}"
            >
              <Icon name="Smartphone" size={20} />
              <Icon
                name="Lock"
                size={14}
                class="absolute -right-1 -bottom-1 rounded-full bg-background"
              />
            </span>
          {/snippet}
        </Button>
      {/if}
    </header>

    <!-- Timeline. One segment per step, each a jump to it. Same band, same colours
       and same meanings as plain cook mode — this is the same progress. -->
    {#if showTimeline}
      <CookTimeline
        steps={recipe.steps}
        {completedStepIds}
        currentStepId={currentStep?.id ?? null}
        onJump={jumpToStep}
      />
    {/if}

    <!-- Recipe-changed banner -->
    {#if recipeChanged}
      <CookRecipeChangedBanner {restarting} onRestart={handleRestart} />
    {/if}

    <!-- Persistent timers bar -->
    {#if barTimers.length > 0}
      <CookTimersBar
        timers={barTimers}
        steps={recipe.steps}
        {now}
        progressFor={timerProgressFor}
        onEdit={openRunningTimerSheet}
        onDismiss={dismissTimer}
      />
    {/if}

    <!-- Stage 1: the prep board / Stage 2: the steps with their notes -->
    {#if stage === 'mise'}
      <!-- A DEEPER GROUND than the rest of the app. The bench is a set of white
         cards and nothing else, so the page behind them is tinted a step down from
         `--background` — otherwise white-on-near-white leaves the cards with no
         edge to lift off once their outlines go. -->
      <main class="min-h-0 flex-1 overflow-y-auto bg-muted/40 px-4 py-4">
        <div class="mx-auto flex max-w-2xl flex-col gap-6">
          {#if board.cards.length === 0 && board.alsoGetOut.length === 0}
            <p class="text-sm text-muted-foreground" data-testid="guided-prep-empty">
              This plan has no prep — everything happens in the steps.
            </p>
          {/if}

          {#if board.cards.length > 0}
            <!-- ONE CARD PER BOWL (issue #767). The container leads, so the card
               reads top-to-bottom as get this bowl → do these things → these
               amounts go in it — the order the work actually happens in, rather
               than the container trailing each job like an afterthought. Counting
               the cards answers "how many bowls?" on this screen, which is what let
               the separate Get-out stage go.

               The TICK ROWS ARE THE INGREDIENTS, not the jobs: "dice the carrots,
               onion and celery" is three things the cook does one at a time, and a
               single tick clearing all three is one you can only give from memory
               at the end. Ticking the last row finishes the job; finishing every
               job finishes the card. -->
            <ul class="flex flex-col gap-3" data-testid="guided-prep-list">
              {#each board.cards as card (card.key)}
                {@const cardProgress = guidedPrepCardProgress(card, checkedPrepIds)}
                <!-- The fold waits out the tick beat on the row that caused it, or
                   the cook's last tap would vanish before they saw it land. The
                   hold is a no-op under reduced motion, where the card folds at
                   once — which is the right answer there too. -->
                {@const celebrating = card.tickIds.some((id) => justTicked.isExiting(id))}
                {@const collapsed =
                  cardProgress.allChecked && !celebrating && peekedCardKey !== card.key}
                <!-- Lifted, not boxed: a soft ambient shadow instead of an outline,
                   and a quiet sage edge down the left so the eye finds where each
                   bowl starts without a rule round all four sides. Done fades to
                   sage — the colour a finished thing goes everywhere else in Salt. -->
                <li
                  class="overflow-hidden rounded-xl border-l-[3px] border-l-secondary/60 shadow-ambient {cardProgress.allChecked
                    ? 'bg-secondary/5'
                    : 'bg-card'}"
                  data-testid="guided-prep-card"
                  data-container-key={card.key}
                  data-complete={cardProgress.allChecked}
                >
                  {#if collapsed}
                    <!-- Done: one line, and the bench clears. Tapping it looks
                       again; it is never a way to untick, exactly as a collapsed
                       step is not — only a row can clear itself. -->
                    <button
                      type="button"
                      class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 active:bg-muted"
                      onclick={() => toggleCardPeek(card.key, true)}
                      data-testid="guided-prep-card-done"
                    >
                      <Icon name="Check" size={18} class="shrink-0 text-primary" />
                      <span class="min-w-0 flex-1 truncate text-base text-muted-foreground">
                        {card.name ?? 'Nothing to set aside'} · done
                      </span>
                      <Icon name="ChevronDown" size={16} class="shrink-0 text-muted-foreground" />
                    </button>
                  {:else}
                    <!-- The header. A named card always has one; the unheaded card
                       (every job that sets nothing aside) gains one only once it is
                       done, because it then needs somewhere to fold back from. -->
                    {#if card.name !== null || cardProgress.allChecked}
                      {#snippet cardHeading()}
                        {#if card.name !== null}
                          <!-- The vessel itself, drawn (issue #882). The card's
                             name is resolved against the curated tool vocabulary
                             at DISPLAY time — nothing about this card stores a
                             tool id — so a name the list does not know simply
                             renders as words: CanonIcon draws its own bare tile
                             and the header is the name alone. That is the point,
                             not a shortfall. The generic soup glyph that used to
                             sit here was a picture of the wrong thing beside
                             "baking tray", which is the defect this replaces. -->
                          <CanonIcon
                            thumbnail={$kitIcons.kitIconFor(card.name)}
                            version={$kitIcons.kitIconVersionFor(card.name)}
                            name={card.name}
                            size={32}
                          />
                        {/if}
                        <span
                          class="min-w-0 flex-1 truncate text-base font-semibold"
                          data-testid="guided-prep-card-name"
                        >
                          {card.name ?? 'Nothing to set aside'}
                        </span>
                        <span
                          class="shrink-0 text-sm tabular-nums text-muted-foreground"
                          data-testid="guided-prep-card-count"
                        >
                          {cardProgress.checked}/{cardProgress.total}
                        </span>
                      {/snippet}
                      {#if cardProgress.allChecked}
                        <button
                          type="button"
                          class="flex w-full items-center gap-2.5 border-b border-border/50 px-4 py-3.5 text-left transition-colors hover:bg-muted/50 active:bg-muted"
                          onclick={() => toggleCardPeek(card.key, false)}
                          data-testid="guided-prep-card-header"
                        >
                          {@render cardHeading()}
                          <Icon name="ChevronUp" size={16} class="shrink-0 text-muted-foreground" />
                        </button>
                      {:else}
                        <div
                          class="flex w-full items-center gap-2.5 border-b border-border/50 px-4 py-3.5"
                          data-testid="guided-prep-card-header"
                        >
                          {@render cardHeading()}
                        </div>
                      {/if}
                    {/if}

                    <ul class="flex flex-col gap-2 px-3 py-4">
                      {#each card.jobs as job (job.id)}
                        {@const jobDone = job.rows.every((r) => checkedPrepIds.has(r.id))}
                        <!-- A job naming no ingredient ("open the tin") has nothing
                           to tick under it, so the job line IS its tick row. -->
                        {@const jobTickId =
                          job.rows.length === 1 && job.rows[0]!.ingredient === null
                            ? job.rows[0]!.id
                            : null}
                        <li data-testid="guided-prep-job" data-prep-id={job.id}>
                          {#if jobTickId !== null}
                            {@const popping = jobDone && justTicked.isExiting(jobTickId)}
                            <button
                              type="button"
                              class="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50 active:bg-muted {popping
                                ? 'salt-tick-row motion-reduce:animate-none'
                                : ''}"
                              onclick={() => togglePrep(jobTickId)}
                              aria-pressed={jobDone}
                              data-testid="guided-prep-row"
                              data-tick-id={jobTickId}
                            >
                              <span
                                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border {jobDone
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-input'} {popping
                                  ? 'salt-check-pop motion-reduce:animate-none'
                                  : ''}"
                                data-testid="guided-prep-check"
                              >
                                {#if jobDone}<Icon name="Check" size={16} />{/if}
                              </span>
                              <span
                                class="min-w-0 flex-1 text-base {jobDone
                                  ? 'text-muted-foreground line-through'
                                  : ''}"
                              >
                                {job.text}
                              </span>
                            </button>
                          {:else}
                            <p
                              class="px-2 text-base {jobDone
                                ? 'text-muted-foreground line-through'
                                : ''}"
                              data-testid="guided-prep-job-text"
                            >
                              {job.text}
                            </p>
                            <!-- HOW MUCH (issue #761), now the thing you tap. The
                               job's sentence carries no quantities by design, so
                               without these the cook is told to finely slice "the
                               red onion" and never told there is one of them.
                               Long-press adds to the shopping list (#714) — every
                               ingredient row on this page is its own button now, so
                               the gesture reaches all of them rather than only the
                               "Also get out" remainder. -->
                            <ul class="mt-0.5 flex flex-col gap-0.5 pl-4">
                              {#each job.rows as row (row.id)}
                                {@const ingredient = row.ingredient}
                                {#if ingredient}
                                  {@const checked = checkedPrepIds.has(row.id)}
                                  {@const popping = checked && justTicked.isExiting(row.id)}
                                  <li>
                                    <button
                                      type="button"
                                      class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 active:bg-muted {popping
                                        ? 'salt-tick-row motion-reduce:animate-none'
                                        : ''}"
                                      onclick={() => togglePrep(row.id)}
                                      use:longpress={{
                                        onLongPress: () =>
                                          void addIngredientToShoppingList(ingredient),
                                      }}
                                      aria-pressed={checked}
                                      data-testid="guided-prep-row"
                                      data-tick-id={row.id}
                                    >
                                      <span
                                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border {checked
                                          ? 'border-primary bg-primary text-primary-foreground'
                                          : 'border-input'} {popping
                                          ? 'salt-check-pop motion-reduce:animate-none'
                                          : ''}"
                                        data-testid="guided-prep-check"
                                      >
                                        {#if checked}<Icon name="Check" size={16} />{/if}
                                      </span>
                                      <CanonIcon
                                        thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                                        name={ingredientLabel(ingredient)}
                                        version={$ingredientIcons.iconVersionFor(ingredient)}
                                        dimmed={checked}
                                        size={32}
                                      />
                                      <span
                                        class="min-w-0 flex-1 text-base {checked
                                          ? 'text-muted-foreground line-through'
                                          : ''}"
                                      >
                                        <IngredientText {ingredient} />
                                      </span>
                                    </button>
                                  </li>
                                {/if}
                              {/each}
                            </ul>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if board.alsoGetOut.length > 0}
            <!-- The remainder: ingredients this plan names in no job. Almost always
               because the recipe gained them after the plan was written. Ticked into
               the SAME list as a prep row, by ingredient id — they are rows on this
               screen and the cook should not have to care which kind they are. -->
            <section class="flex flex-col gap-2" data-testid="guided-also-get-out">
              <div class="flex flex-col gap-1 border-b py-2">
                <h2 class="text-base font-semibold text-foreground">Also get out</h2>
                <p class="text-sm text-muted-foreground">
                  The plan doesn't mention these — it was probably written before they were part of
                  the recipe.
                </p>
              </div>
              <ul class="flex flex-col gap-2">
                {#each board.alsoGetOut as ingredient (ingredient.id)}
                  {@const checked = checkedPrepIds.has(ingredient.id)}
                  {@const popping = checked && justTicked.isExiting(ingredient.id)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                        ? 'border-primary/40 bg-primary/5'
                        : 'bg-card hover:bg-muted/50'} {popping
                        ? 'salt-tick-row motion-reduce:animate-none'
                        : ''}"
                      onclick={() => togglePrep(ingredient.id)}
                      use:longpress={{
                        onLongPress: () => void addIngredientToShoppingList(ingredient),
                      }}
                      aria-pressed={checked}
                      data-testid="guided-also-get-out-row"
                    >
                      <span
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input'} {popping
                          ? 'salt-check-pop motion-reduce:animate-none'
                          : ''}"
                      >
                        {#if checked}<Icon name="Check" size={18} />{/if}
                      </span>
                      <CanonIcon
                        thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                        name={ingredientLabel(ingredient)}
                        version={$ingredientIcons.iconVersionFor(ingredient)}
                        dimmed={checked}
                        size={40}
                      />
                      <span
                        class="min-w-0 flex-1 text-base {checked
                          ? 'text-muted-foreground line-through'
                          : ''}"
                      >
                        <IngredientText {ingredient} />
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      </main>
    {:else}
      <!-- The steps, one per screen, on the same gesture-owned deck plain cook mode
         uses. NOT a scroll container: `$lib/deck` owns the drag, the fling, the
         wheel, the arrow keys and the spring. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <main
        bind:this={deck.viewportEl}
        class="relative min-h-0 flex-1 touch-pinch-zoom overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        data-testid="cook-steps-view"
        tabindex="0"
        aria-label="Guided steps"
        onpointerdown={deck.handlePointerDown}
        onpointermove={deck.handlePointerMove}
        onpointerup={deck.handlePointerUp}
        onpointercancel={deck.handlePointerUp}
        onwheel={deck.handleWheel}
        onkeydown={deck.handleKeyDown}
      >
        {#if recipe.steps.length === 0}
          <div class="flex h-full flex-col items-center justify-center p-6">
            <EmptyState
              title="This recipe has no steps"
              description="There's nothing to guide through — tap Finish cooking when you're done."
            />
          </div>
        {/if}
        <div
          bind:this={deck.contentEl}
          class="will-change-transform"
          style="transform: translate3d(0, {-deck.offset}px, 0); padding-bottom: {PEEK_MAX_PX}px"
          data-testid="cook-steps-deck"
        >
          {#each recipe.steps as step, i (step.id)}
            {@const done = completedStepIds.has(step.id)}
            {@const note = noteByStep.get(step.id) ?? null}
            {@const collapsed = done && peekedStepId !== step.id}
            <!-- Check-ins hang off the step's TIMER, so a step that has lost its
               timer has nothing to hang them on — they are neither shown nor armed
               rather than promised and never delivered. -->
            {@const checkIns = step.timer ? (note?.checkIns ?? []) : []}
            <!-- What is in the bowl this step reaches for, and what it introduces
               that came out of no bowl (issue #761). `containerContents` is empty
               whenever the named container matches no prep job — plan drift, a
               renamed bowl, a hand-edit — and the container line then renders
               exactly as it did before this existed. `loose` is the first-use list
               minus only THAT bowl's contents: an ingredient prepped elsewhere, or
               into no container at all, is still printed here, because plain cook
               mode prints it here. -->
            {@const containerEntry = prepEntryForContainer(prepEntries, note?.container ?? null)}
            {@const containerContents = prepEntryIngredients(recipe, containerEntry)}
            {@const loose = looseIngredientsForStep(
              firstUseMap.get(step.id) ?? [],
              prepEntries,
              note,
            )}
            {@const stepKit = kitStartingAtStep.get(step.id) ?? []}
            <section
              use:stepAnchor={step.id}
              data-step-id={step.id}
              data-complete={done}
              data-testid="cook-step"
              class="flex flex-col px-4 {collapsed ? 'py-2' : 'border-t py-6'}"
              style="min-height: {collapsed ? 0 : sectionMinHeight(deck.viewportHeight)}px"
            >
              {#if collapsed}
                <!-- A DONE step recedes into sage, so the live step is the only
                   black-on-white thing on the deck. Sage rather than the teal
                   primary because that is what a finished thing goes everywhere
                   else in Salt — the shopping list floods a ticked row with it.
                   Plain cook mode hands the same component its teal; the two
                   values live at these two call sites so neither can be changed
                   without seeing the other. -->
                <CookStepCollapsed
                  index={i}
                  text={step.text}
                  accentClass="border-secondary/30 bg-secondary/5"
                  labelClass="text-secondary"
                  onPeek={() => peekStep(step.id)}
                />
              {:else}
                <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
                  <div class="flex flex-col gap-3">
                    {#if done}
                      <div>
                        <span
                          class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                          data-testid="cook-step-done-badge"
                        >
                          <Icon name="Check" size={12} />
                          Done
                        </span>
                      </div>
                    {/if}
                    <!-- THE RECIPE'S OWN WORDS, verbatim and first. The plan adds
                       lines underneath; it never overrides, rewords or reorders
                       one. -->
                    <p class="text-xl font-semibold leading-relaxed tracking-tight sm:text-2xl">
                      {step.text}
                    </p>
                  </div>

                  <!-- The recipe's own step note, still the recipe speaking, so it
                     keeps its amber-callout vocabulary and its place directly under
                     the instruction — above anything the plan added. -->
                  {#if step.note}
                    <div
                      class="flex items-start gap-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                      data-testid="cook-step-note"
                    >
                      <Icon name="TriangleAlert" size={20} class="mt-1 shrink-0 text-amber-500" />
                      <span class="whitespace-pre-wrap text-lg">{step.note}</span>
                    </div>
                  {/if}

                  <!-- What the plan added: which prepped container this step wants,
                     how the station is set, and the sensory test that says it is
                     going right. Quiet rows rather than callouts — none of them is a
                     warning, and three amber boxes on one step would shout down the
                     instruction they belong to. Each line is independently optional
                     (null means the plan had nothing honest to say), so a step with
                     no note renders exactly as it does in plain cook mode.
                     `whitespace-pre-wrap` keeps author-typed line breaks.
                     The check-ins are listed here too, as what they are: what this
                     step's timer will say, and when. Displayed, never enforced —
                     starting the timer is what arms them, and ignoring one changes
                     nothing about the cook. -->
                  <!-- The guard admits `loose` too (issue #761): an ingredient this
                     step introduces from no bowl has to be printed whether or not
                     the plan had anything to say about the step, so this list is
                     "everything guided mode adds under this step" rather than
                     "everything the plan authored". -->
                  {#if loose.length > 0 || (note && (note.container || note.setup || note.cue || checkIns.length > 0))}
                    <ul
                      class="flex flex-col gap-2.5 border-l-2 border-secondary/40 pl-4"
                      data-testid="guided-step-notes"
                    >
                      {#if note?.container}
                        <li class="flex flex-col gap-2" data-testid="guided-step-note-container">
                          <span class="flex items-start gap-3">
                            <!-- The same drawn vessel as the mise card's header
                               (issue #882), at the callout's size. Resolved from
                               the step's own words, so the two surfaces cannot
                               disagree about which bowl this is. -->
                            <CanonIcon
                              thumbnail={$kitIcons.kitIconFor(note.container)}
                              version={$kitIcons.kitIconVersionFor(note.container)}
                              name={note.container}
                              size={32}
                            />
                            <span class="whitespace-pre-wrap text-base text-muted-foreground"
                              >{note.container}</span
                            >
                          </span>
                          <!-- What is actually in it. Nested UNDER the bowl's name
                             rather than beside it: the name is the handle the cook
                             already knows from the prep screen, and the contents are
                             the amounts that screen showed. Empty when no prep job
                             fills this name, in which case the row above is all
                             there is — the pre-#761 rendering, unchanged. -->
                          {#if containerContents.length > 0}
                            <ul class="ml-10 flex flex-col gap-1.5">
                              {#each containerContents as ingredient (ingredient.id)}
                                <li
                                  class="flex items-center gap-2"
                                  data-testid="guided-step-container-contents"
                                >
                                  <CanonIcon
                                    thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                                    name={ingredientLabel(ingredient)}
                                    version={$ingredientIcons.iconVersionFor(ingredient)}
                                    size={32}
                                  />
                                  <span class="min-w-0 flex-1 text-base">
                                    <IngredientText {ingredient} />
                                  </span>
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        </li>
                      {/if}
                      <!-- Used here, out of no bowl. Plain cook mode reprints every
                         ingredient at the step that first uses it; this is the same
                         list with the bowl's own contents taken out, so nothing is
                         said twice on one screen and nothing goes unsaid. A quiet
                         row in the same register as the others — an ingredient is
                         not a warning. -->
                      {#each loose as ingredient (ingredient.id)}
                        <li class="flex items-center gap-3" data-testid="guided-step-loose">
                          <span
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary/10 text-secondary"
                          >
                            <Icon name="Plus" size={17} ariaLabel="Also" />
                          </span>
                          <CanonIcon
                            thumbnail={$ingredientIcons.thumbnailFor(ingredient)}
                            name={ingredientLabel(ingredient)}
                            version={$ingredientIcons.iconVersionFor(ingredient)}
                            size={32}
                          />
                          <span class="min-w-0 flex-1 text-base">
                            <IngredientText {ingredient} />
                          </span>
                        </li>
                      {/each}
                      {#if note?.setup}
                        <li class="flex items-start gap-3" data-testid="guided-step-note-setup">
                          <span
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-tertiary-variant/10 text-tertiary-variant"
                          >
                            <Icon name="Flame" size={17} ariaLabel="Setup" />
                          </span>
                          <span class="whitespace-pre-wrap text-base text-muted-foreground"
                            >{note.setup}</span
                          >
                        </li>
                      {/if}
                      {#if note?.cue}
                        <li class="flex items-start gap-3" data-testid="guided-step-note-cue">
                          <span
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                          >
                            <Icon name="Ear" size={17} ariaLabel="Cue" />
                          </span>
                          <span class="whitespace-pre-wrap text-base text-muted-foreground"
                            >{note.cue}</span
                          >
                        </li>
                      {/if}
                      {#each checkIns as checkIn, ci (ci)}
                        <li class="flex items-start gap-3" data-testid="guided-step-check-in">
                          <span
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary/10 text-secondary"
                          >
                            <Icon name="Bell" size={17} ariaLabel="Check in" />
                          </span>
                          <!-- `whitespace-pre-wrap` sits on the AUTHORED TEXT alone,
                             never on a span that also holds markup. This row is the
                             only note built from more than one interpolation, and
                             with the class on the outer span the source's own newline
                             and indentation between "—" and the text were preserved
                             verbatim — a line break and a 28-space indent on screen.
                             The other rows are a single `{...}`, so nothing of the
                             source can leak into them; this one had to be split. -->
                          <span class="text-base text-muted-foreground">
                            <span class="font-medium text-foreground"
                              >{checkIn.atMinutes} min in</span
                            >
                            —
                            <span class="whitespace-pre-wrap">{checkIn.text}</span>
                          </span>
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  <!-- The kit this step reaches for (issue #882) — the same row,
                     in the same chip vocabulary, plain cook mode draws. BESIDE the
                     plan's notes rather than inside them, because it is not
                     something the plan authored: the container line above is what
                     the plan says about THIS BOWL, and this is what the recipe needs
                     got out. Nesting it in that list would put the recipe's own
                     words inside the plan's bracket.

                     Additive, never a substitution — no line of text on this screen
                     is replaced by a picture, and an unresolved label keeps its
                     words and loses only the drawing. That is principle 5 of
                     docs/ai-kitchen-assistant.md at its narrowest: guided mode shows
                     everything plain cook mode shows, and then some. -->
                  {#if stepKit.length > 0}
                    <CookStepKit entries={stepKit} />
                  {/if}

                  <!-- Per-step timer, unchanged from plain cook mode: state derives
                     purely from the persisted `endsAt`, so it survives reloads and
                     device switches, and the persistent bar above keeps it visible
                     once this step collapses. -->
                  {#if step.timer}
                    <CookStepTimer
                      timer={step.timer}
                      entry={timerByStep.get(step.id)}
                      {now}
                      progressFor={timerProgressFor}
                      onStart={() => startTimer(step)}
                      onAdjust={() => openStepTimerSheet(step)}
                      onDismiss={dismissTimer}
                    />
                  {/if}

                  {#if done}
                    <CookStepDoneControls
                      onUntick={() => untickStep(step.id)}
                      onCollapse={() => (peekedStepId = null)}
                    />
                  {/if}
                </div>
              {/if}
            </section>
          {/each}
        </div>
        <!-- THE GAP BELOW THE STEP, captioned (issue #769).

           Plain cook mode spends this space on the top of the next step's own text,
           fading out — the best answer available when there is no plan. A guided
           plan can say what that step DOES in one line, and, far more usefully, which
           part of it has to be started now: an oven that needs fifteen minutes to
           come up is a next-step instruction that has to happen during this one, and
           a fading first clause will never say so.

           Same box, same measured height, still `pointer-events-none` — the deck owns
           every gesture in this area and nothing here may intercept one.

           THE GAP IS PAINTED OUT, not faded over. A gradient that reaches transparent
           part-way up leaves the next step's opening line legible above the words
           replacing it, which is the worst of both: two previews of the same step, one
           of them half-erased. So the panel is a SOLID ground with a short soft edge
           along its top — `LOOKAHEAD_VEIL_PX` — which is there only to keep the join
           from reading as a rule across the screen.

           Two stacked boxes rather than one multi-stop gradient because the stops are
           in PIXELS, not percentages: the gap varies from ~96px to 224px, so a
           percentage stop would make the soft edge grow and shrink with it. Utilities
           only for the same reason `--color-background` cannot be named here — the
           theme inlines it, so an inline gradient would have to reach past the token
           layer to the `--salt-*` primitive.

           Falls back to precisely the old fade in both of the cases where the panel
           would be wrong: no lookahead authored, and a step whose own text runs so
           far down the screen that a panel would cover the lines still being read
           (`fadeFitsLookahead` — the geometry rule, tested with the rest of the deck
           arithmetic rather than guessed at here). -->
        {#if lookahead && fadeFitsLookahead(fadeHeight)}
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col"
            style="height: {fadeHeight}px"
            data-testid="guided-step-lookahead"
          >
            <div
              class="shrink-0 bg-gradient-to-t from-background to-transparent"
              style="height: {LOOKAHEAD_VEIL_PX}px"
              aria-hidden="true"
            ></div>
            <div class="flex flex-1 flex-col justify-end gap-1 bg-background px-4 pb-3">
              <div class="mx-auto flex w-full max-w-2xl flex-col gap-1">
                {#if lookahead.getAhead}
                  <!-- The one line here that is an INSTRUCTION, so it is the one line
                   that gets a colour and an icon. It is also deliberately above the
                   summary: if the cook reads one thing in this gap, it is this. -->
                  <p
                    class="flex items-start gap-2 text-sm font-medium text-primary"
                    data-testid="guided-step-get-ahead"
                  >
                    <Icon name="Hourglass" size={16} class="mt-0.5 shrink-0" />
                    <span class="min-w-0 flex-1">{lookahead.getAhead}</span>
                  </p>
                {/if}
                {#if lookahead.lookahead}
                  <p class="flex items-baseline gap-2 text-sm text-muted-foreground">
                    <span class="shrink-0 text-xs font-semibold uppercase tracking-wide">
                      Next · {lookahead.number}
                    </span>
                    <span class="min-w-0 flex-1 truncate">{lookahead.lookahead}</span>
                  </p>
                {/if}
              </div>
            </div>
          </div>
        {:else}
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background to-transparent"
            style="height: {fadeHeight}px"
            aria-hidden="true"
          ></div>
        {/if}
      </main>
    {/if}

    <!-- Footer. Exactly one primary action, always in the same place, and — the
       page's only stage chrome besides the header line — the way back one stage on
       the left. The prep board has no bulk tick: it is work you actually did, not a
       shelf you can declare gathered in one tap. -->
    <footer
      class="flex shrink-0 items-center gap-3 border-t px-4 py-3 {stage === 'steps'
        ? 'justify-between'
        : 'justify-end'}"
    >
      {#if stage === 'mise'}
        <Button size="lg" onclick={goToSteps} data-testid="cook-stage-toggle">
          {completedStepCount > 0 ? 'Continue cooking' : 'Start cooking'}
          {#snippet trailing()}<Icon name="ArrowRight" size={16} />{/snippet}
        </Button>
      {:else}
        <Button variant="ghost" onclick={goToMise} data-testid="cook-stage-back">
          {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
          Prep
        </Button>
        {#if currentStep && !currentStepDone}
          <Button size="lg" onclick={handleStepDone} data-testid="cook-step-done">
            {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
            {nextIncompleteStep ? 'Done · next' : 'Done'}
          </Button>
        {:else if nextIncompleteStep}
          <Button size="lg" onclick={handleResume} data-testid="cook-step-resume">
            Resume · step {nextIncompleteNumber}
            {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
          </Button>
        {:else}
          <Button
            size="lg"
            onclick={handleComplete}
            loading={completing}
            disabled={completing}
            data-testid="cook-mode-complete"
          >
            {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
            Finish cooking
          </Button>
        {/if}
      {/if}
    </footer>

    <!-- Mounted for the life of the page, never wrapped in `{#if}` — the sheet owns
       its own open/close transition. It portals to <body>, so it lands above this
       full-viewport container rather than inside it. -->
    <CookTimerSheet
      bind:open={timerSheetOpen}
      prefill={timerSheetPrefill}
      running={timerSheetTarget?.running ?? false}
      onConfirm={confirmTimerSheet}
    />
  {/if}
</div>
