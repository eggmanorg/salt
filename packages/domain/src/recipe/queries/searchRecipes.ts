import type { RecipeKind } from '../entities/Recipe.js';

// Keyword search over the recipe library (issue #840). The ranking half of the
// chef's `findRecipes` tool: the Cloud Function does the Firestore I/O and this
// decides what comes back and in what order.
//
// PURE (CLAUDE.md rule 1). Plain data in, plain data out — no clock, no I/O, no
// randomness, no mutation of any argument. The CF is a thin adapter around it,
// which is what makes the thing the chef actually depends on unit-testable
// without an emulator.
//
// WHY KEYWORDS AND NOT EMBEDDINGS. Vector search is the right end state for a
// library of thousands, and the tool's signature is shaped so it is a swap
// inside `findRecipes` and nothing else. What it costs today is a server-only
// `recipeEmbeddings` collection, an embedding branch on `onRecipeWritten`, a
// vector index configured in three Firebase projects and a backfill — against a
// bar this clears easily: the app's own search box is a substring match on title
// and tags alone. Title + description + tags with ranking already beats it, and
// the chef turns a vibe into keywords before it ever calls (that instruction is
// in the tool description, which is where the model reads it).
//
// The candidate is a SHALLOW projection on purpose. `ingredients` and `steps`
// never reach this function because they never leave Firestore for a search —
// see the `select()` in the CF handler. Ingredient search is deferred by
// decision and needs either a full-document read per search or a maintained
// summary index; neither is this.

/**
 * One recipe as search sees it — the shallow line, never the whole dish.
 *
 * `tags` and `kind` are here because they are filtered and ranked on. Times and
 * servings are deliberately NOT: they are carried on the caller's own row type
 * (see the generic on `searchRecipes`) and shown to the model, but nothing here
 * ranks by them. "Something quick" is answered by the chef reading the minutes
 * on the lines it got back, not by this function guessing what quick means.
 */
export interface RecipeSearchCandidate {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind: RecipeKind;
  readonly tags: readonly string[];
}

/**
 * What the chef asked for. Every field is optional; all of them absent is browse.
 *
 * Each is `?: T | undefined` rather than a bare `?:` because the repo runs
 * `exactOptionalPropertyTypes`, and the caller is a Zod-inferred wire type whose
 * optional fields are exactly that union. Narrowing here would force the Cloud
 * Function to strip undefined keys before calling — ceremony that buys nothing.
 */
export interface RecipeSearchFilters {
  /**
   * Free text. Tokenised and matched against title, description and tags.
   *
   * ABSENT OR BLANK IS BROWSE, and that is deliberate rather than a degenerate
   * case: "what shall we have this week?" carries no keywords, and the chef needs
   * to see the library to answer it. A browse returns the whole (capped, filtered)
   * index ordered by title — which is the ambient recipe index this feature
   * rejected, except paid only on the turns that need it.
   */
  readonly query?: string | undefined;
  /**
   * Restrict to one kind of entry.
   *
   * Absent means every kind that is a dish — see `isHiddenFromSearch`, which
   * takes `placeholder` out of an unrestricted search. Naming it here is how a
   * caller that genuinely wants the placeholders gets them.
   */
  readonly kind?: RecipeKind | undefined;
  /**
   * Restrict to entries carrying ALL of these tags, compared case-insensitively.
   *
   * AND rather than OR, because that is what narrowing means and it is what the
   * chef reaches for it for: "quick AND vegetarian" is one shortlist, "quick or
   * vegetarian" is most of the library. Strictness is safe here precisely because
   * the chef also holds `query`, which is fuzzy — and the tool description tells
   * it which is which.
   */
  readonly tags?: readonly string[] | undefined;
  /** Cap on returned rows. Clamped to `RECIPE_SEARCH_RESULT_CEILING`. */
  readonly maxResults?: number | undefined;
}

/**
 * Rows returned for a RANKED search when the caller does not say.
 *
 * A chef proposing five nights does not need sixty candidates, and every row is
 * paid for in the next model turn's prompt. Truncating a ranked list is safe
 * because it drops the least relevant answers; a browse is ordered by title, so
 * it does not get this default — see `resultLimit`.
 */
export const RECIPE_SEARCH_DEFAULT_MAX_RESULTS = 25;

/**
 * The hard ceiling, whatever the caller asks for, and the default for a browse.
 *
 * A bound on what one turn can cost, NOT a statement about how big the library
 * may get: it is above today's library (59 dishes) so a browse can see all of
 * it, and a library that outgrows it degrades to "the first sixty by title",
 * which is the point at which the deferred vector search stops being deferred.
 */
export const RECIPE_SEARCH_RESULT_CEILING = 60;

// Field weights. Title carries most because a dish's name is what someone
// searching for it types; tags are curated and therefore trustworthy but coarse;
// a description mentions half a dozen things the dish merely contains. The ratio
// is a judgement, not a measurement — nothing depends on the exact numbers, and
// they are safe to retune.
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;

/**
 * Shortest token that may match by prefix.
 *
 * Four, so "lamb" reaches "lambs" and "roast" reaches "roasted", while "a", "of"
 * and "to" cannot prefix-match half the library.
 */
const MIN_PREFIX_MATCH_LENGTH = 4;

// Words that appear in a query because English needs them, not because the user
// meant them. Kept deliberately short: a stop list is a place for a real word to
// go missing, and the weighting already buries a token that matches everything.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'what',
  'when',
  'which',
  'with',
  'you',
  'your',
]);

