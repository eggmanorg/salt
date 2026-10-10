/**
 * Library drawings (issue #1663, Phase 4) — `salt-flow`, `salt-steps` and
 * `salt-shapes`. The flow chart's layout is pure and pinned here: every box
 * drawn once, every arrow a chain of row-to-row segments, nothing two to a slot
 * and no row wider than a phone holds. The steps' gauges and the shapes' own
 * rules refuse what could not be drawn to its figures, as a sentence.
 */
import { describe, it, expect } from 'vitest';
import {
  LIBRARY_FLOW_NODE_CAP,
  LIBRARY_FLOW_WIDTH_CAP,
  LIBRARY_SHAPES_CAP,
  layoutLibraryFlow,
  parseLibraryBlock,
  type LibraryBlock,
  type LibraryFlowRow,
} from '@salt/domain/schemas';

function parsed(kind: string, source: string): LibraryBlock {
  const result = parseLibraryBlock(kind, source);
  if (!result.ok) throw new Error(result.problem);
  return result.block;
}

function problem(kind: string, source: string): string {
  const result = parseLibraryBlock(kind, source);
  if (result.ok) throw new Error(`expected ${kind} to be refused`);
  return result.problem;
}

type Keyed = { key: string };
const boxes = (n: number): Keyed[] => Array.from({ length: n }, (_, i) => ({ key: `n${i}` }));
const arrow = (a: number, b: number, label?: string) => ({ from: `n${a}`, to: `n${b}`, label });

function laid(nodes: Keyed[], edges: ReturnType<typeof arrow>[]): LibraryFlowRow<Keyed>[] {
  const result = layoutLibraryFlow(nodes, edges, LIBRARY_FLOW_WIDTH_CAP);
  if (!result.ok) throw new Error(result.problem);
  return [...result.rows];
}

/** Every slot each arrow passes through, followed from its box down its links. */
function trace(rows: LibraryFlowRow<Keyed>[], from: string, to: string): boolean {
  const start = rows.findIndex((r) => r.slots.some((s) => s.node?.key === from));
  const reach = (row: number, slot: number): boolean => {
    if (row >= rows.length - 1) return false;
    return rows[row]!.links.some((l) => {
      if (l.from !== slot) return false;
      const next = rows[row + 1]!.slots[l.to]!;
      return next.node === null ? reach(row + 1, l.to) : next.node.key === to;
    });
  };
  return reach(
    start,
    rows[start]!.slots.findIndex((s) => s.node?.key === from),
  );
}

describe('layoutLibraryFlow', () => {
  it('puts each box one row below the lowest box feeding it', () => {
    // 0 → 1 → 2, and 0 → 2 directly: 2 sits under 1, and 0 → 2 passes row 1.
    const rows = laid(boxes(3), [arrow(0, 1, 'yes'), arrow(1, 2), arrow(0, 2, 'no')]);
    expect(rows.map((r) => r.slots.map((s) => s.node?.key ?? '|'))).toEqual([
      ['n0'],
      ['n1', '|'],
      ['n2'],
    ]);
    // Labels ride on an arrow's first segment only.
    expect(rows[0]!.links).toEqual([
      { from: 0, to: 0, label: 'yes' },
      { from: 0, to: 1, label: 'no' },
    ]);
    expect(rows[1]!.links).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
    expect(rows[2]!.links).toEqual([]);
  });

  it('orders a row by where its feeders sit, so arrows rarely cross', () => {
    // 0 and 1 side by side; 1 feeds 2, 0 feeds 3 — 3 goes left of 2.
    const rows = laid(boxes(4), [arrow(1, 2), arrow(0, 3)]);
    expect(rows[1]!.slots.map((s) => s.node?.key)).toEqual(['n3', 'n2']);
  });

  it.each([
    ['a box named twice', [{ key: 'a' }, { key: 'a' }], [], /two boxes are called "a"/],
    ['an arrow from nowhere', boxes(2), [{ from: 'x', to: 'n0' }], /starts at "x"/],
    ['an arrow to nowhere', boxes(2), [{ from: 'n0', to: 'x' }], /ends at "x"/],
    ['an arrow to itself', boxes(2), [arrow(0, 0)], /to itself/],
    ['two arrows on one pair', boxes(2), [arrow(0, 1), arrow(0, 1)], /two arrows join/],
    ['a loop', boxes(3), [arrow(0, 1), arrow(1, 2), arrow(2, 1)], /cannot loop/],
    [
      'a row wider than a phone',
      boxes(5),
      [arrow(0, 1), arrow(0, 2), arrow(0, 3), arrow(0, 4)],
      /row 2 needs 4 boxes and arrows side by side; a phone fits 3/,
    ],
  ])('refuses %s', (_name, nodes, edges, message) => {
    const result = layoutLibraryFlow(nodes, edges, LIBRARY_FLOW_WIDTH_CAP);
    expect(result.ok ? 'laid out' : result.problem).toMatch(message);
  });

  it('lays out any chart up to the cap with every box once, no shared slot and every arrow traced', () => {
    // A seeded sweep of random top-down charts at the capped size.
    let seed = 1663;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let drawn = 0;
    for (let trial = 0; trial < 400; trial++) {
      const n = 2 + Math.floor(random() * (LIBRARY_FLOW_NODE_CAP - 1));
      const edges: ReturnType<typeof arrow>[] = [];
      for (let b = 1; b < n; b++) {
        const a = Math.floor(random() * b);
        edges.push(arrow(a, b));
        const c = Math.floor(random() * b);
        if (c !== a && random() < 0.3) edges.push(arrow(c, b));
      }
      const result = layoutLibraryFlow(boxes(n), edges, LIBRARY_FLOW_WIDTH_CAP);
      if (!result.ok) {
        expect(result.problem).toMatch(/a phone fits 3/);
        continue;
      }
      drawn++;
      const rows = [...result.rows];
      const keys = rows.flatMap((r) => r.slots.flatMap((s) => (s.node ? [s.node.key] : [])));
      expect(keys.sort()).toEqual(
        boxes(n)
          .map((b) => b.key)
          .sort(),
      );
      for (const [r, row] of rows.entries()) {
        expect(row.slots.length).toBeLessThanOrEqual(LIBRARY_FLOW_WIDTH_CAP);
        for (const link of row.links) {
          expect(link.from).toBeLessThan(row.slots.length);
          expect(link.to).toBeLessThan(rows[r + 1]!.slots.length);
        }
        // A passing arrow has one segment in and one out: it never forks or ends.
        if (r > 0) {
          row.slots.forEach((slot, i) => {
            if (slot.node !== null) return;
            expect(rows[r - 1]!.links.filter((l) => l.to === i)).toHaveLength(1);
            expect(row.links.filter((l) => l.from === i)).toHaveLength(1);
          });
        }
      }
      for (const e of edges) expect(trace(rows, e.from, e.to)).toBe(true);
    }
    // The sweep is live: most charts it builds fit a phone.
    expect(drawn).toBeGreaterThan(200);
  });
});

