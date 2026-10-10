// spec: ui-spec-v04.md §12.7 v0.4
import type { Snippet } from 'svelte';

/**
 * The only colour channel a document block has (§12.7). A NAME, mapped to a
 * design token in `docTone.ts` — there is no prop anywhere on these primitives
 * that takes a colour, a class for one or a style. `@salt/domain`'s
 * `LibraryTone` is the same five words; web-pwa passes one straight into the
 * other, so the compiler is what keeps the two lists in step.
 */
export type DocTone = 'primary' | 'sage' | 'terracotta' | 'warning' | 'muted';

export interface DocChip {
  label: string;
  tone: DocTone;
}

export interface DocCardLine {
  /** A small uppercase name ahead of the sentence — a stage, a step. */
  label?: string | undefined;
  text: string;
}

export interface DocCard {
  title: string;
  chips: readonly DocChip[];
  /** Join the chips with arrows: stages in order, not a set. */
  arrows: boolean;
  lines: readonly DocCardLine[];
  footnote?: string | undefined;
}

export interface DocCardGroup {
  heading?: string | undefined;
  cards: readonly DocCard[];
}

export interface DocCardsProps {
  groups: readonly DocCardGroup[];
  class?: string;
}

export interface DocCalloutProps {
  tone: DocTone;
  label?: string | undefined;
  /** The callout's body — the caller decides how it is rendered. */
  children?: Snippet;
  class?: string;
}

export interface DocStat {
  value: string;
  label: string;
  tone: DocTone;
}

export interface DocStatsProps {
  items: readonly DocStat[];
  class?: string;
}

// ─── Drawings (§12.7, #1663 Phase 2) ─────────────────────────────────────────

/** A figure as the author typed it, and the number it means — drawn by `value`, shown as `text`. */
export interface DocFigure {
  text: string;
  value: number;
}

export type DocChartType = 'bar' | 'column' | 'pie';

export interface DocChartItem {
  label: string;
  value: DocFigure;
  /** Unset: one tone for every bar; a different tone per slice. */
  tone?: DocTone | undefined;
}

export interface DocChartProps {
  type: DocChartType;
  /** Written after every value. */
  unit?: string | undefined;
  items: readonly DocChartItem[];
  caption?: string | undefined;
  class?: string;
}

/** One stage of a row: a value (`to` unset) or a range. */
export interface DocRangeStage {
  label?: string | undefined;
  from: DocFigure;
  to?: DocFigure | undefined;
  /** Unset: the tone of the band holding the stage's top value. */
  tone?: DocTone | undefined;
}

export interface DocRangeRow {
  label: string;
  stages: readonly DocRangeStage[];
}

export interface DocRangeGroup {
  heading?: string | undefined;
  rows: readonly DocRangeRow[];
}

/** A shaded stretch of the axis, open-ended at a missing edge. */
export interface DocRangeBand {
  from?: DocFigure | undefined;
  to?: DocFigure | undefined;
  label: string;
  tone: DocTone;
}

/** A marked value drawn across every row. */
export interface DocRangeLine {
  at: DocFigure;
  label: string;
  tone: DocTone;
}

export interface DocRangeMapProps {
  unit?: string | undefined;
  /** The axis ends. Unset: the lowest and highest figure the drawing holds. */
  min?: DocFigure | undefined;
  max?: DocFigure | undefined;
  bands: readonly DocRangeBand[];
  lines: readonly DocRangeLine[];
  groups: readonly DocRangeGroup[];
  caption?: string | undefined;
  class?: string;
}

/** Elapsed time in one of these, or `dates` — where a figure's `value` is days since 1970-01-01 (UTC). */
export type DocTimelineUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'dates';

export interface DocTimelineItem {
  label: string;
  from: DocFigure;
  to?: DocFigure | undefined;
  tone?: DocTone | undefined;
}

export interface DocTimelineProps {
  unit: DocTimelineUnit;
  items: readonly DocTimelineItem[];
  caption?: string | undefined;
  class?: string;
}
