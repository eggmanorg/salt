<script lang="ts">
  import { Button, CanonIcon, EmptyState, Icon, Spinner } from '@salt/ui-components';
  import { onDestroy, onMount } from 'svelte';
  import { flattenIngredients, progressOver, recipeChangedSince, stageStatus } from '@salt/domain';
  import type { BatchStageDoc } from '@salt/domain/schemas';
  import { goBack } from '../../lib/nav.js';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import {
    batch,
    initBatchSync,
    advanceStage,
    setIngredientChecked,
    setStepDone,
  } from '../../lib/batchService.js';
  import { observations, initBatchObservationsSync } from '../../lib/batchObservationService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { isWakeLockSupported, createWakeLock } from '../../lib/wakeLock.js';
  import { tick as hapticTick } from '../../lib/haptics.js';
  // The #994 cook parts, reused verbatim: the pager and its geometry, the collapsed
  // row, the kit chips, the done controls, the timeline and the amber banner.
  import { createStepDeck } from '../../lib/stepDeck.svelte.js';
  import { sectionMinHeight, PEEK_MAX_PX } from '../../lib/cookDeck.js';
  import { ingredientIcons, ingredientLabel } from '../../lib/cookIngredientIcons.js';
  import { firstUseByStep, kitByStep, stageTemperatureText } from '@salt/domain';
  import IngredientText from '../recipes/IngredientText.svelte';
  import CookTimeline from '../recipes/CookTimeline.svelte';
  import CookStepCollapsed from '../recipes/CookStepCollapsed.svelte';
  import CookStepKit from '../recipes/CookStepKit.svelte';
  import CookStepDoneControls from '../recipes/CookStepDoneControls.svelte';
  import CookRecipeChangedBanner from '../recipes/CookRecipeChangedBanner.svelte';
  import BatchObservationSheet from './BatchObservationSheet.svelte';
  import BatchReadingRow from './BatchReadingRow.svelte';
  import {
    formatGrams,
    formatStatedDuration,
    formatTimeOfDay,
    formatWhen,
    isObservational,
  } from './batchDisplay.js';

  // COOKING A RUN (issue #1327, epic #778) — `/batches/:id/cook`.
  //
  // The app's THIRD full-viewport route, and the third reading of one act. Cook mode
  // is the recipe's own numbers; the guided cook is the same steps through a plan;
  // this is the same steps through a RUNNING BATCH — the frozen grams as the
  // weigh-out, the schedule's stages as bands on the steps they cite, and the
  // schedule's clock where cook mode would arm a timer. Declared in
  // `../fullViewport.ts` and named in `docs/design/ui-spec-v05.md` §2.1, as every
  // member of that list must be; the chrome is never suppressed from in here.
  //
  // ─── WHY THERE IS NO COOK SESSION ─────────────────────────────────────────────
  //
  // The ticks — which components are weighed, which steps are done — live on the
  // BATCH document (`checkedIngredientIds`, `completedStepIds`). A `cookSessions`
  // doc is per user and dies with the cook; a batch is the family's and outlives it.
  // Two people can have hands on one bake, and "the flour is weighed" is a fact
  // about the batch rather than about whoever weighed it — the same argument that
  // already put stage done/skip on this document. Everyone on the run sees everyone
  // else's ticks, deliberately. `docs/formulas-schedules-batches.md` says it
  // outright: a batch is not a cook session and must not be built on one.
  //
  // That is also why none of the session-bound cook modules is here.
  // `cookLifecycle.svelte.ts` and `cookTimers.svelte.ts` stay with the recipe
  // screens; the deck is shared because the deck genuinely is the same deck, which
  // is what the progress seam on `createStepDeck` exists for.
  //
  // ─── WHY THERE IS NO FINISH ───────────────────────────────────────────────────
  //
  // Cook mode ends its session; this page ends nothing. A batch ends when every
  // stage is done or skipped, on the batch page, exactly as today — and for a
  // ferment or a cure the hands-on part is one day of a weeks-long run, so a Finish
  // meaning "the batch is over" would be wrong for two of the three crafts and a
  // Finish meaning "hands off" is just leaving. Back returns to `/batches/:id`.
  //
  // ─── WHY THE SCHEDULE OWNS THE CLOCK ──────────────────────────────────────────
  //
  // A step cited by a `wait` stage with a duration counts down to that stage's
  // `plannedEndAt` and offers no cook timer — the batch's push reminder already
  // exists for that moment (`onBatchWritten`), and a second clock beside it would be
  // two alarms for one prove. The recipe's own timer for such a step is shown as
  // TEXT: it is the recipe's opinion, and the run's plan is what is actually being
  // waited on. Marking the step done marks the stage done, which re-times the tail
  // through `withStageAdvanced` and lets the existing reminder path re-enqueue.
  //
  // Every number on screen that belongs to the run is the run's own frozen figure;
  // the METHOD is read live from the recipe, which is the one join the batch page
  // deliberately does not make. That is why the recipe-updated banner belongs here
  // and not there — and why it carries no Restart: the grams are frozen by design,
  // so there is nothing to restart (a fresh run is a fresh run).

  let { params }: { params?: { id?: string } } = $props();

  const batchId = $derived(params?.id ?? '');

  $effect(() => {
    if (!batchId) return;
    return initBatchSync(batchId);
  });

  // The log rides on its own subscription, as it does on the batch page: an
  // observational stage shows the latest reading taken against it, and the header
  // pencil writes into the same collection.
  $effect(() => {
    if (!batchId) return;
    return initBatchObservationsSync(batchId);
  });

  // Three states, all different sentences: `undefined` still loading, `null` a link
  // to a run that is not there, a document the run.
  const run = $derived($batch);
  // The LIVE recipe, for the method alone. `null` while the library loads and
  // `null` for a dish that has since been deleted — the run survives either.
  const recipe = $derived(run ? ($recipes.find((r) => r.id === run.recipeId) ?? null) : null);
  const steps = $derived(recipe?.steps ?? []);

  // ─── The ticks ────────────────────────────────────────────────────────────────
  const checkedIds = $derived(new Set(run?.checkedIngredientIds ?? []));
  const completedIds = $derived(new Set(run?.completedStepIds ?? []));

  // ─── The weigh-out ────────────────────────────────────────────────────────────
  //
  // The batch's own `quantities`, grams leading and the percentage muted under it —
  // this is what mise en place IS for a run, and the one place a scaled number is
  // ever shown (the recipe never shows one). The label is the recipe's own line as
  // it was when the run started; the picture is joined against the LIVE recipe by
  // ingredient id, so a row whose ingredient has since gone keeps its words and
  // loses only its tile.
  //
  // Recipe-only ingredients — the crushed vitamin C tablet the formula has no
  // percentage for — come after, as written, with no batch quantity. They are as
  // real a part of the weigh-out as the flour, and dropping them would send someone
  // to the recipe page mid-bake.
  const liveIngredients = $derived(recipe ? flattenIngredients(recipe) : []);
  const ingredientById = $derived(new Map(liveIngredients.map((ing) => [ing.id, ing])));
  const quantityById = $derived(new Map((run?.quantities ?? []).map((q) => [q.ingredientId, q])));
  const extraIngredients = $derived(liveIngredients.filter((ing) => !quantityById.has(ing.id)));
  // Counted over the rows ON SCREEN, never over the stored id list — a tick left
  // behind by an edited-away ingredient must not inflate the count (`progressOver`).
  const miseIds = $derived([
    ...(run?.quantities ?? []).map((q) => q.ingredientId),
    ...extraIngredients.map((ing) => ing.id),
  ]);
  const mise = $derived(progressOver(miseIds, checkedIds));

  // ─── Where the stages sit in the method ───────────────────────────────────────
  //
  // Stages are ANNOTATIONS ON THE METHOD, not a replacement for it: the deck is
  // every recipe step in recipe order, and a stage rides on the step it cites.
  //
  // A stage with no step — an added fridge retard, or one whose citation the
  // extraction dropped as hallucinated — gets a card of its own, after the previous
  // stage's step, or before the first step when it is the first stage. Never
  // hidden: `extractProcessStages` drops the citation and never the stage, so a
  // `stepId` of `null` is as real a stage as any other and nothing here gates on it.
  interface StagePlacement {
    stage: BatchStageDoc;
    /** 1-based, over the run's whole stage list — what the band counts. */
    number: number;
  }
  const layout = $derived.by(() => {
    const stages = run?.stages ?? [];
    const stepIds = new Set(steps.map((s) => s.id));
    const onStep = new Map<string, StagePlacement>();
    const after = new Map<string, StagePlacement[]>();
    const leading: StagePlacement[] = [];
    let anchor: string | null = null;
    stages.forEach((stage, index) => {
      const placement: StagePlacement = { stage, number: index + 1 };
      // A second stage citing a step the first already claimed becomes a card of its
      // own rather than overwriting the band — two stages are two stages.
      if (stage.stepId !== null && stepIds.has(stage.stepId) && !onStep.has(stage.stepId)) {
        onStep.set(stage.stepId, placement);
        anchor = stage.stepId;
        return;
      }
      if (anchor === null) leading.push(placement);
      else {
        const list = after.get(anchor);
        if (list) list.push(placement);
        else after.set(anchor, [placement]);
      }
    });
    return { onStep, after, leading, total: stages.length };
  });

  // ─── The deck ─────────────────────────────────────────────────────────────────
  let stage = $state<'mise' | 'steps'>('mise');
  let peekedStepId = $state<string | null>(null);

  const stepDeck = createStepDeck({
    steps: () => steps,
    // Completion lives on the BATCH here — the seam issue #1327 gave the deck.
    completedStepIds: () => completedIds,
    setStepDone: (id, done) => void markStep(id, done),
    stage: () => stage,
    setStage: (next) => {
      stage = next;
    },
    setPeeked: (id) => {
      peekedStepId = id;
    },
  });
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
  const currentStep = $derived(stepDeck.currentStep);
  const currentStepDone = $derived(stepDeck.currentStepDone);
  const nextIncompleteStep = $derived(stepDeck.nextIncompleteStep);
  const nextIncompleteNumber = $derived(stepDeck.nextIncompleteNumber);
  const fadeHeight = $derived(stepDeck.fadeHeight);
  const showTimeline = $derived(stage === 'steps' && steps.length > 1);
  const stepProgress = $derived(
    progressOver(
      steps.map((s) => s.id),
      completedIds,
    ),
  );

  const firstUse = $derived(recipe ? firstUseByStep(recipe.ingredients) : new Map());
  const kit = $derived(kitByStep(recipe?.kit ?? [], steps));

  // ─── Writing ──────────────────────────────────────────────────────────────────
  //
  // ONE WRITE AT A TIME. Every command here rewrites the WHOLE batch document
  // (LWW, `setDoc`), so two in the air at once is one silently overwriting the
  // other — the same single lock the batch page keeps across its three stage
  // commands, and the reason marking a step with a stage is two sequential writes
  // rather than two concurrent ones.
  let writing = $state(false);

  async function markStep(stepId: string, done: boolean): Promise<void> {
    const current = run;
    if (!current || writing) return;
    writing = true;
    try {
      const ticked = await setStepDone(current, stepId, done);
      if (ticked.kind !== 'ok') {
        addToast("Couldn't save that. Try again.", 'destructive');
        return;
      }
      // MARKING THE STEP OF A STAGE MARKS THE STAGE. That write is the one the whole
      // reminder engine hangs off: `withStageAdvanced` re-times every later stage
      // from this instant and `onBatchWritten` re-queues the reminders whose key
      // moved — exactly what Done does on the batch page. Early and late are the
      // same gesture.
      //
      // UNTICKING DOES NOT UN-MARK IT. There is no inverse of `withStageAdvanced`
      // and there deliberately is not one: the tail has already been re-timed
      // against the instant the stage ended, and "un-ending" it would have to invent
      // a schedule nobody planned. Unticking a step is a correction to the METHOD's
      // checklist; the run's record of what happened stands, and the batch page is
      // where a run is corrected.
      if (!done) return;
      const placement = layout.onStep.get(stepId);
      if (!placement) return;
      const status = stageStatus(placement.stage);
      if (status === 'done' || status === 'skipped') return;
      const advanced = await advanceStage(ticked.value, placement.stage.id);
      if (advanced.kind !== 'ok') {
        addToast("Couldn't mark that stage done. Try again.", 'destructive');
      }
    } finally {
      writing = false;
    }
  }

  async function toggleIngredient(id: string): Promise<void> {
    const current = run;
    if (!current || writing) return;
    const next = !checkedIds.has(id);
    if (next) hapticTick();
    writing = true;
    const result = await setIngredientChecked(current, id, next);
    writing = false;
    if (result.kind !== 'ok') addToast("Couldn't save that. Try again.", 'destructive');
  }

  // Marking a STAGE-ONLY card done — it has no step to tick, so this is the batch
  // page's own Done, on the same producer, reached from here.
  async function markStageDone(stageId: string): Promise<void> {
    const current = run;
    if (!current || writing) return;
    writing = true;
    const result = await advanceStage(current, stageId);
    writing = false;
    if (result.kind !== 'ok') addToast("Couldn't mark that stage done. Try again.", 'destructive');
  }

  // ─── The clock ────────────────────────────────────────────────────────────────
  //
  // One ticker for the whole page, driving every wait-stage countdown. Nothing is
  // written and nothing is derived FROM it except words: the planned end is on the
  // document and this only says how far off it is.
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  /** How long until (or how long past) an instant, in the words a cook wants. */
  function countdown(iso: string): string {
    const endMs = Date.parse(iso);
    if (!Number.isFinite(endMs)) return '';
    const minutes = Math.round((endMs - nowMs) / 60_000);
    const magnitude = Math.abs(minutes);
    const span =
      magnitude >= 60
        ? `${Math.floor(magnitude / 60)} h ${magnitude % 60} min`
        : `${magnitude} min`;
    if (minutes <= -1) return `${span} over`;
    if (minutes < 1) return 'due now';
    return `${span} left`;
  }

  /** The latest reading logged against a stage — an observational stage's only news. */
  function latestReading(stageId: string) {
    const log = $observations ?? [];
    // The adapter orders ascending by `at` (when it was OBSERVED), so the last
    // matching entry is the most recent reading. Never re-sorted here.
    return log.filter((entry) => entry.stageId === stageId).at(-1) ?? null;
  }

  // ─── Staleness ────────────────────────────────────────────────────────────────
  //
  // An ORDERING against the run's start, not `hasRecipeChanged`'s inequality: a
  // batch snapshots no `updatedAt`, so there is no stamp to be unequal to. No
  // Restart — see the header comment.
  const recipeChanged = $derived(
    recipeChangedSince(run?.createdAt ?? null, recipe?.updatedAt ?? null),
  );

  // ─── The log, from here ───────────────────────────────────────────────────────
  let logOpen = $state(false);

  // ─── Keep awake ───────────────────────────────────────────────────────────────
  const wakeLockSupported = isWakeLockSupported();
  const wake = wakeLockSupported ? createWakeLock() : null;
  let keepAwake = $state(false);
  let togglingWakeLock = false;
  onDestroy(() => void wake?.disable());

  async function toggleWakeLock(): Promise<void> {
    if (togglingWakeLock) return;
    togglingWakeLock = true;
    try {
      if (keepAwake) {
        await wake?.disable();
        keepAwake = false;
        addToast('Screen can sleep again', 'success');
        return;
      }
      // Report what actually happened: `enable()` resolves false when the browser or
      // OS refuses, and the toggle must not claim a lock it never got.
      const acquired = (await wake?.enable()) ?? false;
      keepAwake = acquired;
      if (acquired) addToast('Screen will stay awake', 'success');
      else addToast("Your browser wouldn't let the screen stay awake.", 'destructive');
    } finally {
      togglingWakeLock = false;
    }
  }

  // Focus entry for a full-viewport route (ui-spec-v05 §2.4). The chrome that had
  // focus is unmounted as this route activates, so without this the next Tab would
  // restart at the top of the document. No restore on the way out: this page is
  // entered from the batch page, which unmounts as it opens.
  let pageEl = $state.raw<HTMLElement | null>(null);
  onMount(() => pageEl?.focus({ preventScroll: true }));

  function close(): void {
    goBack(`/batches/${batchId}`);
  }
