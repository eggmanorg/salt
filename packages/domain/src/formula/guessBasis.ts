// Which of a recipe's ingredients are the basis — the set whose combined weight
// is 100% (issue #806, phase 1 of epic #778).
//
// This holds a DECISION ("which of these is the flour?"), not a lookup, which is
// why it is here and not in a service or a page (docs/domain-implementation.md).
// It is pure and total: it takes text that has ALREADY been resolved by the
// caller, so domain never touches the canon store, never reaches for a canon id,
// and never needs to know that canon exists.
//
// It is a GUESS and nothing more. The mapping screen shows what it picked and the
// user moves ingredients in and out of the basis with one tap, so a wrong guess
// costs a tap and a missing guess costs a tap. That is the whole reason the
// keyword list below can be short and stay short: it does not have to be right,
// it has to save the common case.

// Deliberately small, and deliberately not a taxonomy. Bread is the case that
// matters — the basis of a loaf is the flours — and every other craft's basis
// (the vegetables of a kraut, the green weight of a coppa) is far too varied to
// keyword-match honestly, so it is left to the toggle rather than guessed badly.
//
// `wholemeal` and `semolina` earn their place because a real recipe line says
// "300 g strong wholemeal" or "50 g fine semolina" with no "flour" in sight.
// Nothing else does: `rye`, `spelt` and `oat` name grains that appear as flakes,
// berries and whole grains at least as often as they appear as flour, and a
// keyword that is wrong half the time is worse than no keyword at all.
export const BASIS_KEYWORDS: readonly string[] = ['flour', 'wholemeal', 'semolina'];

// Word-boundary matching, with an optional plural. Substring matching would be
// one compound word away from an embarrassment, and the boundary is cheap.
const BASIS_PATTERNS: readonly RegExp[] = BASIS_KEYWORDS.map(
  (keyword) => new RegExp(`\\b${keyword}s?\\b`, 'i'),
);

export type BasisGuessEntry = {
  ingredientId: string;
  // The canon item this ingredient resolved to, if it resolved to one. Canon is
  // the tidier name — "strong white flour" rather than "500g strong white bread
  // flour, plus extra for dusting" — so it LEADS.
  canonName: string | null;
  // The recipe's own line, used only when there is no canon name. An unmatched
  // ingredient is exactly the one a guess still has to help with, and its raw
  // text is the only thing there is to go on.
  rawText: string;
};

/**
 * Guess which ingredients form the basis. Returns their ids, in the order given.
 *
 * Pure: no I/O, no clock, no canon lookup. An empty result is a perfectly good
 * answer — it means "you pick", not "this recipe has no basis".
 */
export function guessBasisIngredientIds(entries: readonly BasisGuessEntry[]): string[] {
  return entries
    .filter((entry) => {
      const text = entry.canonName ?? entry.rawText;
      return BASIS_PATTERNS.some((pattern) => pattern.test(text));
    })
    .map((entry) => entry.ingredientId);
}
