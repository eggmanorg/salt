// spec: ui-spec-v04.md §12.7
//
// The geometry behind the flow chart and the shape shelf (#1663 Phase 4):
// slots in a flow chart row never share a half-column, and every shape in a
// drawing shares one scale and is drawn to its measurements.
import { describe, it, expect } from 'vitest';
import {
  DOC_SHAPE_MAX_PX,
  flowSlot,
  shapeExtent,
  shapePath,
  shapeScale,
  type DocShapeSize,
} from '../src/primitives/DocBlocks/docDiagram';
import { DOC_NARROWEST_PHONE_PX, docFigureInnerPx } from '../src/primitives/DocBlocks/docScale';

describe('flowSlot', () => {
  it('centres a row and puts each slot on its own two half-columns, for every row of the capped width', () => {
    for (let columns = 1; columns <= 3; columns++) {
      for (let count = 1; count <= columns; count++) {
        const spans = Array.from({ length: count }, (_, i) => {
          const { column, centre } = flowSlot(i, count, columns);
          const start = Number(column.split(' / ')[0]);
          // The centre is the line between the slot's two half-columns.
          expect(centre).toBeCloseTo((start / (2 * columns)) * 100, 9);
          return start;
        });
        // Inside the grid, never overlapping, and as far from one edge as the other.
        expect(spans[0]).toBeGreaterThanOrEqual(1);
        expect(spans.at(-1)! + 2).toBeLessThanOrEqual(2 * columns + 1);
        spans.slice(1).forEach((s, i) => expect(s - spans[i]!).toBeGreaterThanOrEqual(2));
        expect(spans[0]! - 1).toBe(2 * columns + 1 - (spans.at(-1)! + 2));
      }
    }
  });

  it('puts a lone box in the middle', () => {
    expect(flowSlot(0, 1, 3)).toEqual({ column: '3 / span 2', centre: 50 });
  });
});

/** Every coordinate pair in a path, control points included. */
function points(d: string): [number, number][] {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!]);
}

/** The box a path is drawn in: the hull of its points, which holds every curve. */
function box(d: string) {
  const p = points(d);
  const xs = p.map(([x]) => x);
  const ys = p.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** The outline's width at its top and bottom edges. */
function edgeWidth(d: string, y: number): number {
  const xs = points(d)
    .filter(([, py]) => py === y)
    .map(([x]) => x);
  return Math.max(...xs) - Math.min(...xs);
}

describe('shapePath', () => {
  const shapes: [string, DocShapeSize, { mouth: number; base: number; widest: number }][] = [
    [
      'straight',
      { profile: 'straight', mouth: 100, height: 80 },
      { mouth: 100, base: 100, widest: 100 },
    ],
    [
      'straight with a shoulder',
      { profile: 'straight', mouth: 80, height: 120, width: 100 },
      { mouth: 80, base: 100, widest: 100 },
    ],
    [
      'straight, narrower than its mouth',
      { profile: 'straight', mouth: 100, height: 120, width: 90 },
      { mouth: 100, base: 90, widest: 100 },
    ],
    [
      'tapered',
      { profile: 'tapered', mouth: 100, height: 75, base: 85.5 },
      { mouth: 100, base: 85.5, widest: 100 },
    ],
    [
      'belly',
      { profile: 'belly', mouth: 100, height: 200, width: 130 },
      { mouth: 100, base: 100, widest: 130 },
    ],
    [
      'belly on a narrow base',
      { profile: 'belly', mouth: 100, height: 200, width: 130, base: 80 },
      { mouth: 100, base: 80, widest: 130 },
    ],
    [
      'rounded',
      { profile: 'rounded', mouth: 100, height: 90, width: 110 },
      { mouth: 100, base: 0, widest: 110 },
    ],
  ];

  it.each(shapes)('draws a %s shape to its measurements', (_name, shape, want) => {
    const d = shapePath(shape);
    // The whole outline sits in the measured box and reaches every edge of it.
    expect(shapeExtent(shape)).toBe(want.widest);
    expect(box(d)).toEqual({ left: 0, right: want.widest, top: 0, bottom: shape.height });
    expect(edgeWidth(d, 0)).toBeCloseTo(want.mouth, 9);
    // A rounded base curves into the bottom, so it has no measured base width.
    if (shape.profile !== 'rounded') expect(edgeWidth(d, shape.height)).toBeCloseTo(want.base, 9);
  });
});

describe('shapeScale', () => {
  it('draws equal heights equal and the tallest at the full height, across a drawing', () => {
    const jars: DocShapeSize[] = [
      { profile: 'tapered', mouth: 100, height: 75, base: 85 },
      { profile: 'belly', mouth: 100, height: 230, width: 128 },
      { profile: 'straight', mouth: 100, height: 75 },
    ];
    const scale = shapeScale(jars);
    expect(230 * scale).toBeCloseTo(DOC_SHAPE_MAX_PX, 9);
    // One scale: the two 75-tall jars are drawn the same height, in proportion.
    expect(jars[0]!.height * scale).toBe(jars[2]!.height * scale);
    expect((75 * scale) / (230 * scale)).toBeCloseTo(75 / 230, 9);
  });

  it('shrinks to fit the widest shape on a 360px phone when that is the tighter limit', () => {
    const tray: DocShapeSize[] = [{ profile: 'straight', mouth: 600, height: 50 }];
    expect(600 * shapeScale(tray)).toBeCloseTo(docFigureInnerPx(DOC_NARROWEST_PHONE_PX), 9);
  });
});
