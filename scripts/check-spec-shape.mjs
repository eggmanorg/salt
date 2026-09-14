#!/usr/bin/env node
// Report whether an issue is one `/salt-run` can consume — and whether the
// `specced` label belongs on it, which is not quite the same question.
//
//   node scripts/check-spec-shape.mjs < body.md
//   node scripts/check-spec-shape.mjs body.md --title-file title.txt
//   gh issue view 1234 --json body -q .body | node scripts/check-spec-shape.mjs
//
// Exit 0 = the `specced` label belongs on it, 1 = a spec body that must not
// carry the label, 2 = not a spec issue at all. `spec-shape.yml` keys the label
// off those three; a human runs it to see WHY before re-posting.
//
// `--title-file` IS OPTIONAL AND CHANGES NOTHING WHEN ABSENT. Without it the
// verdict is the body's shape alone, byte for byte as before — which is how the
// spec commands' own verification step invokes this, with no issue to take a
// title from yet. With it, an issue titled `epic…` is refused the label however
// well-formed its body is: an epic is a container that is never built, and one
// in a spec shape is runnable by construction (#1378).
//
// The check itself, and what it deliberately does not check, is in
// scripts/lib/specIssueShape.mjs.

import { readFileSync } from 'node:fs';

import { SPEC_LABEL, SPEC_VARIANTS, specLabelVerdict } from './lib/specIssueShape.mjs';

const argv = process.argv.slice(2);
const titleFlag = argv.indexOf('--title-file');
if (titleFlag !== -1 && argv[titleFlag + 1] === undefined) {
  console.error('--title-file needs a path');
  process.exit(2);
}
const titleFile = titleFlag === -1 ? null : argv[titleFlag + 1];
const consumed = titleFlag === -1 ? new Set() : new Set([titleFlag, titleFlag + 1]);
const positional = argv.filter((arg, index) => !consumed.has(index) && !arg.startsWith('--'));

const source = positional[0] && positional[0] !== '-' ? positional[0] : 0;
const body = readFileSync(source, 'utf8');
// A title file is read as-is and trimmed: `jq -r` leaves a trailing newline, and
// the predicate anchors at the start so leading whitespace would defeat it.
const title = titleFile === null ? '' : readFileSync(titleFile, 'utf8').trim();

const { variant, problems, epic, applies } = specLabelVerdict({ title, body });

if (!variant) {
  console.log(
    'not a spec issue — no /salt-spec, /salt-defect or /salt-refactor signature heading found.',
  );
  console.log(
    `  expected one of: ${SPEC_VARIANTS.map((entry) => `## ${entry.signature} (${entry.command})`).join(', ')}`,
  );
  process.exit(2);
}

const command = SPEC_VARIANTS.find((entry) => entry.id === variant).command;

if (applies) {
  console.log(`${variant} spec (${command}) — runnable. Label \`${SPEC_LABEL}\` applies.`);
  process.exit(0);
}

// A category error, not a list of shape complaints — say so in the headline, so
// the step summary this lands in reads as "wrong kind of issue" rather than
// "nearly a spec".
console.log(
  epic
    ? `epic — MUST NOT be runnable. Label \`${SPEC_LABEL}\` does not apply:`
    : `${variant} spec (${command}) — NOT runnable. Label \`${SPEC_LABEL}\` does not apply:`,
);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
