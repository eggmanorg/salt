/**
 * Library drawings (issue #1663, Phase 2) — `salt-chart`, `salt-range` and
 * `salt-timeline`. The blocks carry figures and the renderer draws them, so what
 * is pinned here is that a figure is read as the number it means while keeping
 * the text typed, and that each kind's caps and shape rules refuse what a phone
 * could not draw — as a result with a sentence, never a throw.
 */
import { describe, it, expect } from 'vitest';
import {
  LIBRARY_CHART_ITEM_CAP,
  LIBRARY_RANGE_ROW_CAP,
  libraryDayNumber,
  parseLibraryBlock,
  type LibraryBlock,
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

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => `  - label: item ${i}\n    value: ${i + 1}\n`).join('');

describe('salt-chart', () => {
  it('reads each value as the number it means, keeping the text typed', () => {
    const block = parsed(
      'chart',
      'type: column\nunit: ml\nitems:\n  - label: "745"\n    value: 1,062\n  - label: "740"\n    value: 290\n    tone: sage\n',
    );
    if (block.kind !== 'chart') throw new Error('unreachable');
    expect(block.data.type).toBe('column');
    expect(block.data.unit).toBe('ml');
    expect(block.data.items).toEqual([
      { label: '745', value: { text: '1,062', value: 1062 }, tone: undefined },
      { label: '740', value: { text: '290', value: 290 }, tone: 'sage' },
    ]);
  });

  it('is a bar chart when no type is given', () => {
    const block = parsed('chart', `items:\n${items(2)}`);
    expect(block.kind === 'chart' && block.data.type).toBe('bar');
  });

  it.each(Object.entries(LIBRARY_CHART_ITEM_CAP))(
    'a %s chart draws at most %s items',
    (type, cap) => {
      expect(parseLibraryBlock('chart', `type: ${type}\nitems:\n${items(cap)}`).ok).toBe(true);
      expect(problem('chart', `type: ${type}\nitems:\n${items(cap + 1)}`)).toMatch(/at most/);
    },
  );

  it.each([
    ['one item', `items:\n${items(1)}`, /items/],
    [
      'a value that is not a number',
      'items:\n  - label: a\n    value: lots\n  - label: b\n    value: 2',
      /plain number/,
    ],
    [
      'a value with its unit in it',
      'items:\n  - label: a\n    value: 290 ml\n  - label: b\n    value: 2',
      /plain number/,
    ],
    [
      'a value below zero',
      'items:\n  - label: a\n    value: -3\n  - label: b\n    value: 2',
      /from zero/,
    ],
    [
      'a pie of nothing',
      'type: pie\nitems:\n  - label: a\n    value: 0\n  - label: b\n    value: 0',
      /above zero/,
    ],
    ['a type that does not exist', `type: donut\nitems:\n${items(2)}`, /type/],
  ])('refuses %s', (_name, source, message) => {
    expect(problem('chart', source)).toMatch(message);
  });
});

const CONTROL_FREAK_MAP = `unit: °
bands:
  - to: 120
    label: Gentle
    tone: sage
  - from: 120
    to: 170
    label: Steady
    tone: primary
  - from: 170
    label: Fierce
    tone: terracotta
lines:
  - at: 130
    label: Butter browns
groups:
  - heading: Meat and fish
    rows:
      - label: Duck breast
        stages:
          - label: Rendering
            from: 130
            to: 140
          - at: 175
  - heading: Eggs
    rows:
      - label: Poached eggs
        stages:
          - from: 90
            to: 95
`;

