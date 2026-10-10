<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { axisPercent, withUnit } from './docScale';
  import { DOC_TONE_SOLID } from './docTone';
  import type { DocStepGauge, DocStepsProps } from './DocBlocks.types';

  /**
   * Numbered steps, each a short caption and, optionally, a small gauge: one
   * value or a range marked to scale between the gauge's own ends, its figures
   * written as typed. A list in role only — `div`s, so a `salt-md` body's list
   * rules do not restyle it (see DocCards).
   */
  let { steps, caption, class: className }: DocStepsProps = $props();

  // One expression, not `"{x}%"`: see DocAxisRows.
  const pct = (n: number) => `${n}%`;
  const place = (g: DocStepGauge, v: number) => axisPercent(v, g.min.value, g.max.value);
  const said = (g: DocStepGauge) =>
    withUnit(g.to ? `${g.from.text}–${g.to.text}` : g.from.text, g.unit);
</script>

<div class={cn('salt-doc-steps my-3 grid gap-2', className)} role="list">
  {#each steps as step, i (i)}
    <div
      class="flex gap-3 rounded border border-border bg-card px-3 py-2.5 text-sm"
      role="listitem"
    >
      <span
        class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground tabular-nums"
        >{i + 1}</span
      >
      <div class="grid min-w-0 flex-1 gap-1">
        {#if step.label}
          <span class="font-semibold text-foreground">{step.label}</span>
        {/if}
        <span class="text-foreground">{step.text}</span>
        {#if step.gauge}
          {@const g = step.gauge}
          {@const tone = g.tone ?? 'primary'}
          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2" data-gauge>
            <span class="relative mx-1.5 h-2 rounded-full bg-muted" aria-hidden="true">
              <span
                class={cn(
                  'absolute top-1/2 h-3 min-w-3 -translate-x-1.5 -translate-y-1/2 rounded-full',
                  DOC_TONE_SOLID[tone],
                )}
                style:left={pct(place(g, g.from.value))}
                style:width={`calc(${pct(place(g, g.to?.value ?? g.from.value) - place(g, g.from.value))} + 0.75rem)`}
                data-tone={tone}
                data-mark
              ></span>
            </span>
            <span class="text-xs font-semibold whitespace-nowrap text-foreground tabular-nums"
              >{said(g)}</span
            >
            <span class="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>{withUnit(g.min.text, g.unit)}</span><span>{withUnit(g.max.text, g.unit)}</span>
            </span>
          </div>
        {/if}
      </div>
    </div>
  {/each}
  {#if caption}
    <div class="text-xs text-muted-foreground">{caption}</div>
  {/if}
</div>
