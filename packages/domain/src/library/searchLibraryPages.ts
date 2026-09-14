/**
 * The shape a page has to be in to be searched — the fields the match reads, and
 * no more. Structural rather than `LibraryPageDoc` so the caller can hand over
 * whatever it has parsed and get the same object back.
 */
export interface LibraryPageCandidate {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
}

export interface LibraryPageSearchFilters {
  readonly query?: string | undefined;
  readonly maxResults?: number | undefined;
}

/** How many pages come back when the caller does not say. */
export const LIBRARY_PAGE_SEARCH_DEFAULT_MAX = 10;

/**
 * The most that ever come back, whatever was asked for.
 *
 * Each match carries a summary of up to `LIBRARY_PAGE_SUMMARY_CHARS`, so this is
 * the bound on how much prose one search can put into the next model turn.
 */
export const LIBRARY_PAGE_SEARCH_CEILING = 25;

const tokenise = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);

/**
 * Keyword search over the library's pages.
 *
 * A FILTER, NOT A RANKING, and deliberately so — a library is tens of pages, not
 * the hundreds of recipes `searchRecipes` scores, and every match comes back with
 * a summary the model reads for itself. Every token of the query must appear
 * somewhere in the page (title, tags or body); the only ordering is that a page
 * whose TITLE OR TAGS carry every token comes before one matched on its body
 * alone, which is the difference between the page about jars and the page that
 * mentions them.
 *
 * An absent or blank query browses: the whole library, newest edit first, capped
 * like any other search.
 */
export function searchLibraryPages<T extends LibraryPageCandidate>(
  pages: readonly T[],
  filters: LibraryPageSearchFilters = {},
): T[] {
  const limit = Math.min(
    Math.max(1, Math.floor(filters.maxResults ?? LIBRARY_PAGE_SEARCH_DEFAULT_MAX)),
    LIBRARY_PAGE_SEARCH_CEILING,
  );
  const tokens = tokenise(filters.query ?? '');
  if (tokens.length === 0) return pages.slice(0, limit);

  const named: T[] = [];
  const mentioned: T[] = [];
  for (const page of pages) {
    const heading = `${page.title} ${page.tags.join(' ')}`.toLowerCase();
    const whole = `${heading} ${page.body}`.toLowerCase();
    if (!tokens.every((t) => whole.includes(t))) continue;
    (tokens.every((t) => heading.includes(t)) ? named : mentioned).push(page);
  }
  return [...named, ...mentioned].slice(0, limit);
}