describe('salt-flow', () => {
  it('names boxes by label unless given an id, and lays them out', () => {
    const block = parsed(
      'flow',
      [
        'nodes:',
        '  - label: Is it set?',
        '    id: set',
        '    tone: primary',
        '  - label: Turn out',
        '  - label: Another 10 minutes',
        'edges:',
        '  - from: set',
        '    to: Turn out',
        '    label: "yes"',
        '  - from: set',
        '    to: Another 10 minutes',
        '    label: "no"',
        'caption: Custard',
      ].join('\n'),
    );
    if (block.kind !== 'flow') throw new Error('unreachable');
    expect(block.data.caption).toBe('Custard');
    expect(block.data.rows[0]!.slots[0]!.node).toEqual({
      key: 'set',
      label: 'Is it set?',
      tone: 'primary',
    });
    expect(block.data.rows[1]!.slots.map((s) => s.node?.label)).toEqual([
      'Turn out',
      'Another 10 minutes',
    ]);
  });

  it('refuses a layout problem as the block’s problem', () => {
    expect(
      problem('flow', 'nodes:\n  - label: a\n  - label: b\nedges:\n  - from: a\n    to: c'),
    ).toMatch(/ends at "c"/);
  });

  it('refuses more boxes than the cap', () => {
    const nodes = Array.from({ length: LIBRARY_FLOW_NODE_CAP + 1 }, (_, i) => `  - label: n${i}`);
    expect(
      problem('flow', `nodes:\n${nodes.join('\n')}\nedges:\n  - from: n0\n    to: n1`),
    ).toMatch(/nodes/);
  });
});

describe('salt-steps', () => {
  it('reads steps with an optional gauge, its scale from 0 unless given', () => {
    const block = parsed(
      'steps',
      [
        'steps:',
        '  - label: Render',
        '    text: Cold pan, gentle heat.',
        '    gauge:',
        '      from: 130',
        '      to: 140',
        '      max: 250',
        '      unit: °',
        '  - text: Rest five minutes.',
        '    gauge:',
        '      at: 5',
        '      min: 1',
        '      max: 10',
        '      tone: sage',
      ].join('\n'),
    );
    if (block.kind !== 'steps') throw new Error('unreachable');
    const [render, rest] = block.data.steps;
    expect(render!.gauge).toMatchObject({
      min: { text: '0', value: 0 },
      max: { value: 250 },
      from: { value: 130 },
      to: { value: 140 },
      unit: '°',
    });
    expect(rest!.label).toBeUndefined();
    expect(rest!.gauge).toMatchObject({ min: { value: 1 }, from: { value: 5 }, tone: 'sage' });
    expect(rest!.gauge!.to).toBeUndefined();
  });

  it.each([
    ['a gauge whose max is not above min', 'min: 5\n        max: 5\n        at: 5', /above `min`/],
    [
      'a value past the gauge',
      'max: 100\n        at: 120',
      /120 is outside the gauge \(0 to 100\)/,
    ],
    [
      'a value below it',
      'min: 10\n        max: 100\n        from: 5\n        to: 20',
      /5 is outside/,
    ],
    ['a gauge with no value', 'max: 100', /needs either `at`/],
  ])('refuses %s', (_name, gauge, message) => {
    expect(
      problem('steps', `steps:\n  - text: a\n  - text: b\n    gauge:\n        ${gauge}`),
    ).toMatch(message);
  });

  it('holds 2 to 12 steps', () => {
    const steps = (n: number) =>
      `steps:\n${Array.from({ length: n }, (_, i) => `  - text: step ${i}`).join('\n')}`;
    expect(parseLibraryBlock('steps', steps(2)).ok).toBe(true);
    expect(parseLibraryBlock('steps', steps(12)).ok).toBe(true);
    expect(parseLibraryBlock('steps', steps(1)).ok).toBe(false);
    expect(parseLibraryBlock('steps', steps(13)).ok).toBe(false);
  });
});

