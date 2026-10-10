import { LIBRARY_BLOCK_FENCE_PREFIX, parseLibraryBlock } from '../schemas/libraryBlocks.js';

// What makes a page the page writer laid out SAFE TO SAVE in place of the
// chef's draft (issue #1663). The page writer is a second model call that
// rewrites a body the chef already wrote; these are the mechanical checks that
// decide whether its rewrite is kept, and the CF handler keeps the draft on any
// failure. Pure, so the decision can be pinned here rather than only in the
// Cloud Function that acts on it.

/** One `salt-*` fenced block found in a body. */
export interface FoundLibraryBlock {
  /** The part of the info string after `salt-`. */
  readonly kind: string;
  /** The text between the fences. */
  readonly source: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every `salt-*` fenced code block in `body`, in order.
 *
 * A line scanner, not a Markdown parser, and its boundary is stated rather than
 * implied: it sees fences at the TOP LEVEL of the document (up to three spaces
 * of indentation, the CommonMark limit) and not fences nested inside a list item
 * or a block quote. It does track every fence, not only `salt-` ones, so a
 * `salt-` fence quoted inside an ordinary code block is correctly NOT a block. An
 * unclosed fence runs to the end of the body, as CommonMark says it does.
 */
export function findLibraryBlocks(body: string): FoundLibraryBlock[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const found: FoundLibraryBlock[] = [];
  let i = 0;
  // Each `!` below is total: `lines[i]` is read only inside `i < lines.length`,
  // both FENCE_OPEN groups always participate in a match, and `split` never
  // returns an empty array.
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1]!;
    const info = open[2]!.trim();
    // A backtick fence's info string may not itself contain a backtick.
    if (fence.startsWith('`') && info.includes('`')) {
      i++;
      continue;
    }
    const closing = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const content: string[] = [];
    i++;
    while (i < lines.length && !closing.test(lines[i]!)) {
      content.push(lines[i]!);
      i++;
    }
    i++; // past the closing fence (or past the end)
    const word = info.split(/\s+/)[0]!;
    if (word.startsWith(LIBRARY_BLOCK_FENCE_PREFIX)) {
      found.push({
        kind: word.slice(LIBRARY_BLOCK_FENCE_PREFIX.length),
        source: content.join('\n'),
      });
    }
  }
  return found;
}

// An ordered-list marker is structure, not a figure: a numbered list the page
// writer turns into cards has no reason to keep "1." and "2.", and counting
// them would throw away a good layout for losing a bullet.
const ORDERED_LIST_MARKER = /^[ \t]*\d{1,9}[.)](?=[ \t]|$)/gm;
const NUMBER = /\d+(?:\.\d+)?/g;

/** Every number in `text`, ordered-list markers aside, as written. */
export function figuresIn(text: string): string[] {
  return text.replace(ORDERED_LIST_MARKER, '').match(NUMBER) ?? [];
}

/**
 * The figures in `draft` that `composed` does not carry — as a MULTISET, so a
 * draft saying 175 twice needs 175 twice. Empty means every figure survived.
 *
 * Compared as WRITTEN: "6.3" and "6.30" are different figures here, and so are
 * "1,062" and "1062" (the first is two figures, 1 and 062). That errs towards
 * keeping the chef's draft, which is the safe direction. Figures the composed
 * body ADDS — a total in a stats block — are allowed.
 *
 * Its boundary: it checks that every number token is still SOMEWHERE on the
 * page, not that it is still attached to the same item, sign or unit. A figure
 * moved to a different item (duck 175 / steak 200 swapped), a dropped minus
 * sign ("-18 °C" → "18 °C") and a changed unit all pass.
 */
export function missingFigures(draft: string, composed: string): string[] {
  const have = new Map<string, number>();
  for (const f of figuresIn(composed)) have.set(f, (have.get(f) ?? 0) + 1);
  const missing: string[] = [];
  for (const f of figuresIn(draft)) {
    const n = have.get(f) ?? 0;
    if (n === 0) missing.push(f);
    else have.set(f, n - 1);
  }
  return missing;
}

export type ComposedPageCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Any line that opens a `salt-` fence, at any indentation and under any run of
// list markers or `>` quote markers — deliberately looser than
// `findLibraryBlocks`, which sees top-level fences only while the renderer draws
// one nested in a list item or block quote too.
const LOOSE_SALT_FENCE_OPEN = /^[ \t>*+\-\d.)]*(?:`{3,}|~{3,})[ \t]*salt-/gm;

/**
 * Whether `composed` may be saved in place of `draft`.
 *
 * Refused when it is blank, longer than `maxLength`, carries a `salt-*` fence
 * the top-level scan cannot see (nested in a list or quote, or quoted inside
 * another code block — so it cannot be checked), carries a `salt-*` block that
 * does not parse, or is missing a number token the draft held (`missingFigures`
 * states what that does not catch). Also refused: a `salt-shapes` measurement
 * that is not a figure in the draft — a shape is drawn to scale from its
 * measurements, so a measurement the page writer made up draws a wrong picture
 * that looks exact. Its boundary: the number must appear SOMEWHERE in the draft,
 * so a made-up height that happens to equal a capacity elsewhere still passes.
 * The `reason` is for the log, not for the household.
 */
export function checkComposedPage(
  draft: string,
  composed: string,
  maxLength: number,
): ComposedPageCheck {
  if (composed.trim() === '') return { ok: false, reason: 'blank' };
  if (composed.length > maxLength) return { ok: false, reason: 'too long' };
  const blocks = findLibraryBlocks(composed);
  const opened = composed.replace(/\r\n?/g, '\n').match(LOOSE_SALT_FENCE_OPEN)?.length ?? 0;
  if (opened > blocks.length) return { ok: false, reason: 'salt- block not at top level' };
  const drafted = new Set(figuresIn(draft));
  for (const block of blocks) {
    const parsed = parseLibraryBlock(block.kind, block.source);
    if (!parsed.ok) return { ok: false, reason: `salt-${block.kind}: ${parsed.problem}` };
    if (parsed.block.kind === 'shapes') {
      const guessed = parsed.block.data.shelves
        .flatMap((shelf) => shelf.items)
        .flatMap((s) => [s.mouth, s.height, s.width, s.base])
        .flatMap((f) => (f ? figuresIn(f.text) : []))
        .find((f) => !drafted.has(f));
      if (guessed !== undefined) {
        return { ok: false, reason: `salt-shapes: ${guessed} is not a measurement in the draft` };
      }
    }
  }
  const missing = missingFigures(draft, composed);
  if (missing.length > 0) return { ok: false, reason: `figures lost: ${missing.join(', ')}` };
  return { ok: true };
}
