import type { BoundViolation } from '@salt/domain';

// WHY A PERCENTAGE WAS REFUSED, IN ONE WORDING (issue #1402).
//
// `solveFormula` has refused a bound violation since #782 and `BoundViolation`
// reports both ends when both were declared, precisely so a caller can show the
// WINDOW rather than the edge that was hit (`formula/failure.ts`). This is the one
// place that is said in words.
//
// IT LIVES IN `lib/` BECAUSE A `.ts` SERVICE NEEDS IT TOO (issue #1055): three
// surfaces reach a bound violation — the formula screen refusing to save, the bake
// sheet refusing to start, and `batchService` wording the freeze's own refusal — and
// a safety sentence with three copies is three sentences. It used to be two private
// functions inside `batchService.ts`, reachable from neither screen.
//
// ONE SENTENCE, THREE TAILS. What is shared is the subject, the percentage and the
// window; what each surface adds is where to go next, which genuinely differs — the
// bake sheet can suggest a different time, and the formula screen is already where
// you would be sent. The shared part is what must not drift.
//
// It words a refusal and never decides one. Nothing here re-tests a bound.

/**
 * Which window was missed, in the figures the rail itself declared.
 *
 * Both ends when both were declared; otherwise the one end that was, because a
 * component may legitimately carry only a floor or only a ceiling. The last line is
 * not dead code — `BoundViolation` allows a violation with neither end present, and
 * a sentence naming no figure is better than one naming `undefined`.
 */
export function describeBoundWindow(violation: BoundViolation): string {
  const { minPercent, maxPercent } = violation;
  if (minPercent !== undefined && maxPercent !== undefined) {
    return `outside the ${minPercent}%–${maxPercent}% window it has to sit in`;
  }
  if (violation.bound === 'min' && minPercent !== undefined) {
    return `below the ${minPercent}% it has to stay above`;
  }
  if (violation.bound === 'max' && maxPercent !== undefined) {
    return `above the ${maxPercent}% it has to stay under`;
  }
  return 'outside the window it has to sit in';
}

/**
 * A refused solve, worded — the subject, its percentage and the window it missed.
 *
 * `label` is the recipe's own words for the line, looked up by the caller. An
 * ingredient that has left the recipe gets the generic subject rather than its id: a
 * blank reads as "we no longer know what this was", which is the same choice
 * `freezeBatch` makes for a quantity's label, where an id reads as gibberish.
 *
 * The sentence ends in a full stop and carries no advice. Each surface appends its
 * own next step.
 */
export function describeBoundViolation(
  reason: { readonly violations: readonly BoundViolation[] },
  label: (ingredientId: string) => string | undefined,
): string {
  const violation = reason.violations[0];
  if (violation === undefined) {
    // A `boundViolation` with an empty list cannot be produced by
    // `boundViolationsIn`, which only returns the reason when it found one. Worded
    // anyway rather than thrown: this is copy, and copy does not get to be the thing
    // that breaks a screen.
    return 'One of the percentages is outside the window it has to sit in.';
  }
  const named = label(violation.ingredientId);
  const subject = named === undefined || named === '' ? 'one ingredient' : `“${named}”`;
  return `That would put ${subject} at ${violation.percent}% of the basis, ${describeBoundWindow(violation)}.`;
}
