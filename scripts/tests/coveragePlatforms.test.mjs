import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { staleAbovePoints } from '../../coverage.areas.mjs';
import { ratchetFindings, totalsByArea } from '../lib/coverageFileSet.mjs';
import { comparePlatforms, platformsAgree, repoRelative } from '../lib/coveragePlatforms.mjs';

// The two runner roots this actually has to cope with, plus a developer's
// machine — none of which share a prefix with either of the others.
const UBUNTU = '/home/runner/work/salt/salt';
const MACOS = '/Users/runner/work/salt/salt';
const LAPTOP = '/Users/daniel/Projects/salt-vscode';

const fileCoverage = ({ lines = [], branches = [], statementLines } = {}) => ({
  statementMap: Object.fromEntries(
    lines.map((_, i) => [i, { start: { line: statementLines ? statementLines[i] : i + 1 } }]),
  ),
  s: Object.fromEntries(lines.map((hits, i) => [i, hits])),
  b: Object.fromEntries(branches.map((arms, i) => [i, arms])),
});

const arms = (covered, uncovered) => [
  ...Array.from({ length: covered }, () => 1),
  ...Array.from({ length: uncovered }, () => 0),
];

const report = (root, files) =>
  Object.fromEntries(
    Object.entries(files).map(([file, coverage]) => [`${root}/${file}`, coverage]),
  );

/** The same tree, measured identically — the state every green run is in. */
const AGREED = {
  'apps/web-pwa/src/routes/RecipeViewPage.svelte': fileCoverage({
    lines: [1, 1, 0, 2],
    branches: [arms(3, 1), arms(1, 2)],
  }),
  'packages/domain/src/index.ts': fileCoverage({ lines: [1, 1], branches: [arms(2, 0)] }),
};

describe('repoRelative', () => {
  it('re-roots each runner’s absolute path onto the same repo-relative key', () => {
    const file = 'apps/web-pwa/src/routes/RecipeViewPage.svelte';
    for (const root of [UBUNTU, MACOS, LAPTOP]) {
      expect(repoRelative(`${root}/${file}`, ['apps', 'packages'])).toBe(file);
    }
  });

  // A key this cannot place must NOT be silently paired with another: pairing
  // two files by a guess is how a comparison reports agreement it never made.
  it('returns null for a path holding no repo-relative segment', () => {
    expect(repoRelative('/tmp/scratch/coverage.json', ['apps', 'packages'])).toBeNull();
  });

  // `salt/salt` on the runners, and a developer whose checkout is under
  // `~/Projects/apps/…` would be the other way this bites. The LAST occurrence
  // is not the answer either; the FIRST one is the repo root by construction.
  it('splits at the first repo-relative segment, not a later repeat of it', () => {
    expect(repoRelative(`${UBUNTU}/apps/web-pwa/src/apps/inner.ts`, ['apps', 'packages'])).toBe(
      'apps/web-pwa/src/apps/inner.ts',
    );
  });
});

describe('comparePlatforms', () => {
  it('finds nothing when both platforms measured the same tree identically', () => {
    const comparison = comparePlatforms(report(UBUNTU, AGREED), report(MACOS, AGREED));

    expect(comparison.compared).toBe(2);
    expect(comparison.moved).toEqual([]);
    expect(comparison.onlyIn).toEqual([]);
    expect(platformsAgree(comparison)).toBe(true);
  });

  // THE #967 SHAPE: a test waiting on host timing instead of driving it, so a
  // line runs on one runner and not the other. Totals unchanged, coverage moved.
  it('names the file and the metric when one platform covers a line the other does not', () => {
    const divergent = {
      ...AGREED,
      'apps/web-pwa/src/routes/RecipeViewPage.svelte': fileCoverage({
        lines: [1, 1, 1, 2],
        branches: [arms(3, 1), arms(1, 2)],
      }),
    };
    const comparison = comparePlatforms(report(UBUNTU, AGREED), report(MACOS, divergent));

    expect(platformsAgree(comparison)).toBe(false);
    expect(comparison.moved).toHaveLength(1);
    expect(comparison.moved[0].file).toBe('apps/web-pwa/src/routes/RecipeViewPage.svelte');
    expect(comparison.moved[0].differing).toEqual(['lineCovered']);
    expect(comparison.moved[0].a.lineCovered).toBe(3);
    expect(comparison.moved[0].b.lineCovered).toBe(4);
  });

  // THE #977 SHAPE: load order decides which top-level paths execute, so the
  // set of INSTRUMENTED branches moves — a changed denominator, which is what
  // #1328 actually observed (uncovered count identical at 1748 on both sides).
  it('catches a moved branch denominator, not only moved coverage', () => {
    const divergent = {
      ...AGREED,
      'packages/domain/src/index.ts': fileCoverage({ lines: [1, 1], branches: [arms(2, 1)] }),
    };
    const comparison = comparePlatforms(report(UBUNTU, AGREED), report(MACOS, divergent));

    expect(comparison.moved[0].differing).toEqual(['branchTotal']);
  });

  it('reports a file only one platform measured, and says which side', () => {
    const extra = { ...AGREED, 'packages/domain/src/only-here.ts': fileCoverage({ lines: [1] }) };
    const comparison = comparePlatforms(report(UBUNTU, AGREED), report(MACOS, extra));

    expect(comparison.onlyIn).toEqual([{ file: 'packages/domain/src/only-here.ts', side: 'b' }]);
    expect(platformsAgree(comparison)).toBe(false);
  });

  it('surfaces unplaceable paths rather than dropping them', () => {
    const comparison = comparePlatforms(
      { '/tmp/nowhere/mystery.ts': fileCoverage({ lines: [1] }), ...report(UBUNTU, AGREED) },
      report(MACOS, AGREED),
    );

    expect(comparison.unplaceable.a).toEqual(['/tmp/nowhere/mystery.ts']);
    expect(platformsAgree(comparison)).toBe(false);
  });
});