</script>

<FeatureGuard feature="bread">
  <!-- `z-dialog` (50) and `fixed inset-0`, the rung ui-spec-v02 §4.1 gives a
     full-viewport route. `tabindex="-1"` makes the container a programmatic focus
     target and is not a tab stop; no `role="dialog"` — this is a route, not a layer
     (ui-spec-v05 §2.6). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={pageEl}
    tabindex="-1"
    class="z-dialog fixed inset-0 flex h-dvh flex-col bg-background focus:outline-none"
    data-testid="batch-cook-page"
  >
    {#if run === undefined}
      <div class="flex flex-1 items-center justify-center"><Spinner /></div>
    {:else if run === null}
      <div class="flex flex-1 flex-col items-center justify-center p-6">
        <EmptyState title="Batch not found" description="It may have been deleted." />
        <Button variant="outline" onclick={close} data-testid="batch-cook-back">Back</Button>
      </div>
    {:else}
      <header class="flex shrink-0 items-center gap-3 px-4 py-3 {showTimeline ? '' : 'border-b'}">
        <Button
          variant="ghost"
          size="icon"
          onclick={close}
          ariaLabel="Back to the batch"
          title="Back to the batch"
          data-testid="batch-cook-close"
        >
          {#snippet leading()}<Icon name="ArrowLeft" size={20} />{/snippet}
        </Button>
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-base font-semibold" data-testid="batch-cook-title">
            {run.recipeTitle}
          </span>
          <span class="text-xs text-muted-foreground" data-testid="batch-cook-subtitle">
            {#if stage === 'mise'}
              Weigh out · {mise.checked}/{mise.total} ready
            {:else}
              Step {stepProgress.checked}/{stepProgress.total} done
            {/if}
          </span>
        </div>
        <!-- THE LOG IS THE DOOR THAT STAYS OPEN. The same sheet the batch page has,
           defaulting to the stage in hand, so a reading mid-bake does not mean going
           back to the desk view. -->
        <Button
          variant="ghost"
          size="icon"
          onclick={() => (logOpen = true)}
          ariaLabel="Log a reading"
          title="Log a reading"
          data-testid="batch-cook-log"
        >
          {#snippet leading()}<Icon
              name="Pencil"
              size={20}
              class="text-muted-foreground"
            />{/snippet}
        </Button>
        {#if wakeLockSupported}
          <Button
            variant="ghost"
            size="icon"
            onclick={() => void toggleWakeLock()}
            ariaLabel="Keep screen awake"
            title={keepAwake ? 'Screen stays awake' : 'Keep screen awake'}
            aria-pressed={keepAwake}
            data-testid="batch-cook-wakelock"
            data-active={keepAwake}
          >
            {#snippet leading()}
              <span
                class="relative inline-flex transition-colors {keepAwake
                  ? 'text-warning'
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

      {#if showTimeline}
        <CookTimeline
          {steps}
          completedStepIds={completedIds}
          currentStepId={currentStep?.id ?? null}
          onJump={jumpToStep}
        />
      {/if}

      {#if recipeChanged}
        <!-- No Restart: the batch's grams are frozen by design and re-freezing them
           against a moved recipe would be a new run, not a restart. -->
        <CookRecipeChangedBanner
          message="This recipe was updated after this batch started. The batch's own amounts and times are unchanged."
        />
      {/if}

      {#if stage === 'mise'}
        <main class="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="batch-cook-mise">
          <div class="mx-auto flex max-w-2xl flex-col gap-2">
            <p class="text-xs text-muted-foreground" data-testid="batch-cook-frozen-note">
              These grams were worked out when the batch started. Editing the recipe or its formula
              afterwards won't change one.
            </p>
            {#each run.quantities as quantity (quantity.ingredientId)}
              {@const checked = checkedIds.has(quantity.ingredientId)}
              {@const live = ingredientById.get(quantity.ingredientId)}
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                  ? 'border-primary/40 bg-primary/5'
                  : 'bg-card hover:bg-muted/50'}"
                onclick={() => void toggleIngredient(quantity.ingredientId)}
                aria-pressed={checked}
                data-testid="batch-cook-mise-row"
                data-ingredient-id={quantity.ingredientId}
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input'}"
                  data-testid="batch-cook-mise-check"
                >
                  {#if checked}<Icon name="Check" size={18} />{/if}
                </span>
                <CanonIcon
                  thumbnail={live ? $ingredientIcons.thumbnailFor(live) : null}
                  name={live ? ingredientLabel(live) : quantity.label}
                  version={live ? $ingredientIcons.iconVersionFor(live) : undefined}
                  dimmed={checked}
                  size={40}
                />
                <span class="min-w-0 flex-1 text-base {checked ? 'text-muted-foreground' : ''}">
                  {#if quantity.label === ''}
                    <!-- The ingredient had already left the recipe when this run
                       started: a blank reads as "we no longer know what this was",
                       which is true. An id would read as gibberish. -->
                    <span class="italic text-muted-foreground">no longer in the recipe</span>
                  {:else}
                    {quantity.label}
                  {/if}
                </span>
                <!-- GRAMS LEAD, percent muted underneath: the figure you set the
                   scale to is the one the eye should land on. -->
                <span class="shrink-0 text-right">
                  <span
                    class="block text-lg font-semibold tabular-nums"
                    data-testid="batch-cook-mise-grams"
                  >
                    {formatGrams(quantity.grams)}
                  </span>
                  <span class="block text-xs tabular-nums text-muted-foreground">
                    {quantity.percent}%
                  </span>
                </span>
              </button>
            {/each}

            {#each extraIngredients as ingredient (ingredient.id)}
              {@const checked = checkedIds.has(ingredient.id)}
              <!-- AS WRITTEN, with no batch quantity — the formula has no percentage
                 for it and inventing one would be arithmetic the freeze never did. -->
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors active:bg-muted {checked
                  ? 'border-primary/40 bg-primary/5'
                  : 'bg-card hover:bg-muted/50'}"
                onclick={() => void toggleIngredient(ingredient.id)}
                aria-pressed={checked}
                data-testid="batch-cook-mise-extra"
                data-ingredient-id={ingredient.id}
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border {checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input'}"
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
                <span class="min-w-0 flex-1 text-base {checked ? 'text-muted-foreground' : ''}">
                  <IngredientText {ingredient} />
                </span>
              </button>
            {/each}
          </div>
        </main>
      {:else}
        <!-- The deck. Not a scroll container: `$lib/deck` owns the drag, the fling
           and the spring. The two a11y silences are cook mode's, for cook mode's
           reason — this element replaces a native scroller, which is focusable and
           arrow-key operable for free. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <main
          bind:this={deck.viewportEl}
          class="relative min-h-0 flex-1 touch-pinch-zoom overflow-hidden salt-focus-ring-inset"
          data-testid="batch-cook-steps"
          tabindex="0"
          aria-label="The method, stage by stage"
          onpointerdown={deck.handlePointerDown}
          onpointermove={deck.handlePointerMove}
          onpointerup={deck.handlePointerUp}
          onpointercancel={deck.handlePointerUp}
          onwheel={deck.handleWheel}
          onkeydown={deck.handleKeyDown}
        >
          {#if steps.length === 0}
            <div class="flex h-full flex-col items-center justify-center p-6">
              <EmptyState
                title={recipe === null ? 'Loading the method…' : 'This recipe has no steps'}
                description="The stages are still on the batch page."
              />
            </div>
          {/if}
          <div
            bind:this={deck.contentEl}
            class="will-change-transform"
            style="transform: translate3d(0, {-deck.offset}px, 0); padding-bottom: {PEEK_MAX_PX}px"
            data-testid="batch-cook-deck"
          >
            {#snippet stageCard(placement: StagePlacement)}
              {@const stageDoc = placement.stage}
              {@const status = stageStatus(stageDoc)}
              <!-- A STAGE WITH NO STEP, in sequence and never hidden. It carries its
                 own Done because the footer acts on steps and this is not one. -->
              <section
                class="mx-4 my-3 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-4"
                data-testid="batch-cook-stage-card"
                data-stage-id={stageDoc.id}
                data-status={status}
              >
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  <span class="font-semibold">Stage {placement.number} of {layout.total}</span>
                  <span class="font-medium">{stageDoc.label}</span>
                  <span class="text-xs uppercase tracking-wide text-muted-foreground">
                    {stageDoc.kind === 'wait' ? 'wait' : 'active'}
                  </span>
                </div>
                {@render stageFacts(stageDoc)}
                {#if status === 'notStarted' || status === 'inProgress'}
                  <div>
                    <Button
                      size="sm"
                      onclick={() => void markStageDone(stageDoc.id)}
                      disabled={writing}
                      data-testid="batch-cook-stage-done"
                    >
                      {#snippet leading()}<Icon name="Check" size={16} />{/snippet}
                      Mark done
                    </Button>
                  </div>
                {/if}
              </section>
            {/snippet}

            {#snippet stageFacts(stageDoc: BatchStageDoc)}
              {@const status = stageStatus(stageDoc)}
              {@const stated = formatStatedDuration(stageDoc.duration)}
              <div class="flex flex-col gap-1 text-sm">
                {#if isObservational(stageDoc)}
                  <span class="text-muted-foreground" data-testid="batch-cook-stage-observational">
                    No fixed time — mark it done when it's ready.
                  </span>
                  {#if latestReading(stageDoc.id)}
                    {@const reading = latestReading(stageDoc.id)!}
                    <div
                      class="rounded border border-border p-2"
                      data-testid="batch-cook-stage-reading"
                    >
                      <BatchReadingRow run={run!} entry={reading} when={formatWhen(reading.at)} />
                    </div>
                  {/if}
                {:else}
                  <span
                    class="tabular-nums text-muted-foreground"
                    data-testid="batch-cook-stage-window"
                  >
                    {formatTimeOfDay(stageDoc.plannedStartAt)}–{formatTimeOfDay(
                      stageDoc.plannedEndAt,
                    )}
                  </span>
                  <!-- THE SCHEDULE'S CLOCK, and the only one on a wait stage. Nothing
                     is armed for it: the run's own push reminder already exists for
                     this moment. -->
                  {#if stageDoc.kind === 'wait' && (status === 'notStarted' || status === 'inProgress')}
                    <span class="font-medium tabular-nums" data-testid="batch-cook-stage-countdown">
                      {countdown(stageDoc.plannedEndAt)}
                    </span>
                  {/if}
                {/if}
                <div
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                >
                  {#if stated !== null}
                    <span data-testid="batch-cook-stage-stated">Recipe says {stated}</span>
                  {/if}
                  {#if stageDoc.environment !== null}
                    <span
                      class="flex items-center gap-1"
                      data-testid="batch-cook-stage-environment"
                    >
                      <Icon name="Thermometer" size={12} />
                      {stageTemperatureText(stageDoc.environment.temperature)}
                    </span>
                  {/if}
                  {#if stageDoc.place !== null}
                    <span class="flex items-center gap-1" data-testid="batch-cook-stage-place">
                      <Icon name="MapPin" size={12} />
                      {stageDoc.place.label}
                    </span>
                  {/if}
                  {#if stageDoc.until !== null}
                    <span data-testid="batch-cook-stage-until">{stageDoc.until}</span>
                  {/if}
                  {#if status === 'done'}
                    <span data-testid="batch-cook-stage-status">stage done</span>
                  {:else if status === 'skipped'}
                    <span data-testid="batch-cook-stage-status">stage skipped</span>
                  {/if}
                </div>
              </div>
            {/snippet}

            {#each layout.leading as placement (placement.stage.id)}
              {@render stageCard(placement)}
            {/each}

            {#each steps as step, i (step.id)}
              {@const done = completedIds.has(step.id)}
              {@const collapsed = done && peekedStepId !== step.id}
              {@const placement = layout.onStep.get(step.id) ?? null}
              {@const chips = firstUse.get(step.id) ?? []}
              {@const stepKit = kit.get(step.id) ?? []}
              <section
                use:stepAnchor={step.id}
                data-step-id={step.id}
                data-complete={done}
                data-testid="batch-cook-step"
                class="flex flex-col px-4 {collapsed ? 'py-2' : 'border-t py-6'}"
                style="min-height: {collapsed ? 0 : sectionMinHeight(deck.viewportHeight)}px"
              >
                {#if collapsed}
                  <CookStepCollapsed
                    index={i}
                    text={step.text}
                    accentClass="border-primary/40 bg-primary/5"
                    labelClass="text-muted-foreground"
                    onPeek={() => peekStep(step.id)}
                  />
                {:else}
                  <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
                    {#if placement !== null}
                      <!-- THE BAND. The stage this step is, wearing the run's own
                         clock, temperature, place and criterion. -->
                      <div
                        class="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
                        data-testid="batch-cook-stage-band"
                        data-stage-id={placement.stage.id}
                        data-status={stageStatus(placement.stage)}
                      >
                        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                          <span class="font-semibold">
                            Stage {placement.number} of {layout.total}
                          </span>
                          <span class="font-medium">{placement.stage.label}</span>
                          <span class="text-xs uppercase tracking-wide text-muted-foreground">
                            {placement.stage.kind === 'wait' ? 'wait' : 'active'}
                          </span>
                        </div>
                        {@render stageFacts(placement.stage)}
                      </div>
                    {/if}

                    {#if done}
                      <div>
                        <span
                          class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                          data-testid="batch-cook-step-done-badge"
                        >
                          <Icon name="Check" size={12} />
                          Done
                        </span>
                      </div>
                    {/if}
                    <p class="text-xl leading-relaxed sm:text-2xl">{step.text}</p>

                    {#if step.note}
                      <div
                        class="flex items-start gap-3 rounded border border-warning/40 bg-warning/10 px-4 py-3 text-warning-text"
                        data-testid="batch-cook-step-note"
                      >
                        <Icon name="TriangleAlert" size={20} class="mt-1 shrink-0 text-warning" />
                        <span class="whitespace-pre-wrap text-lg">{step.note}</span>
                      </div>
                    {/if}

                    {#if chips.length > 0}
                      <!-- First use, in THE BATCH'S GRAMS where the run froze one.
                         An ingredient the formula has no percentage for keeps the
                         recipe's own words. -->
                      <ul
                        class="flex flex-wrap items-start gap-2"
                        data-testid="batch-cook-step-firstuse"
                      >
                        {#each chips as ing (ing.id)}
                          {@const quantity = quantityById.get(ing.id)}
                          <li class="shrink-0 max-w-full">
                            <span
                              class="flex w-full items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-4 text-left text-base"
                              data-testid="batch-cook-step-chip"
                            >
                              <CanonIcon
                                thumbnail={$ingredientIcons.thumbnailFor(ing)}
                                name={ingredientLabel(ing)}
                                version={$ingredientIcons.iconVersionFor(ing)}
                                size={40}
                                class="rounded-full"
                              />
                              <span class="min-w-0 break-words">
                                {#if quantity !== undefined}
                                  <span class="font-medium tabular-nums">
                                    {formatGrams(quantity.grams)}
                                  </span>
                                  {ingredientLabel(ing)}
                                {:else}
                                  <IngredientText ingredient={ing} />
                                {/if}
                              </span>
                            </span>
                          </li>
                        {/each}
                      </ul>
                    {/if}

                    {#if stepKit.length > 0}
                      <CookStepKit entries={stepKit} />
                    {/if}

                    {#if step.timer}
                      <!-- THE RECIPE'S OPINION, never armed. Where a wait stage times
                         this step the run's own clock is above; where it does not,
                         Phase 2 is what gives this a button (issue #1327, decision
                         9) — and a timer here today would be a second clock for the
                         same wait. -->
                      <p class="text-sm text-muted-foreground" data-testid="batch-cook-step-timer">
                        The recipe says {step.timer.durationMinutes} min for this step.
                      </p>
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
              {#each layout.after.get(step.id) ?? [] as placement (placement.stage.id)}
                {@render stageCard(placement)}
              {/each}
            {/each}
          </div>
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background to-transparent"
            style="height: {fadeHeight}px"
            aria-hidden="true"
          ></div>
        </main>
      {/if}

      <!-- Footer. One primary, always in the same place. NO FINISH: when every step
         is ticked the only thing left is to leave, and the run ends on its stages. -->
      <footer class="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3">
        {#if stage === 'mise'}
          <span class="text-sm text-muted-foreground">Weigh everything out first.</span>
          <Button size="lg" onclick={goToSteps} data-testid="batch-cook-stage-toggle">
            {stepProgress.checked > 0 ? 'Continue cooking' : 'Start cooking'}
            {#snippet trailing()}<Icon name="ArrowRight" size={16} />{/snippet}
          </Button>
        {:else}
          <Button variant="ghost" onclick={goToMise} data-testid="batch-cook-stage-back">
            {#snippet leading()}<Icon name="ArrowLeft" size={16} />{/snippet}
            Weigh out
          </Button>
          {#if currentStep && !currentStepDone}
            <Button
              size="lg"
              onclick={handleStepDone}
              disabled={writing}
              data-testid="batch-cook-step-done"
            >
              {#snippet leading()}<Icon name="Check" size={18} />{/snippet}
              {nextIncompleteStep ? 'Done · next' : 'Done'}
            </Button>
          {:else if nextIncompleteStep}
            <Button size="lg" onclick={handleResume} data-testid="batch-cook-step-resume">
              Resume · step {nextIncompleteNumber}
              {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
            </Button>
          {:else}
            <!-- NOT a Finish. It navigates and nothing else: the stages are what end
               a run, on the batch page, and for a cure the hands-on part is one day
               of a weeks-long batch. -->
            <Button size="lg" variant="outline" onclick={close} data-testid="batch-cook-to-batch">
              Back to the batch
              {#snippet trailing()}<Icon name="ArrowRight" size={18} />{/snippet}
            </Button>
          {/if}
        {/if}
      </footer>
    {/if}

    <!-- Mounted for the life of the page, never wrapped in `{#if}` — the sheet owns
       its own open/close transition and portals to <body>, so it lands above this
       full-viewport container rather than inside it. -->
    <BatchObservationSheet bind:open={logOpen} {batchId} run={run ?? null} />
  </div>
</FeatureGuard>