describe('salt-shapes', () => {
  const shape = (fields: string) =>
    `shelves:\n  - items:\n      - label: "740"\n        ${fields.split('\n').join('\n        ')}`;

  it('reads measurements as figures in one unit, mm unless said', () => {
    const block = parsed(
      'shapes',
      [
        'shelves:',
        '  - heading: Mold',
        '    items:',
        '      - label: "742"',
        '        profile: tapered',
        '        mouth: 100',
        '        base: 85.5',
        '        height: 107',
        '        caption: 580 ml',
        '        count: 4',
        '        tone: sage',
      ].join('\n'),
    );
    if (block.kind !== 'shapes') throw new Error('unreachable');
    expect(block.data.unit).toBe('mm');
    expect(block.data.shelves[0]!.items[0]).toMatchObject({
      profile: 'tapered',
      mouth: { text: '100', value: 100 },
      base: { text: '85.5', value: 85.5 },
      height: { value: 107 },
      count: { value: 4 },
    });
  });

  it.each([
    ['straight', 'mouth: 100\nheight: 80\nwidth: 100'],
    ['tapered', 'mouth: 100\nheight: 80\nbase: 80'],
    ['belly', 'mouth: 100\nheight: 80\nwidth: 120\nbase: 90'],
    ['belly', 'mouth: 100\nheight: 80\nwidth: 120'],
    ['rounded', 'mouth: 100\nheight: 80'],
  ])('draws a %s shape from the widths it uses', (profile, fields) => {
    expect(parseLibraryBlock('shapes', shape(`profile: ${profile}\n${fields}`)).ok).toBe(true);
  });

  it.each([
    [
      'a tapered shape with no base',
      'profile: tapered\nmouth: 100\nheight: 80',
      /needs its measured `base`/,
    ],
    [
      'a belly with no width',
      'profile: belly\nmouth: 100\nheight: 80',
      /needs its measured `width`/,
    ],
    [
      'a measurement it would not draw',
      'profile: straight\nmouth: 100\nheight: 80\nbase: 90',
      /not drawn from a `base`/,
    ],
    [
      'a width on a tapered shape',
      'profile: tapered\nmouth: 100\nheight: 80\nbase: 90\nwidth: 99',
      /not drawn from a `width`/,
    ],
    [
      'a belly narrower than its mouth',
      'profile: belly\nmouth: 100\nheight: 80\nwidth: 90',
      /widest point/,
    ],
    [
      'a belly narrower than its base',
      'profile: belly\nmouth: 80\nheight: 80\nwidth: 90\nbase: 95',
      /widest point/,
    ],
    ['a zero height', 'profile: straight\nmouth: 100\nheight: 0', /height: must be above zero/],
    [
      'a measurement with its unit in it',
      'profile: straight\nmouth: 100 mm\nheight: 80',
      /plain number/,
    ],
    ['a part count', 'profile: straight\nmouth: 100\nheight: 80\ncount: 1.5', /whole number/],
    ['an unknown profile', 'profile: square\nmouth: 100\nheight: 80', /profile/],
  ])('refuses %s', (_name, fields, message) => {
    expect(problem('shapes', shape(fields))).toMatch(message);
  });

  it(`holds at most ${LIBRARY_SHAPES_CAP} shapes across its shelves`, () => {
    const shelf = (n: number) =>
      `  - items:\n${Array.from({ length: n }, (_, i) => `      - label: j${i}\n        profile: straight\n        mouth: 100\n        height: 80`).join('\n')}`;
    expect(parseLibraryBlock('shapes', `shelves:\n${shelf(12)}\n${shelf(12)}`).ok).toBe(true);
    expect(problem('shapes', `shelves:\n${shelf(12)}\n${shelf(13)}`)).toMatch(/at most 24/);
  });
});
