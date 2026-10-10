// spec: ui-spec-v04.md §12.7 v0.4
import { docFigureInnerPx, DOC_NARROWEST_PHONE_PX } from './docScale';
import type { DocShapeProfile } from './DocBlocks.types';

// The geometry behind the flow chart and the shape shelf (#1663 Phase 4). Pure,
// so "nothing overlaps" and "equal heights draw equal" are pinned in
// `docDiagram.test.ts` rather than read off a rendered drawing.

// ─── Flow chart ──────────────────────────────────────────────────────────────
//
// A row of a flow chart is a grid of `2 × columns` equal half-columns, with no
// gap, and every slot spans two of them, the row's slots centred. So a slot's
// centre is a whole number of half-columns from the left edge, and the arrows
// drawn between rows (as percentages of the same width) meet the boxes'
// centres exactly at any screen width.

export interface DocFlowSlotPlace {
  /** The CSS `grid-column` the slot occupies. */
  column: string;
  /** Its centre, as a percentage of the row's width. */
  centre: number;
}

/** Where slot `i` of a row of `count` sits in a chart `columns` slots wide. */
export function flowSlot(i: number, count: number, columns: number): DocFlowSlotPlace {
  const start = columns - count + 2 * i + 1;
  return { column: `${start} / span 2`, centre: (start / (2 * columns)) * 100 };
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** A shape's measurements, in the drawing's one unit. */
export interface DocShapeSize {
  profile: DocShapeProfile;
  mouth: number;
  height: number;
  width?: number | undefined;
  base?: number | undefined;
}

/** The shape's widest extent — the width of the box it is drawn in. */
export function shapeExtent(s: DocShapeSize): number {
  return Math.max(s.mouth, s.width ?? 0, s.base ?? 0);
}

/** The tallest a shape is drawn, in px: the tallest in a drawing is drawn this tall. */
export const DOC_SHAPE_MAX_PX = 144;

/**
 * Pixels per unit for a whole drawing: ONE scale, so equal measurements draw
 * equal however many shelves they are on. The tallest shape is drawn
 * `DOC_SHAPE_MAX_PX` tall unless the widest would then not fit the drawing on a
 * 360px phone, in which case the widest fits.
 */
export function shapeScale(shapes: readonly DocShapeSize[]): number {
  const tallest = Math.max(...shapes.map((s) => s.height));
  const widest = Math.max(...shapes.map(shapeExtent));
  return Math.min(DOC_SHAPE_MAX_PX / tallest, docFigureInnerPx(DOC_NARROWEST_PHONE_PX) / widest);
}

/**
 * The shape's outline as an SVG path in its own units, in a box `shapeExtent`
 * wide and `height` tall, centred, mouth at the top. Curves are drawn with their
 * control points inside the measured box, and a curve never leaves the hull of
 * its control points — so the outline reaches each measured width and never
 * passes it.
 */
export function shapePath(s: DocShapeSize): string {
  const c = shapeExtent(s) / 2;
  const h = s.height;
  const m = s.mouth / 2;
  const w = (s.width ?? s.mouth) / 2;
  const n = (v: number) => Number(v.toFixed(3));
  // Each outline is its left half, top to bottom, mirrored for the right.
  const left = (x: number) => n(c - x);
  const right = (x: number) => n(c + x);
  // A shoulder from the mouth to the body, a quarter of the height at most.
  const shoulder = Math.min(Math.abs(w - m), h / 4);
  switch (s.profile) {
    case 'tapered': {
      const b = s.base! / 2;
      return `M ${left(m)} 0 L ${left(b)} ${h} L ${right(b)} ${h} L ${right(m)} 0 Z`;
    }
    case 'belly': {
      // Out to the widest point at half height, then in to the base; each curve
      // ends vertical at the widest point, so that point is exactly `width`.
      const b = (s.base ?? s.mouth) / 2;
      const y = h / 2;
      return [
        `M ${left(m)} 0`,
        `C ${left(m)} ${n(y / 2)} ${left(w)} ${n(y / 2)} ${left(w)} ${n(y)}`,
        `C ${left(w)} ${n(y + y / 2)} ${left(b)} ${n(h - y / 4)} ${left(b)} ${h}`,
        `L ${right(b)} ${h}`,
        `C ${right(b)} ${n(h - y / 4)} ${right(w)} ${n(y + y / 2)} ${right(w)} ${n(y)}`,
        `C ${right(w)} ${n(y / 2)} ${right(m)} ${n(y / 2)} ${right(m)} 0 Z`,
      ].join(' ');
    }
    case 'rounded': {
      const r = Math.min(w, h / 3);
      return [
        `M ${left(m)} 0 L ${left(w)} ${n(shoulder)} L ${left(w)} ${n(h - r)}`,
        `Q ${left(w)} ${h} ${left(w - r)} ${h} L ${right(w - r)} ${h}`,
        `Q ${right(w)} ${h} ${right(w)} ${n(h - r)} L ${right(w)} ${n(shoulder)} L ${right(m)} 0 Z`,
      ].join(' ');
    }
    default:
      return `M ${left(m)} 0 L ${left(w)} ${n(shoulder)} L ${left(w)} ${h} L ${right(w)} ${h} L ${right(w)} ${n(shoulder)} L ${right(m)} 0 Z`;
  }
}
