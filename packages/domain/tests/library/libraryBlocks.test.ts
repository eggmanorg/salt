/**
 * Library blocks (issue #1663) — `salt-<kind>` YAML inside a page body.
 *
 * Two claims here are Rule 12 obligations rather than coverage:
 *
 *  1. COLOUR IS A TONE, NEVER A VALUE. No schema has a field that takes a colour,
 *     a class or a style; the walk below goes red the moment one is added.
 *  2. A BROKEN BLOCK IS A RESULT, NEVER A THROW. Bad YAML, an unknown kind and a
 *     refused shape all come back as `{ ok: false }` with a sentence to show.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  LIBRARY_BLOCK_KINDS,
  LIBRARY_TONES,
  LibraryCalloutBlockSchema,
  LibraryCardsBlockSchema,
  LibraryChartBlockSchema,
  LibraryRangeBlockSchema,
  LibraryStatsBlockSchema,
  LibraryTimelineBlockSchema,
  parseLibraryBlock,
} from '@salt/domain/schemas';

const CONTROL_FREAK_CARDS = `groups:
  - heading: Meat and fish
    cards:
      - title: Duck breast
        arrows: true
        chips:
          - label: 130–140°
            tone: sage
          - label: 175°
            tone: terracotta
        lines:
          - label: Rendering
            text: Start in a cold pan. Very gentle heat to render the fat cap.
          - Once the fat is mostly rendered, increase heat to crisp the skin.
        footnote: Carbon steel or cast iron frying pan
`;

describe('parseLibraryBlock — cards', () => {
  it('reads grouped cards with toned chips, arrows, lines and a footnote', () => {
    const parsed = parseLibraryBlock('cards', CONTROL_FREAK_CARDS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.block.kind !== 'cards') throw new Error('unreachable');
    const card = parsed.block.data.groups[0]!.cards[0]!;
    expect(parsed.block.data.groups[0]!.heading).toBe('Meat and fish');
    expect(card.arrows).toBe(true);
    expect(card.chips).toEqual([
      { label: '130–140°', tone: 'sage' },
      { label: '175°', tone: 'terracotta' },
    ]);
    expect(card.lines).toEqual([
      { label: 'Rendering', text: 'Start in a cold pan. Very gentle heat to render the fat cap.' },
      {
        label: undefined,
        text: 'Once the fat is mostly rendered, increase heat to crisp the skin.',
      },
    ]);
    expect(card.footnote).toBe('Carbon steel or cast iron frying pan');
  });

  it('defaults a chip to muted, arrows to off, and lines and chips to none', () => {
    const parsed = parseLibraryBlock(
      'cards',
      'groups:\n  - cards:\n      - title: Fried eggs\n        chips:\n          - label: 140°\n',
    );
    if (!parsed.ok || parsed.block.kind !== 'cards') throw new Error(JSON.stringify(parsed));
    const card = parsed.block.data.groups[0]!.cards[0]!;
    expect(card).toEqual({
      title: 'Fried eggs',
      chips: [{ label: '140°', tone: 'muted' }],
      arrows: false,
      lines: [],
    });
  });

  it('keeps every scalar as the string the author typed (failsafe YAML)', () => {
    // Under YAML's default schema `0.50` becomes the number 0.5 and `no` becomes
    // false; what a person types into a block on their phone is what shows.
    const parsed = parseLibraryBlock(
      'stats',
      'items:\n  - value: 0.50\n    label: no\n  - value: 16\n    label: jars',
    );
    if (!parsed.ok || parsed.block.kind !== 'stats') throw new Error(JSON.stringify(parsed));
    expect(parsed.block.data.items.map((i) => [i.value, i.label])).toEqual([
      ['0.50', 'no'],
      ['16', 'jars'],
    ]);
  });
});

describe('parseLibraryBlock — callout and stats', () => {
  it('reads a callout with a tone, label and body', () => {
    expect(
      parseLibraryBlock(
        'callout',
        'tone: warning\nlabel: Probe Control\nbody: Poached eggs read the water, not the pan.',
      ),
    ).toEqual({
      ok: true,
      block: {
        kind: 'callout',
        data: {
          tone: 'warning',
          label: 'Probe Control',
          body: 'Poached eggs read the water, not the pan.',
        },
      },
    });
  });

  it('reads 2–4 stat tiles and refuses one or five', () => {
    const tile = (n: number) => `  - value: "${n}"\n    label: thing ${n}\n`;
    const tiles = (n: number) => `items:\n${Array.from({ length: n }, (_, i) => tile(i)).join('')}`;
    expect(parseLibraryBlock('stats', tiles(2)).ok).toBe(true);
    expect(parseLibraryBlock('stats', tiles(4)).ok).toBe(true);
    expect(parseLibraryBlock('stats', tiles(1)).ok).toBe(false);
    expect(parseLibraryBlock('stats', tiles(5)).ok).toBe(false);
  });

  it.each(LIBRARY_TONES)('accepts the %s tone on every toned field', (tone) => {
    expect(parseLibraryBlock('callout', `tone: ${tone}\nbody: x`).ok).toBe(true);
    expect(
      parseLibraryBlock(
        'stats',
        `items:\n  - value: "1"\n    label: a\n    tone: ${tone}\n  - value: "2"\n    label: b`,
      ).ok,
    ).toBe(true);
    expect(
      parseLibraryBlock(
        'cards',
        `groups:\n  - cards:\n      - title: t\n        chips:\n          - label: c\n            tone: ${tone}`,
      ).ok,
    ).toBe(true);
  });
});

describe('parseLibraryBlock — a broken block is a result, never a throw', () => {
  it.each([
    ['an unknown kind', 'sketch', 'items: []', /no "sketch" drawing/],
    ['YAML that does not parse', 'callout', 'body: [unclosed', /could not be read/],
    ['a colour that is not a tone', 'callout', 'tone: "#ff0000"\nbody: x', /tone/],
    ['a field no schema has', 'callout', 'body: x\nstyle: "color: red"', /style|Unrecognized/],
    ['a missing required field', 'cards', 'groups:\n  - cards:\n      - chips: []', /title/],
    ['an empty block', 'stats', '', /./],
  ])('%s', (_name, kind, source, problem) => {
    const parsed = parseLibraryBlock(kind, source);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toMatch(problem);
  });
});

describe('colour is a tone, never a value', () => {
  // Every key reachable from each block schema, by walking the Zod tree. A
  // colour, class or style field — under any of the names it would plausibly be
  // given — fails here before it can reach a renderer.
  function keysOf(schema: z.ZodTypeAny, into: Set<string>): Set<string> {
    const def = schema._def as Record<string, unknown>;
    if (schema instanceof z.ZodObject) {
      for (const [k, v] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
        into.add(k);
        keysOf(v, into);
      }
    } else if (schema instanceof z.ZodArray) keysOf(schema.element as z.ZodTypeAny, into);
    else if (schema instanceof z.ZodUnion)
      for (const o of schema.options as z.ZodTypeAny[]) keysOf(o, into);
    else if (def.innerType) keysOf(def.innerType as z.ZodTypeAny, into);
    else if (def.schema) keysOf(def.schema as z.ZodTypeAny, into);
    return into;
  }

  const SCHEMAS = {
    cards: LibraryCardsBlockSchema,
    callout: LibraryCalloutBlockSchema,
    stats: LibraryStatsBlockSchema,
    chart: LibraryChartBlockSchema,
    range: LibraryRangeBlockSchema,
    timeline: LibraryTimelineBlockSchema,
  };

  it('covers every kind there is', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...LIBRARY_BLOCK_KINDS].sort());
  });

  it.each(Object.entries(SCHEMAS))('%s has no colour, class or style field', (_kind, schema) => {
    const keys = keysOf(schema, new Set());
    // The walk is live: it reaches nested fields, so an empty set is not a pass.
    expect(keys.size).toBeGreaterThan(1);
    for (const key of keys) {
      expect(key).not.toMatch(/colou?r|fill|stroke|style|class|hex|rgb|hsl|background/i);
    }
  });
});
