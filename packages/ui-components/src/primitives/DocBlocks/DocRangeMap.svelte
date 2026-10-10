<!-- spec: ui-spec-v04.md §12.7 v0.4 -->
<script lang="ts">
  import DocAxisRows, { type AxisGroup, type AxisLegendEntry } from './DocAxisRows.svelte';
  import { axisFor, axisPercent, bandToneAt, formatTick, isUnitSymbol, withUnit } from './docScale';
  import type { DocFigure, DocRangeBand, DocRangeMapProps, DocRangeStage } from './DocBlocks.types';

  /**
   * Rows of stages on one shared axis — the Control Freak temperature map: every
   * task on one scale, shaded gentle / steady / fierce, with the butter line.
   * Drawn from the figures, so a figure edited by hand redraws its mark.
   */
  let {
    unit,
    min,
    max,
    bands,
    lines,
    groups,
    caption,
    class: className,
  }: DocRangeMapProps = $props();

  // A one-symbol unit rides on every tick (`150°`); a word is said once, at the head.
  const symbol = $derived(unit !== undefined && isUnitSymbol(unit));
  const tickLabel = (t: number) => (symbol ? withUnit(formatTick(t), unit) : formatTick(t));

  const axis = $derived(
    axisFor(
      [
        ...groups.flatMap((g) =>
          g.rows.flatMap((r) =>
            r.stages.flatMap((s) => [s.from.value, s.to?.value ?? s.from.value]),
          ),
        ),
        ...bands.flatMap((b) => [b.from?.value, b.to?.value].filter((v) => v !== undefined)),
        ...lines.map((l) => l.at.value),
      ],
      { min: min?.value, max: max?.value, label: tickLabel },
    ),
  );
  const pct = (v: number) => axisPercent(v, axis.min, axis.max);
  const ticks = $derived(axis.ticks.map((t) => ({ at: pct(t), label: tickLabel(t) })));

  const span = (s: { from: DocFigure; to?: DocFigure | undefined }) =>
    s.to ? `${s.from.text}–${withUnit(s.to.text, unit)}` : withUnit(s.from.text, unit);
  const stageTitle = (s: DocRangeStage) => (s.label ? `${s.label} ${span(s)}` : span(s));

  const drawn: AxisGroup[] = $derived(
    groups.map((g) => ({
      heading: g.heading,
      rows: g.rows.map((row) => ({
        label: row.label,
        said: row.stages.map(stageTitle).join(', then '),
        marks: row.stages.map((s, i) => ({
          from: pct(s.from.value),
          to: pct(s.to?.value ?? s.from.value),
          point: s.to === undefined || s.to.value === s.from.value,
          tone: s.tone ?? bandToneAt(s.to?.value ?? s.from.value, bands) ?? 'primary',
          number: row.stages.length > 1 ? i + 1 : undefined,
          title: stageTitle(s),
        })),
      })),
    })),
  );

  const bandText = (b: DocRangeBand) =>
    b.from && b.to
      ? `${b.label}, ${b.from.text}–${withUnit(b.to.text, unit)}`
      : b.to
        ? `${b.label}, up to ${withUnit(b.to.text, unit)}`
        : `${b.label}, over ${withUnit(b.from!.text, unit)}`;

  const legend: AxisLegendEntry[] = $derived([
    ...bands.map((b) => ({ kind: 'band' as const, tone: b.tone, text: bandText(b) })),
    ...lines.map((l) => ({
      kind: 'line' as const,
      tone: l.tone,
      text: `${l.label}, ${withUnit(l.at.text, unit)}`,
    })),
  ]);
</script>

<DocAxisRows
  class={className}
  {ticks}
  unitLabel={symbol ? undefined : unit}
  bands={bands.map((b) => ({
    from: pct(b.from?.value ?? axis.min),
    to: pct(b.to?.value ?? axis.max),
    tone: b.tone,
  }))}
  lines={lines.map((l) => ({ at: pct(l.at.value), tone: l.tone }))}
  groups={drawn}
  {legend}
  {caption}
/>
