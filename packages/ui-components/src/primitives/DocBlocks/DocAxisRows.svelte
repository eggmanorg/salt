<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts" module>
  import type { DocTone } from './DocBlocks.types';

  /** Everything below is in PERCENT of the plot track (`docScale.ts`). */
  export interface AxisTick {
    at: number;
    label: string;
  }
  export interface AxisBand {
    from: number;
    to: number;
    tone: DocTone;
  }
  export interface AxisLine {
    at: number;
    tone: DocTone;
  }
  export interface AxisMark {
    from: number;
    to: number;
    /** A point when `from === to`. */
    point: boolean;
    tone: DocTone;
    /** The stage's place in its row, drawn on the mark, when a row has several. */
    number?: number | undefined;
    title: string;
  }
  export interface AxisRow {
    label: string;
    /** What the marks say, for a screen reader. */
    said: string;
    marks: readonly AxisMark[];
  }
  export interface AxisGroup {
    heading?: string | undefined;
    rows: readonly AxisRow[];
  }
  export interface AxisLegendEntry {
    kind: 'band' | 'line';
    tone: DocTone;
    text: string;
  }
</script>

<script lang="ts">
  import { cn } from '../../lib/cn';
  import { DOC_AXIS_COLUMNS } from './docScale';
  import { DOC_TONE_BAND, DOC_TONE_RULE, DOC_TONE_SOLID } from './docTone';

  /**
   * The shared body of the axis drawings (`DocRangeMap`). Not exported: it takes
   * geometry already worked out, in percent, and draws it.
   *
   * A grid of label | plot rows. Each row's plot cell draws its own slice of the
   * bands, gridlines and reference lines, full height, with no gap between rows
   * — so they read as continuous columns down the drawing, and a label that wraps
   * to two lines only makes its own row taller. Everything is HTML positioned by
   * percentage, so text is real text at the type scale, at any width.
   */
  let {
    ticks,
    unitLabel,
    bands,
    lines,
    groups,
    legend,
    caption,
    class: className,
  }: {
    ticks: readonly AxisTick[];
    /** Shown once, at the head of the label column, when the ticks do not carry it. */
    unitLabel?: string | undefined;
    bands: readonly AxisBand[];
    lines: readonly AxisLine[];
    groups: readonly AxisGroup[];
    legend: readonly AxisLegendEntry[];
    caption?: string | undefined;
    class?: string | undefined;
  } = $props();

  const columns = `minmax(0, ${DOC_AXIS_COLUMNS.label}fr) minmax(0, ${DOC_AXIS_COLUMNS.plot}fr)`;

  // A tick label at either end is anchored inside the track rather than centred
  // on its tick, so it never hangs past the drawing.
  // Each style value is one expression, not text around one: Svelte compiles
  // `"{x}%"` with a `?? ''` fallback that can never fire, a branch no test can reach.
  const pct = (n: number) => `${n}%`;

  const anchor = (at: number) => (at < 8 ? '' : at > 92 ? '-translate-x-full' : '-translate-x-1/2');
</script>

{#snippet backdrop()}
  {#each bands as band, b (b)}
    <span
      class={cn('absolute inset-y-0', DOC_TONE_BAND[band.tone])}
      style:left={pct(band.from)}
      style:width={pct(band.to - band.from)}
      aria-hidden="true"
    ></span>
  {/each}
  {#each ticks as tick, t (t)}
    <span
      class="absolute inset-y-0 border-l border-border"
      style:left={pct(tick.at)}
      aria-hidden="true"
    ></span>
  {/each}
  {#each lines as line, l (l)}
    <span
      class={cn('absolute inset-y-0 border-l border-dashed', DOC_TONE_RULE[line.tone])}
      style:left={pct(line.at)}
      aria-hidden="true"
    ></span>
  {/each}
{/snippet}

<div
  class={cn('salt-doc-axis my-3 grid gap-2 rounded border border-border bg-card p-3', className)}
>
  <div class="grid gap-x-2" style:grid-template-columns={columns}>
    <div class="self-end text-right text-xs text-muted-foreground">{unitLabel ?? ''}</div>
    <div class="relative mx-2 h-5" aria-hidden="true">
      {#each ticks as tick, t (t)}
        <span
          class={cn(
            'absolute bottom-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums',
            anchor(tick.at),
          )}
          style:left={pct(tick.at)}
          data-tick>{tick.label}</span
        >
      {/each}
    </div>

    {#each groups as group, g (g)}
      {#if group.heading}
        <div
          class="pt-2 pb-0.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          {group.heading}
        </div>
        <div class="relative mx-2">{@render backdrop()}</div>
      {/if}
      {#each group.rows as row, r (r)}
        <div class="flex min-h-7 flex-col justify-center py-0.5 text-sm text-foreground">
          <span><span>{row.label}</span><span class="sr-only">{`: ${row.said}`}</span></span>
        </div>
        <div class="relative mx-2" aria-hidden="true" data-row={row.label}>
          {@render backdrop()}
          {#if row.marks.length > 1}
            {@const centres = row.marks.map((m) => (m.from + m.to) / 2)}
            <span
              class="absolute top-1/2 border-t border-dashed border-placeholder"
              style:left={pct(Math.min(...centres))}
              style:width={pct(Math.max(...centres) - Math.min(...centres))}
            ></span>
          {/if}
          {#each row.marks as mark, m (m)}
            <span
              class={cn(
                'absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full text-xs leading-none font-semibold',
                mark.number === undefined ? 'h-3' : 'h-4',
                mark.point
                  ? cn('-translate-x-1/2', mark.number === undefined ? 'w-3' : 'w-4')
                  : mark.number === undefined
                    ? 'min-w-3'
                    : 'min-w-4',
                DOC_TONE_SOLID[mark.tone],
              )}
              style:left={pct(mark.from)}
              style:width={mark.point ? undefined : `${mark.to - mark.from}%`}
              title={mark.title}
              data-tone={mark.tone}
              data-mark>{mark.number ?? ''}</span
            >
          {/each}
        </div>
      {/each}
    {/each}
  </div>

  {#if legend.length > 0}
    <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {#each legend as entry, e (e)}
        <span class="inline-flex items-center gap-1.5">
          {#if entry.kind === 'band'}
            <span class={cn('size-2.5 rounded-sm', DOC_TONE_SOLID[entry.tone])} aria-hidden="true"
            ></span>
          {:else}
            <span
              class={cn('h-2.5 w-0 border-l-2 border-dashed', DOC_TONE_RULE[entry.tone])}
              aria-hidden="true"
            ></span>
          {/if}
          <span>{entry.text}</span>
        </span>
      {/each}
    </div>
  {/if}
  {#if caption}
    <div class="text-xs text-muted-foreground">{caption}</div>
  {/if}
</div>
