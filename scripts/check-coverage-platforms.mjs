#!/usr/bin/env node
// The check behind `coverage.areas.mjs`' cross-platform claim (issue #1333).
//
// That file's header says its pins carry NO MARGIN, and the justification it
// gives is that macOS and CI's ubuntu-latest measure the same tree identically.
// Until this existed, nothing anywhere checked that sentence — an unqualified
// absolute guaranteed by a comment, which is the defect class CLAUDE.md Rule 12
// names. The premise is load-bearing: where two platforms disagree by so much
// as a hundredth, a pin set with no margin on one of them is a red build on the
// other, and the recorded fix for that red is always a lower pin.
//
// WHY THE RATCHET COULD NOT DO THIS, on any number of runners. It compares one
// measurement against a pin, never two measurements against each other, so it
// sees a divergence only when one side lands BELOW the pin. A platform
// measuring anything from the pinned figure up to a full staleness point above
// it passes silently — and that band is exactly where the divergence #1328
// chased was reported to live (0.02 of a branch point). Comparing the reports
// to each other is a different question and needs a different check.
//
// Run: pnpm coverage:platforms:check <report-a.json> <report-b.json> [labels]
// Wired into ci.yml's `coverage-platforms` job, which is the only place both
// reports exist at once. Deliberately NOT in the `ci` aggregator's `needs`: a
// platform divergence is a real defect and must be visible, but it is a defect
// in the measurement estate rather than in the PR that surfaced it, and holding
// somebody's merge hostage to it would teach exactly the reflex — make the red
// go away — that this guard exists to remove.

import { readFileSync, existsSync } from 'node:fs';
import { COMPARED_TOTALS, comparePlatforms, platformsAgree } from './lib/coveragePlatforms.mjs';

const [pathA, pathB, labelA = 'A', labelB = 'B'] = process.argv.slice(2);

if (!pathA || !pathB) {
  console.error(
    'Usage: node scripts/check-coverage-platforms.mjs <report-a.json> <report-b.json> ' +
      '[label-a] [label-b]\n\n' +
      'Each report is a `coverage/unit/coverage-final.json` produced by `pnpm test:coverage` ' +
      'on one platform, at the SAME COMMIT as the other. Comparing two commits answers a ' +
      'different question and this cannot tell the difference.',
  );
  process.exit(2);
}

// Missing input fails LOUDLY, unlike the two coverage guards beside it, which
// exit 0 when no report exists. Their reasoning does not carry: they run in the
// job that produces the report, so "no report" there means the suite already
// failed for a better reason. Here the reports arrive as downloaded artifacts,
// so a missing one means the download broke — and a check that shrugs at
// "nothing to compare" is a green that means unchecked.
for (const [label, file] of [
  [labelA, pathA],
  [labelB, pathB],
]) {
  if (!existsSync(file)) {
    console.error(`No coverage report for ${label} at ${file} — nothing to compare against.`);
    process.exit(1);
  }
}

const comparison = comparePlatforms(
  JSON.parse(readFileSync(pathA, 'utf8')),
  JSON.parse(readFileSync(pathB, 'utf8')),
);

if (platformsAgree(comparison)) {
  console.log(
    `Coverage measures identically on ${labelA} and ${labelB}: ${comparison.compared} files, ` +
      'same line and branch totals on every one.\n\n' +
      "This is what `coverage.areas.mjs`' no-margin rule rests on — the pins are set AT the " +
      'measurement, so a platform disagreeing by a hundredth is a red build there.',
  );
  process.exit(0);
}

console.error(`Coverage does NOT measure identically on ${labelA} and ${labelB}.\n`);

if (comparison.compared === 0) {
  console.error(
    'Zero files were compared, which is not agreement — it is a comparison that never happened. ' +
      'Either both reports are empty or their paths no longer re-root onto a repo-relative key. ' +
      'Fix the inputs; do not read this as a pass.\n',
  );
}

for (const [label, unplaceable] of [
  [labelA, comparison.unplaceable.a],
  [labelB, comparison.unplaceable.b],
]) {
  if (unplaceable.length > 0) {
    console.error(
      `${unplaceable.length} path(s) in ${label}'s report hold no repo-relative segment and were ` +
        `not compared, e.g. ${unplaceable[0]}. That is a broken input, not a divergence.\n`,
    );
  }
}

for (const { file, side } of comparison.onlyIn) {
  console.error(`  ONLY ON ${side === 'a' ? labelA : labelB}: ${file}`);
}

for (const { file, differing, a, b } of comparison.moved) {
  console.error(`  ${file}`);
  for (const key of COMPARED_TOTALS.filter((k) => differing.includes(k))) {
    console.error(`      ${key.padEnd(13)} ${labelA}=${a[key]}  ${labelB}=${b[key]}`);
  }
}

console.error(
  `\n${comparison.moved.length} file(s) measured differently and ${comparison.onlyIn.length} ` +
    `reached only one platform, out of ${comparison.compared} compared.\n\n` +
    'THE FIX IS AT THE SOURCE, never a pin. Both times this has happened the cause was a test ' +
    'rather than a platform: #967 was two tests waiting on host timing instead of driving it ' +
    '(unit-test-spec UT-F5, UT-F2), and #977 was a fire-and-forget `import()` still in flight at ' +
    'worker teardown, corrupting the v8 merge. Lowering a pin to whichever platform reads lower ' +
    'manufactures exactly the margin `coverage.areas.mjs` forbids, and it was already tried and ' +
    'discarded once (#1328).',
);

process.exit(1);
