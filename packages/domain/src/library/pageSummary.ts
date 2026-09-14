import type { LibraryPageDoc } from '../schemas/libraryPage.js';

/**
 * How much of a page a search line carries, in UTF-16 code units.
 *
 * Long enough to tell one sous-vide table from another and to answer a question
 * outright where the opening lines already do; short enough that a search across
 * the whole library is not a wall of prose in the next model turn. Cut on a word
 * boundary where one is near enough and marked with an ellipsis, the same shape
 * `trimDescription` uses for a recipe's description.
 */
export const LIBRARY_PAGE_SUMMARY_CHARS = 220;

/** Opening or closing fence of a code block. */
const FENCE = /^\s*(?:```|~~~)/;

/** A line carrying no letter and no digit — a rule, a table separator, punctuation. */
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * One line of markdown as prose.
 *
 * Deliberately a SHALLOW strip, not a parser: links and images collapse to their
 * text, the block markers that open a line are dropped, table pipes become spaces
 * and the inline emphasis characters are removed. Anything it does not know about
 * survives as text, which is the right failure — a summary with a stray character
 * in it is readable, and a parser dependency in the pure domain for the sake of
 * one summary line is not worth its weight.
 */
function asProse(line: string): string {
  return (
    line
      // Links and images alike — `[text](href)` and `![alt](src)` — keep their
      // words and lose their target.
      //
      // BOUNDED REPETITIONS, and that is not cosmetic: the unbounded `[^\]]*`
      // this started as is a polynomial ReDoS on a body the household can paste
      // anything into (CodeQL `js/polynomial-redos`, caught on PR #1389). A run of
      // `![` makes the engine rescan from every position, which is quadratic in
      // the length of the line. With a ceiling the work at each start position is
      // capped, so the whole pass is linear. The numbers are generous — a link
      // whose text runs past 256 characters or whose href passes 2048 simply
      // keeps its raw markdown in the summary, which is the shallow strip's
      // stated failure mode already.
      .replace(/!?\[([^\][\n]{0,256})\]\([^()\n]{0,2048}\)/g, '$1')
      // Whatever opens the line: heading hashes, blockquote arrows, bullet and
      // ordered-list markers, in any combination and any order.
      .replace(/^\s*(?:[>#]+\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/\|/g, ' ')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      // Closing hashes of a `## Heading ##`. AFTER the whitespace collapse above,
      // so there is no run of spaces left for it to backtrack across — the same
      // quadratic shape the link rule above avoids.
      .replace(/ ?#+$/, '')
      .trim()
  );
}

function truncate(text: string): string {
  if (text.length <= LIBRARY_PAGE_SUMMARY_CHARS) return text;
  const cut = text.slice(0, LIBRARY_PAGE_SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > LIBRARY_PAGE_SUMMARY_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The opening of a page as one line of prose — its first heading and the prose
 * that follows, markdown markers stripped and cut to `LIBRARY_PAGE_SUMMARY_CHARS`.
 *
 * DERIVED AT CALL TIME AND NEVER STORED (issue #1377). A `summary` field on the
 * document would be a second source of truth for the same prose, drifting from the
 * body the moment somebody edited it and with nothing to notice — the same
 * reasoning #1373 gives for refusing a hand-written equipment summary.
 *
 * WHAT IT IS, precisely, because the sentence above is the loose version: the
 * page's lines in document order, code fences and their contents skipped, lines
 * with no letter or digit in them skipped (horizontal rules, table separators),
 * each one flattened by `asProse` and joined with a space until the budget is
 * spent. On an ordinary page — a heading, then a paragraph — that IS "the first
 * heading and the opening prose". On a page that opens with a table it is the
 * first rows of that table, which is still the most useful two hundred characters
 * available and is not claimed to be anything else.
 */
export function libraryPageSummary(page: Pick<LibraryPageDoc, 'body'>): string {
  const parts: string[] = [];
  let length = 0;
  let inFence = false;
  for (const raw of page.body.split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text = asProse(raw);
    if (!HAS_WORD.test(text)) continue;
    parts.push(text);
    length += text.length + 1;
    if (length >= LIBRARY_PAGE_SUMMARY_CHARS) break;
  }
  return truncate(parts.join(' '));
}
