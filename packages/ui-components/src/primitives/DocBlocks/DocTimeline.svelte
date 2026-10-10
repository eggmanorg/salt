<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import DocAxisRows, { type AxisGroup } from './DocAxisRows.svelte';
  import { DOC_TIME_STEPS, axisFor, axisPercent, formatDay, formatTick } from './docScale';
  import type { DocTimelineItem, DocTimelineProps } from './DocBlocks.types';

  /**
   * Events and spans on one time axis — a ferment, a brine schedule. One row per
   * item: its label, its time in words underneath, and its mark on the axis.
   * Elapsed time ticks in whole periods (days by the week); dates tick as
   * `12 Oct`.
   */
  let { unit, items, caption, class: className }: DocTimelineProps = $props();

  const dated = $derived(unit === 'dates');
  const tickLabel = (t: number) => (dated ? formatDay(t) : formatTick(t));
  const axis = $derived(
    axisFor(
      items.flatMap((i) => [i.from.value, i.to?.value ?? i.from.value]),
      { steps: DOC_TIME_STEPS[unit], label: tickLabel },
    ),
  );
  const pct = (v: number) => axisPercent(v, axis.min, axis.max);

  // "day 5", "days 0–7"; "12 Oct", "12 Oct – 19 Oct".
  const singular = $derived(unit.replace(/s$/, ''));
  const when = (i: DocTimelineItem) => {
    if (dated) {
      return i.to
        ? `${formatDay(i.from.value)} – ${formatDay(i.to.value)}`
        : formatDay(i.from.value);
    }
    return i.to ? `${unit} ${i.from.text}–${i.to.text}` : `${singular} ${i.from.text}`;
  };

  const drawn: AxisGroup[] = $derived([
    {
      rows: items.map((i) => ({
        label: i.label,
        detail: when(i),
        said: when(i),
        marks: [
          {
            from: pct(i.from.value),
            to: pct(i.to?.value ?? i.from.value),
            point: i.to === undefined || i.to.value === i.from.value,
            tone: i.tone ?? 'primary',
            title: when(i),
          },
        ],
      })),
    },
  ]);
</script>

<DocAxisRows
  class={className}
  ticks={axis.ticks.map((t) => ({ at: pct(t), label: tickLabel(t) }))}
  unitLabel={dated ? undefined : unit}
  bands={[]}
  lines={[]}
  groups={drawn}
  legend={[]}
  {caption}
/>
