// spec: ui-spec-v04.md §12.7
//
// The flow chart, steps and shape shelf (#1663 Phase 4). jsdom lays nothing
// out, so what is asserted is the geometry each mark is GIVEN — a slot's grid
// column, an arrow's ends, a shape's drawn size — and the text it carries; the
// arithmetic is pinned in `docDiagram.test.ts`.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DocFlowChart from '../src/primitives/DocBlocks/DocFlowChart.svelte';
import DocShapes from '../src/primitives/DocBlocks/DocShapes.svelte';
import DocSteps from '../src/primitives/DocBlocks/DocSteps.svelte';
import { DOC_TONE_SHAPE } from '../src/primitives/DocBlocks/docTone';
import type { DocFigure, DocTone } from '../src/primitives/DocBlocks/DocBlocks.types';

afterEach(() => cleanup());

const fig = (value: number, text = String(value)): DocFigure => ({ text, value });

describe('shape tones map to tokens, never a raw colour', () => {
  it.each(['primary', 'sage', 'terracotta', 'warning', 'muted'] as DocTone[])('%s', (tone) => {
    expect(DOC_TONE_SHAPE[tone]).toMatch(/^fill-\S+ stroke-\S+$/);
    expect(DOC_TONE_SHAPE[tone]).not.toMatch(/\[|#|-\d{2,3}\b/);
  });
});

describe('DocFlowChart', () => {
  // Is it set? → (yes) Turn out; (no) Another 10 minutes → Turn out, drawn as
  // the domain layout hands it over: three rows, a pass in the middle one.
  const rows = [
    {
      slots: [{ node: { label: 'Is it set?', tone: 'primary' as const } }],
      links: [
        { from: 0, to: 0, label: 'no' },
        { from: 0, to: 1, label: 'yes' },
      ],
    },
    {
      slots: [{ node: { label: 'Another 10 minutes' } }, { node: null }],
      links: [
        { from: 0, to: 0 },
        { from: 1, to: 0 },
      ],
    },
    { slots: [{ node: { label: 'Turn out' } }], links: [] },
  ];

  it('places each slot on the grid and draws each arrow between slot centres', () => {
    const { container } = render(DocFlowChart, { props: { rows, caption: 'Custard' } });
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-node]'));
    expect(nodes.map((n) => n.textContent?.trim())).toEqual([
      'Is it set?',
      'Another 10 minutes',
      'Turn out',
    ]);
    // Two columns wide (the middle row); a lone box is centred across them.
    expect(nodes[0]!.parentElement!.style.gridColumn).toBe('2 / span 2');
    expect(nodes[1]!.parentElement!.style.gridColumn).toBe('1 / span 2');
    expect(container.querySelector<HTMLElement>('[data-pass]')!.style.gridColumn).toBe(
      '3 / span 2',
    );
    // Only the boxes below the first carry an arrowhead.
    expect(nodes.map((n) => n.querySelector('svg') !== null)).toEqual([false, true, true]);
    expect(nodes[0]!.dataset.tone).toBe('primary');
    expect(nodes[1]!.dataset.tone).toBeUndefined();

    const links = Array.from(container.querySelectorAll('[data-link]')).map((l) =>
      ['x1', 'x2'].map((a) => Number(l.getAttribute(a))),
    );
    expect(links).toEqual([
      [50, 25],
      [50, 75],
      [25, 50],
      [75, 50],
    ]);
    // A label sits 60% down its segment: 50 → 25 puts "no" at 35%.
    const labels = Array.from(container.querySelectorAll<HTMLElement>('span.absolute'));
    expect(labels.map((l) => [l.textContent, l.style.left])).toEqual([
      ['no', '35%'],
      ['yes', '65%'],
    ]);
    expect(container.textContent).toContain('Custard');
  });

  it('draws no strip under the last row and no caption when none is given', () => {
    const { container } = render(DocFlowChart, { props: { rows: rows.slice(2) } });
    expect(container.querySelectorAll('[data-link]')).toHaveLength(0);
    expect(container.querySelector('.mt-2')).toBeNull();
  });
});

describe('DocSteps', () => {
  it('numbers the steps and marks each gauge’s value to its own scale', () => {
    const { container, getAllByRole } = render(DocSteps, {
      props: {
        steps: [
          {
            label: 'Render',
            text: 'Cold pan, gentle heat.',
            gauge: { min: fig(0), max: fig(200), from: fig(130), to: fig(140), unit: '°' },
          },
          {
            text: 'Rest.',
            gauge: { min: fig(0), max: fig(10), from: fig(5), tone: 'sage' as const },
          },
          { text: 'Slice.' },
        ],
        caption: 'Duck',
      },
    });
    expect(getAllByRole('listitem').map((li) => li.textContent?.trim().slice(0, 1))).toEqual([
      '1',
      '2',
      '3',
    ]);
    const marks = Array.from(container.querySelectorAll<HTMLElement>('[data-mark]'));
    expect(marks.map((m) => m.style.left)).toEqual(['65%', '50%']);
    expect(marks[0]!.style.width).toBe('calc(5% + 0.75rem)');
    expect(marks[1]!.style.width).toBe('calc(0% + 0.75rem)');
    expect(marks.map((m) => m.dataset.tone)).toEqual(['primary', 'sage']);
    const gauges = Array.from(container.querySelectorAll('[data-gauge]'));
    expect(gauges[0]!.textContent).toContain('130–140°');
    expect(gauges[0]!.textContent).toContain('200°');
    expect(gauges[1]!.textContent).toContain('5');
    expect(container.textContent).toContain('Render');
    expect(container.textContent).toContain('Duck');
  });

  it('draws steps with no caption', () => {
    const { container } = render(DocSteps, {
      props: { steps: [{ text: 'a' }, { text: 'b' }] },
    });
    expect(container.textContent).not.toContain('undefined');
    expect(container.querySelectorAll('[data-gauge]')).toHaveLength(0);
  });
});

describe('DocShapes', () => {
  const shelves = [
    {
      heading: 'Mold',
      items: [
        {
          label: '740',
          profile: 'tapered' as const,
          mouth: fig(100),
          base: fig(85),
          height: fig(75),
          caption: '290 ml',
          count: fig(6),
          tone: 'sage' as const,
        },
        {
          label: '743',
          profile: 'tapered' as const,
          mouth: fig(100),
          base: fig(85),
          height: fig(150),
        },
      ],
    },
    {
      items: [
        {
          label: '738',
          profile: 'belly' as const,
          mouth: fig(100),
          width: fig(130),
          height: fig(300),
        },
        {
          label: '905',
          profile: 'straight' as const,
          mouth: fig(100),
          height: fig(75),
          count: fig(2),
        },
      ],
    },
  ];

  it('draws every shape to one scale, owned ones filled and counted', () => {
    const { container } = render(DocShapes, { props: { unit: 'mm', shelves, caption: 'RR100' } });
    const svgs = Array.from(container.querySelectorAll<SVGElement>('svg'));
    const heights = svgs.map((s) => parseFloat(s.style.height));
    // The tallest at the full height, and the two 75 mm jars — on different
    // shelves — the same height, half the 150 mm one.
    expect(heights[2]).toBeCloseTo(144, 9);
    expect(heights[0]).toBe(heights[3]);
    expect(heights[1]).toBeCloseTo(2 * heights[0]!, 9);
    expect(parseFloat(svgs[2]!.style.width) / heights[2]!).toBeCloseTo(130 / 300, 9);
    expect(svgs[0]!.getAttribute('aria-label')).toBe('740, 75 mm tall, 100 mm across the mouth');

    const paths = Array.from(container.querySelectorAll<SVGPathElement>('path'));
    expect(paths.map((p) => p.dataset.tone)).toEqual(['sage', undefined, undefined, undefined]);
    expect(paths[1]!.getAttribute('class')).toContain('fill-none');
    const counts = Array.from(container.querySelectorAll('[data-count]'));
    expect(counts.map((c) => c.textContent)).toEqual(['×6', '×2']);
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(container.textContent).toContain('290 ml');
    expect(container.textContent).toContain('Drawn to scale, in mm. RR100');
  });

  it('says it is drawn to scale even with no caption', () => {
    const { container } = render(DocShapes, { props: { unit: 'cm', shelves: shelves.slice(1) } });
    expect(container.textContent?.trim().endsWith('Drawn to scale, in cm')).toBe(true);
  });
});
