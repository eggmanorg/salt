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
//      the nearest half, and a positive amount never to zero in EITHER unit
//      (issue #1321);
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

    it('floors a positive measure at 0.1 rather than rounding it away', () => {
      // Issue #1321, Daniel's call: the minimum always shows. 1g of yeast for one
      // of forty is 0.025g, which `roundGrams` takes to zero — and a row reading
      // "0g yeast" is an ingredient the cook silently leaves out, exactly the
      // hazard the count path was floored against.
      expect(scaleQuantity({ type: 'single', value: 1 }, 1 / 40, 'g')).toEqual({
        type: 'single',
        value: 0.1,
      });
      // The same rule through the jug.
      expect(scaleQuantity({ type: 'single', value: 2 }, 0.02, 'ml')).toEqual({
        type: 'single',
        value: 0.1,
      });
      // 0.05 is already the nearest tenth away from zero, so it needs no floor —
      // the two paths agree on the answer and only one of them is a rescue.
      expect(scaleQuantity({ type: 'single', value: 1 }, 0.05, 'g')).toEqual({
        type: 'single',
        value: 0.1,
      });
    });

    it('floors each end of a vanishing range on its own', () => {
      // Both ends survive as a range rather than collapsing to "0–0g".
      expect(scaleQuantity({ type: 'range', min: 1, max: 2 }, 1 / 100, 'g')).toEqual({
        type: 'range',
        min: 0.1,
        max: 0.1,
      });
    });

    it('leaves a non-finite stored measure at zero rather than promoting it', () => {
      // `QuantitySchema` is `z.number()`, which admits Infinity. The floor is a
      // rescue for a REAL small amount; "Infinity g" is not one, and 0.1g would
      // read as a plausible figure somebody might actually weigh out.
      expect(scaleQuantity({ type: 'single', value: Number.POSITIVE_INFINITY }, 2, 'g')).toEqual({
        type: 'single',
        value: 0,
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

    it('refuses to turn a non-finite stored amount into a non-finite one', () => {
      // `QuantitySchema` is `z.number()`, which admits Infinity, and a corrupt or
      // hand-edited document can carry one. "Infinity eggs" on a mise list is worse
      // than nothing there at all, so the rounding floors it — the same reasoning,
      // and the same answer, as `roundGrams`' own guard.
      expect(scaleQuantity({ type: 'single', value: Number.POSITIVE_INFINITY }, 2, null)).toEqual({
        type: 'single',
        value: 0,
      });
    });

    it('floors a positive count at a half rather than rounding it away', () => {
      // 1 egg cooked for one of eight servings is 0.125, which rounds to nothing —
      // and a row reading "0 eggs" is an ingredient silently left out of the dish.
      expect(scaleQuantity({ type: 'single', value: 1 }, 1 / 8, null)).toEqual({
        type: 'mixed',
        whole: 0,
        numerator: 1,
        denominator: 2,
      });
      // A quarter is already the nearest half away from zero, so it needs no floor
      // — the two paths agree on the answer and only one of them is a rescue.
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

  // ─── Rule 12: a positive amount never reads as nothing ──────────────────────
  //
  // The claim the header makes, stated once and asserted here across both units
  // and every shape a stored quantity comes in — rather than only at the two
  // factors somebody thought to write a case for. An ingredient that disappears
  // from a scaled list, while the list still LOOKS complete, is the failure this
  // path exists to avoid, and it is invisible to every other gate in the repo.
  describe('a positive amount never scales away to nothing', () => {
    const stated: Quantity[] = [
      { type: 'single', value: 1 },
      { type: 'single', value: 0.5 },
      { type: 'mixed', whole: 0, numerator: 1, denominator: 4 },
      { type: 'range', min: 1, max: 2 },
    ];
    // Every factor the picker can produce against the largest base it offers, plus
    // the extremes a hand-typed `?serves=` reaches (`SERVINGS_PARAM_MAX` is 100).
    const factors = [1 / 100, 1 / 40, 1 / 12, 0.05, 0.125, 0.25, 1 / 3, 0.5, 0.99];

    for (const unit of ['g', 'ml', null] as const) {
      it(`holds for ${unit ?? 'a count'}`, () => {
        for (const quantity of stated) {
          for (const factor of factors) {
            const scaled = scaleQuantity(quantity, factor, unit);
            const ends =
              scaled.type === 'range' ? [scaled.min, scaled.max] : [quantityToNumber(scaled)];
            for (const end of ends) {
              expect(
                end,
                `${JSON.stringify(quantity)} × ${factor} ${unit ?? 'count'}`,
              ).toBeGreaterThan(0);
            }
          }
        }
      });
    }
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
