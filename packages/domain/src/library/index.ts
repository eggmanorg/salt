// Library module (epic #1372, issue #1377) — the pure half of the kitchen notes
// the chef can now look through. This file is the ONLY thing other domain modules
// and adapters import from `library`; anything not re-exported here is private.
//
// The tenant that keeps the module alive is `libraryPageSummary`: the decision
// that a page's summary is DERIVED and never stored. That is a policy, and it is
// what keeps a second source of truth for the same prose out of the document —
// which is why it is here rather than in the Cloud Function that calls it, where
// nothing pure could pin it.
//
// The page SCHEMA, the revision cap and `pushRevision` live in
// `schemas/libraryPage.ts` with the document they describe. This module is what
// reads a page, not what shapes one.
export { libraryPageSummary, LIBRARY_PAGE_SUMMARY_CHARS } from './pageSummary.js';
export {
  searchLibraryPages,
  LIBRARY_PAGE_SEARCH_DEFAULT_MAX,
  LIBRARY_PAGE_SEARCH_CEILING,
} from './searchLibraryPages.js';
export type { LibraryPageCandidate, LibraryPageSearchFilters } from './searchLibraryPages.js';
