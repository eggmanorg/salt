<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    Chip,
    DetailPage,
    EmptyState,
    Icon,
    Spinner,
  } from '@salt/ui-components';
  import { buildBatchLog } from '@salt/domain';
  import { push } from 'svelte-spa-router';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { batch, initBatchSync } from '../../lib/batchService.js';
  import { observations, initBatchObservationsSync } from '../../lib/batchObservationService.js';
  import BatchObservationSheet from './BatchObservationSheet.svelte';
  import BatchReadingRow from './BatchReadingRow.svelte';
  import {
    formatDrift,
    formatTimeOfDay,
    groupLogByDay,
    stageLabelById,
    yieldSummary,
  } from './batchDisplay.js';

  // The batch log (issue #1280, epic #778) — `/batches/:id/log`.
  //
  // A batch page answers WHAT HAPPENS NEXT. This answers WHAT ACTUALLY HAPPENED: the
  // run's start, every stage started, finished or skipped with its note, every
  // reading, and the abandonment if there was one — one list, oldest first, under
  // date headings, because a log is read forwards.
  //
  // ─── A READING SURFACE ────────────────────────────────────────────────────────
  //
  // Nothing is entered here that is not entered elsewhere. The one control is the
  // same **Log a reading** sheet the batch page has, unmodified, so the log is a door
  // as well as a record — a cure is weighed on day 12 and this is where you are
  // standing when you weigh it. There is no editing and no deleting: the observation
  // log is append-only, and the derived half has no entries to delete.
  //
  // ─── IT DERIVES NOTHING OF ITS OWN ────────────────────────────────────────────
  //
  // `buildBatchLog` merges the two subscriptions into the ordered list, and it OWNS
  // the order and the tiebreak. Nothing here re-sorts; `groupLogByDay` only cuts the
  // list the domain handed over into calendar days, in the order it arrived. A page
  // that sorted again would be a second answer to a question already answered.
  //
  // Stage entries carry an id, never a word — `stageLabelById` joins it against this
  // run's own frozen stages, so a label cannot go stale and an id that no longer
  // resolves prints nothing rather than an error.
  //
  // ─── WHAT IT DOES NOT CLAIM ───────────────────────────────────────────────────
  //
  // The over/under beside a finished step is against THE TIME THAT STEP WAS GIVEN —
  // the plan as it stood when it began, which `withStageAdvanced` re-times in place.
  // Drift from the schedule the run started with is unrecoverable from the document
  // and is not shown. A step given no length shows nothing at all rather than "0 min
  // over" (`buildBatchLog`'s `driftMinutes` is null there).
  //
  // A run abandoned before `abandonedAt` existed has no abandonment line: nothing
  // recorded when, and `updatedAt` is a later write's stamp, not the moment the cook
  // gave up.
  //
  // An ordinary AppShell route (CLAUDE.md rule 7), so NO entry in ./fullViewport.ts —
  // a batch is desk work at the bench with the nav still under it, exactly as the two
  // batch routes beside it. Nothing is persisted here, scroll position included
  // (rule 3).

  let { params }: { params?: { id?: string } } = $props();

  const batchId = $derived(params?.id ?? '');

  // The same two subscriptions `BatchDetailPage` opens, unchanged and disposed with
  // the page. Two listeners because they are two collections: the run is a document
  // rewritten whole, its readings are documents each written once.
  $effect(() => {
    if (!batchId) return;
    return initBatchSync(batchId);
  });
  $effect(() => {
    if (!batchId) return;
    return initBatchObservationsSync(batchId);
  });

  // Three states, all different sentences: `undefined` is still loading, `null` is a
  // link to a run that is not there, a document is the run.
  const run = $derived($batch);
  const readings = $derived($observations);

  // Both must have arrived before a line is drawn. Rendering the stages while the
  // readings are still in flight would show a run that looks as though nobody logged
  // anything, which is a claim rather than a loading state.
  const loading = $derived(run === undefined || readings === undefined);
  const days = $derived(run && readings ? groupLogByDay(buildBatchLog(run, readings)) : []);

  let logOpen = $state(false);
