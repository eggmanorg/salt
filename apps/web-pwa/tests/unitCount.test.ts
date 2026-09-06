import { describe, it, expect } from 'vitest';
import { parseUnitCount } from '../src/routes/recipes/unitCount.js';
import { parseMinutes } from '../src/routes/recipes/cookTimerDuration.js';

// The count derivation `FormulaPage` and `RecipeBakeBatchSheet` each used to
// declare for themselves (issue #1055). The page-level tables in
// `FormulaPage.test.ts` and `RecipeBakeBatchSheet.test.ts` assert that both
// surfaces still reach this answer; what is asserted here is the answer itself.

describe('parseUnitCount', () => {
  it.each([
    ['a whole number of loaves', '3', 3],
    ['one', '1', 1],
    ['a number padded with spaces', '  12  ', 12],
    ['an empty box', '', null],
    ['whitespace only', '   ', null],
    ['zero', '0', null],
    ['a negative number', '-1', null],
    ['half a loaf', '2.5', null],
    ['letters', 'abc', null],
    ['a number with letters after it', '3 loaves', null],
  ])('reads %s (%j) as %j', (_case, text, expected) => {
    expect(parseUnitCount(text)).toBe(expected);
  });

  it('rejects a fraction rather than rounding it', () => {
    // `DoughAmountSchema.count` is `z.number().int().positive()`, so a rounded
    // 2.5 would be a silent correction to a document the user did not declare —
    // and 2.4 and 2.6 would round to different shapes from the same intent.
    // Nothing is the honest answer, and it is what keeps Save disabled.
    expect(parseUnitCount('2.5')).toBeNull();
    expect(parseUnitCount('2.4')).toBeNull();
    expect(parseUnitCount('2.6')).toBeNull();
  });

  it('rejects a non-finite figure', () => {
    expect(parseUnitCount('Infinity')).toBeNull();
    expect(parseUnitCount('1e400')).toBeNull();
  });

  it('takes exponent notation that lands on a whole number', () => {
    // Inherited from `Number`, not chosen — pinned so a later reimplementation
    // on a regex cannot change it without saying so.
    expect(parseUnitCount('1e3')).toBe(1000);
  });

  it('is stricter than the cook timer parser on nothing, and looser on nothing', () => {
    // Both reject the same junk and both demand a positive integer, but they are
    // NOT interchangeable and must not be collapsed: `cookTimerDuration`'s
    // parser is regex-anchored (`/^\d+$/`), so it refuses exponent notation and
    // a leading `+`, which this one takes. It stays separate deliberately —
    // Behavior Contract clause 4.
    expect(parseMinutes('1e3')).toBeNull();
    expect(parseUnitCount('1e3')).toBe(1000);

    for (const junk of ['', '0', '-5', '2.5', 'abc']) {
      expect(parseMinutes(junk)).toBeNull();
      expect(parseUnitCount(junk)).toBeNull();
    }
  });
});
