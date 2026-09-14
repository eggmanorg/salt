import { z } from 'zod';

// `libraryPages/{pageId}` — one reference page in the library (epic #1372).
//
// The kitchen facts that are NOT recipes: which Weck jars are in the cupboard and
// how much kraut each one holds, the Control Freak temperatures proven right in
// this kitchen, a sous vide time-and-temperature table lifted off a website. A
// page is a long document nobody reads until they go looking for it.
//
// SIBLING TO `kitchenMemories`, deliberately not the same collection. A kitchen
// memory is one line of standing preference injected into EVERY chef turn; a
// library page is a thousand words of jar dimensions. Merging them would put the
// jar dimensions into every prompt.
//
// FAMILY-SHARED, like everything except the four per-user collections CLAUDE.md
// enumerates: no `ownerUid`, no per-user scoping. `createdBy`/`lastEditedBy` are
// display NAMES denormalised at write time, for audit only — never read to decide
// anything, never a gate. firestore.rules records the standing invariant that uids
// appear nowhere in the family-shared data model.
//
// GREENFIELD → no back-compat constraint (docs/data-model.md §Back-compat lists the
// six production collections; this is not one).
//
// FLAT, WITH TAGS — no `parentId`, no `order`, no tree. Nothing in this repo is
// tree-shaped and a page filed by tags can be in two places at once, which a folder
// cannot. Adding a nullable `parentId` later is purely additive.

// Named here because more than one layer addresses this collection — the browser
// adapter today, and the chef's Cloud Function from Phase 4. A literal in each is a
// rename waiting to go half-done.
export const LIBRARY_PAGE_COLLECTION = 'libraryPages';

/**
 * The longest body a page may hold, in UTF-16 code units — what `.length` and
 * Zod's `.max()` both count.
 *
 * THE SIZING BOUND IS MECHANICAL, not a claim in a comment (CLAUDE.md Rule 12).
 * A Firestore document is capped at 1 MiB (1,048,576 bytes), and a page carries
 * its current body plus up to `LIBRARY_PAGE_REVISION_CAP` more inside
 * `revisions`. A UTF-16 code unit encodes to at most 3 bytes of UTF-8 (a
 * surrogate PAIR — two units — encodes to 4), so the worst case is
 *
 *     (1 + 10) × 20,000 × 3  =  660,000 bytes of body
 *
 * plus eleven titles (200 units → 600 bytes each) and the small scalar fields:
 * comfortably inside the limit with room for the tag list and the timestamps.
 * `tests/library/libraryPage.schema.test.ts` builds that worst case and measures
 * it, so the bound goes red if either number is raised past what it can carry.
 *
 * 20,000 units is ~3,000 words — several times the longest thing this library is
 * for, and it is the textarea's `maxlength` as well, so a page cannot be TYPED
 * past it either.
 */
export const LIBRARY_PAGE_BODY_MAX = 20_000;

/** The longest title, in UTF-16 code units. A title is a line, not a paragraph. */
export const LIBRARY_PAGE_TITLE_MAX = 200;

/**
 * How many previous versions a page keeps.
 *
 * Enforced by `pushRevision`, the one function that ever grows the array —
 * deliberately NOT a `.max()` on the schema, which would make an over-long array
 * a REJECTED READ and so lose the page entirely rather than trim it. A cap whose
 * only failure mode is "the page disappears" is worse than the unbounded growth
 * it guards against.
 */
export const LIBRARY_PAGE_REVISION_CAP = 10;

/**
 * One previous version of a page — the whole of what is restorable, which is the
 * title and the body and nothing else. No diffing, no branching, no per-field
 * history: a page is an evening's work and this exists so a bad rewrite is not
 * final, not so the library grows a version-control system.
 */
export const LibraryPageRevisionSchema = z.object({
  title: z.string().max(LIBRARY_PAGE_TITLE_MAX),
  body: z.string().max(LIBRARY_PAGE_BODY_MAX),
  /** When this version STOPPED being current, ISO. */
  savedAt: z.string(),
  /** Display name of whoever replaced it. Audit only, like `lastEditedBy`. */
  savedBy: z.string(),
});

export const LibraryPageSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1).default(1),
  // Room for "tool pages" — a self-contained interactive page hosted later,
  // sandboxed, with no access to Salt's data. Carried from day one as a literal so
  // widening it to an enum is additive; NOTHING is built on it today and nothing
  // branches on it.
  kind: z.literal('note').default('note'),
  title: z.string().max(LIBRARY_PAGE_TITLE_MAX),
  // Markdown. Rendered through the existing AST → Svelte pipeline, which has no
  // `rehype-raw`, so raw HTML in here is INERT — the safe default, and the switch
  // Phase 3 opens deliberately and behind an allowlist of its own.
  body: z.string().max(LIBRARY_PAGE_BODY_MAX),
  // How a page is filed. Several per page, and a filter rather than a place.
  tags: z.array(z.string()).default([]),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
  // Display NAMES, never uids. Audit only — displayed and nothing else; never
  // checked on read, never pinned on update, never a gate on anything.
  createdBy: z.string(),
  lastEditedBy: z.string(),
  // Newest first. Travels with the page on a single read rather than sitting in a
  // subcollection, because there is exactly one editor at a time — unlike
  // `batches/observations`, which is append-only with two concurrent writers.
  revisions: z.array(LibraryPageRevisionSchema).default([]),
});

export type LibraryPageRevisionDoc = z.infer<typeof LibraryPageRevisionSchema>;
export type LibraryPageDoc = z.infer<typeof LibraryPageSchema>;

/**
 * Put `snapshot` at the front of `revisions` and drop anything past the cap.
 *
 * Pure, and the ONLY place the array grows — which is what makes
 * `LIBRARY_PAGE_REVISION_CAP` a bound rather than an intention.
 *
 * DEDUPLICATED against the newest revision: a snapshot whose title and body both
 * already match the front of the list is dropped. A revision is captured once per
 * editing session, not per write, and reopening an editor without changing
 * anything must not push a second identical copy — ten revisions of the same text
 * would be the history that cannot restore anything.
 *
 * `savedAt`/`savedBy` are deliberately outside the comparison: two sessions that
 * changed nothing are the same version whoever opened them and whenever.
 */
export function pushRevision(
  revisions: readonly LibraryPageRevisionDoc[],
  snapshot: LibraryPageRevisionDoc,
): LibraryPageRevisionDoc[] {
  const newest = revisions[0];
  if (newest !== undefined && newest.title === snapshot.title && newest.body === snapshot.body) {
    return [...revisions];
  }
  return [snapshot, ...revisions].slice(0, LIBRARY_PAGE_REVISION_CAP);
}
