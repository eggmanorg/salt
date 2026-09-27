import { describe, it, expect } from 'vitest';
import { formatCountdown, formatMinutes } from '../src/lib/durationDisplay.js';

/**
 * The app's one duration vocabulary (issues #878, #933).
 *
 * This file began as issue #933 Phase 1's characterisation net over
 * `lib/durationDisplay.ts`'s copy, which had no test file at all — which is how
 * it came to disagree with the recipe page's copy for months without anything in
 * CI noticing. Phase 3 retired that body in favour of the recipe page's, deleted
 * `routes/recipes/recipeDuration.ts`, and folded its suite in here.
 *
 * The three rows that flipped are marked EXCEPTION 1 below, and they are the
 * whole of the permitted behaviour change: the spelling `h` → `hr`, and the three
 * defects that came from splitting hours off the RAW input instead of rounding
 * first. Nothing else in this file moved between the two implementations.
 */

describe('formatMinutes — the vocabulary', () => {
  const cases = [
    { name: 'a single minute', minutes: 1, rendered: '1 min' },
    { name: 'the middle of the sub-hour range', minutes: 40, rendered: '40 min' },
    { name: 'the last minute before the hour', minutes: 59, rendered: '59 min' },
    // EXCEPTION 1 — every row from here down read `h` before Phase 3.
    { name: 'the hour itself', minutes: 60, rendered: '1 hr' },
    { name: 'one minute past the hour', minutes: 61, rendered: '1 hr 1 min' },
    { name: 'an hour and a quarter', minutes: 75, rendered: '1 hr 15 min' },
    {
      name: 'the 90-minute bake the two copies used to disagree about',
      minutes: 90,
      rendered: '1 hr 30 min',
    },
    { name: 'a whole number of hours drops the minutes', minutes: 120, rendered: '2 hr' },
    { name: 'two hours and a quarter', minutes: 135, rendered: '2 hr 15 min' },
    { name: 'a six-hour prove', minutes: 360, rendered: '6 hr' },
    { name: 'a full day stays in hours', minutes: 1440, rendered: '24 hr' },
    { name: 'past a day, still hours', minutes: 1500, rendered: '25 hr' },
    { name: 'a 36-hour cure is not 1 day 12 hr', minutes: 2160, rendered: '36 hr' },
  ];

  it.each(cases)('$name — $minutes → $rendered', ({ minutes, rendered }) => {
    expect(formatMinutes(minutes)).toBe(rendered);
  });

  it('never displays a duration over 90 minutes in minutes (issue #878)', () => {
    for (let m = 91; m <= 3000; m += 1) {
      expect(formatMinutes(m)).toMatch(/^\d+ hr( \d+ min)?$/);
    }
  });

  it('switches to hours at the hour, and only at the hour', () => {
    expect(formatMinutes(59)).toBe('59 min');
    expect(formatMinutes(60)).toBe('1 hr');
    expect(formatMinutes(61)).toBe('1 hr 1 min');
  });
});

// ── The three defects Phase 3 removed (EXCEPTION 1) ──────────────────────────
//
// All three came from ONE ordering choice in the retired copy: it took
// `Math.floor(m / 60)` and `Math.round(m % 60)` on the RAW input, where this
// implementation rounds to a whole minute first and then guards. The old answers
// are named in each case so the change stays legible after the copy is gone.
describe('formatMinutes — rounds before it splits', () => {
  it('switches units at a value that rounds up to the hour — 59.6 is 1 hr', () => {
    // The retired copy rendered '60 min': `Math.floor(59.6 / 60)` is 0, so its
    // hour branch was never reached and the remainder rounded up to a full 60.
    expect(formatMinutes(59.6)).toBe('1 hr');
  });

  it('clamps a non-finite duration rather than rendering arithmetic on it', () => {
    // The retired copy rendered 'NaN h NaN min' and 'Infinity h NaN min'. The
    // schema types these as `number`, so an imported recipe could reach them.
    expect(formatMinutes(Number.NaN)).toBe('0 min');
    expect(formatMinutes(Number.POSITIVE_INFINITY)).toBe('0 min');
    expect(formatMinutes(Number.NEGATIVE_INFINITY)).toBe('0 min');
  });

  it('clamps a negative duration instead of counting backwards', () => {
    // The retired copy rendered '-1 h -5 min' for -5 and '-1 h' for -0.5:
    // `Math.floor(-5 / 60)` is -1, so a small negative read as an hour and a bit,
    // in the wrong direction.
    expect(formatMinutes(-5)).toBe('0 min');
    expect(formatMinutes(-0.5)).toBe('0 min');
    expect(formatMinutes(0)).toBe('0 min');
  });
});

