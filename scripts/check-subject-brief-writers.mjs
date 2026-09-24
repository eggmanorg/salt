#!/usr/bin/env node
// Holds the canonical list of `equipmentIcons.subjectBrief` writers honest
// (issue #1519). The list lives in `docs/canon-icons.md` → "Who writes
// `subjectBrief`"; this compares it against the code and fails when the two
// disagree.
//
// Why a script and not a comment: four prose enumerations of this set existed
// across three packages and a doc, and all four went stale twice on the same
// mechanism — a PR added a writer and touched none of them (#1461, then #1482).
// Nothing greps for writers of a Firestore field, so nothing ever noticed.
// CLAUDE.md rule 12's first option is to pin the claim with something that goes
// red; this is that pin, and #1519 also reduced the four enumerations to one so
// there is a single place for it to be red ABOUT.
//
// The matcher, the scan roots and — importantly — what this deliberately cannot
// see all live in `scripts/lib/subjectBriefWriters.mjs`. Read that header before
// adding a writer or widening the scan.
//
// Run: pnpm briefwriters:check   (wired into ci.yml's `static` job)

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCAN_EXTENSION,
  SCAN_ROOTS,
  SKIP_DIRS,
  TABLE_START,
  diffWriters,
  findSubjectBriefWrites,
  parseDeclaredWriters,
} from './lib/subjectBriefWriters.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/canon-icons.md';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXTENSION.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((root) => {
  const full = path.join(REPO_ROOT, root);
  return existsSync(full) ? walk(full) : [];
});

// Liveness (docs/unit-test-spec.md UT-E2). A walk that has stopped seeing files
// reports green over nothing, and nothing else in CI would say so.
if (files.length === 0) {
  console.error('briefwriters:check — the walk found no source files. The scan is broken.');
  process.exit(1);
}

/** One entry per assignment, so two writers in one file count twice. */
const found = [];
/** Human-readable sites, for the failure report only. */
const sites = [];
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  for (const { line, text } of findSubjectBriefWrites(readFileSync(file, 'utf8'))) {
    found.push(rel);
    sites.push(`${rel}:${line}  ${text}`);
  }
}

// The second liveness arm, and the one that matters more: the field is written
// by at least one thing in every state of the world this check is designed for.
// Zero means the matcher stopped matching, not that the writers went away.
if (found.length === 0) {
  console.error(
    `briefwriters:check — no \`subjectBrief\` assignment found anywhere under\n` +
      `  ${SCAN_ROOTS.join(', ')}\n` +
      'The matcher is broken, or the field was renamed. Either way this is not a pass.',
  );
  process.exit(1);
}

const docPath = path.join(REPO_ROOT, DOC);
if (!existsSync(docPath)) {
  console.error(`briefwriters:check — ${DOC} is missing; it holds the canonical writer list.`);
  process.exit(1);
}

const declared = parseDeclaredWriters(readFileSync(docPath, 'utf8'));
if (declared.error) {
  console.error(`briefwriters:check FAILED — ${DOC}: ${declared.error}.`);
  console.error(`\nThe list is the table fenced by \`${TABLE_START} … -->\` under`);
  console.error('"Who writes `subjectBrief`". Restore it rather than deleting this check.');
  process.exit(1);
}

const { missing, extra } = diffWriters(found, declared.paths);

if (missing.length > 0 || extra.length > 0) {
  console.error(`briefwriters:check FAILED — the code and ${DOC} disagree about who writes`);
  console.error('`equipmentIcons.subjectBrief`.\n');
  if (extra.length > 0) {
    console.error('  In the code, not in the table:');
    for (const p of extra) console.error(`    ${p}`);
  }
  if (missing.length > 0) {
    console.error('  In the table, not in the code:');
    for (const p of missing) console.error(`    ${p}`);
  }
  console.error('\nEvery assignment the scan found:');
  for (const s of sites) console.error(`  ${s}`);
  console.error(`\nFix it in ${DOC} → "Who writes \`subjectBrief\`": add, remove or re-bucket`);
  console.error('the row. The table is the ONE enumeration — the comments in');
  console.error('  apps/cloud-functions/src/index.ts');
  console.error('  apps/cloud-functions/src/flows/describeEquipmentSubject.ts');
  console.error('  apps/web-pwa/src/lib/equipmentService.ts');
  console.error('  packages/adapters/firebase-sync/src/equipmentIconSubscription.ts');
  console.error('point at it and must not restate it (#1519). A new writer also needs a');
  console.error('CATEGORY, which this check cannot judge: say how its sentence is obtained,');
  console.error('and if it fits none of the three buckets, add a fourth rather than blurring one.');
  process.exit(1);
}

console.log(
  `briefwriters:check passed — ${found.length} \`subjectBrief\` writer(s) across ` +
    `${new Set(found).size} file(s), matching ${DOC}.`,
);
