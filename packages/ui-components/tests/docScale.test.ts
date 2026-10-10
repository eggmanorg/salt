// spec: ui-spec-v04.md §12.7
//
// The arithmetic the data-drawn library blocks (#1663 Phase 2) are drawn by.
// "Drawn to one scale" is pinned here: a value maps to its own place on the
// axis, and the ticks chosen fit a phone.
import { describe, it, expect } from 'vitest';
import {
  DOC_AXIS_MAX_TICKS,
  DOC_TICK_CHAR_PX,
  axisFor,
  axisPercent,
  axisTrackPx,
  bandToneAt,
  formatTick,
  withUnit,
} from '../src/primitives/DocBlocks/docScale';

describe('axisPercent — a value maps to its axis position', () => {
  it('places a value in proportion between the ends', () => {
    // The mock-up's map: 90–250 °C. 130 is a quarter of the way along.
    expect(axisPercent(130, 90, 250)).toBe(25);
    expect(axisPercent(90, 90, 250)).toBe(0);
    expect(axisPercent(250, 90, 250)).toBe(100);
    expect(axisPercent(170, 90, 250)).toBe(50);
  });

  it('keeps the scale linear: equal steps in value are equal steps on the axis', () => {
    const a = axisPercent(100, 90, 250);
    const b = axisPercent(150, 90, 250);
    const c = axisPercent(200, 90, 250);
    expect(b - a).toBeCloseTo(c - b, 10);
  });

  it('holds a value past an end at the end, and an empty axis at zero', () => {
    expect(axisPercent(300, 90, 250)).toBe(100);
    expect(axisPercent(10, 90, 250)).toBe(0);
    expect(axisPercent(5, 5, 5)).toBe(0);
  });
});

describe('axisFor', () => {
  it('runs from the lowest figure to the highest, with round ticks inside', () => {
    // The Control Freak page's figures: 90 (poached eggs) to 250 (stir-fry).
    expect(axisFor([90, 95, 130, 175, 250])).toEqual({
      min: 90,
      max: 250,
      ticks: [100, 150, 200, 250],
    });
  });

  it('keeps the ends the author fixed', () => {
    const axis = axisFor([100, 150], { min: 0, max: 300 });
    expect([axis.min, axis.max]).toEqual([0, 300]);
    expect(axis.ticks).toEqual([0, 100, 200, 300]);
  });

  it(`never draws more than ${DOC_AXIS_MAX_TICKS} ticks`, () => {
    for (const [lo, hi] of [
      [0, 1],
      [0, 7],
      [3, 997],
      [-18, 250],
      [0.1, 0.35],
      [0, 10_000],
    ] as const) {
      expect(axisFor([lo, hi]).ticks.length).toBeLessThanOrEqual(DOC_AXIS_MAX_TICKS);
      expect(axisFor([lo, hi]).ticks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the round step that fits best when none leaves room for the labels', () => {
    const axis = axisFor([0, 1000], { label: () => 'a label far too long for any gap' });
    expect(axis.ticks).toEqual([0, 1000]);
  });

  it('falls back to the axis ends when no round step gives two ticks inside it', () => {
    // Steps of 2 give five ticks (too many); steps of 5 give one (10).
    expect(axisFor([5.5, 14.5]).ticks).toEqual([5.5, 14.5]);
  });

  it('gives a single value room either side', () => {
    expect(axisFor([5])).toMatchObject({ min: 4, max: 6 });
  });

  it('prints decimal ticks without float noise', () => {
    expect(axisFor([0.1, 0.4]).ticks).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('bandToneAt', () => {
  const bands = [
    { to: { value: 120 }, tone: 'sage' as const },
    { from: { value: 120 }, to: { value: 170 }, tone: 'primary' as const },
    { from: { value: 170 }, tone: 'terracotta' as const },
  ];

  it('reads a band as holding its top edge and not its bottom one', () => {
    expect(bandToneAt(95, bands)).toBe('sage');
    expect(bandToneAt(120, bands)).toBe('sage');
    expect(bandToneAt(121, bands)).toBe('primary');
    expect(bandToneAt(170, bands)).toBe('primary');
    expect(bandToneAt(175, bands)).toBe('terracotta');
  });

  it('is undefined where no band reaches', () => {
    expect(bandToneAt(50, [{ from: { value: 100 }, tone: 'sage' }])).toBeUndefined();
  });
});

describe('labels', () => {
  it('sets a symbol against its number and a word after a space', () => {
    expect(withUnit('130', '°')).toBe('130°');
    expect(withUnit('40', '%')).toBe('40%');
    expect(withUnit('290', 'ml')).toBe('290 ml');
    expect(withUnit('290', undefined)).toBe('290');
  });

  it('groups thousands on a tick', () => {
    expect(formatTick(10000)).toBe('10,000');
    expect(formatTick(0.25)).toBe('0.25');
  });
});

describe('the axis at a phone’s width', () => {
  // Arithmetic over the layout's own constants (see `axisTrackPx`), not a
  // browser measurement — jsdom lays nothing out. What it pins is that the
  // ticks `axisFor` chooses never put two labels on top of each other at the
  // household's phone widths.
  const AXES: { name: string; values: number[]; label: (t: number) => string }[] = [
    { name: 'the temperature map', values: [90, 250], label: (t) => withUnit(formatTick(t), '°') },
    {
      name: 'a freezer to a fryer',
      values: [-18, 250],
      label: (t) => withUnit(formatTick(t), '°'),
    },
    { name: 'large figures', values: [0, 10_000], label: formatTick },
    { name: 'fractions', values: [0.1, 0.35], label: formatTick },
  ];

  it.each([360, 412])('leaves room between neighbouring tick labels at %ipx', (width) => {
    const track = axisTrackPx(width);
    for (const { values, label } of AXES) {
      const axis = axisFor(values, { label });
      const span = axis.max - axis.min;
      for (let i = 1; i < axis.ticks.length; i++) {
        const gap = ((axis.ticks[i]! - axis.ticks[i - 1]!) / span) * track;
        const need = Math.max(label(axis.ticks[i]!).length, label(axis.ticks[i - 1]!).length);
        expect(gap).toBeGreaterThanOrEqual(need * DOC_TICK_CHAR_PX);
      }
      expect(axis.ticks.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives the plot most of a 360px phone, and more at 412px', () => {
    expect(axisTrackPx(360)).toBeGreaterThan(150);
    expect(axisTrackPx(412)).toBeGreaterThan(axisTrackPx(360));
  });

  it('takes fewer ticks when the labels are long', () => {
    const short = axisFor([0, 1000], { label: (t) => String(t) });
    const long = axisFor([0, 1000], { label: (t) => `${t} millilitres` });
    expect(long.ticks.length).toBeLessThan(short.ticks.length);
  });
});
