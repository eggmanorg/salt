#!/usr/bin/env node
// Rejects a Tailwind default-palette colour in `apps/web-pwa/src` that is not on
// the group-C allowlist (issue #993).
//
// The matcher, the allowlist and the reasoning all live in
// `scripts/lib/rawPalette.mjs` — including what this check deliberately does not
// see. Read that header before adding an entry.
//
// Why a script and not a lint rule: nothing in the toolchain reads a class
// string. `eslint.config.js` carries only import/global/boundary rules, there is
// no eslint-plugin-tailwindcss and no stylelint, `tokens.theme.test.ts` reads
// `salt.css` and never app source, and depcruise is an import-graph tool. That
// blind spot is how 130 raw amber occurrences accumulated across 27 files, and
// CLAUDE.md rule 12 is why naming them was not enough on its own.
//
// Run: pnpm palette:check   (wired into ci.yml's `static` job)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST, findRawPalette } from './lib/rawPalette.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'apps/web-pwa/src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // `.ts` as well as `.svelte`, and that is not incidental: `environment.ts`
    // and `shoppingRowShell.ts` both hold class strings, and a Svelte-only scan
    // is the exact blind spot that let the one raw arm in an otherwise fully
    // tokenised ladder sit unnoticed. app.css's `@source` glob covers both.
    else if (/\.(svelte|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = statSync(SCAN_ROOT).isDirectory() ? walk(SCAN_ROOT) : [];

// Liveness (docs/unit-test-spec.md UT-E2). A scan that has stopped seeing files,
// or stopped seeing Tailwind colour utilities at all, reports green over
// nothing — and nothing else in CI would say so.
if (files.length === 0) {
  console.error('palette:check — the walk found no source files. The scan is broken.');
  process.exit(1);
}
const sources = files.map((file) => ({
  rel: path.relative(REPO_ROOT, file),
  text: readFileSync(file, 'utf8'),
}));
if (!sources.some(({ text }) => /\b(?:bg|text)-(?:primary|muted|foreground|card)\b/.test(text))) {
  console.error('palette:check — no Tailwind colour utility found anywhere. The scan is broken.');
  process.exit(1);
}

const offenders = [];
/** Allowlisted (file, token) pairs actually seen, so a stale entry can red. */
const seen = new Set();

for (const { rel, text } of sources) {
  const allowed = ALLOWLIST[rel];
  for (const { line, token } of findRawPalette(text)) {
    if (allowed?.tokens.includes(token)) {
      seen.add(`${rel} ${token}`);
      continue;
    }
    offenders.push(`${rel}:${line}  ${token}`);
  }
}

const stale = [];
for (const [rel, { tokens }] of Object.entries(ALLOWLIST)) {
  for (const token of tokens) {
    if (!seen.has(`${rel} ${token}`)) stale.push(`${rel}  ${token}`);
  }
}

if (offenders.length > 0) {
  console.error(
    `palette:check FAILED — ${offenders.length} raw default-palette value(s) in apps/web-pwa/src:\n`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error('\nUse a semantic token. The amber vocabulary has four roles (#993):');
  console.error('  review / review-text   written but nobody has checked it');
  console.error('  warning / warning-text a non-blocking problem');
  console.error('  grounds and borders are alpha modifiers — bg-review/10, border-warning/40');
  console.error('A genuinely new colour goes through docs/design/component-tokens.md:');
  console.error('  design.md frontmatter → salt.css → regenerate tokens/*.ts → pin it in');
  console.error('  tokens.theme.test.ts → then consume it.');
  console.error(
    'If the hue IS the datum, or is deliberately outside the theme, add it to the\n' +
      'allowlist in scripts/lib/rawPalette.mjs WITH ITS REASON.',
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    `palette:check FAILED — ${stale.length} allowlist entr(ies) match nothing any more:\n`,
  );
  for (const s of stale) console.error(`  ${s}`);
  console.error('\nDelete them. An allowlist entry over nothing reads as coverage and is not.');
  process.exit(1);
}

console.log(
  `palette:check passed — ${files.length} files, no raw palette outside the ${
    Object.keys(ALLOWLIST).length
  } allowlisted files.`,
);
