// Raise the first letter and leave every other character exactly as it was.
//
// Deliberately NOT `titleCase`, which lower-cases the whole string first and would
// rewrite wording we do not own — "Maldon sea salt" → "Maldon Sea Salt", "Cosori
// 5L Rice Cooker" → "Cosori 5L Rice Cooker" only by luck. Here the opening letter
// is the only thing this app decides.
//
// The limit, stated rather than implied: a word whose first letter is meant to be
// lower — "pH-neutral" — is raised too ("PH-neutral"). There is no rule that can
// tell that apart from an ordinary lowercase word, and it is pinned as behaviour
// in `IngredientText.test.ts` rather than claimed away.
//
// Idempotent: a string already starting with a capital is returned unchanged.
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
