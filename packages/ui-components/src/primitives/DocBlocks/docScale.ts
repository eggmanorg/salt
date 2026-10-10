// spec: ui-spec-v04.md §12.7 v0.4
import type { DocTone } from './DocBlocks.types';

// The arithmetic behind the data-drawn document blocks (#1663 Phase 2): where a
// figure sits on an axis, which ticks an axis gets, how a pie divides. Pure, so
// "a value maps to its axis position" is pinned in `docScale.test.ts` rather
// than read off a rendered drawing.
//
// Positions are PERCENTAGES of the plot track, never pixels. The drawings are
// laid out by CSS from those percentages, so the same figures draw the same
// proportions at any width; nothing here measures the screen.

/** Where `value` sits between `min` and `max`, as a percentage, held to 0–100. */
export function axisPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** Each value as a percentage of the largest — a bar's length. All zero draws nothing. */
export function barPercents(values: readonly number[]): number[] {
  const top = Math.max(0, ...values);
  return values.map((v) => (top > 0 ? (Math.max(0, v) / top) * 100 : 0));
}

/** The most ticks an axis draws, however much room there is. */
export const DOC_AXIS_MAX_TICKS = 4;

/** Tick steps that read as whole periods, per elapsed unit; past the list, and for anything else, 1, 2, 5 × 10ⁿ. */
export const DOC_TIME_STEPS: Record<string, readonly number[]> = {
  minutes: [1, 2, 5, 10, 15, 30, 60, 120, 240],
  hours: [1, 2, 3, 6, 12, 24, 48, 72],
  days: [1, 2, 7, 14, 28, 56, 91, 182, 364],
  weeks: [1, 2, 4, 8, 13, 26, 52],
  dates: [1, 2, 7, 14, 28, 56, 91, 182, 364],
};

/** Every step worth trying over `span`, smallest first. */
function candidateSteps(span: number, steps: readonly number[] = []): number[] {
  const generic: number[] = [];
  const top = Math.ceil(Math.log10(span)) + 1;
  for (let e = top - 4; e <= top; e++) for (const m of [1, 2, 5]) generic.push(m * 10 ** e);
  const last = steps.at(-1) ?? 0;
  return [...steps, ...generic.filter((g) => g > last)];
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
    steps?: readonly number[] | undefined;
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
  for (const step of candidateSteps(span, opts.steps)) {
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

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** A day number (days since 1970-01-01, UTC) as `12 Oct`. */
export function formatDay(day: number): string {
  return DAY.format(new Date(day * 86_400_000));
}

/** The tones a pie's slices take, in order, when the author set none: five, so no two slices match. */
export const DOC_PIE_TONES: readonly DocTone[] = [
  'primary',
  'sage',
  'terracotta',
  'warning',
  'muted',
];

/**
 * One SVG path per value for a pie in a 100 × 100 box, clockwise from twelve
 * o'clock, each slice's angle in proportion to its value. A zero value has no
 * slice (`null`); one value holding the whole is a full circle.
 */
export function pieSlices(values: readonly number[]): (string | null)[] {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  const c = 50;
  const r = 48;
  const point = (turn: number) => {
    const a = turn * 2 * Math.PI;
    return `${(c + r * Math.sin(a)).toFixed(3)} ${(c - r * Math.cos(a)).toFixed(3)}`;
  };
  let start = 0;
  return values.map((v) => {
    if (total <= 0 || v <= 0) return null;
    const share = v / total;
    const from = start;
    start += share;
    if (share >= 1 - 1e-9) {
      return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z`;
    }
    const large = share > 0.5 ? 1 : 0;
    return `M ${c} ${c} L ${point(from)} A ${r} ${r} 0 ${large} 1 ${point(start)} Z`;
  });
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
