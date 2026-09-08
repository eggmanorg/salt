<script lang="ts">
  import { Icon } from '@salt/ui-components';
  import type { BatchDoc, BatchObservationDoc } from '@salt/domain/schemas';
  import { formatGrams, stageLabelById } from './batchDisplay.js';

  // ONE reading, rendered (issue #1280) — lifted out of `BatchDetailPage`'s "How it
  // went" card so the card's preview and the full batch log render the same row
  // rather than two copies that drift apart the first time a measurement is added.
  //
  // `when` is a STRING the caller has already formatted, because the two surfaces
  // say the instant differently and neither is wrong: the card is a glance and wants
  // "yesterday 07:40", the log sits under a date heading and wants "07:40". Passing
  // the words rather than a flag keeps the choice with the page that made it.

  let { run, entry, when }: { run: BatchDoc; entry: BatchObservationDoc; when: string } = $props();

  // Joined against the run's OWN frozen stages, so an id that no longer resolves
  // renders as an entry about the whole run rather than as an error.
  const stageLabel = $derived(stageLabelById(run, entry.stageId));
</script>

<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
  {#if stageLabel !== null}
    <!-- An entry about the whole run says nothing here, which is the ordinary
         end-of-run verdict and not an omission. -->
    <span class="text-sm font-medium" data-testid="batch-log-entry-stage">{stageLabel}</span>
  {/if}
  <span class="text-sm text-muted-foreground" data-testid="batch-log-entry-when">{when}</span>
  {#if entry.weightGrams !== null}
    <span class="font-medium tabular-nums" data-testid="batch-log-entry-weight">
      {formatGrams(entry.weightGrams)}
    </span>
  {/if}
  <!-- `ph` has no control on either screen (the service writes it null and says
     why). It is RENDERED anyway because the document may carry one — from a later
     screen, or from a hand-written correction — and showing a reading that exists
     costs nothing.

     The temperature DOES have a control now (issue #1286), and this row needed no
     change at all to show it — rendering whatever the document carries is exactly
     what let a dormant field start being answered. The humidity beside it is new
     to the document, so it is new here too. -->
  {#if entry.ph !== null}
    <span class="text-sm tabular-nums" data-testid="batch-log-entry-ph">pH {entry.ph}</span>
  {/if}
  {#if entry.temperatureC !== null}
    <span class="flex items-center gap-1 text-sm tabular-nums" data-testid="batch-log-entry-temp">
      <Icon name="Thermometer" size={12} />
      {entry.temperatureC} °C
    </span>
  {/if}
  {#if entry.relativeHumidityPercent !== null}
    <span class="text-sm tabular-nums" data-testid="batch-log-entry-humidity">
      {entry.relativeHumidityPercent}% RH
    </span>
  {/if}
</div>
{#if entry.note !== ''}
  <p class="whitespace-pre-wrap text-sm" data-testid="batch-log-entry-note">{entry.note}</p>
{/if}
{#if entry.image !== null}
  <!-- The Storage URL the callable stamped on. The bytes never went through
     Firestore and there is no client-writable Storage path anywhere in this
     feature. -->
  <img
    src={entry.image.url}
    alt="How the batch looked at {when}"
    loading="lazy"
    class="mt-1 max-w-sm rounded border border-border object-cover"
    data-testid="batch-log-entry-photo"
  />
{/if}
