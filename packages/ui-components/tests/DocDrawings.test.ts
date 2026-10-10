// spec: ui-spec-v04.md §12.7
//
// The data-drawn document blocks (#1663 Phase 2): DocRangeMap. jsdom lays
// nothing out, so what is asserted is the geometry each mark is GIVEN — its
// percentage along the track — and the text it carries; the arithmetic itself
// is pinned in `docScale.test.ts`.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DocRangeMap from '../src/primitives/DocBlocks/DocRangeMap.svelte';
import { DOC_TONE_BAND, DOC_TONE_RULE, DOC_TONE_SOLID } from '../src/primitives/DocBlocks/docTone';
import type { DocFigure, DocTone } from '../src/primitives/DocBlocks/DocBlocks.types';

afterEach(() => cleanup());

const fig = (value: number, text = String(value)): DocFigure => ({ text, value });
const TONES: DocTone[] = ['primary', 'sage', 'terracotta', 'warning', 'muted'];

describe('drawing tones map to tokens, never a raw colour', () => {
  it.each(TONES)('%s', (tone) => {
    for (const classes of [DOC_TONE_SOLID[tone], DOC_TONE_BAND[tone], DOC_TONE_RULE[tone]]) {
      expect(classes).toMatch(/\S/);
      expect(classes).not.toMatch(/\[|#|-\d{2,3}\b/);
    }
  });
});

const marks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-mark]'));

describe('DocRangeMap', () => {
  const props = {
    unit: '°',
    bands: [
      { to: fig(120), label: 'Gentle', tone: 'sage' as const },
      { from: fig(120), to: fig(170), label: 'Steady', tone: 'primary' as const },
      { from: fig(170), label: 'Fierce', tone: 'terracotta' as const },
    ],
    lines: [{ at: fig(130), label: 'Butter browns', tone: 'warning' as const }],
    groups: [
      {
        heading: 'Meat and fish',
        rows: [
          {
            label: 'Duck breast',
            stages: [{ label: 'Rendering', from: fig(130), to: fig(140) }, { from: fig(175) }],
          },
          { label: 'Stir-fry', stages: [{ from: fig(220), to: fig(250) }] },
        ],
      },
      {
        heading: 'Eggs',
        rows: [{ label: 'Poached eggs', stages: [{ from: fig(90), to: fig(95) }] }],
      },
    ],
    caption: 'Numbered dots are the stages of one task, in order.',
  };

  it('puts every stage at its own place on one axis', () => {
    const { container } = render(DocRangeMap, { props });
    // The axis runs 90–250: 130 is 25% along, 175 is 53.125%.
    const duck = container.querySelector<HTMLElement>('[data-row="Duck breast"]')!;
    const [rendering, crisping] = marks(duck);
    expect(parseFloat(rendering!.style.left)).toBe(25);
    expect(parseFloat(rendering!.style.width)).toBe(6.25);
    expect(parseFloat(crisping!.style.left)).toBeCloseTo(53.125, 6);
    // Ticks are round numbers carrying the unit.
    const ticks = Array.from(container.querySelectorAll('[data-tick]')).map((t) => t.textContent);
    expect(ticks).toEqual(['100°', '150°', '200°', '250°']);
  });

  it('colours a stage by the band holding its top value, and numbers a row’s stages', () => {
    const { container } = render(DocRangeMap, { props });
    const duck = container.querySelector<HTMLElement>('[data-row="Duck breast"]')!;
    expect(marks(duck).map((m) => [m.dataset.tone, m.textContent])).toEqual([
      ['primary', '1'],
      ['terracotta', '2'],
    ]);
    const eggs = container.querySelector<HTMLElement>('[data-row="Poached eggs"]')!;
    expect(marks(eggs).map((m) => [m.dataset.tone, m.textContent])).toEqual([['sage', '']]);
  });

  it('says each row’s stages in words, and keys the bands and the line', () => {
    const { container, getByText } = render(DocRangeMap, { props });
    expect(container.textContent).toContain('Duck breast: Rendering 130–140°, then 175°');
    expect(getByText('Gentle, up to 120°')).toBeInTheDocument();
    expect(getByText('Steady, 120–170°')).toBeInTheDocument();
    expect(getByText('Fierce, over 170°')).toBeInTheDocument();
    expect(getByText('Butter browns, 130°')).toBeInTheDocument();
    expect(container.textContent).toContain('Meat and fish');
    expect(container.textContent).toContain('Numbered dots');
  });

  it('keeps a stage’s own tone, and the axis ends the author set', () => {
    const { container } = render(DocRangeMap, {
      props: {
        unit: 'g',
        min: fig(0),
        max: fig(300),
        bands: [],
        lines: [],
        groups: [
          {
            rows: [
              { label: 'Oven', stages: [{ from: fig(150), tone: 'warning' as const }] },
              { label: 'Grill', stages: [{ from: fig(250) }] },
            ],
          },
        ],
      },
    });
    const [oven] = marks(container);
    expect(oven!.dataset.tone).toBe('warning');
    // No tone and no band: the drawing's own tone.
    expect(marks(container)[1]!.dataset.tone).toBe('primary');
    expect(parseFloat(oven!.style.left)).toBe(50);
    // A word unit is said once, not on every tick.
    const ticks = Array.from(container.querySelectorAll('[data-tick]')).map((t) => t.textContent);
    expect(ticks).toEqual(['0', '100', '200', '300']);
    expect(container.textContent).toContain('Oven: 150 g');
  });

  it('redraws when a figure changes', async () => {
    const { container, rerender } = render(DocRangeMap, { props });
    const left = () =>
      parseFloat(
        marks(container.querySelector<HTMLElement>('[data-row="Stir-fry"]')!)[0]!.style.left,
      );
    expect(left()).toBe(81.25);
    const groups = structuredClone(props.groups);
    groups[0]!.rows[1]!.stages[0]!.from = fig(170);
    await rerender({ ...props, groups });
    expect(left()).toBe(50);
  });
});
