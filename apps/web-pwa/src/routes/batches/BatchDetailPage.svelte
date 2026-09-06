<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DetailPage,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Icon,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
    Spinner,
    TextField,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import type { DomainError } from '@salt/shared-types';
  import { goBack } from '../../lib/nav.js';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import {
    abandonBatch,
    advanceStage,
    batch,
    initBatchSync,
    skipStage,
    startStage,
  } from '../../lib/batchService.js';
  import { stageStatus } from '@salt/domain';
  import { observations, initBatchObservationsSync } from '../../lib/batchObservationService.js';
  import { addToast } from '../../lib/toastStore.js';
  import BatchObservationSheet from './BatchObservationSheet.svelte';
  import {
    formatDate,
    formatGrams,
    formatStatedDuration,
    formatWhen,
    isObservational,
    nextAction,
    stageLabelById,
    yieldSummary,
  } from './batchDisplay.js';

  // One run (issue #812, phases 1, 3 and 4 of epic #778) — `/batches/:id`.
  //
  // An ordinary AppShell route: desk work at the bench, not a hands-full mode, so no
  // entry in ./fullViewport.ts. No `fill` either — this page is simply tall and
  // `<main>` scrolls it (ui-spec-v07 §1.6).
  //
  // ─── EVERY NUMBER HERE IS THE BATCH'S OWN ─────────────────────────────────────
  //
  // This screen reads `batches/{id}` and NOTHING ELSE. It does not load the recipe,
  // it does not load the formula, and it never re-solves anything: the quantities,
  // the totals, the stage times and even the recipe's title were frozen when the run
  // started. Re-map the formula tomorrow, rename the dish, delete it outright — this
  // page still says what this batch was, which is the entire reason the document
  // repeats what the recipe already holds (see `schemas/batch.ts`).
  //
  // It is also why the ingredient list here is the ONLY place a scaled quantity is
  // ever shown. The recipe never shows scaled numbers
  // (docs/formulas-schedules-batches.md) — someone who opens the loaf and taps Cook
  // gets the recipe's own 500 g and never learns a formula exists.
  //
  // ─── THE CONTROLS (issue #812, phase 3) ───────────────────────────────────────
  //
  // Phase 1 shipped this screen able only to READ, so a schedule could be checked
  // against a real bake before anything could act on one. Phase 3 adds the three
  // things that act, and nothing else:
  //
  //   • MARK A STAGE DONE, at the moment it actually is. That single write is what
  //     drives the whole reminder engine: `withStageAdvanced` re-times every later
  //     stage from the instant given, `onBatchWritten` re-queues the reminders whose
  //     `${stageId}@${plannedStartAt}` key changed, and finishing the bulk twenty
  //     minutes early therefore moves the shape, the bake AND every push by twenty
  //     minutes. Nothing here debounces or batches: the trigger's diff is what makes
  //     an unchanged reminder free, so a second tap costs a document write and no
  //     queue churn.
  //   • ABANDON the run — which stops its reminders, because dispatch re-reads the
  //     batch and no-ops on one that is not running.
  //   • HAND OFF TO COOK MODE, which is a link and nothing more.
  //
  // ─── FOUR CONDITIONS, AND MORE THAN ONE STAGE IN HAND (issue #1275) ───────────
  //
  // Phase 3 gated every control on `currentStageId` and nothing else: one stage was
  // advanceable, the rest showed nothing. That is no longer the shape, because a
  // stage now has four conditions rather than two (`stageStatus` in the domain owns
  // the derivation; nothing here re-derives it):
  //
  //   • MARK DONE is offered on the stage in hand AND on any stage already in
  //     progress. The oven you started twenty minutes ago is not the run's next
  //     action, and it is still a thing you finish.
  //   • START is offered on any stage not yet begun — including one further down the
  //     list, which is the whole of overlap-by-marking. It records; it re-times
  //     nothing, and `withStageStarted` is where that is guaranteed.
  //   • SKIP is offered on EVERY stage that has not happened yet, `optional` or not.
  //     No confirmation, no gate on the flag — Daniel's call, in his words: "I'm the
  //     chef, I don't want the app trying to police me." The note field sits BESIDE
  //     the button and never in front of it, so a skip is still one tap.
  //
  // A stage that is done or skipped offers nothing: both are over. `optional` shows
  // as a chip and does nothing else — see `ProcessStageContentSchema.optional`.
  //
  // ─── THE LOG (issue #812, phase 4) ────────────────────────────────────────────
  //
  // A run's readings live in their OWN SUBCOLLECTION, one document per entry, and
  // this page reads them through their own subscription. Nothing about them is held
  // on the batch document: two people weighing the same coppa on the same day would,
  // under last-write-wins on one document, mean the second phone silently erasing
  // the first partner's reading — on exactly the record the feature exists to keep.
  // Separate documents make that collision impossible, so the rule for this screen
  // is simply never to gather them back up: the log is rendered from the list the
  // adapter delivers, and written to one entry at a time.
  //
  // THE ORDER IS THE ADAPTER'S. `orderBy('at', 'asc')` sorts by when a reading was
  // TAKEN, so a back-filled Tuesday weight sits before Thursday's however late it
  // was typed. This page reverses that list to read newest-first and does not re-sort
  // it — sorting by arrival would quietly make a cure's curve wrong. Since #1276 the
  // sheet can actually say "yesterday evening", so that ordering is no longer only
  // theoretical.
  //
  // An entry's STAGE is a join and not a stored word: `stageLabelById` resolves
  // `stageId` against this run's own frozen stages, which is why nothing on the
  // entry can go stale and why an id that no longer resolves simply prints nothing.
  //
  // ─── "FINISHING" A BATCH, WHICH IS NOT A STATE ────────────────────────────────
  //
  // There is still no `finished` state and phase 4 did not add one: "every stage is
  // done" is already answerable from the stages, and `nextAction` is where it is
  // answered — the same function the in-flight list and the controls above read. So
  // when a run reaches `'done'` this page OFFERS the log screen: an invitation with
  // a one-tap Skip, never a gate, and never the only door. A cure is weighed on day
  // 12, so "Log a reading" sits on the log itself and is available the whole way
  // through, and on an abandoned run too — what it got to is the reason abandoning
  // is a state rather than a delete.
  //
  // The invitation is dismissed IN MEMORY and nowhere else (CLAUDE.md Rule 3 — no
  // browser storage). It does not need to persist: once the log has an entry the
  // question has been answered and the prompt stops asking by itself, which covers
  // every case except reopening a done-and-unlogged run, where being asked again is
  // the correct behaviour anyway.
  //
  // ─── STILL NOT HERE, AND NOT BY OVERSIGHT ─────────────────────────────────────
  //
  // No re-scaling, no re-scheduling, and no route back to `proposeSchedule` from a
  // running batch. Freezing is what stops a batch growing versions: what a batch
  // records is what happened, so the only thing that ever moves on this screen is
  // the clock, and only as a consequence of a stage being marked done. NOR is there
  // a way to delete an entry: the log is append-only, which is the whole noun (a
  // mis-typed reading is corrected by re-writing the same id, and no screen offers
  // that yet).
  //
  // The clock is NOT read here. `advanceStage` reads it in the service, and the log
  // sheet reads it to seed its own "when" box (issue #1276 — `logObservation` no
  // longer reads one), which is why every re-timing this screen triggers is a pure
  // function with a fixed answer.

  let { params }: { params?: { id?: string } } = $props();

  const batchId = $derived(params?.id ?? '');

  // Subscribe for as long as the page is open. The service resets its store on every
  // init, so moving between runs can never show the previous one's numbers.
  $effect(() => {
    if (!batchId) return;
    return initBatchSync(batchId);
  });

  // The log rides on its own subscription, disposed with the page. Two listeners
  // rather than one because they are two collections: the run is a document that is
  // rewritten whole, its readings are documents that are each written once.
  $effect(() => {
    if (!batchId) return;
    return initBatchObservationsSync(batchId);
  });

  // Three states, and they are all different sentences: `undefined` is still
  // loading, `null` is a link to a run that is not there, a document is the run.
  const run = $derived($batch);

  // What the schedule was anchored to. The first stage's planned start IS the start
  // that was chosen — phase 1 anchors `{ kind: 'startAt' }` — so there is nothing to
  // store separately and nothing to re-derive.
  const startsAt = $derived(run ? (run.stages[0]?.plannedStartAt ?? null) : null);
  const endsAt = $derived(run ? (run.stages[run.stages.length - 1]?.plannedEndAt ?? null) : null);

  // ─── What the run wants next ──────────────────────────────────────────────────
  //
  // Read through `nextAction` rather than re-derived, so "which stage is now" has
  // one answer across the list card and this page (see batchDisplay.ts). An id is
  // all the markup needs — comparing ids inside the `{#each}` is what keeps the
  // controls attached to the stage they act on rather than to a copy of it.
  const next = $derived(run ? nextAction(run) : null);
  const currentStageId = $derived(next?.kind === 'stage' ? next.stage.id : null);

  // Abandon is gated on the run's STATE and not on `nextAction`, because the two
  // answer different questions. `withBatchAbandoned` is idempotent, so an already
  // abandoned run has nothing to offer; a run whose every stage happens to be done
  // is still `running` and may still be stopped, since there is no `finished` state
  // for it to have reached instead (BatchStateSchema — phase 4's, if ever).
  const canAbandon = $derived(run !== null && run !== undefined && run.state === 'running');

  // ─── Failure copy ─────────────────────────────────────────────────────────────
  //
  // Only a ValidationError carries a sentence, and it is always one the user can act
  // on. Everything else has already been categorised and (where the policy says so)
  // reported by the service on its way through — docs/salt-architecture.md §7.6 —
  // so what is left to do here is say something true and let them try again.
  function failureMessage(error: DomainError, fallback: string): string {
    return error.kind === 'ValidationError' && error.message ? error.message : fallback;
  }

  // ─── The log ──────────────────────────────────────────────────────────────────
  //
  // Newest first, by REVERSING the ascending list the adapter guarantees — not by
  // re-sorting it. `undefined` is still loading; an empty array is the ordinary
  // loaded state of most runs and gets a sentence rather than a spinner.
  const log = $derived($observations);
  const logEntries = $derived(log === undefined ? [] : [...log].reverse());

  let logOpen = $state(false);
  // Dismissal of the end-of-run invitation, for this visit only. In memory by
  // requirement (Rule 3) and by preference: once anything is logged the prompt has
  // its answer and stops asking regardless.
  let promptDismissed = $state(false);
  const wantsPrompt = $derived(log !== undefined && log.length === 0 && !promptDismissed);
  const showPrompt = $derived(next?.kind === 'done' && wantsPrompt);

  // ─── Mark a stage done ────────────────────────────────────────────────────────

  // Which stage is in flight, rather than a bare boolean: the button that was tapped
  // is the one that shows the spinner, and a second tap on it does nothing while the
  // write is out.
  let advancingStageId = $state<string | null>(null);

  async function handleAdvance(stageId: string): Promise<void> {
    const current = run;
    if (!current || advancingStageId !== null) return;
    advancingStageId = stageId;
    const result = await advanceStage(current, stageId);
    advancingStageId = null;
    if (result.kind !== 'ok') {
      // No toast on success. The stage list re-times itself in front of you, which
      // is a far better acknowledgement than a sentence that covers it up.
      addToast(
        failureMessage(result.error, "Couldn't mark that stage done. Try again."),
        'destructive',
      );
      return;
    }
    // Marking the LAST stage done is the moment "how did it go?" is worth asking, so
    // the offer arrives then rather than waiting to be found. The decision is read
    // off the document the write returned — `nextAction` again, never a second guess
    // at what "finished" means — and it is skipped when the log already has an entry
    // or the prompt has been dismissed, so it can only ever appear once.
    if (nextAction(result.value).kind === 'done' && wantsPrompt) logOpen = true;
  }

  // ─── Start a stage, and skip a stage ──────────────────────────────────────────
  //
  // Both share `advancingStageId` as the in-flight lock rather than growing one of
  // their own: all three write the SAME whole document (LWW, `setDoc`), so two of
  // them in the air at once is one silently overwriting the other. One lock across
  // the three is the honest model of the write path, not a convenience.

  async function handleStart(stageId: string): Promise<void> {
    const current = run;
    if (!current || advancingStageId !== null) return;
    advancingStageId = stageId;
    const result = await startStage(current, stageId);
    advancingStageId = null;
    if (result.kind !== 'ok') {
      addToast(
        failureMessage(result.error, "Couldn't mark that stage started. Try again."),
        'destructive',
      );
    }
  }

  // The note is held per stage while it is being typed, so opening the note on one
  // stage cannot carry text into another. Cleared on a successful skip; the stage is
  // over and the note now lives on the document.
  let skipNotes = $state<Record<string, string>>({});
  // Which stage's note field is showing. The field is disclosed rather than always
  // present because a skip is one tap and a text box beside every stage would say
  // otherwise.
  let noteOpenStageId = $state<string | null>(null);

  async function handleSkip(stageId: string): Promise<void> {
    const current = run;
    if (!current || advancingStageId !== null) return;
    advancingStageId = stageId;
    const result = await skipStage(current, stageId, skipNotes[stageId] ?? '');
    advancingStageId = null;
    if (result.kind !== 'ok') {
      addToast(failureMessage(result.error, "Couldn't skip that stage. Try again."), 'destructive');
      return;
    }
    delete skipNotes[stageId];
    if (noteOpenStageId === stageId) noteOpenStageId = null;
    // Skipping the LAST outstanding stage finishes the run exactly as marking it
    // done would — the same `nextAction` reading, so a run that ends on a skip gets
    // the same "how did it go?" invitation as one that ends on a Mark done.
    if (nextAction(result.value).kind === 'done' && wantsPrompt) logOpen = true;
  }

  // ─── Abandon ──────────────────────────────────────────────────────────────────
  //
  // Behind the ⋮ AND behind a confirm, which is two gates for one action — because
  // abandoning is one-way (`withBatchAbandoned` has no inverse, and un-abandoning
  // would present hours-stale planned times as if they still meant something) and
  // because the thumb that reaches this page is reaching for "Mark done". Delete
  // ranks the same way on the recipe view, for the same reason.
  let overflowOpen = $state(false);
  let abandonOpen = $state(false);
  let abandoning = $state(false);

  async function handleAbandon(): Promise<void> {
    const current = run;
    if (!current || abandoning) return;
    abandoning = true;
    const result = await abandonBatch(current);
    abandoning = false;
    if (result.kind !== 'ok') {
      addToast(failureMessage(result.error, "Couldn't stop this batch. Try again."), 'destructive');
      return;
    }
    abandonOpen = false;
    // Stays on the page rather than navigating away: the log of how far it got is
    // the entire reason abandoning is a state and not a delete.
    addToast('Batch abandoned.', 'default');
  }
