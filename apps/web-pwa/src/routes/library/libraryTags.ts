// How a page's tags are typed, and what gets stored (epic #1372, Phase 1).
//
// Tags are typed as one comma-separated line and stored as a list. A chip editor
// would be a better thing to build second; this is the shape that needs no new
// component and reads the same as the row of chips it produces.
//
// Its own module rather than a closure inside the page, because it is the only
// part of that screen with a rule in it — everything else there is "put what was
// typed into the document" — and a rule deserves to be tested without mounting a
// page to reach it.

/**
 * The tags in a typed line: split on commas, trimmed, blanks dropped, and
 * duplicates collapsed CASE-INSENSITIVELY.
 *
 * The words themselves are kept exactly as typed. Case-folding the comparison but
 * not the value is deliberate: "fermentation" typed twice should not become two
 * chips, but a tag is a word somebody chose and lower-casing what is stored would
 * rewrite it. The FIRST spelling wins, which is the one already on the page.
 */
export function parseTagLine(line: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of line.split(',')) {
    const tag = raw.trim();
    if (tag === '' || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}
