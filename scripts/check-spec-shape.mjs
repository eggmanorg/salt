#!/usr/bin/env node
// Report whether an issue body is in a shape `/salt-run` can consume.
//
//   node scripts/check-spec-shape.mjs < body.md
//   gh issue view 1234 --json body -q .body | node scripts/check-spec-shape.mjs
//
// Exit 0 = a valid spec issue (the `specced` label belongs on it), 1 = a spec
// issue with problems, 2 = not a spec issue at all. `spec-shape.yml` keys the
// label off those three; a human runs it to see WHY before re-posting.
//
// The check itself, and what it deliberately does not check, is in
// scripts/lib/specIssueShape.mjs.

import { readFileSync } from 'node:fs';

import { classifySpecIssue, SPEC_LABEL, SPEC_VARIANTS } from './lib/specIssueShape.mjs';

const source = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : 0;
const body = readFileSync(source, 'utf8');

const { variant, ok, problems } = classifySpecIssue(body);

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

if (ok) {
  console.log(`${variant} spec (${command}) — runnable. Label \`${SPEC_LABEL}\` applies.`);
  process.exit(0);
}

console.log(`${variant} spec (${command}) — NOT runnable. Label \`${SPEC_LABEL}\` does not apply:`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
