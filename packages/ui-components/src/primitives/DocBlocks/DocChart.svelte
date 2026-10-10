<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { DOC_PIE_TONES, barPercents, pieSlices, withUnit } from './docScale';
  import { DOC_TONE_FILL, DOC_TONE_SOLID } from './docTone';
  import type { DocChartProps, DocTone } from './DocBlocks.types';

  /**
   * A bar, column or pie chart drawn from its figures. Every value is written as
   * typed beside its mark, so the drawing never has to be read off an axis.
   * Bars and columns are drawn from zero, the longest at full length; a pie's
   * slices are in proportion to their share of the total.
   */
  let { type, unit, items, caption, class: className }: DocChartProps = $props();

  const lengths = $derived(barPercents(items.map((i) => i.value.value)));
  const slices = $derived(pieSlices(items.map((i) => i.value.value)));
  // One expression, not `"{x}%"`: see DocAxisRows. `lengths` has one entry per
  // item, hence the `!` on `lengths[i]` below.
  const pct = (n: number) => `${n}%`;
  const toneOf = (i: number, tone: DocTone | undefined): DocTone =>
    tone ?? (type === 'pie' ? DOC_PIE_TONES[i % DOC_PIE_TONES.length]! : 'primary');
</script>

<div
  class={cn(
    'salt-doc-chart my-3 grid gap-2 rounded border border-border bg-card p-3 text-sm',
    className,
  )}
  data-chart={type}
>
  {#if type === 'bar'}
    <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-2 gap-y-1.5">
      {#each items as item, i (i)}
        <span class="text-foreground">{item.label}</span>
        <span class="relative h-3 rounded-full bg-muted" aria-hidden="true">
          <span
            class={cn(
              'absolute inset-y-0 left-0 rounded-full',
              DOC_TONE_SOLID[toneOf(i, item.tone)],
            )}
            style:width={pct(lengths[i]!)}
            data-tone={toneOf(i, item.tone)}
            data-mark
          ></span>
        </span>
        <span class="text-right whitespace-nowrap text-foreground tabular-nums"
          >{withUnit(item.value.text, unit)}</span
        >
      {/each}
    </div>
  {:else if type === 'column'}
    <div
      class="grid gap-x-1.5 gap-y-1"
      style:grid-template-columns={`repeat(${items.length}, minmax(0, 1fr))`}
    >
      {#each items as item, i (i)}
        <span class="text-center text-xs text-foreground tabular-nums"
          >{withUnit(item.value.text, unit)}</span
        >
      {/each}
      {#each items as item, i (i)}
        <span class="relative h-32" aria-hidden="true">
          <span
            class={cn(
              'absolute inset-x-1 bottom-0 rounded-t',
              DOC_TONE_SOLID[toneOf(i, item.tone)],
            )}
            style:height={pct(lengths[i]!)}
            data-tone={toneOf(i, item.tone)}
            data-mark
          ></span>
        </span>
      {/each}
      {#each items as item, i (i)}
        <span
          class="border-t border-border pt-1 text-center text-xs break-words text-muted-foreground"
          >{item.label}</span
        >
      {/each}
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 100 100" class="size-32 shrink-0" aria-hidden="true">
        {#each slices as d, i (i)}
          {#if d}
            <path
              {d}
              class={cn('stroke-card', DOC_TONE_FILL[toneOf(i, items[i]!.tone)])}
              stroke-width="1"
              stroke-linejoin="round"
              data-tone={toneOf(i, items[i]!.tone)}
              data-mark
            />
          {/if}
        {/each}
      </svg>
      <div class="grid min-w-0 flex-1 gap-1">
        {#each items as item, i (i)}
          <span class="flex items-center gap-2">
            <span
              class={cn('size-2.5 shrink-0 rounded-sm', DOC_TONE_SOLID[toneOf(i, item.tone)])}
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 text-foreground">{item.label}</span>
            <span class="whitespace-nowrap text-foreground tabular-nums"
              >{withUnit(item.value.text, unit)}</span
            >
          </span>
        {/each}
      </div>
    </div>
  {/if}
  {#if caption}
    <div class="text-xs text-muted-foreground">{caption}</div>
  {/if}
</div>
