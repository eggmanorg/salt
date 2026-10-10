// spec: ui-spec-v04.md §12.7 v0.4
import type { DocTone } from './DocBlocks.types';

// The arithmetic behind the data-drawn document blocks (#1663 Phase 2): where a
// figure sits on an axis, and which ticks an axis gets. Pure, so "a value maps
// to its axis position" is pinned in `docScale.test.ts` rather than read off a
// rendered drawing.
//
// Positions are PERCENTAGES of the plot track, never pixels. The drawings are
// laid out by CSS from those percentages, so the same figures draw the same
// proportions at any width; nothing here measures the screen.

/** Where `value` sits between `min` and `max`, as a percentage, held to 0–100. */
export function axisPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** The most ticks an axis draws, however much room there is. */
export const DOC_AXIS_MAX_TICKS = 4;

/** Every step worth trying over `span`, smallest first: 1, 2, 5 × 10ⁿ. */
function candidateSteps(span: number): number[] {
  const steps: number[] = [];
  const top = Math.ceil(Math.log10(span)) + 1;
  for (let e = top - 4; e <= top; e++) for (const m of [1, 2, 5]) steps.push(m * 10 ** e);
  return steps;
}

/** Multiples of `step` inside [min, max], printed without float noise (0.3, not 0.30000000000000004). */
function ticksAt(min: number, max: number, step: number): number[] {
  const places = Math.max(0, -Math.floor(Math.log10(step))) + 1;
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + 1e-9 * step; k++) {
    ticks.push(Number((k * step).toFixed(places)));
  }
  return ticks;
}

/** A tick label's width at 12px: 0.6em a character, generous for Inter's digits. */
export const DOC_TICK_CHAR_PX = 7.2;
/** Clear space wanted between two neighbouring tick labels. */
const TICK_ROOM_PX = 4;

/**
 * Whether ticks `step` apart on an axis `span` long leave room for labels
 * `widestChars` long, on a track `trackPx` wide. Labels are centred on their
 * ticks, so neighbours need the gap to hold one whole label.
 */
export function ticksFit(
  step: number,
  span: number,
  widestChars: number,
  trackPx: number,
): boolean {
  return (step / span) * trackPx >= widestChars * DOC_TICK_CHAR_PX + TICK_ROOM_PX;
}

export interface DocAxis {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * An axis over `values`: from the lowest to the highest unless the author fixed
 * an end, with ticks at whole steps INSIDE it — so the drawing spends no width
 * on empty axis, and the ticks are still round numbers.
 *
 * The step is the smallest that gives at least two and at most
 * `DOC_AXIS_MAX_TICKS` ticks whose labels (`label`) fit between each other on
 * the plot track of a 360px phone (`axisTrackPx`) — so a wider screen only ever
 * has more room. If none fits, the fewest ticks that still number two or more.
 */
export function axisFor(
  values: readonly number[],
  opts: {
    min?: number | undefined;
    max?: number | undefined;
    label?: (tick: number) => string;
  } = {},
): DocAxis {
  let min = opts.min ?? Math.min(...values);
  let max = opts.max ?? Math.max(...values);
  if (!(max > min)) {
    // One value (or none): give it room either side so it is not drawn on an edge.
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const label = opts.label ?? formatTick;
  const track = axisTrackPx(DOC_NARROWEST_PHONE_PX);
  let fallback: number[] | undefined;
  for (const step of candidateSteps(span)) {
    const ticks = ticksAt(min, max, step);
    if (ticks.length > DOC_AXIS_MAX_TICKS) continue;
    if (ticks.length < 2) break;
    fallback = ticks;
    const widest = Math.max(...ticks.map((t) => label(t).length));
    if (ticksFit(step, span, widest, track)) return { min, max, ticks };
  }
  return { min, max, ticks: fallback ?? [min, max] };
}

/**
 * The first band holding `value`. A band holds its top edge and not its bottom
 * one, so 120 on "up to 120 / 120 to 170" is the first band — the mock-up's
 * gentle / steady / fierce reading. Undefined when no band holds it.
 */
export function bandToneAt(
  value: number,
  bands: readonly {
    from?: { value: number } | undefined;
    to?: { value: number } | undefined;
    tone: DocTone;
  }[],
): DocTone | undefined {
  return bands.find(
    (b) =>
      (b.from === undefined || value > b.from.value) && (b.to === undefined || value <= b.to.value),
  )?.tone;
}

/** Whether a unit is a symbol that sits against its number (`130°`, `40%`) rather than a word after a space. */
export function isUnitSymbol(unit: string): boolean {
  return /^[°%′″]/.test(unit);
}

/** `text` with `unit` after it: `130°`, `290 ml`. */
export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  return isUnitSymbol(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

const NUMBER = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 });
/** A tick's number: grouped, at most three decimals. */
export function formatTick(n: number): string {
  return NUMBER.format(n);
}

// ─── Width ───────────────────────────────────────────────────────────────────
//
// The axis drawings are a two-column grid, label | plot, split by these shares;
// the component builds its `grid-template-columns` from the same object. The
// constants after it are the space around the plot on a library page. Together
// they say how wide the plot track is at a given phone width — ARITHMETIC over
// the layout's own numbers, not a measurement: jsdom lays nothing out, so the
// 360px / 412px check in `docScale.test.ts` is only as true as these constants.

export const DOC_AXIS_COLUMNS = { label: 2, plot: 3 } as const;
/** The narrowest phone the household reads on (ui-spec-v05 §2): ticks are chosen to fit it. */
export const DOC_NARROWEST_PHONE_PX = 360;
/** The library page's side gutter, each side. */
const PAGE_GUTTER_PX = 16;
/** The drawing box's padding (`p-3`), each side. */
const FIGURE_PADDING_PX = 12;
/** The gap between the label and plot columns (`gap-x-2`). */
const COLUMN_GAP_PX = 8;
/** The plot track's inset (`mx-2`), each side, so an end dot is not clipped. */
const TRACK_INSET_PX = 8;

/** The plot track's width, in px, on a screen `viewportPx` wide. */
export function axisTrackPx(viewportPx: number): number {
  const inner = viewportPx - 2 * PAGE_GUTTER_PX - 2 * FIGURE_PADDING_PX - COLUMN_GAP_PX;
  const share = DOC_AXIS_COLUMNS.plot / (DOC_AXIS_COLUMNS.label + DOC_AXIS_COLUMNS.plot);
  return inner * share - 2 * TRACK_INSET_PX;
}
