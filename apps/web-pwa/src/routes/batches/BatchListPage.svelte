<script lang="ts">
  import { Chip, ChipGroup, EmptyState, Icon, ListPage, Progress } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { targetProgress } from '@salt/domain';
  import type { CureCategory } from '@salt/domain';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { batches, initBatchesSync } from '../../lib/batchService.js';
  import {
    observationLogs,
    initBatchObservationLogsSync,
  } from '../../lib/batchObservationService.js';
  import {
    categoryChips as chipsFor,
    categoryLabel,
    formatGrams,
    formatWhen,
    nextAction,
    orderBatches,
    targetStanceClass,
    weightLossText,
    yieldSummary,
  } from './batchDisplay.js';

  // The in-flight surface (issue #812, phase 1 of epic #778) — `/batches`.
  //
  // The day-to-day home of this whole epic, and the thing that does not exist in any
  // form today: "Coppa — day 12, weigh Friday", "Kraut — day 5, taste it". A formula
  // is opened once a month; THIS is opened every morning, which is why it is a nav
  // destination rather than a tab on a recipe.
  //
  // FAMILY-SHARED, so it is deliberately not part of "Kitchen" (issue #634), which
  // is a per-user projection. Either partner may glance at the crock.
  //
  // EVERY CARD SAYS ONE THING: the next action and when. That is the whole card
  // shape, and it is the shape a culture's "next feed" would take too if phase 03
  // ever lands one — same card, different noun.
  //
  // An ordinary AppShell list page: no `fill` (nothing here owns its own scrolling —
  // ui-spec-v05 §1.5), no selection mode, no bulk actions. Nothing on this screen
  // WRITES, and that stayed true when phase 3 added the controls: marking a stage
  // done and abandoning a run live on the run's OWN page, next to the stage list
  // they act on. A card here is a glance and a way in, never a place to finish
  // something you cannot see.

  // The collection, for as long as the surface is open. `undefined` is the
  // not-loaded state; an empty array is loaded-and-nothing-running, which is a
  // different sentence and gets the empty snippet rather than the spinner.
  $effect(() => initBatchesSync());

  const all = $derived($batches ?? []);

  // ─── Narrowing to one kind of cure (issue #1404) ─────────────────────────────
  // "Show me all my dry-cured whole muscle", over finished and abandoned runs as
  // well as in-flight ones — which is what the freeze on the run exists for, and
  // why the filter lives on this list rather than on a view of running batches.
  //
  // `null` is ALL, and it is not a category: a household that cures and bakes wants
  // one list by default, and an "everything" chip that is also a value is how a
  // filter row ends up with two ways to mean the same thing.
  let categoryFilter = $state<CureCategory | null>(null);
  // Offered only when the runs actually carry one, so a bread-only household — which
  // is every household today — sees no new chrome at all. Derived from ALL runs
  // rather than from the shown ones, which is also what stops the row disappearing
  // under the person who just used it.
  const categoryChips = $derived(chipsFor(all));
  const shown = $derived(
    categoryFilter === null ? all : all.filter((b) => b.cureCategory === categoryFilter),
  );
  const ordered = $derived(orderBatches(shown));

  // ─── How far along each run is (issue #1407, phase 2) ────────────────────────
  //
  // ONLY RUNS IN FLIGHT THAT CARRY A WEIGHT-LOSS TARGET get a log subscription —
  // a household with nothing but bread opens not a single extra listener, which
  // is what keeps this dark. `batchObservationService` explains why a per-run
  // listener is the route rather than a collection-group query or a denormalised
  // figure on the batch.
  //
  // THE BOUND IS ENFORCED HERE, NOT ASSERTED (#1426 review, blocking 1). This
  // used to filter `all` on `target !== null` alone — and `all` is every batch
  // ever written (`subscribeBatches` carries no `where`/`limit`, and
  // `orderBatches` keeps ended runs rather than dropping them), so a household
  // years into curing opened one listener per cure it had ever logged, not per
  // cure on the go. `nextAction(batch).kind === 'stage'` is the same "still
  // waiting on something" test the card's own next-action line already computes,
  // so a done or abandoned run — however long the target it carries — opens no
  // listener here again; its figure is static and already on the run's own page.
  // `target?.weightLossPercent != null` narrows further: `meterFor` below only
  // ever reads the weight-loss half (see its own comment), so a pH-only target
  // would open a listener the card never consults.
  // `BatchListPage.test.ts` pins this gate directly — a done run, an abandoned
  // run and a pH-only run each open no listener despite carrying a target.
  //
  // The effect reads the JOINED KEY and nothing else, so it re-subscribes when the
  // SET of targeted runs changes and not merely when the store hands back a new
  // array on every snapshot.
  const targetedIdKey = $derived(
    all
      .filter(
        (batch) => nextAction(batch).kind === 'stage' && batch.target?.weightLossPercent != null,
      )
      .map((batch) => batch.id)
      .sort()
      .join(','),
  );
  $effect(() => initBatchObservationLogsSync(targetedIdKey === '' ? [] : targetedIdKey.split(',')));

  /**
   * The weight half for one run, or null — no meter and no gap where one would be.
   *
   * The pH half is deliberately not shown here: it has no bar (there is no frozen
   * zero to measure from) and the card is a glance rather than a second copy of the
   * run's page.
   */
  function meterFor(batch: (typeof ordered)[number]) {
    const log = $observationLogs.get(batch.id);
    if (log === undefined) return null;
    return targetProgress(batch, log)?.weightLoss ?? null;
  }
</script>

