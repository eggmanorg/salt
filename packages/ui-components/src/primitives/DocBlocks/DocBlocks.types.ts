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

// ─── Flow charts, steps and shapes (§12.7, #1663 Phase 4) ────────────────────

export interface DocFlowNode {
  label: string;
  tone?: DocTone | undefined;
}

/** A row slot: a box, or `null` where an arrow passes down through the row. */
export interface DocFlowSlot {
  node: DocFlowNode | null;
}

/** A segment from slot `from` of a row to slot `to` of the next. */
export interface DocFlowLink {
  from: number;
  to: number;
  label?: string | undefined;
}

export interface DocFlowRow {
  slots: readonly DocFlowSlot[];
  /** Segments down to the next row. */
  links: readonly DocFlowLink[];
}

export interface DocFlowChartProps {
  /** Laid out already, top to bottom — `@salt/domain`'s `layoutLibraryFlow`. */
  rows: readonly DocFlowRow[];
  caption?: string | undefined;
  class?: string;
}

/** A small scale beside a step, with one value (`to` unset) or a range marked on it. */
export interface DocStepGauge {
  min: DocFigure;
  max: DocFigure;
  from: DocFigure;
  to?: DocFigure | undefined;
  unit?: string | undefined;
  tone?: DocTone | undefined;
}

export interface DocStep {
  label?: string | undefined;
  text: string;
  gauge?: DocStepGauge | undefined;
}

export interface DocStepsProps {
  steps: readonly DocStep[];
  caption?: string | undefined;
  class?: string;
}

export type DocShapeProfile = 'straight' | 'tapered' | 'belly' | 'rounded';

export interface DocShape {
  label: string;
  profile: DocShapeProfile;
  mouth: DocFigure;
  height: DocFigure;
  width?: DocFigure | undefined;
  base?: DocFigure | undefined;
  caption?: string | undefined;
  count?: DocFigure | undefined;
  /** Unset: drawn in outline. Set: drawn filled — the ones you own. */
  tone?: DocTone | undefined;
}

export interface DocShapeShelf {
  heading?: string | undefined;
  items: readonly DocShape[];
}

export interface DocShapesProps {
  /** The one unit every measurement is in. */
  unit: string;
  shelves: readonly DocShapeShelf[];
  caption?: string | undefined;
  class?: string;
}