</script>

<!-- Bread is still being built (issue #831): everyone outside the test group is
     redirected home and sees nothing at all — no denial copy, because a message
     would announce a feature they are not meant to know exists yet. Cosmetic only;
     the boundary is not here (see lib/featureGate.ts). -->
<FeatureGuard feature="bread">
  {#if run === undefined}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if run === null}
    <div class="p-6">
      <EmptyState title="Batch not found" description="It may have been deleted." />
    </div>
  {:else}
    <DetailPage
      title={run.recipeTitle}
      subtitle={yieldSummary(run.totals)}
      onBack={() => goBack('/batches')}
      backLabel="Back"
      class="p-4 sm:p-6"
    >
      <!-- ─── The ⋮ ──────────────────────────────────────────────────────────────
         One item, and deliberately so. A destructive, one-way action does not get
         a top-level slot beside the thing you came here to tap, and the header is
         where this page's precedent puts it (RecipeViewPage's Delete). The gate is
         on the whole menu rather than on the item, so the trigger can never open
         onto an empty popover — the rule the recipe view's menu keeps too. -->
      {#snippet actions()}
        {#if canAbandon}
          <Popover bind:open={overflowOpen}>
            <PopoverTrigger>
              {#snippet children()}
                <button
                  type="button"
                  class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="More actions"
                  data-testid="batch-actions-overflow"
                >
                  <Icon name="EllipsisVertical" size={20} />
                </button>
              {/snippet}
            </PopoverTrigger>
            <PopoverContent align="end" class="min-w-44 p-1">
              <PopoverMenuItem
                variant="destructive"
                icon="CircleSlash"
                onclick={() => {
                  overflowOpen = false;
                  abandonOpen = true;
                }}
                data-testid="batch-abandon-menu-item"
              >
                Abandon
              </PopoverMenuItem>
            </PopoverContent>
          </Popover>
        {/if}
      {/snippet}

      <div class="flex flex-col gap-4" data-testid="batch-detail">
        <p class="text-sm text-muted-foreground" data-testid="batch-detail-started">
          Started {formatDate(run.createdAt)}{#if run.state === 'abandoned'}
            · abandoned{/if}
        </p>

        <!-- ─── The invitation ────────────────────────────────────────────────────
           Shown when every stage is done and nothing has been written yet — an
           INLINE card, not a modal, so it can sit there being ignored. Skip is
           one tap and dismisses it for this visit; logging anything at all
           dismisses it for good, because the question has then been answered. -->
        {#if showPrompt}
          <Card>
            <CardContent class="pt-6">
              <div class="flex flex-col gap-3" data-testid="batch-log-prompt">
                <div>
                  <p class="font-medium">That's every stage done. How did it go?</p>
                  <p class="text-sm text-muted-foreground">
                    A weight, a note, a photo — whatever you want to remember next time. Entirely
                    optional.
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onclick={() => (logOpen = true)}
                    data-testid="batch-log-prompt-open"
                  >
                    {#snippet leading()}
                      <Icon name="StickyNote" size={16} />
                    {/snippet}
                    Log how it went
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => (promptDismissed = true)}
                    data-testid="batch-log-prompt-skip"
                  >
                    Skip
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        {/if}

        <!-- ─── The scaled ingredient list ────────────────────────────────────────
           The frozen `label` is the recipe's own `rawText`, so it carries the
           recipe's as-written amount ("500 g strong white flour"). That is left
           alone rather than tidied: it is the line this run came from, and the
           figure you actually weigh is the one in the right-hand column, which is
           where the eye goes. -->
        <Card>
          <CardHeader>
            <CardTitle>Weigh out</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-2">
            <ul class="flex flex-col gap-2" data-testid="batch-quantities">
              {#each run.quantities as quantity (quantity.ingredientId)}
                <li
                  class="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
                  data-testid="batch-quantity"
                  data-ingredient-id={quantity.ingredientId}
                >
                  <span class="min-w-0 flex-1 text-sm">
                    {#if quantity.label === ''}
                      <!-- An empty label means the ingredient had already left the
                         recipe when this run started. A blank reads as "we no longer
                         know what this was", which is true; an id reads as gibberish
                         and a guess reads as a fact. -->
                      <span class="italic text-muted-foreground">no longer in the recipe</span>
                    {:else}
                      {quantity.label}
                    {/if}
                  </span>
                  <span class="shrink-0 text-right">
                    <span class="block font-medium tabular-nums" data-testid="batch-quantity-grams">
                      {formatGrams(quantity.grams)}
                    </span>
                    <span class="block text-xs tabular-nums text-muted-foreground">
                      {quantity.percent}%
                    </span>
                  </span>
                </li>
              {/each}
            </ul>

            <dl class="flex flex-col gap-1 pt-2 text-sm" data-testid="batch-totals">
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">In the bowl</dt>
                <dd class="tabular-nums" data-testid="batch-total-grams">
                  {formatGrams(run.totals.totalGrams)}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-muted-foreground">Off the bench</dt>
                <dd class="tabular-nums" data-testid="batch-usable-grams">
                  {formatGrams(run.totals.usableGrams)}
                </dd>
              </div>
              {#if run.totals.units !== null}
                <div class="flex justify-between gap-3">
                  <dt class="text-muted-foreground">Baked, each</dt>
                  <dd class="tabular-nums" data-testid="batch-baked-each">
                    about {formatGrams(run.totals.units.bakedUnitGrams)}
                  </dd>
                </div>
              {/if}
            </dl>

            <p class="text-xs text-muted-foreground" data-testid="batch-frozen-note">
              These were worked out when the batch started. Editing the recipe or its formula
              afterwards won't change a number here.
            </p>
          </CardContent>
        </Card>

        <!-- ─── The schedule ─────────────────────────────────────────────────────── -->
        <Card>
          <CardHeader>
            <CardTitle>The plan</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            {#if startsAt !== null && endsAt !== null}
              <p class="text-sm text-muted-foreground" data-testid="batch-schedule-span">
                From {formatWhen(startsAt)} to {formatWhen(endsAt)}.
              </p>
            {/if}

            <ol class="flex flex-col gap-2" data-testid="batch-stages">
              {#each run.stages as stage (stage.id)}
                {@const stated = formatStatedDuration(stage.duration)}
                {@const isCurrent = stage.id === currentStageId}
                {@const status = stageStatus(stage)}
                <li
                  class="flex flex-col gap-1 rounded border border-border p-3"
                  class:opacity-60={status === 'done' || status === 'skipped'}
                  class:border-primary={isCurrent}
                  data-testid="batch-stage"
                  data-stage-id={stage.id}
                  data-current={isCurrent ? 'true' : null}
                  data-status={status}
                  data-planned-start={stage.plannedStartAt}
                  data-planned-end={stage.plannedEndAt}
                >
                  <div class="flex items-baseline justify-between gap-3">
                    <span
                      class="min-w-0 flex-1 font-medium"
                      class:line-through={status === 'skipped'}
                      data-testid="batch-stage-label"
                    >
                      {stage.label}
                    </span>
                    <!-- The recipe's own opinion, and NOTHING follows from it: the
                       Skip control below is offered on this stage whether the chip
                       is here or not. It exists so a run read back a year later
                       distinguishes "the recipe said I could" from "I decided to". -->
                    {#if stage.optional}
                      <span
                        class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        data-testid="batch-stage-optional"
                      >
                        optional
                      </span>
                    {/if}
                    <span class="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                      {stage.kind === 'wait' ? 'wait' : 'active'}
                    </span>
                  </div>

                  {#if stage.skipped !== null}
                    {@const skip = stage.skipped}
                    <!-- A SKIPPED STAGE SHOWS WHAT HAPPENED, NOT WHAT WAS PLANNED.
                       Its `plannedStartAt`/`plannedEndAt` are still on the document
                       — deliberately, since blanking them would destroy what the
                       plan said — and they are now meaningless, so they are not
                       rendered. The time it was skipped at and the reason, if one
                       was given, are what is worth reading back. -->
                    <div class="flex flex-col gap-0.5 text-sm">
                      <span class="text-muted-foreground" data-testid="batch-stage-skipped">
                        Skipped {formatWhen(skip.at)}
                      </span>
                      {#if skip.note !== ''}
                        <span data-testid="batch-stage-skipped-note">{skip.note}</span>
                      {/if}
                    </div>
                  {:else}
                    <!-- Hoisted rather than tested inline, because `stageStatus`
                       already guarantees an in-progress stage has an `actualStartAt`
                       and a second inline null test would be a branch nothing can
                       take. -->
                    {@const startedAt = status === 'inProgress' ? stage.actualStartAt : null}
                    <div class="flex flex-col gap-0.5 text-sm">
                      {#if startedAt !== null}
                        <span class="text-primary" data-testid="batch-stage-in-progress">
                          In progress since {formatWhen(startedAt)}
                        </span>
                      {/if}
                      <span class="tabular-nums" data-testid="batch-stage-start">
                        Starts {formatWhen(stage.plannedStartAt)}
                      </span>
                      {#if isObservational(stage)}
                        <!-- A stage with no duration is scheduled at ZERO elapsed time —
                         `plannedEndAt` equals `plannedStartAt`. Printing that as a
                         span would read as an instant event, which is the one thing
                         it is not: the length is not zero and it is not infinite, it
                         is UNKNOWN (see `resolveSchedule`'s header). So it says so,
                         and says what everything after it therefore is. -->
                        <span class="text-muted-foreground" data-testid="batch-stage-observational">
                          No fixed time — you decide when it's ready, and the times below are the
                          plan as if this took none.
                        </span>
                      {:else}
                        <span
                          class="tabular-nums text-muted-foreground"
                          data-testid="batch-stage-end"
                        >
                          Ends {formatWhen(stage.plannedEndAt)}
                        </span>
                      {/if}
                    </div>
                  {/if}

                  {#if stated !== null || stage.environment !== null || stage.until !== null}
                    <div
                      class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                    >
                      {#if stated !== null}
                        <!-- What the RECIPE said, beside the single time the schedule
                           had to commit to. A range is scheduled at its long end and
                           keeps its whole span here, so "45–60 min" is still readable
                           against a clock that says 60. -->
                        <span data-testid="batch-stage-stated">
                          Recipe says {stated}{#if stage.duration?.kind === 'range'}, planned at the
                            long end{/if}
                        </span>
                      {/if}
                      {#if stage.environment !== null}
                        <span class="flex items-center gap-1" data-testid="batch-stage-environment">
                          <Icon name="Thermometer" size={12} />
                          {stage.environment.celsius} °C{#if stage.environment.relativeHumidityPercent !== undefined}
                            · {stage.environment.relativeHumidityPercent}% RH{/if}
                        </span>
                      {/if}
                      {#if stage.until !== null}
                        <span data-testid="batch-stage-until">{stage.until}</span>
                      {/if}
                    </div>
                  {/if}

                  <!-- ─── The controls, on the stage in hand and nowhere else ─────
                     "Done" is the write the whole reminder engine hangs off, so it
                     is the primary and it is tapped WHEN THE STAGE IS ACTUALLY
                     DONE, not when the clock says it should have been: early and
                     late are the same gesture and the schedule re-times either way.

                     COOK MODE rides beside it on an `active` stage. `active` is the
                     gate — the process's own definition of a stage the cook carries
                     out and is present for (ProcessStageKindSchema), which is
                     exactly when having the method in front of you helps. NOT the
                     label ("Bake" is a word three bread recipes spelled three ways,
                     which is why that field exists at all) and NOT `stepId`, which
                     an extraction is allowed to drop when the citation is
                     hallucinated — losing the bake its link for a reason that has
                     nothing to do with baking. The link carries only the recipe id
                     because cook mode takes only a recipe id: it lands at the top of
                     cook mode with its own timers, which is the whole hand-off (see
                     docs/formulas-schedules-batches.md) and needs no new machinery
                     at the sharp end. -->
                  <!-- ABANDONED RUNS OFFER NOTHING. `next.kind` rather than
                     `run.state` so this page reads the run's condition through the
                     same derivation as everything else on it; a stopped run has no
                     next action by definition, and nothing on it is still to do. -->
                  {#if next?.kind !== 'abandoned' && (status === 'notStarted' || status === 'inProgress')}
                    <div
                      class="flex flex-wrap items-center gap-2 pt-2"
                      data-testid="batch-stage-controls"
                    >
                      <!-- Mark done leads on the stage in hand and on anything
                         already under way; on a stage further down the list that
                         has not begun, Start leads instead, because that is the
                         thing you are actually doing when you reach past the queue.
                         Both are the same size of gesture and both are a record. -->
                      {#if isCurrent || status === 'inProgress'}
                        <Button
                          size="sm"
                          onclick={() => void handleAdvance(stage.id)}
                          loading={advancingStageId === stage.id}
                          disabled={advancingStageId !== null}
                          data-testid="batch-stage-advance"
                        >
                          {#snippet leading()}
                            <Icon name="Check" size={16} />
                          {/snippet}
                          Mark done
                        </Button>
                      {/if}
                      {#if status === 'notStarted'}
                        <Button
                          size="sm"
                          variant={isCurrent ? 'outline' : 'solid'}
                          onclick={() => void handleStart(stage.id)}
                          disabled={advancingStageId !== null}
                          data-testid="batch-stage-mark-started"
                        >
                          {#snippet leading()}
                            <Icon name="Play" size={16} />
                          {/snippet}
                          Start
                        </Button>
                      {/if}
                      <!-- SKIP, ON EVERY STAGE, OPTIONAL OR NOT, AND IN ONE TAP.
                         No confirmation dialogue and no gate on `optional`: the cook
                         decides what happens in the kitchen and Salt records it. The
                         note is a separate, optional disclosure beside the button —
                         never a step in front of it. -->
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={() => void handleSkip(stage.id)}
                        disabled={advancingStageId !== null}
                        data-testid="batch-stage-skip"
                      >
                        {#snippet leading()}
                          <Icon name="SkipForward" size={16} />
                        {/snippet}
                        Skip
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Why are you skipping ${stage.label || 'this stage'}?`}
                        aria-expanded={noteOpenStageId === stage.id}
                        onclick={() =>
                          (noteOpenStageId = noteOpenStageId === stage.id ? null : stage.id)}
                        data-testid="batch-stage-skip-note-toggle"
                      >
                        {#snippet leading()}
                          <Icon name="StickyNote" size={16} />
                        {/snippet}
                        Why?
                      </Button>
                      {#if stage.kind === 'active' && (isCurrent || status === 'inProgress')}
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => push(`/recipes/${run.recipeId}/cook`)}
                          data-testid="batch-stage-cook"
                        >
                          {#snippet leading()}
                            <Icon name="CookingPot" size={16} />
                          {/snippet}
                          Cook mode
                        </Button>
                      {/if}
                    </div>
                    {#if noteOpenStageId === stage.id}
                      <TextField
                        label="Why not?"
                        placeholder="Out of milk"
                        value={skipNotes[stage.id] ?? ''}
                        onValueChange={(v) => (skipNotes[stage.id] = v)}
                        data-testid="batch-stage-skip-note"
                      />
                    {/if}
                  {/if}
                </li>
              {/each}
            </ol>
          </CardContent>
        </Card>

        <!-- ─── The log ───────────────────────────────────────────────────────────
           OUTSIDE the ⋮, and outside `canAbandon` with it. Phase 3 gated that whole
           menu on the run being `running` so its trigger could never open onto an
           empty popover, and an always-available item put inside it would vanish
           the moment a run was stopped — on precisely the surface whose reason for
           existing is that an abandoned run keeps what it recorded. Here it is a
           control on the thing it acts on: the log has a button, the button says
           what it does, and it stands whatever state the run is in.

           It is also the door that is open the whole way through. A cure is weighed
           on day 12, not only at the end, so the end-of-run invitation above is an
           extra prompt and never the only route to this. -->
        <Card>
          <CardHeader class="flex-row items-center justify-between gap-3">
            <CardTitle>How it went</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onclick={() => (logOpen = true)}
              data-testid="batch-log-add"
            >
              {#snippet leading()}
                <Icon name="Plus" size={16} />
              {/snippet}
              Log a reading
            </Button>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            {#if log === undefined}
              <!-- Still loading. Nothing is said, because "nothing recorded yet" would
                 be a claim about six weeks of a cure's log that we have not read. -->
              <Spinner />
            {:else if logEntries.length === 0}
              <p class="text-sm text-muted-foreground" data-testid="batch-log-empty">
                Nothing recorded yet. A weight, a note or a photo — it stays on this batch.
              </p>
            {:else}
              <!-- Newest first: the reverse of the ascending list the adapter sorted
                 by `at`, never a re-sort of our own. -->
              <ul class="flex flex-col gap-3" data-testid="batch-log">
                {#each logEntries as entry (entry.id)}
                  {@const stageLabel = stageLabelById(run, entry.stageId)}
                  <li
                    class="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0"
                    data-testid="batch-log-entry"
                    data-observation-id={entry.id}
                    data-at={entry.at}
                    data-stage-id={entry.stageId ?? ''}
                  >
                    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {#if stageLabel !== null}
                        <!-- An entry about the whole run says nothing here, which is
                             the ordinary end-of-run verdict and not an omission. -->
                        <span class="text-sm font-medium" data-testid="batch-log-entry-stage">
                          {stageLabel}
                        </span>
                      {/if}
                      <span
                        class="text-sm text-muted-foreground"
                        data-testid="batch-log-entry-when"
                      >
                        {formatWhen(entry.at)}
                      </span>
                      {#if entry.weightGrams !== null}
                        <span class="font-medium tabular-nums" data-testid="batch-log-entry-weight">
                          {formatGrams(entry.weightGrams)}
                        </span>
                      {/if}
                      <!-- Neither of these has a control on this screen (the service
                         writes them null and says why). They are RENDERED anyway
                         because the document may carry them — from a later screen,
                         or from a hand-written correction — and showing a reading
                         that exists costs nothing. -->
                      {#if entry.ph !== null}
                        <span class="text-sm tabular-nums" data-testid="batch-log-entry-ph">
                          pH {entry.ph}
                        </span>
                      {/if}
                      {#if entry.temperatureC !== null}
                        <span
                          class="flex items-center gap-1 text-sm tabular-nums"
                          data-testid="batch-log-entry-temp"
                        >
                          <Icon name="Thermometer" size={12} />
                          {entry.temperatureC} °C
                        </span>
                      {/if}
                    </div>
                    {#if entry.note !== ''}
                      <p class="whitespace-pre-wrap text-sm" data-testid="batch-log-entry-note">
                        {entry.note}
                      </p>
                    {/if}
                    {#if entry.image !== null}
                      <!-- The Storage URL the callable stamped on. The bytes never went
                         through Firestore and there is no client-writable Storage
                         path anywhere in this feature. -->
                      <img
                        src={entry.image.url}
                        alt="How the batch looked on {formatWhen(entry.at)}"
                        loading="lazy"
                        class="mt-1 max-w-sm rounded border border-border object-cover"
                        data-testid="batch-log-entry-photo"
                      />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </CardContent>
        </Card>
      </div>
    </DetailPage>
  {/if}

  <!-- Outside the `{#if}` for the reason the abandon confirm is: a sheet must not be
     torn out from under itself if the run's snapshot changes while it is open. -->
  <BatchObservationSheet
    bind:open={logOpen}
    {batchId}
    run={run ?? null}
    onLogged={() => (promptDismissed = true)}
  />

  <!-- ─── Abandon confirm ──────────────────────────────────────────────────────────
     Outside the `{#if}` so the dialog is not torn out from under itself if the
     write lands before the animation finishes. It says what abandoning does and
     what it does not: the run stops and its reminders stop with it, and the log of
     how far it got stays exactly where it is — which is the difference between this
     and a delete, and the reason there is no way back. -->
  <Dialog
    bind:open={abandonOpen}
    onOpenChange={(v) => {
      if (!v) abandoning = false;
    }}
  >
    <DialogContent>
      <div class="flex flex-col gap-4" data-testid="batch-abandon-dialog">
        <DialogHeader>
          <DialogTitle>Abandon this batch?</DialogTitle>
          <DialogDescription>
            Its reminders stop. What it recorded stays — you just won't be asked about it again, and
            there's no way back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onclick={() => (abandonOpen = false)} disabled={abandoning}>
            Keep going
          </Button>
          <Button
            variant="destructive"
            onclick={() => void handleAbandon()}
            loading={abandoning}
            disabled={abandoning}
            data-testid="batch-abandon-confirm"
          >
            Abandon
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</FeatureGuard>
