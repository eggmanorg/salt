// spec: ui-spec-v04.md §12.7
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import DocCards from '../src/primitives/DocBlocks/DocCards.svelte';
import DocStats from '../src/primitives/DocBlocks/DocStats.svelte';
import { DOC_TONE_INK, DOC_TONE_TINT } from '../src/primitives/DocBlocks/docTone';
import type { DocTone } from '../src/primitives/DocBlocks/DocBlocks.types';
import DocCalloutFixture from './fixtures/DocCalloutFixture.svelte';

afterEach(() => cleanup());

const TONES: DocTone[] = ['primary', 'sage', 'terracotta', 'warning', 'muted'];

describe('docTone — every tone maps to a token, never a raw colour', () => {
  it.each(TONES)('%s', (tone) => {
    for (const classes of [DOC_TONE_TINT[tone], DOC_TONE_INK[tone]]) {
      expect(classes).toMatch(/\S/);
      // An arbitrary value (`bg-[#…]`) or a palette step (`bg-amber-500`) is a
      // colour no design token names.
      expect(classes).not.toMatch(/\[|#|-\d{2,3}\b/);
    }
  });
});

describe('DocCards', () => {
  const groups = [
    {
      heading: 'Meat and fish',
      cards: [
        {
          title: 'Duck breast',
          arrows: true,
          chips: [
            { label: '130–140°', tone: 'sage' as const },
            { label: '175°', tone: 'terracotta' as const },
          ],
          lines: [{ label: 'Rendering', text: 'Start in a cold pan.' }, { text: 'Then crisp it.' }],
          footnote: 'Carbon steel pan',
        },
        {
          title: 'Fried eggs',
          arrows: false,
          chips: [
            { label: '140°', tone: 'muted' as const },
            { label: '150°', tone: 'muted' as const },
          ],
          lines: [],
        },
      ],
    },
  ];

  it('draws a heading per group and a card per entry, with every line and the footnote', () => {
    const { container, getByRole } = render(DocCards, { props: { groups } });
    expect(getByRole('heading', { name: 'Meat and fish' })).toBeInTheDocument();
    expect(container.textContent).toContain('Duck breast');
    expect(container.textContent).toContain('Rendering');
    expect(container.textContent).toContain('Start in a cold pan.');
    expect(container.textContent).toContain('Then crisp it.');
    expect(container.textContent).toContain('Carbon steel pan');
  });

  it('colours each chip by its tone', () => {
    const { container } = render(DocCards, { props: { groups } });
    const chip = container.querySelector('[data-tone="terracotta"]');
    expect(chip?.textContent).toBe('175°');
    expect(chip?.className).toContain('bg-tertiary-tint');
  });

  it('joins chips with an arrow only when the card says they are stages', () => {
    const { container } = render(DocCards, { props: { groups } });
    const cards = container.querySelectorAll('.bg-card');
    expect(cards[0]!.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('then');
    expect(cards[1]!.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });
});

describe('DocCallout', () => {
  it.each(TONES)('renders the %s tone with its label and body', (tone) => {
    const { container } = render(DocCalloutFixture, {
      props: { tone, label: 'Probe Control', body: 'Read the water.' },
    });
    const aside = container.querySelector('aside');
    expect(aside).toHaveAttribute('data-tone', tone);
    expect(aside?.className).toContain(DOC_TONE_TINT[tone].split(' ')[0]!);
    expect(aside?.textContent).toContain('Probe Control');
    expect(aside?.textContent).toContain('Read the water.');
  });
});

describe('DocStats', () => {
  it('draws one tile per figure, in one row', () => {
    const items = [
      { value: '16', label: 'jars owned', tone: 'sage' as const },
      { value: '3 of 13', label: 'models', tone: 'muted' as const },
      { value: '6.3 L', label: 'capacity', tone: 'primary' as const },
    ];
    const { container } = render(DocStats, { props: { items } });
    const row = container.querySelector('.salt-doc-stats');
    expect(row).toHaveClass('grid-cols-3');
    expect(row?.children).toHaveLength(3);
    expect(row?.textContent).toContain('6.3 L');
    expect(row?.textContent).toContain('jars owned');
  });
});
