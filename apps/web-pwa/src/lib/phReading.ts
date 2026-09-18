import { PhSchema } from '@salt/domain/schemas';

// A pH TYPED INTO A BOX, in one place (issue #1442).
//
// Two screens ask for a pH — the observation sheet logging a reading, and the formula
// screen naming the target a run is aiming at — and until this module they each
// carried the same four-line parse and the same error sentence, character for
// character, under a comment asserting the copy was "not a second opinion". That is
// the state `sharedHelperGuard` exists to replace: comments asking the next author to
// keep copies in agreement have already failed twice in this repo, and a request is
// not a mechanism.
//
// IT IS NOT A SECOND OPINION, AND NOW THAT IS MECHANICAL RATHER THAN ASSERTED. The
// bound is `PhSchema`'s, imported and run rather than restated, so the field and the
// rail behind it cannot disagree about what a pH is. What this module adds is only
// WHEN the answer arrives: on the field, while the number is still being typed,
// instead of at the write. Widening or narrowing the scale is one edit in
// `packages/domain/src/schemas/formula.ts` and both screens follow.
//
// It parses and words; it decides nothing and writes nothing. A blank box is not an
// error — it is "not measured", which is most readings, and "no target", which is
// most formulas.

/**
 * The pH in this box, or `null` for "there isn't one".
 *
 * `null` covers both a blank box and an unusable one, because the screens treat them
 * identically at the write — nothing is stored either way. What tells them apart for
 * the READER is `phFieldError` below, which fires only on text that is present and
 * cannot be a pH.
 */
export function parsePhReading(text: string): number | null {
  const raw = text.trim();
  if (raw === '') return null;
  const parsed = PhSchema.safeParse(Number(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * What to say under the box, or `''` when there is nothing to say.
 *
 * Empty for a blank box: leaving a reading out is the ordinary answer and must never
 * read as a mistake.
 */
export function phFieldError(text: string): string {
  return text.trim() !== '' && parsePhReading(text) === null
    ? 'A pH from 0 to 14, or leave it blank.'
    : '';
}
