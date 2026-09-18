import { describe, it, expect } from 'vitest';
import type { BoundViolation } from '@salt/domain';
import { describeBoundViolation, describeBoundWindow } from '../src/lib/boundViolation.js';

// The ONE wording for a refused percentage (issue #1402).
//
// Three surfaces reach a bound violation — the formula screen refusing to save, the
// bake sheet refusing to start, and `batchService` wording the freeze's own refusal
// — and until this module they could not share a sentence: the wording was private
// to `batchService`. What is pinned here is the wording itself; that each surface
// actually uses it is pinned in each surface's own suite.
//
// Its boundary: it WORDS a refusal and never decides one. Nothing here re-tests a
// bound, so a green assertion below says nothing about whether anything is safe.

function violation(over: Partial<BoundViolation> = {}): BoundViolation {
  return { ingredientId: 'ing-cure', percent: 1.2, bound: 'max', ...over };
}

describe('describeBoundWindow', () => {
  it('names the whole window when both ends were declared', () => {
    // Which is the case every curing salt produces: the table gives both ends, and
    // `BoundViolation` carries both precisely so this can be said.
    expect(describeBoundWindow(violation({ minPercent: 0.15, maxPercent: 0.3 }))).toBe(
      'outside the 0.15%–0.3% window it has to sit in',
    );
  });

  it('names the one end that was declared, when only one was', () => {
    expect(describeBoundWindow(violation({ bound: 'max', maxPercent: 2.5 }))).toBe(
      'above the 2.5% it has to stay under',
    );
    expect(describeBoundWindow(violation({ bound: 'min', minPercent: 0.2 }))).toBe(
      'below the 0.2% it has to stay above',
    );
  });

  it('says something rather than "undefined" when neither end rode along', () => {
    // `BoundViolation` allows it, so this is reachable by type rather than dead.
    expect(describeBoundWindow(violation())).toBe('outside the window it has to sit in');
  });
});

describe('describeBoundViolation', () => {
  const label = (id: string) => (id === 'ing-cure' ? '2.5 g cure #1' : undefined);

  it('names the line, its percentage and the window, and stops there', () => {
    // No advice: each surface appends its own next step, because they genuinely
    // differ and only the subject must not drift.
    expect(
      describeBoundViolation(
        { violations: [violation({ minPercent: 0.15, maxPercent: 0.3 })] },
        label,
      ),
    ).toBe(
      'That would put “2.5 g cure #1” at 1.2% of the basis, outside the 0.15%–0.3% window it has to sit in.',
    );
  });

  it('falls back to a generic subject for an ingredient that has left the recipe', () => {
    // A blank reads as "we no longer know what this was", which is true; an id
    // reads as gibberish and a guess reads as a fact.
    const orphan = { violations: [violation({ ingredientId: 'gone', maxPercent: 0.3 })] };
    expect(describeBoundViolation(orphan, label)).toContain('one ingredient');
    expect(describeBoundViolation(orphan, () => '')).toContain('one ingredient');
  });

  it('words an empty violation list rather than breaking the screen', () => {
    // `boundViolationsIn` cannot produce one, but this is copy, and copy does not
    // get to be the thing that breaks a screen.
    expect(describeBoundViolation({ violations: [] }, label)).toBe(
      'One of the percentages is outside the window it has to sit in.',
    );
  });
});
