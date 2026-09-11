import { describe, it, expect } from 'vitest';
import { scaleQuantity, quantityToNumber } from '../../src/index.js';
import type { Quantity } from '../../src/index.js';

// The DRAWING half of serving-scaling (issue #1314): a stated amount restated at a
// different number of servings, rounded to a figure a person can weigh or count.
//
// Two things are pinned here and both are product decisions rather than
// implementation detail:
//
//   1. what a scaled number is rounded to — grams through `roundGrams`, counts to
//      the nearest half, and a positive count never to zero;
//   2. that this rounding is NOT what the shopping list buys. The display/purchase
//      boundary is the claim the issue makes (CLAUDE.md Rule 12), and the half of
//      it that lives in this package is asserted below; the other half — that
//      `buildRecipeAddPlan` still computes from the exact factor — is pinned in
//      `apps/web-pwa/tests/recipeService.scaling.test.ts`, because the plan
//      builder is an app module this package must not import (Rule 6).

describe('scaleQuantity', () => {
  describe('a measure (g / ml)', () => {
    it('scales and rounds to whole grams at or above the 10g threshold', () => {
      // 300g at 6/4 servings.
      expect(scaleQuantity({ type: 'single', value: 300 }, 1.5, 'g')).toEqual({
        type: 'single',
        value: 450,
      });
      // 33g × 1.5 = 49.5 → a figure a domestic scale can actually show.
      expect(scaleQuantity({ type: 'single', value: 33 }, 1.5, 'g')).toEqual({
        type: 'single',
        value: 50,
      });
    });

    it('keeps one decimal below the threshold, so a small amount survives', () => {
      // 5g × 1.5 = 7.5. Rounding this to 8 would be the whole-gram rule applied
      // where it costs the most.
      expect(scaleQuantity({ type: 'single', value: 5 }, 1.5, 'g')).toEqual({
        type: 'single',
        value: 7.5,
      });
    });

    it('rounds millilitres by the same rule, deliberately', () => {
      // The stated widening of `roundGrams` (issue #782) to a jug. Stated rather
      // than hidden: a second rounding rule is the defect it exists to end.
      expect(scaleQuantity({ type: 'single', value: 200 }, 1.5, 'ml')).toEqual({
        type: 'single',
        value: 300,
      });
      expect(scaleQuantity({ type: 'single', value: 4 }, 1.5, 'ml')).toEqual({
        type: 'single',
        value: 6,
      });
    });

    it('never renders a measure as a fraction', () => {
      // 3g × 1.5 = 4.5 — read off a scale as "4.5g", never as "4½g".
      expect(scaleQuantity({ type: 'single', value: 3 }, 1.5, 'g')).toEqual({
        type: 'single',
        value: 4.5,
      });
    });
  });

  describe('a count (unit null)', () => {
    it('rounds to the nearest half and says so as an exact fraction', () => {
      // 3 eggs at 6/4 servings = 4.5 → "4½", which is the `mixed` arm.
      expect(scaleQuantity({ type: 'single', value: 3 }, 1.5, null)).toEqual({
        type: 'mixed',
        whole: 4,
        numerator: 1,
        denominator: 2,
      });
    });

    it('stays a plain number when it lands on a whole one', () => {
      expect(scaleQuantity({ type: 'single', value: 2 }, 2, null)).toEqual({
        type: 'single',
        value: 4,
      });
    });

    it('invents no precision finer than a half', () => {
      // 2 × (5/4) = 2.5 exactly; 1 × (5/4) = 1.25 → 1.5, not 1.25 or 1⅓.
      expect(scaleQuantity({ type: 'single', value: 1 }, 1.25, null)).toEqual({
        type: 'mixed',
        whole: 1,
        numerator: 1,
        denominator: 2,
      });
    });

    it('floors a positive count at a half rather than rounding it away', () => {
      // 1 egg scaled down for one of four servings is 0.25 — which rounds to 0,
      // and a row reading "0 eggs" is an ingredient silently left out of the dish.
      expect(scaleQuantity({ type: 'single', value: 1 }, 0.25, null)).toEqual({
        type: 'mixed',
        whole: 0,
        numerator: 1,
        denominator: 2,
      });
    });

    it('reads a stored exact fraction as its value', () => {
      // "½ clove garlic" doubled is one clove.
      expect(
        scaleQuantity({ type: 'mixed', whole: 0, numerator: 1, denominator: 2 }, 2, null),
      ).toEqual({ type: 'single', value: 1 });
      // "1 ⅓" × 3 = 4.
      expect(
        scaleQuantity({ type: 'mixed', whole: 1, numerator: 1, denominator: 3 }, 3, null),
      ).toEqual({ type: 'single', value: 4 });
    });
  });

  describe('a range', () => {
    it('scales both ends and stays a range', () => {
      // It is NOT reduced to a number here. `quantityToNumber` is the one place
      // that decides which end of a range a single figure means (issue #917), and
      // a second opinion about that is what this function must not grow.
      expect(scaleQuantity({ type: 'range', min: 20, max: 30 }, 1.5, 'g')).toEqual({
        type: 'range',
        min: 30,
        max: 45,
      });
    });

    it('rounds a count range to halves, end by end', () => {
      expect(scaleQuantity({ type: 'range', min: 1, max: 2 }, 1.5, null)).toEqual({
        type: 'range',
        min: 1.5,
        max: 3,
      });
    });
  });

  describe('the identity and the degenerate factors', () => {
    const original: Quantity = { type: 'mixed', whole: 1, numerator: 1, denominator: 2 };

    it('returns the very quantity it was given at factor 1', () => {
      // Not merely an equal one: an unscaled page must render exactly what it
      // rendered before this function existed, stored fraction and all.
      expect(scaleQuantity(original, 1, null)).toBe(original);
      expect(scaleQuantity(original, 1, 'g')).toBe(original);
    });

    it('returns the quantity untouched for a factor that is not a positive number', () => {
      // The factor is derived from a URL parameter at the only call site. A pure
      // query with a UI caller has nothing useful to throw.
      expect(scaleQuantity(original, 0, null)).toBe(original);
      expect(scaleQuantity(original, -2, null)).toBe(original);
      expect(scaleQuantity(original, Number.NaN, null)).toBe(original);
      expect(scaleQuantity(original, Number.POSITIVE_INFINITY, null)).toBe(original);
    });
  });

  // ─── Rule 12: the display figure is not the purchase figure ─────────────────
  //
  // The issue's one safety claim is that these two paths never merge. This half
  // asserts the fork is real and observable: for an amount the display rounding
  // actually moves, the rounded figure and the exact product are DIFFERENT
  // numbers — so a shopping plan reading the rounded one would buy something
  // other than what the screen said. If `scaleQuantity` ever stopped rounding,
  // this test goes red and the claim would have quietly become vacuous rather
  // than true.
  describe('the drawing figure differs from the buying figure', () => {
    it('rounds a gram amount the exact product does not', () => {
      const stated: Quantity = { type: 'single', value: 33 };
      const factor = 1.5;
      const exact = quantityToNumber(stated) * factor;
      const drawn = quantityToNumber(scaleQuantity(stated, factor, 'g'));
      expect(exact).toBe(49.5);
      expect(drawn).toBe(50);
      expect(drawn).not.toBe(exact);
    });

    it('rounds a count the exact product does not', () => {
      const stated: Quantity = { type: 'single', value: 1 };
      const factor = 5 / 4;
      const exact = quantityToNumber(stated) * factor;
      const drawn = quantityToNumber(scaleQuantity(stated, factor, null));
      expect(exact).toBe(1.25);
      expect(drawn).toBe(1.5);
      expect(drawn).not.toBe(exact);
    });
  });
});