</script>

<FeatureGuard feature="bread">
  {#if run === undefined}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if run === null}
    <div class="p-6">
      <EmptyState title="Batch not found" description="It may have been deleted." />
    </div>
  {:else}
    <DetailPage
      title="The log"
      subtitle="{run.recipeTitle} · {yieldSummary(run.totals)}"
      onBack={() => push(`/batches/${batchId}`)}
      backLabel="Back to the run"
      class="p-4 sm:p-6"
    >
      {#snippet actions()}
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
      {/snippet}

      {#if loading}
        <div class="flex justify-center p-8"><Spinner /></div>
      {:else}
        <div class="flex flex-col gap-4" data-testid="batch-log-page">
          {#each days as day (day.key)}
            <Card>
              <CardContent class="flex flex-col gap-3 pt-6">
                <h2 class="text-sm font-semibold" data-testid="batch-log-day">{day.label}</h2>
                <ol class="flex flex-col gap-3">
                  {#each day.entries as entry, index (`${entry.kind}-${entry.at}-${index}`)}
                    {@const stageId =
                      entry.kind === 'observation' ? entry.observation.stageId : null}
                    <li
                      class="flex flex-col gap-1 border-b border-border pb-3 last:border-0 last:pb-0"
                      data-testid="batch-log-line"
                      data-kind={entry.kind}
                      data-at={entry.at}
                      data-stage-id={entry.kind === 'observation'
                        ? (stageId ?? '')
                        : entry.kind === 'batchStarted' || entry.kind === 'batchAbandoned'
                          ? ''
                          : entry.stageId}
                    >
                      {#if entry.kind === 'observation'}
                        <BatchReadingRow
                          {run}
                          entry={entry.observation}
                          when={formatTimeOfDay(entry.at)}
                        />
                      {:else}
                        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span
                            class="text-sm tabular-nums text-muted-foreground"
                            data-testid="batch-log-line-when"
                          >
                            {formatTimeOfDay(entry.at)}
                          </span>
                          <span class="text-sm font-medium" data-testid="batch-log-line-what">
                            {#if entry.kind === 'batchStarted'}
                              Batch started
                            {:else if entry.kind === 'batchAbandoned'}
                              Batch abandoned
                            {:else}
                              {stageLabelById(run, entry.stageId) ?? 'A step'} —
                              {entry.kind === 'stageStarted'
                                ? 'started'
                                : entry.kind === 'stageDone'
                                  ? 'done'
                                  : 'skipped'}
                            {/if}
                          </span>
                          {#if entry.kind === 'stageDone'}
                            {@const drift = formatDrift(entry.driftMinutes)}
                            {#if drift !== null}
                              <!-- A `fact` chip because that is what it is: a measured
                                 attribute of the step. Against the time this step WAS
                                 GIVEN — not drift from the schedule the run started
                                 with, which is not on the document. -->
                              <Chip variant="fact" data-testid="batch-log-line-drift">
                                {drift}
                              </Chip>
                            {/if}
                          {/if}
                        </div>
                        {#if entry.kind === 'stageSkipped' && entry.note !== ''}
                          <p class="whitespace-pre-wrap text-sm" data-testid="batch-log-line-note">
                            {entry.note}
                          </p>
                        {/if}
                      {/if}
                    </li>
                  {/each}
                </ol>
              </CardContent>
            </Card>
          {/each}
        </div>
      {/if}
    </DetailPage>
  {/if}

  <!-- Outside the `{#if}` for the reason `BatchDetailPage` puts it there: a sheet
     must not be torn out from under itself if the run's snapshot changes while it is
     open. Reused unmodified — the log is a door as well as a record. -->
  <BatchObservationSheet bind:open={logOpen} {batchId} run={run ?? null} />
</FeatureGuard>
