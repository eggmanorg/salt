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
 *     false` in firestore.rules, so only Cloud Functions and the operator
 *     scripts beside them can reach it — the roots follow from that rule, not
 *     from a survey of where writes happen to live today.
 *   • the CATEGORY column, and the prose that cites it. The table says which of
 *     the three buckets a writer sits in; a wrong bucket is a reviewer's job.
 *     The count and the membership are this script's job, and those are the two
 *     halves that broke twice.
 *   • a comment that starts a FIFTH enumeration somewhere new. The four sites
 *     were reduced to pointers at the table (#1519) precisely so there is one
 *     list to keep current; nothing mechanical stops a future comment writing
 *     the list out again in prose.
 */

/** Extensions the walk reads. `.mjs` is here for the operator backfill script. */
export const SCAN_EXTENSION = /\.(ts|mjs)$/;

/**
 * Where a writer can live. Both are under `apps/cloud-functions`: `src` for the
 * callables and triggers, `scripts` for the `--apply` backfill, which is an
 * operator tool rather than a path but writes the same field with the same
 * Admin-SDK authority.
 */
export const SCAN_ROOTS = ['apps/cloud-functions/src', 'apps/cloud-functions/scripts'];

/** Directory names the walk never descends into. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', 'tests', '__tests__']);

/**
 * A field assignment, not a read. `subjectBrief:` in an object literal or an
 * update payload matches; `icon.data.subjectBrief` correctly misses because it
 * is a read, and `{ subjectBrief }` shorthand misses because nothing in the
 * tree writes that way today — see the header for why that is stated rather
 * than defended against.
 */
const ASSIGNMENT = /\bsubjectBrief\s*:/;

/**
 * Line comments are stripped and block-comment bodies skipped before matching,
 * so the prose ABOUT the writers cannot be counted as one. The strip is
 * textual: a `//` inside a string literal would truncate the line early. No
 * line in the scan roots is written that way, and the failure it would cause is
 * a false NEGATIVE — a writer the doc then over-declares, which this check
 * still reds on.
 */
function codeOf(line) {
  if (/^\s*(\/\*|\*)/.test(line)) return '';
  return line.replace(/\/\/.*$/, '');
}

/**
 * Every `subjectBrief` assignment in one file's text.
 *
 * @param {string} text
 * @returns {{ line: number, text: string }[]} 1-based line numbers.
 */
export function findSubjectBriefWrites(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (ASSIGNMENT.test(codeOf(line))) found.push({ line: i + 1, text: line.trim() });
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
