/**
 * Library drawings (issue #1663, Phase 2) — `salt-range`. The block carries
 * figures and the renderer draws them, so what is pinned here is that a figure
 * is read as the number it means while keeping the text typed, and that the
 * kind's caps and shape rules refuse what a phone could not draw — as a result
 * with a sentence, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { LIBRARY_RANGE_ROW_CAP, parseLibraryBlock, type LibraryBlock } from '@salt/domain/schemas';

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
