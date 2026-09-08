import { describe, it, expect } from 'vitest';
import { placeReachesTemperature } from '../../src/index.js';

// The one piece of degree-handling this epic allows (issue #1286): a comparison
// over two intervals that produces a note on the bake sheet. These tests exist to
// pin the CLAIM the function's header makes — CONTAINMENT, not overlap — because
// that is the sentence a reader would otherwise have to take on trust (CLAUDE.md
// rule 12).

const PROOFER = { minCelsius: 20, maxCelsius: 30 };
const FRIDGE = { minCelsius: 2, maxCelsius: 8 };

describe('placeReachesTemperature', () => {
  it('holds a fixed figure inside its range', () => {
    expect(placeReachesTemperature(PROOFER, { kind: 'fixed', celsius: 24 })).toBe(true);
  });

  it('does not hold a fixed figure outside it', () => {
    expect(placeReachesTemperature(FRIDGE, { kind: 'fixed', celsius: 24 })).toBe(false);
  });

  it('counts both ends as reachable', () => {
    expect(placeReachesTemperature(FRIDGE, { kind: 'fixed', celsius: 2 })).toBe(true);
    expect(placeReachesTemperature(FRIDGE, { kind: 'fixed', celsius: 8 })).toBe(true);
  });

  it('holds a range it covers entirely', () => {
    expect(
      placeReachesTemperature(PROOFER, { kind: 'range', minCelsius: 22, maxCelsius: 26 }),
    ).toBe(true);
  });

  it('does NOT hold a range it only partly covers — the claim, stated', () => {
    // A chamber running 24–30 can hit 24, 25 and 26 but not 22 or 23. Containment
    // says no, and that is deliberate: the answer is information and never a gate,
    // so the cost of saying "this only covers part of it" is a sentence, while the
    // cost of staying quiet is a prove that sat too warm.
    expect(
      placeReachesTemperature(
        { minCelsius: 24, maxCelsius: 30 },
        { kind: 'range', minCelsius: 22, maxCelsius: 26 },
      ),
    ).toBe(false);
  });

  it('does not hold a range wholly outside it', () => {
    expect(placeReachesTemperature(FRIDGE, { kind: 'range', minCelsius: 22, maxCelsius: 26 })).toBe(
      false,
    );
  });

  it('reads a transposed pair at its widest rather than refusing', () => {
    // The manifest carries no refine that would fail a whole equipment list over
    // one pair typed the wrong way round, so this reads 30–20 as 20–30 — and the
    // same for a stage's own range.
    expect(
      placeReachesTemperature(
        { minCelsius: 30, maxCelsius: 20 },
        { kind: 'range', maxCelsius: 22, minCelsius: 26 },
      ),
    ).toBe(true);
  });

  it('handles sub-zero figures', () => {
    expect(
      placeReachesTemperature(
        { minCelsius: -22, maxCelsius: -16 },
        { kind: 'fixed', celsius: -18 },
      ),
    ).toBe(true);
  });
});