/**
 * Search and rank a shallow recipe index.
 *
 * Generic in the row type so the caller keeps whatever else it projected —
 * servings, timings — without this function knowing or caring about it. Ranking
 * reads only the five fields `RecipeSearchCandidate` names.
 *
 * ORDER. With a query: score descending, then title ascending. Without one:
 * title ascending. Ties break on the title rather than on input order so the
 * same library and the same question give the same answer twice — a stable
 * result is what makes a prompt-behaviour problem reproducible.
 *
 * A query that matches nothing returns an empty list. That is an answer ("we
 * have nothing like that"), not a failure, and the chef is told to treat it as
 * one — never to invent a dish and present it as saved.
 */
export function searchRecipes<T extends RecipeSearchCandidate>(
  candidates: readonly T[],
  filters: RecipeSearchFilters = {},
): T[] {
  const wantedTags = (filters.tags ?? []).map(normalise).filter((t) => t.length > 0);
  const filtered = candidates.filter((candidate) => {
    if (filters.kind !== undefined && candidate.kind !== filters.kind) return false;
    if (filters.kind === undefined && isHiddenFromSearch(candidate.kind)) return false;
    if (wantedTags.length === 0) return true;
    const own = new Set(candidate.tags.map(normalise));
    return wantedTags.every((tag) => own.has(tag));
  });

  const queryTokens = tokenise(filters.query ?? '');
  const limit = resultLimit(filters.maxResults, queryTokens.length === 0);

  // Browse: no query, or a query that was nothing but stop words and
  // punctuation. Both mean "show me the library", and collapsing them is what
  // stops a query of "and" returning zero dishes.
  if (queryTokens.length === 0) {
    return [...filtered].sort(byTitle).slice(0, limit);
  }

  return filtered
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, queryTokens) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || byTitle(a.candidate, b.candidate))
    .slice(0, limit)
    .map((scored) => scored.candidate);
}

/**
 * Kinds a library search never offers unless asked for by name.
 *
 * Only `placeholder`, and it is the one kind that is not a dish: a stock
 * photograph and a title, with every capability in `capabilities.ts` set false.
 * Left in, it is not merely noise — its tags are `comfort`/`cold`/`bright`/`hot`
 * and its description is evocative kitchen prose, so a search for a VIBE scores
 * it while a real recipe that never uses the word scores zero and is filtered
 * out. The chef is told to name and link every library entry it gets back, so
 * the household would be offered a photograph as tonight's dinner. The app's own
 * list never mixes them in either — placeholders stand on their own shelf.
 *
 * A caller that passes `kind: 'placeholder'` has asked for exactly them and gets
 * them. `special` and `cocktail` are real entries and stay: a special is a
 * legitimate answer to "what is for dinner", which the tool description says.
 */
function isHiddenFromSearch(kind: RecipeKind): boolean {
  return kind === 'placeholder';
}

/**
 * How many rows come back.
 *
 * A BROWSE with no stated cap gets the ceiling, not the default, and the
 * asymmetry is the point: a ranked search truncated at 25 drops the 26th-best
 * answer, while a browse truncated at 25 drops everything after the 25th TITLE —
 * with a library past that size, the same dishes are invisible on every planning
 * turn, forever, and nothing in the result says so. The tool description promises
 * the model that leaving `query` out browses the whole library; this is what
 * keeps that true up to the ceiling.
 */
function resultLimit(requested: number | undefined, browsing: boolean): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return browsing ? RECIPE_SEARCH_RESULT_CEILING : RECIPE_SEARCH_DEFAULT_MAX_RESULTS;
  }
  return Math.min(Math.floor(requested), RECIPE_SEARCH_RESULT_CEILING);
}

function byTitle(a: RecipeSearchCandidate, b: RecipeSearchCandidate): number {
  return a.title.localeCompare(b.title);
}

/**
 * How well one dish answers the query.
 *
 * Each query token scores AT MOST ONCE PER FIELD, at that field's weight. A
 * description that says "chicken" eight times is not eight times the answer to
 * "chicken" — without the cap, one long rambling description outranks the dish
 * actually called "Roast chicken", which is the failure this shape exists to
 * avoid.
 */
function scoreCandidate(candidate: RecipeSearchCandidate, queryTokens: string[]): number {
  const title = tokenSet(candidate.title);
  const description = tokenSet(candidate.description ?? '');
  const tags = tokenSet(candidate.tags.join(' '));

  let score = 0;
  for (const token of queryTokens) {
    if (matches(title, token)) score += TITLE_WEIGHT;
    if (matches(tags, token)) score += TAG_WEIGHT;
    if (matches(description, token)) score += DESCRIPTION_WEIGHT;
  }
  return score;
}

/**
 * Does this field hold the token?
 *
 * Equality, or a prefix relation in either direction once the shorter side is
 * long enough to mean something — "lamb" finds "lambs", "roasted" finds "roast".
 * Deliberately not a stemmer: a stemmer is a dependency and a vocabulary, and
 * the chef is already decomposing the question into words a recipe would use.
 */
function matches(field: ReadonlySet<string>, token: string): boolean {
  for (const word of field) {
    if (word === token) return true;
    const shorter = word.length < token.length ? word : token;
    if (shorter.length < MIN_PREFIX_MATCH_LENGTH) continue;
    if (word.startsWith(token) || token.startsWith(word)) return true;
  }
  return false;
}

function tokenSet(text: string): ReadonlySet<string> {
  return new Set(tokenise(text));
}

/**
 * Words, lowercased, with punctuation and stop words gone.
 *
 * Splits on anything that is not a letter or a digit, which keeps accented
 * letters intact (`\p{L}`) — "jalapeño" and "crème" are one token each, not two.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}
