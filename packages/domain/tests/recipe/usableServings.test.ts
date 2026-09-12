import { describe, it, expect } from 'vitest';
import { usableServings, servingsScale } from '../../src/index.js';

// Issue #1123. The rule every scaler needs and none of them stated: `?? 1` treats
// a MISSING servings count as "scale from 1", and a stored 0 is not missing — it
// is the value that makes the division meaningless.

describe('usableServings', () => {
  it('passes a real count through', () => {
    expect(usableServings(4)).toBe(4);
    expect(usableServings(1)).toBe(1);
  });

  it('reports an unstated count as unstated', () => {
    expect(usableServings(null)).toBeNull();
  });

  it('reports 0 as unstated — a base of zero is what divided a list by Infinity', () => {
    expect(usableServings(0)).toBeNull();
  });

  it('reports a negative count as unstated — it would flip every amount', () => {
    expect(usableServings(-2)).toBeNull();
  });

  it('reports a non-finite count as unstated', () => {
    expect(usableServings(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableServings(Number.NaN)).toBeNull();
  });

  it('leaves a fractional count usable — "serves 2.5" scales fine, it just reads oddly', () => {
    expect(usableServings(2.5)).toBe(2.5);
  });
});

// Issue #1321. The base/active/factor rule was written out twice — once in
// `RecipeViewPage` and once in `cookServings.svelte.ts` — so the recipe page and
// the cook screens each carried their own copy of the same arithmetic. The two
// screens keep their own answer to WHICH number is being asked for; what is pinned
// here is the single answer to what that number MEANS.

describe('servingsScale', () => {
  it('reports a recipe with no usable base as unscalable, whatever is requested', () => {
    // The one nullable both call sites narrow through. `usableServings`' rule,
    // applied to the stored count — there is nothing to divide by.
    expect(servingsScale(null, 6)).toBeNull();
    expect(servingsScale(0, 6)).toBeNull();
    expect(servingsScale(Number.NaN, 6)).toBeNull();
  });

  it('reads a recipe as written when nothing is requested', () => {
    // Factor exactly 1, which is the value `scaleQuantity` returns the stored
    // quantity untouched for — an unscaled page renders what it always rendered.
    expect(servingsScale(4, null)).toEqual({ base: 4, active: 4, factor: 1, isScaled: false });
  });

  it('reads it at the requested count, and says so', () => {
    expect(servingsScale(4, 6)).toEqual({ base: 4, active: 6, factor: 1.5, isScaled: true });
    expect(servingsScale(4, 2)).toEqual({ base: 4, active: 2, factor: 0.5, isScaled: true });
  });

  it('is not scaled when the request happens to equal the recipe', () => {
    // "Serves 4" chosen on a recipe that serves 4 is as written, not a scale of 1×
    // that merely looks like one — the cook links carry no `?serves=` for it.
    expect(servingsScale(4, 4)).toEqual({ base: 4, active: 4, factor: 1, isScaled: false });
  });

  it('ignores an unusable REQUEST the same way it ignores an unusable base', () => {
    // A number is a servings count by one rule, wherever it arrived from — a URL,
    // or a cook session pinned before `usableServings` existed. Falling back to the
    // base is what stops a stored 0 dividing the page by zero.
    expect(servingsScale(4, 0)?.active).toBe(4);
    expect(servingsScale(4, -2)?.active).toBe(4);
    expect(servingsScale(4, Number.POSITIVE_INFINITY)?.active).toBe(4);
    expect(servingsScale(4, Number.NaN)?.isScaled).toBe(false);
  });

  it('gives a finite factor for every input it does not refuse', () => {
    // The property the two hand-written copies could each have broken on their own:
    // whatever comes back, the factor is a number `scaleQuantity` will honour
    // (`Number.isFinite` and `> 0`) rather than one it silently ignores.
    const inputs = [null, 0, -2, 0.5, 1, 4, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const stated of inputs) {
      for (const requested of inputs) {
        const result = servingsScale(stated, requested);
        if (result === null) continue;
        expect(Number.isFinite(result.factor)).toBe(true);
        expect(result.factor).toBeGreaterThan(0);
        expect(result.isScaled).toBe(result.factor !== 1);
      }
    }
  });
});