describe('salt-range', () => {
  it('reads stages as a value or a range, bands open at a missing edge, and a reference line', () => {
    const block = parsed('range', CONTROL_FREAK_MAP);
    if (block.kind !== 'range') throw new Error('unreachable');
    const duck = block.data.groups[0]!.rows[0]!;
    expect(duck.stages).toEqual([
      {
        label: 'Rendering',
        tone: undefined,
        from: { text: '130', value: 130 },
        to: { text: '140', value: 140 },
      },
      { label: undefined, tone: undefined, from: { text: '175', value: 175 } },
    ]);
    expect(block.data.bands[0]).toEqual({
      to: { text: '120', value: 120 },
      label: 'Gentle',
      tone: 'sage',
    });
    expect(block.data.lines).toEqual([
      { at: { text: '130', value: 130 }, label: 'Butter browns', tone: 'warning' },
    ]);
  });

  it('reads a figure written with thousands separators, or a minus sign, as the number it means', () => {
    const block = parsed(
      'range',
      'groups:\n  - rows:\n      - label: Freezer to jar\n        stages:\n          - from: -18\n            to: 1,062\n',
    );
    if (block.kind !== 'range') throw new Error('unreachable');
    expect(block.data.groups[0]!.rows[0]!.stages[0]).toMatchObject({
      from: { text: '-18', value: -18 },
      to: { text: '1,062', value: 1062 },
    });
  });

  it(`holds at most ${LIBRARY_RANGE_ROW_CAP} rows across all its groups`, () => {
    const group = (n: number) =>
      `  - rows:\n${Array.from({ length: n }, (_, i) => `      - label: r${i}\n        stages:\n          - at: ${i}\n`).join('')}`;
    expect(parseLibraryBlock('range', `groups:\n${group(20)}${group(20)}`).ok).toBe(true);
    expect(problem('range', `groups:\n${group(20)}${group(20)}${group(1)}`)).toMatch(/at most 40/);
  });

  it.each([
    [
      'a value that is not a number',
      'groups:\n  - rows:\n      - label: a\n        stages:\n          - at: lots',
      /plain number/,
    ],
    [
      'a value with its unit in it',
      'groups:\n  - rows:\n      - label: a\n        stages:\n          - at: 130 °C',
      /plain number/,
    ],
    [
      'a stage with both a value and a range',
      'groups:\n  - rows:\n      - label: a\n        stages:\n          - at: 1\n            from: 1\n            to: 2',
      /either `at`/,
    ],
    [
      'a stage with half a range',
      'groups:\n  - rows:\n      - label: a\n        stages:\n          - from: 1',
      /either `at`/,
    ],
    [
      'a range that runs backwards',
      'groups:\n  - rows:\n      - label: a\n        stages:\n          - from: 9\n            to: 2',
      /below `from`/,
    ],
    [
      'a band with no edge',
      'bands:\n  - label: x\n    tone: sage\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 1',
      /band needs/,
    ],
    [
      'an axis that ends below where it starts',
      'min: 9\nmax: 2\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 5',
      /above `min`/,
    ],
    [
      'a figure past the axis end the author set',
      'max: 200\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 250',
      /250 is outside the axis/,
    ],
    [
      'a band that ends where it starts',
      'bands:\n  - from: 5\n    to: 5\n    label: x\n    tone: sage\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 1',
      /must be above `from`/,
    ],
    [
      'a figure below the axis start the author set',
      'min: 100\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 50',
      /50 is outside the axis \(100 to …\)/,
    ],
    [
      'a band with a colour',
      'bands:\n  - to: 1\n    label: x\n    tone: "#00ff00"\ngroups:\n  - rows:\n      - label: a\n        stages:\n          - at: 1',
      /tone/,
    ],
  ])('refuses %s', (_name, source, message) => {
    expect(problem('range', source)).toMatch(message);
  });
});

describe('salt-timeline', () => {
  it('reads elapsed time as figures in its unit, days when none is given', () => {
    const block = parsed(
      'timeline',
      'items:\n  - label: Salt and pack\n    at: 0\n  - label: Ferment\n    from: 0\n    to: 7\n    tone: sage\n',
    );
    if (block.kind !== 'timeline') throw new Error('unreachable');
    expect(block.data.unit).toBe('days');
    expect(block.data.items).toEqual([
      { label: 'Salt and pack', tone: undefined, from: { text: '0', value: 0 } },
      {
        label: 'Ferment',
        tone: 'sage',
        from: { text: '0', value: 0 },
        to: { text: '7', value: 7 },
      },
    ]);
  });

  it('reads calendar dates as day numbers, in UTC', () => {
    const block = parsed(
      'timeline',
      'unit: dates\nitems:\n  - label: Brine\n    from: 2026-10-12\n    to: 2026-10-19\n',
    );
    if (block.kind !== 'timeline') throw new Error('unreachable');
    const item = block.data.items[0]!;
    expect(item.from).toEqual({ text: '2026-10-12', value: libraryDayNumber('2026-10-12') });
    expect(item.to!.value - item.from.value).toBe(7);
  });

  it.each([
    [
      'a date that does not exist',
      'unit: dates\nitems:\n  - label: a\n    at: 2026-02-30',
      /must be a date/,
    ],
    [
      'a number where a date belongs',
      'unit: dates\nitems:\n  - label: a\n    at: 3',
      /must be a date/,
    ],
    ['a date where days belong', 'items:\n  - label: a\n    at: 2026-10-12', /number of days/],
    ['a span that runs backwards', 'items:\n  - label: a\n    from: 7\n    to: 1', /below `from`/],
    ['an item with no time', 'items:\n  - label: a', /either `at`/],
    ['a unit that does not exist', 'unit: fortnights\nitems:\n  - label: a\n    at: 1', /unit/],
  ])('refuses %s', (_name, source, message) => {
    expect(problem('timeline', source)).toMatch(message);
  });

  it('holds at most 16 items', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `  - label: i${i}\n    at: ${i}\n`).join('');
    expect(parseLibraryBlock('timeline', `items:\n${many(16)}`).ok).toBe(true);
    expect(parseLibraryBlock('timeline', `items:\n${many(17)}`).ok).toBe(false);
  });
});

describe('libraryDayNumber', () => {
  it('counts days from 1970-01-01', () => {
    expect(libraryDayNumber('1970-01-01')).toBe(0);
    expect(libraryDayNumber('1970-01-02')).toBe(1);
    expect(libraryDayNumber('2024-03-01')! - libraryDayNumber('2024-02-28')!).toBe(2);
  });

  it('refuses what is not a real date', () => {
    expect(libraryDayNumber('2026-13-01')).toBeNull();
    expect(libraryDayNumber('12 Oct')).toBeNull();
  });
});