// ── What did NOT change when the two copies became one ───────────────────────
describe('formatMinutes — behaviour both implementations always shared', () => {
  it('rounds a fraction below the hour to the nearest minute', () => {
    expect(formatMinutes(40.4)).toBe('40 min');
  });

  it('rounds the leftover minutes of an over-the-hour fraction', () => {
    expect(formatMinutes(90.5)).toBe('1 hr 31 min');
  });
});

/**
 * A running timer (#1621): `mm:ss` under an hour, the vocabulary above at an hour
 * and over. Both forms are pinned at every boundary — the switch sits on the
 * CEILed second, and the minutes over it are CEILed, so the display never shows
 * less time than is left.
 */
describe('formatCountdown — mm:ss under an hour, words at and over it', () => {
  const cases = [
    { name: 'zero', ms: 0, full: '0:00', compact: '0:00' },
    {
      name: 'a 40-minute timer, as it always read',
      ms: 2_400_000,
      full: '40:00',
      compact: '40:00',
    },
    {
      name: 'a hair under 59:59 still reads 59:59',
      ms: 3_598_500,
      full: '59:59',
      compact: '59:59',
    },
    { name: 'the last second before the hour', ms: 3_599_000, full: '59:59', compact: '59:59' },
    { name: 'the hour itself', ms: 3_600_000, full: '1 hr', compact: '1h' },
    { name: 'a millisecond past the hour', ms: 3_600_001, full: '1 hr 1 min', compact: '1h 1m' },
    { name: 'a second past the hour', ms: 3_601_000, full: '1 hr 1 min', compact: '1h 1m' },
    { name: 'exactly 61 minutes', ms: 3_660_000, full: '1 hr 1 min', compact: '1h 1m' },
    { name: 'a second past 61 minutes', ms: 3_661_000, full: '1 hr 2 min', compact: '1h 2m' },
    { name: 'a 2-hour timer just started', ms: 7_199_900, full: '2 hr', compact: '2h' },
    { name: 'a 2½-hour braise', ms: 9_000_000, full: '2 hr 30 min', compact: '2h 30m' },
    { name: 'negative clamps to 0:00', ms: -5_000, full: '0:00', compact: '0:00' },
    { name: 'NaN reads 0:00', ms: Number.NaN, full: '0:00', compact: '0:00' },
    { name: 'Infinity reads 0:00', ms: Number.POSITIVE_INFINITY, full: '0:00', compact: '0:00' },
  ];

  it.each(cases)('$name → $full', ({ ms, full }) => {
    expect(formatCountdown(ms)).toBe(full);
    expect(formatCountdown(ms, 'full')).toBe(full);
  });

  it.each(cases)('$name → $compact (compact)', ({ ms, compact }) => {
    expect(formatCountdown(ms, 'compact')).toBe(compact);
  });

  it('ticks from 2 hr to 1 hr 59 min once a whole minute has gone', () => {
    expect(formatCountdown(7_140_001)).toBe('2 hr');
    expect(formatCountdown(7_140_000)).toBe('1 hr 59 min');
  });
});
