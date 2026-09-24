/**
 * Who writes `equipmentIcons.subjectBrief` — the matching half of the guard
 * (issue #1519). `scripts/check-subject-brief-writers.mjs` is the walk and the
 * report; this is the judgement, split out so the matcher can be characterised
 * directly the way `rawPalette.mjs` and `schemaCatchSites.mjs` are. A scan that
 * only ever runs over the real tree can be green because the tree matches the
 * doc OR because the matcher stopped matching, and those are not the same
 * thing.
 *
 * ── What this exists for ──────────────────────────────────────────────────
 *
 * Four separate hand-written prose enumerations of "everything that writes
 * `subjectBrief`" existed across three packages and a doc, none derived from
 * the code. They went stale in #1461, when the manifest trigger and the
 * backfill script were recognised as concurrent writers; they were
 * hand-corrected; and they went stale again one PR later (#1482) when
 * `authorEntryIconBrief` landed. CLAUDE.md rule 12 names exactly that failure —
 * an enumeration nothing greps for is a claim with no reader. This is the
 * reader.
 *
 * ── What it checks, and what it does NOT claim ────────────────────────────
 *
 * It compares two lists as MULTISETS, and nothing else:
 *
 *   • the source paths that assign `subjectBrief` under the scan roots, one
 *     entry per assignment, and
 *   • the paths declared in the canonical table in `docs/canon-icons.md`.
 *
 * So a new writer file, a deleted one, and a second writer added inside a file
 * that already had one all go red. What it does not see:
 *
 *   • a write that never spells the field name on the line — an object spread
 *     (`ref.set({ ...patch })`), a computed key (`{ [field]: brief }`), or a
 *     `FieldPath`. None exists today; a future one would evade this entirely,
 *     and saying so is better than implying a completeness the scan lacks.
 *   • anything outside the scan roots. `equipmentIcons` is `allow write: if
 *     false` in firestore.rules, which constrains browsers, not Admin-SDK
 *     code — it does not by itself keep a write out of root `scripts/`, which
 *     already holds five other Admin-SDK operator scripts. The roots are
 *     `apps/cloud-functions/src` and `apps/cloud-functions/scripts` because
 *     that is where the Firestore Admin SDK is actually invoked against this
 *     field today, per a survey of the tree, not because the rules clause
 *     forbids anywhere else — an operator script that writes it from
 *     elsewhere would be a real, undetected fifth site.
 *   • the CATEGORY column, and the prose that cites it. The table says which of
 *     the three buckets a writer sits in; a wrong bucket is a reviewer's job.
 *     The count and the membership are this script's job, and those are the two
 *     halves that broke twice.
 *   • a comment that starts a FIFTH enumeration somewhere new. The four sites
 *     were reduced to pointers at the table (#1519) precisely so there is one
 *     list to keep current; nothing mechanical stops a future comment writing
 *     the list out again in prose.
 */

import ts from 'typescript';

/** Extensions the walk reads. `.mjs` is here for the operator backfill script. */
export const SCAN_EXTENSION = /\.(ts|mjs)$/;

/**
 * Where a writer can live. Both are under `apps/cloud-functions`: `src` for the
 * callables and triggers, `scripts` for the `--apply` backfill, which is an
 * operator tool rather than a path but writes the same field with the same
 * Admin-SDK authority.
 */
export const SCAN_ROOTS = ['apps/cloud-functions/src', 'apps/cloud-functions/scripts'];

/**
 * Directory names the walk never descends into: build output and test
 * fixtures, never a source directory. `lib` is deliberately absent —
 * `apps/cloud-functions/scripts/lib/` holds real source (the testable half of
 * self-executing operator scripts, lifted out the way `kitRerunPlan.ts` is),
 * and it is inside a declared scan root. Skipping it would make that
 * directory a blind spot a writer could sit in un-caught.
 */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '__tests__']);

/**
 * A field assignment, not a read. `subjectBrief:` in an object literal or an
 * update payload matches; `icon.data.subjectBrief` correctly misses because it
 * is a read, and `{ subjectBrief }` shorthand misses because nothing in the
 * tree writes that way today — see the header for why that is stated rather
 * than defended against.
 */
const ASSIGNMENT = /\bsubjectBrief\s*:/;

