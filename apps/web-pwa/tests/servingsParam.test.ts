import { describe, it, expect } from 'vitest';
import {
  readServingsParam,
  withServingsParam,
  SERVINGS_PARAM_MAX,
} from '../src/routes/recipes/servingsParam.js';

// The `?serves=N` round trip (issue #1314). It is the whole persistence mechanism
// for reading a recipe at a different number of servings — CLAUDE.md Rule 3 rules
// out browser storage, and a module-level stash would silently revert nineteen
// amounts on a refresh.
//
// What matters most here is the `null` side: every unusable value must read as "no
// parameter at all", because the fallback is the recipe exactly as written, which
// is the only safe thing a nonsense URL can produce.

describe('readServingsParam', () => {
  it('reads a whole positive count', () => {
    expect(readServingsParam('serves=6')).toBe(6);
    expect(readServingsParam('serves=1')).toBe(1);
    expect(readServingsParam('?serves=12')).toBe(12);
  });

  it('finds it beside another parameter, either way round', () => {
    expect(readServingsParam('meal=m1&serves=8')).toBe(8);
    expect(readServingsParam('serves=8&meal=m1')).toBe(8);
  });

  it('trims surrounding whitespace', () => {
    expect(readServingsParam('serves=%206%20')).toBe(6);
  });

  it('reads no parameter as null', () => {
    expect(readServingsParam(undefined)).toBeNull();
    expect(readServingsParam('')).toBeNull();
    expect(readServingsParam('meal=m1')).toBeNull();
    expect(readServingsParam('serves=')).toBeNull();
    expect(readServingsParam('serves=%20%20')).toBeNull();
  });

  it('reads anything that is not a serving count as null', () => {
    expect(readServingsParam('serves=four')).toBeNull();
    expect(readServingsParam('serves=6.5')).toBeNull();
    expect(readServingsParam('serves=NaN')).toBeNull();
    expect(readServingsParam('serves=Infinity')).toBeNull();
  });

  it('refuses zero and below, which is `usableServings`’ rule', () => {
    // A 0 is not a scaling base (issue #1123) — reading it as one divides by zero.
    expect(readServingsParam('serves=0')).toBeNull();
    expect(readServingsParam('serves=-4')).toBeNull();
  });

  it('refuses a count above the ceiling rather than painting nine-digit amounts', () => {
    expect(readServingsParam(`serves=${SERVINGS_PARAM_MAX}`)).toBe(SERVINGS_PARAM_MAX);
    expect(readServingsParam(`serves=${SERVINGS_PARAM_MAX + 1}`)).toBeNull();
    expect(readServingsParam('serves=1000000000')).toBeNull();
  });
});

describe('withServingsParam', () => {
  it('attaches the count to a bare path', () => {
    expect(withServingsParam('/recipes/r1', 6)).toBe('/recipes/r1?serves=6');
  });

  it('composes with a path that already carries a querystring', () => {
    expect(withServingsParam('/recipes/r1?meal=m1', 6)).toBe('/recipes/r1?meal=m1&serves=6');
  });

  it('returns the path untouched for null, so a reset leaves a clean URL', () => {
    // "Back to as written" is this function with nothing to add, not a second
    // helper — and the address bar ends up at /recipes/r1 rather than ?serves=4.
    expect(withServingsParam('/recipes/r1', null)).toBe('/recipes/r1');
  });

  it('round-trips with the reader', () => {
    const path = withServingsParam('/recipes/r1', 9);
    expect(readServingsParam(path.split('?')[1])).toBe(9);
  });
});