describe('platformsAgree', () => {
  // The failure mode this guard would otherwise SHARE with the claim it
  // replaces: a green that means "unchecked". Two empty reports differ in
  // nothing, and nothing is not agreement (CLAUDE.md Rule 12).
  it('refuses to call a comparison of zero files a pass', () => {
    const comparison = comparePlatforms({}, {});

    expect(comparison.compared).toBe(0);
    expect(comparison.moved).toEqual([]);
    expect(platformsAgree(comparison)).toBe(false);
  });
});

// WHY THIS GUARD EXISTS AT ALL, pinned rather than asserted in a comment.
//
// The obvious objection to a whole extra CI job is "run the ratchet on macOS
// too and be done". This is the case that answers it: a divergence the ratchet
// calls green on BOTH platforms, because it compares each one against a pin and
// never against the other. It is also the shape #1328 reported — a moved branch
// denominator with the covered count intact — so the case is not hypothetical.
describe('the divergence the ratchet structurally cannot see', () => {
  const glob = 'packages/domain/src/**';

  // Magnitudes matter here and small fixtures cannot make this point: the
  // staleness tolerance is a full coverage POINT, so a divergence only hides
  // inside it at a denominator where a point is worth more than one arm. These
  // are the order of magnitude of the area the defect was reported against —
  // `apps/web-pwa/src/routes/**` carries ~6,300 branch arms.
  //
  // Both platforms leave the SAME 2,703 branches uncovered. What differs is how
  // many the run instrumented at all, which is the #1328 observation exactly
  // (uncovered identical at 1748 on both sides, the ratio 0.02 apart) and the
  // #977 mechanism: load order decides which top-level paths execute.
  const branchesOn = (total) =>
    fileCoverage({ lines: [1, 1], branches: [arms(total - 2703, 2703)] });

  const onUbuntu = { 'packages/domain/src/index.ts': branchesOn(10000) }; // 72.97%
  const onMacos = { 'packages/domain/src/index.ts': branchesOn(10050) }; // 73.10%

  // Pinned AT ubuntu's measurement, with no margin — which is what the header
  // says every pin in this repo is, and the practice this whole issue is about
  // making safe.
  const pin = {
    [glob]: { lines: 100, branches: 72.97, uncoveredLines: 0, uncoveredBranches: 2703 },
  };

  const findingsFor = (files) =>
    // The repo's own tolerance, so this case cannot be an artefact of a number
    // chosen to make the point.
    ratchetFindings(totalsByArea(files, [glob]), pin, { staleAbove: staleAbovePoints });

  it('is green on the ratchet on each platform taken alone', () => {
    expect(findingsFor(onUbuntu)).toEqual([]);
    expect(findingsFor(onMacos)).toEqual([]);
  });

  it('and is red here', () => {
    const comparison = comparePlatforms(report(UBUNTU, onUbuntu), report(MACOS, onMacos));

    expect(platformsAgree(comparison)).toBe(false);
    expect(comparison.moved[0].differing).toEqual(['branchTotal', 'branchCovered']);
  });
});

// THE COMMENT AND THE MECHANISM IT NAMES.
//
// `coverage.areas.mjs`' header now says the cross-platform claim is checked, and
// names the job that checks it. That sentence is true only while the job exists
// and still does what it says — and deleting a CI job does not touch the comment
// that promises it, which is the second construction path CLAUDE.md Rule 12
// warns about: a true sentence going false somewhere else entirely. Before this
// issue the header's claim was guaranteed by nothing; a claim guaranteed by a
// job nobody checks is still guaranteed by nothing.
describe('the header claim and the CI job that backs it', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const areasHeader = readFileSync(join(repoRoot, 'coverage.areas.mjs'), 'utf8');

  it('runs the suite on a second platform and compares the two reports', () => {
    expect(ci).toMatch(/^ {2}unit-macos:$/m);
    expect(ci).toContain('runs-on: macos-latest');
    expect(ci).toMatch(/^ {2}coverage-platforms:$/m);
    expect(ci).toContain('needs: [unit, unit-macos]');
    expect(ci).toContain('node scripts/check-coverage-platforms.mjs');
  });

  it('feeds it BOTH uploaded reports, since one of them compares to nothing', () => {
    expect(ci).toContain('name: coverage-unit\n');
    expect(ci).toContain('name: coverage-unit-macos\n');
    expect(ci).toContain('coverage-ubuntu/coverage-final.json');
    expect(ci).toContain('coverage-macos/coverage-final.json');
  });

  // The header says the check reds without blocking a merge, and that is the
  // whole of why it is tolerable to red on somebody else's PR. Putting the job
  // into the aggregator's `needs` would silently convert it into a merge gate
  // and leave the sentence describing a policy the repo no longer has.
  it('is kept out of the `ci` aggregator, which is what makes it non-blocking', () => {
    const aggregator = ci.match(/^ {2}ci:\n(?: {4}.*\n| *\n)*/m)?.[0] ?? '';
    expect(aggregator).toContain('needs: [static, types, unit, boot-payload]');
    expect(aggregator).not.toContain('coverage-platforms');
  });

  it('and the header still points at that job by name', () => {
    expect(areasHeader).toContain('coverage-platforms');
    expect(areasHeader).toContain('scripts/check-coverage-platforms.mjs');
  });
});