/**
 * Blank out every comment in a whole file's text before matching, so the
 * prose ABOUT the writers cannot be counted as one.
 *
 * Comments are found the way the compiler finds them, not by a hand-rolled
 * character walk: the text is parsed by `typescript` (the same dependency
 * `schemaCatchSites.mjs` parses with) and every token the parser produced is
 * visited. A comment can only sit in the trivia between two tokens, so the
 * trivia ranges are blanked and every token's own text is kept verbatim. That
 * is what makes a `//` or `/*` inside a regex LITERAL (`/\/\//`, `/[//]/`,
 * `/a\/*b/`), a quoted string or a template literal part of a token rather
 * than a comment opener, and a quote character inside a regex (`/don't/`)
 * part of the regex rather than a string opener. A `//` or `/*` inside a
 * template `${...}` interpolation is real code, not literal text, so it IS a
 * comment opener there and gets stripped like anywhere else. The hand-rolled
 * walker this replaced had no regex state and went green over a real writer
 * on exactly those lines (#1550).
 *
 * Only characters are blanked, never removed, and newlines inside a comment
 * are kept, so line numbers downstream line up with the original file.
 *
 * Its boundary: the file is parsed as TypeScript whatever its extension, with
 * JSDoc parsing off (JSDoc would otherwise be surfaced as nodes rather than
 * trivia), and the above holds for source that parses. On source that does
 * not, the parser's error recovery decides the tokens, and text it skips is
 * re-scanned lexically — where a `/` reads as division, which is the old
 * walker's blindness back again for that file.
 */
function stripComments(text) {
  const sourceFile = ts.createSourceFile(
    'scan.ts',
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind.TS,
  );
  const chars = text.split(''); // UTF-16 units, the indexing the parser's positions use
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  };
  const visit = (node) => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      // A leaf token: [pos, start) is its leading trivia — whitespace and comments only.
      blank(node.pos, node.getStart(sourceFile));
      return;
    }
    children.forEach(visit);
  };
  visit(sourceFile);
  return chars.join('');
}

/**
 * Every `subjectBrief` assignment in one file's text.
 *
 * @param {string} text
 * @returns {{ line: number, text: string }[]} 1-based line numbers.
 */
export function findSubjectBriefWrites(text) {
  const found = [];
  const codeLines = stripComments(text).split('\n');
  const originalLines = text.split('\n');
  codeLines.forEach((code, i) => {
    if (ASSIGNMENT.test(code)) found.push({ line: i + 1, text: originalLines[i].trim() });
  });
  return found;
}

/** Fences around the canonical table in `docs/canon-icons.md`. */
export const TABLE_START = '<!-- subject-brief-writers:start';
export const TABLE_END = '<!-- subject-brief-writers:end';

/**
 * The paths declared by the canonical table, one entry per row — so two writers
 * in one file mean two rows, and the comparison stays a multiset.
 *
 * A row's path is the first backticked token that looks like a repo-root
 * relative source file. The writer's NAME is backticked too and comes first in
 * the row, which is why "looks like a path" (contains `/`, ends in `.ts` or
 * `.mjs`) decides rather than column position.
 *
 * @param {string} markdown Full text of the doc.
 * @returns {{ paths: string[] } | { error: string }}
 */
export function parseDeclaredWriters(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.includes(TABLE_START));
  const end = lines.findIndex((l) => l.includes(TABLE_END));
  if (start === -1 || end === -1 || end < start) {
    return { error: `the ${TABLE_START} … ${TABLE_END} fences are missing or out of order` };
  }

  const paths = [];
  for (const line of lines.slice(start + 1, end)) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/.test(row)) continue; // the --- separator row
    const backticked = [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const path = backticked.find((t) => t.includes('/') && SCAN_EXTENSION.test(t));
    if (path) paths.push(path);
  }

  if (paths.length === 0) return { error: 'the fenced table declares no writer rows' };
  return { paths };
}

/**
 * Compare the two multisets.
 *
 * @param {string[]} found Paths from the scan, one per assignment.
 * @param {string[]} declared Paths from the doc, one per row.
 * @returns {{ missing: string[], extra: string[] }} `missing` are declared and
 *   not found; `extra` are found and not declared. Both empty means agreement.
 */
export function diffWriters(found, declared) {
  const tally = (list) => {
    const counts = new Map();
    for (const p of list) counts.set(p, (counts.get(p) ?? 0) + 1);
    return counts;
  };
  const f = tally(found);
  const d = tally(declared);
  const missing = [];
  const extra = [];
  for (const path of new Set([...f.keys(), ...d.keys()])) {
    const delta = (f.get(path) ?? 0) - (d.get(path) ?? 0);
    for (let i = 0; i < delta; i += 1) extra.push(path);
    for (let i = 0; i < -delta; i += 1) missing.push(path);
  }
  return { missing: missing.sort(), extra: extra.sort() };
}