<!-- Bread is still being built (issue #831): everyone outside the test group is
     redirected home and sees nothing at all — no denial copy, because a message
     would announce a feature they are not meant to know exists yet. Cosmetic only;
     the boundary is not here (see lib/featureGate.ts). -->
<FeatureGuard feature="bread">
  <ListPage
    title="Batches"
    description="What's on the go, and what each one wants next."
    isLoading={$batches === undefined}
    isEmpty={ordered.length === 0}
    class="p-4 sm:p-6"
    data-testid="batch-list-page"
  >
    {#snippet empty()}
      <EmptyState
        title="Nothing on the go."
        description={'Open a recipe you\'ve written a formula for and tap "Bake a batch" — the run turns up here with its next step and the time it lands.'}
        data-testid="batch-list-empty"
      />
    {/snippet}

    {#snippet children()}
      <!-- The same `Chip` single-select row the recipes list uses (ui-spec-v09
           §8.23, adapted at §8.24.2): exactly one is pressed at all times, which is
           a property of what the click does rather than of the chip. -->
      {#if categoryChips.length > 0}
        <ChipGroup class="mb-3" ariaLabel="Cure type" data-testid="batch-category-filters">
          <Chip
            pressed={categoryFilter === null}
            onclick={() => (categoryFilter = null)}
            data-testid="batch-category-filter"
            data-category=""
          >
            All
          </Chip>
          {#each categoryChips as chip (chip.value)}
            <Chip
              pressed={categoryFilter === chip.value}
              onclick={() => (categoryFilter = chip.value)}
              data-testid="batch-category-filter"
              data-category={chip.value}
            >
              {chip.label}
            </Chip>
          {/each}
        </ChipGroup>
      {/if}
      <ul class="flex flex-col gap-2" data-testid="batch-list">
        {#each ordered as batch (batch.id)}
          {@const next = nextAction(batch)}
          {@const meter = meterFor(batch)}
          <li>
            <!-- The whole card is the target. A run has exactly one thing you can do
               with it from here — open it — so a row with a separate affordance
               would be a smaller tap area for no additional choice. -->
            <button
              type="button"
              class="flex w-full flex-col gap-1 rounded border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-accent"
              class:opacity-60={next.kind !== 'stage'}
              onclick={() => push(`/batches/${batch.id}`)}
              data-testid="batch-card"
              data-batch-id={batch.id}
              data-next-at={next.kind === 'stage' ? next.stage.plannedStartAt : ''}
            >
              <span class="flex items-baseline justify-between gap-3">
                <span class="min-w-0 flex-1 truncate font-medium" data-testid="batch-card-title">
                  {batch.recipeTitle}
                </span>
                <span class="shrink-0 text-xs text-muted-foreground" data-testid="batch-card-yield">
                  {yieldSummary(batch.totals)}
                </span>
              </span>

              <!-- THE LINE THIS SCREEN EXISTS FOR. A run with nothing left to do says
                 so plainly rather than borrowing the shape of one that is waiting on
                 you: an empty "next" reads as a bug, and "all done" reads as a log. -->
              {#if next.kind === 'stage'}
                <span class="flex items-center gap-2 text-sm" data-testid="batch-card-next">
                  <Icon name="Hourglass" size={14} class="text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate">{next.stage.label}</span>
                  <span class="shrink-0 tabular-nums text-muted-foreground">
                    {formatWhen(next.stage.plannedStartAt)}
                  </span>
                </span>
              {:else if next.kind === 'done'}
                <!-- "Done or skipped" rather than "done": since #1275 a run can
                   finish on a skip, and a card that said "Every stage done" over a
                   run whose last stage was deliberately left out would be the log
                   quietly lying — which is the whole defect that issue exists to
                   fix. `nextAction` makes no distinction between the two endings,
                   correctly; the copy is where the honesty has to live. -->
                <span class="flex items-center gap-2 text-sm" data-testid="batch-card-next">
                  <Icon name="Check" size={14} class="text-muted-foreground" />
                  <span>Every stage done or skipped.</span>
                </span>
              {:else}
                <span class="flex items-center gap-2 text-sm" data-testid="batch-card-next">
                  <Icon name="CircleSlash" size={14} class="text-muted-foreground" />
                  <span>Abandoned.</span>
                </span>
              {/if}

              <!-- ─── How far along it is (issue #1407) ──────────────────────
                 THE CUE, and the whole of it: a coppa at 31% of a 35% target is a
                 different colour and a fuller bar than one at 12%, without reading
                 the numbers. No word on this card judges a run, nothing is
                 blocked, and past the target the bar simply stays full while the
                 figure keeps counting. A run with no target — which is every bake
                 — renders nothing at all here. -->
              {#if meter !== null}
                <span
                  class="flex flex-col gap-1"
                  data-testid="batch-card-target"
                  data-stance={meter.stance}
                >
                  <span class="text-sm tabular-nums {targetStanceClass(meter.stance)}">
                    {weightLossText(meter)}
                  </span>
                  <Progress
                    value={meter.fractionOfTarget * 100}
                    ariaLabel={`How far ${batch.recipeTitle} has got towards what it is aiming at`}
                  />
                </span>
              {/if}

              <span class="text-xs text-muted-foreground">
                {formatGrams(batch.totals.totalGrams)} in total{#if batch.vessel !== undefined}
                  · {batch.vessel}{/if}
              </span>

              <!-- WHAT THIS RUN WAS, from the run's own frozen fields (issue
                   #1404) — never read through to the recipe, which may since have
                   been renamed, re-mapped or deleted. A run with no category says
                   nothing rather than "—": every card on this screen says one
                   thing, and a dash is a second thing that means nothing. -->
              {#if categoryLabel(batch) !== null}
                <span class="text-xs text-muted-foreground" data-testid="batch-card-category">
                  {categoryLabel(batch)}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/snippet}
  </ListPage>
</FeatureGuard>
