<script lang="ts">
  import type { RecipePhase } from '@salt/domain';
  import { recipePhaseTotals } from '@salt/domain';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import { phaseTimelineBlocks, type PhaseBandKind } from './phaseTimeline.js';

  // The planning timeline (issue #1122) — "how does this evening go?", answered
  // before a single step is read. It replaces the plain-text phase list PR #1201
  // shipped, and it is the only drawing of `metadata.phases` in the app.
  //
  // THE BAR IS DECORATION AND SAYS SO. It is `aria-hidden`, and every figure in it
  // is repeated in words in the legend beneath: each phase's name, its elapsed
  // time, its hands-on and hands-off split, and whether its wait was drawn
  // shortened. Nothing here depends on colour, on width or on being able to see
  // the strip at all — that is #878's ribbon's contract, met again because the
  // reason for it has not changed.
  //
  // EVERY NUMBER COMES THROUGH THE DOMAIN. `recipePhaseTotals` for the summary
  // line, `phaseElapsedMinutes` (inside `phaseTimelineBlocks`) per phase. This
  // component adds up nothing of its own, so the figure here, the chip on the
  // list and the line on the cook plan cannot disagree.
  //
  // It takes the phase list rather than the `Recipe` so the caller owns the
  // feature gate — the page resolves gate-off to an empty list once, and this
  // component never has to know a gate exists.

  interface Props {
    /** Already gate-resolved by the caller. Rendered in order, never re-sorted. */
    phases: readonly RecipePhase[];
    /** The model's one-line account of the timing. Absent on a hand-built strip. */
    timingSummary?: string | null;
  }

  const { phases, timingSummary = null }: Props = $props();

  const blocks = $derived(phaseTimelineBlocks(phases));
  const totals = $derived(recipePhaseTotals(phases));
  const anyCompressed = $derived(blocks.some((block) => block.compressed));

  // Three treatments, and the third is the point. Hands-on is solid — it is the
  // thing you are deciding about. A short wait is the same hue gone pale, because
  // it is the same recipe still running without you. A long wait is drawn as an
  // outlined GAP rather than filled at all: it is the stretch where nothing is
  // happening and you are not in the room, and it is the only band whose width is
  // a lie, so it should not look like the bands that are telling the truth.
  function bandTint(kind: PhaseBandKind): string {
    if (kind === 'hands-on') return 'bg-primary';
    if (kind === 'wait') return 'bg-primary-tint';
    return 'border border-dashed border-primary/50 bg-transparent';
  }
</script>

<div class="flex flex-col gap-2" data-testid="recipe-phases">
  {#if timingSummary}
    <p class="text-xs text-muted-foreground" data-testid="recipe-timing-summary">
      {timingSummary}
    </p>
  {/if}

  <!-- Unkeyed for the reason the #878 ribbon's segments are: the list is re-derived
       whole from the recipe, and two phases may honestly share a label ("Rest"
       twice). Position is the identity. -->
  <div class="flex h-3 gap-0.5" aria-hidden="true" data-testid="recipe-phase-timeline-bar">
    {#each blocks as block, i (i)}
      <!-- `min-w-1` so a two-minute phase beside an overnight prove is still a mark
           on the strip rather than nothing at all. The muted ground shows through a
           phase a cook has timed at zero, which draws as an empty slot. -->
      <div
        class="flex min-w-1 overflow-hidden rounded-sm bg-muted"
        style="width: {block.widthPercent}%"
      >
        {#each block.bands as band, j (j)}
          <span class="{bandTint(band.kind)} min-w-0.5" style="width: {band.widthPercent}%"></span>
        {/each}
      </div>
    {/each}
  </div>

  <ol class="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="recipe-phase-legend">
    {#each blocks as block, i (i)}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-medium text-foreground">{block.label}</span>
        <span class="tabular-nums">{formatMinutes(block.elapsedMinutes)}</span>
        <span class="tabular-nums">
          {formatMinutes(block.handsOnMinutes)} hands-on ·
          {formatMinutes(block.handsOffMinutes)} hands-off
        </span>
        {#if block.compressed}
          <!-- The one thing the reader cannot get from the numbers: that this
               block's width is not to scale. Said per phase rather than once at the
               bottom, so it sits beside the block it is true of. -->
          <span data-testid="recipe-phase-shortened">(wait drawn shortened)</span>
        {/if}
      </li>
    {/each}
  </ol>

  <p class="text-xs text-muted-foreground" data-testid="recipe-phase-totals">
    <span class="font-medium text-foreground">{formatMinutes(totals.elapsedMinutes)}</span>
    start to finish ·
    <span class="font-medium text-foreground">{formatMinutes(totals.handsOnMinutes)}</span>
    hands-on
    {#if anyCompressed}
      · not drawn to scale
    {/if}
  </p>
</div>
