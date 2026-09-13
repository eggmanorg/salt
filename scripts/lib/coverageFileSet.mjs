// Set arithmetic behind `scripts/check-coverage-files.mjs`, kept apart from the
// IO so it can be unit-tested without first producing a coverage report.
//
// `path.matchesGlob` rather than a dependency: the globs in `coverage.areas.mjs`
// use only `*`, `**` and `{a,b}`, which Node matches with the same semantics
// vitest's own globber does. `scripts/check-docs-map.mjs` matches globs the same
// way for the same reason.

import path from 'node:path';

const matchesAny = (file, globs) => globs.some((glob) => path.matchesGlob(file, glob));

/**
 * The files the coverage globs name, out of the files git actually tracks.
 * Tracked files are the right universe: they exclude `node_modules` and build
 * output without needing an ignore list of our own.
 */
export function expectedCoverageFiles(trackedFiles, { include, exclude }) {
  return trackedFiles
    .filter((file) => matchesAny(file, include) && !matchesAny(file, exclude))
    .sort();
}

/**
 * How the report and the globs disagree.
 *
 * `missing` is the failure this whole guard exists for: a file the globs name
 * that never reached the report, which means it left the denominator instead of
 * counting as 0%. `unexpected` is the mirror image and is split by whether git
 * tracks the file, because an untracked one is a local working-tree artefact
 * rather than a broken glob.
 */
export function diffCoverageFiles(expected, actual, trackedFiles) {
  const inReport = new Set(actual);
  const named = new Set(expected);
  const tracked = new Set(trackedFiles);
  const extra = actual.filter((file) => !named.has(file)).sort();

  return {
    missing: expected.filter((file) => !inReport.has(file)),
    unexpected: extra.filter((file) => tracked.has(file)),
    untracked: extra.filter((file) => !tracked.has(file)),
  };
}

/** How many files sit behind each per-area floor. */
export function countByArea(files, areas) {
  return areas.map((glob) => ({
    glob,
    count: files.filter((file) => path.matchesGlob(file, glob)).length,
  }));
}

// ---------------------------------------------------------------------------
// The arithmetic behind `scripts/check-coverage-ratchet.mjs` (issue #1133)
// ---------------------------------------------------------------------------
// Everything below reproduces what VITEST enforces, deliberately and to the
// last decimal, because a check that disagreed with the thing it is guarding
// would be worse than none: it would red a PR vitest calls green, or print a
// replacement pin that fails the moment it is pasted.
//
// The source of truth is vitest's `BaseCoverageProvider.checkThresholds`, which
// compares `coverageMap.getCoverageSummary().data[metric].pct` against the pin.
// That summary is istanbul-lib-coverage's, so:
//   - a LINE is a statement's start line, hit-counted by the MAXIMUM of the
//     statements starting on it (`FileCoverage.getLineCoverage`);
//   - a BRANCH is one arm, counted flat across every entry in `b`;
//   - an area's figure is the sum of its files' totals, percentaged once at the
//     end (`CoverageSummary.merge`) — never an average of per-file percentages.
//
// ONE DELIBERATE NARROWING of that claim, and it is a narrowing rather than an
// exception (issue #1161). `trackedReportEntries` below drops report entries git
// does not track, so on a working tree holding an uncommitted source file this
// arithmetic disagrees with the percentage vitest itself just printed. That is
// the point: the ratchet's job is to give the answer CI gives, and CI checks out
// only committed files. Both figures are correct and they measure different file
// sets, so the script prints which files it dropped — unexplained, two different
// percentages on screen read as a bug in the one module that cannot afford one.
// On a clean tree, and on every CI run, the sets are identical and so are the
// figures.

/**
 * Istanbul's percentage, reproduced arithmetic-for-arithmetic — not merely a
 * same-answer float path. `percent()` in istanbul-lib-coverage 3.2.2
 * (`lib/percent.js`) is `Math.floor(((1000 * 100 * covered) / total) / 10) /
 * 100`, and `Math.floor((covered / total) * 10000) / 100` — the obvious
 * rewrite, and what this used to be — is a DIFFERENT float path that reads a
 * hundredth low on 4,218 of the `(covered, total)` pairs with `total <= 12000`
 * (e.g. `57/100`: istanbul 57, the rewrite 56.99), never high. None of this
 * repo's committed pins land on one of those pairs, so the divergence was
 * dormant, not absent — a future re-measure could still hit one. FLOORS to two
 * decimals rather than rounding either way: rounding reads a hundredth high on
 * six of this repo's eight areas, and a pin a hundredth high is a red build.
 */
export function coveragePercent(covered, total) {
  return total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;
}

/** Hits per source line: the max over the statements starting on that line. */
function lineHits(fileCoverage) {
  const hits = new Map();
  for (const [id, count] of Object.entries(fileCoverage.s)) {
    const entry = fileCoverage.statementMap[id];
    if (!entry) continue;
    const { line } = entry.start;
    if (!hits.has(line) || hits.get(line) < count) hits.set(line, count);
  }
  return [...hits.values()];
}

const metric = (covered, total) => ({
  covered,
  total,
  uncovered: total - covered,
  pct: coveragePercent(covered, total),
});

/**
 * One file's four raw totals, as the ratchet counts them.
 *
 * Extracted so `totalsByArea` and the cross-platform guard cannot disagree
 * about what a "line" is: both go through this, and the max-over-statements
 * rule in `lineHits` is stated once. A second copy is the shape
 * `coverage.areas.mjs`' header forbids for the pins themselves, and it would
 * fail the same way — silently, by reporting agreement between two counters
 * that had drifted.
 */
export function fileTotals(fileCoverage) {
  const lines = lineHits(fileCoverage);
  const arms = Object.values(fileCoverage.b);

  return {
    lineTotal: lines.length,
    lineCovered: lines.filter((hits) => hits > 0).length,
    branchTotal: arms.reduce((total, branch) => total + branch.length, 0),
    branchCovered: arms.reduce((total, branch) => total + branch.filter((h) => h > 0).length, 0),
  };
}

/**
 * The report, with every entry git does not track removed — and the names of
 * the ones removed, so the caller can say so out loud.
 *
 * Vitest's `coverage.include` globs the WORKING TREE, not the index, so a `.ts`
 * or `.svelte` file sitting under a measured `src/` reaches the report whether
 * or not it is committed — which is the normal state of a source file between
 * writing it and `git add`. CI never sees one; a developer's machine sees them
 * constantly. Counting them made the ratchet answer a different question
 * locally than it answers in CI, and — far worse — put numbers no committed
 * file can reproduce into a paste block whose whole instruction is "paste them,
 * do not retype them" (issue #1161).
 *
 * Kept apart from the git call for the usual reason: this is set arithmetic and
 * is unit-testable without first spending 40 s producing a report.
 * `check-coverage-files.mjs` asks git the same question for a different purpose
 * — "did the report reach every file the globs name" — where an untracked extra
 * is correctly a note and not a failure, and that stays as it is.
 */
export function trackedReportEntries(fileCoverages, trackedFiles) {
  const tracked = new Set(trackedFiles);
  const entries = Object.entries(fileCoverages);

  return {
    tracked: Object.fromEntries(entries.filter(([file]) => tracked.has(file))),
    dropped: entries
      .filter(([file]) => !tracked.has(file))
      .map(([file]) => file)
      .sort(),
  };
}

/**
 * Which of `areas` actually lost an entry to `trackedReportEntries` above —
 * i.e. whose printed totals genuinely differ from what `pnpm test:coverage`
 * just showed, as opposed to merely "something, somewhere, was dropped".
 *
 * `coverageInclude` (`coverage.areas.mjs`) globs beyond the eight pinned
 * areas: `packages/shared-types/src/**` is measured and deliberately
 * unfloored, so a dropped file there changes no area's figures at all. Keying
 * the caller's caveats off `dropped.length > 0` for the whole run said so
 * anyway — the note claimed the printed figures "will differ" when not one of
 * them did, and the same blanket check hedged an unrelated area's `regressed`
 * message with "though vitest may still be green here" when nothing about
 * that area's own numbers was in question. Scoping to the areas a dropped file
 * actually reaches is the honest fix (PR #1166 review, finding 3) — the
 * mechanical one (softening "will" to "may") would still be true everywhere
 * and useful nowhere.
 */
export function areasAffectedByDroppedFiles(droppedFiles, areas) {
  return areas.filter((glob) => droppedFiles.some((file) => path.matchesGlob(file, glob)));
}

/**
 * Per-area line and branch totals from an istanbul-shaped report, keyed by
 * REPO-RELATIVE path — the caller converts, because istanbul keys its report
 * absolutely and every glob in `coverage.areas.mjs` is relative.
 *
 * Buckets by `path.matchesGlob` exactly as `countByArea` above does, so an area
 * holds the same files here as it does in the file-set guard.
 */
export function totalsByArea(fileCoverages, areas) {
  return areas.map((glob) => {
    let lc = 0;
    let lt = 0;
    let bc = 0;
    let bt = 0;
    let files = 0;

    for (const [file, fileCoverage] of Object.entries(fileCoverages)) {
      if (!path.matchesGlob(file, glob)) continue;
      files += 1;

      const totals = fileTotals(fileCoverage);
      lt += totals.lineTotal;
      lc += totals.lineCovered;
      bt += totals.branchTotal;
      bc += totals.branchCovered;
    }

    return { glob, files, lines: metric(lc, lt), branches: metric(bc, bt) };
  });
}

/** The pin field holding each metric's uncovered-count ceiling. */
const CEILING_KEY = { lines: 'uncoveredLines', branches: 'uncoveredBranches' };

// Hundredths, as integers. `89.14 - 88.03 > 1` is true in binary floating point
// and so is `1.0000000000000142 > 1`, which is how a tolerance of exactly one
// point starts firing on an area sitting exactly one point clear.
const hundredths = (n) => Math.round(n * 100);

/**
 * Every value `ratioVerdict` can return, so the printing half can be checked
 * against the deciding half instead of trusting that the two were edited
 * together. `check-coverage-ratchet.mjs` asserts its message table covers
 * exactly this list; without that, a fifth verdict reaches the printer as
 * `RATIO_MESSAGE[verdict] is not a function` on somebody else's red build, and
 * a verdict that stops being reachable leaves its sentence sitting there
 * looking live.
 */
export const RATIO_VERDICTS = ['grew', 'regressed', 'unknown', 'unfloored'];

/** See `ratchetFindings`' docstring for why this has four values and not two. */
function ratioVerdict(pct, floor, staleAbove) {
  if (typeof floor !== 'number') return 'unfloored';
  if (hundredths(pct) < hundredths(floor)) return 'regressed';
  return hundredths(pct) >= hundredths(floor) + hundredths(staleAbove) ? 'grew' : 'unknown';
}

/**
 * Everything wrong with an area, as data — the printing lives in the script.
 *
 * Two kinds, because they are two different failures and neither subsumes the
 * other (issue #1133):
 *
 *   - `ceiling`: the area left MORE lines or branches untested than it was
 *     pinned at. This is the one a ratio structurally cannot see, because
 *     deleting well-covered code moves the ratio without moving the testing —
 *     the #929/#1113 case written up in `coverage.areas.mjs`.
 *   - `stale`: the area sits more than `staleAbove` points ABOVE its floor, so
 *     coverage was earned and never banked. A red, not a warning, because the
 *     ratchet's regression half has been mechanical since #943 while its
 *     ratcheting half was remembered — and remembering failed for 34 points in
 *     the one area #941 named as the sharpest risk.
 *
 * An area with no pin is skipped, not defaulted: `coverage.areas.mjs` leaves
 * two areas deliberately unfloored and inventing a ceiling for them here would
 * put a second, silent declaration next to the one that file exists to be.
 *
 * A `ceiling` finding carries `ratio`, FOUR-VALUED, so the message can say
 * whether raising the ceiling is legitimate (issue #1161):
 *
 *   - `'grew'` — `pct >= floor + staleAbove`. The only band in which the ratio
 *     can be CERTIFIED not to have fallen, so the only one where a bigger
 *     ceiling may be the honest fix.
 *   - `'regressed'` — `pct < floor`. Vitest is red on this area too.
 *   - `'unknown'` — everything between. Nothing records where the area stood on
 *     the last green run: the pin records where it stood when it was last
 *     BANKED, and `staleAbove` deliberately lets the two differ by up to a full
 *     point. Every point of that window is room for a real loss of coverage to
 *     look like growth, so the honest answer is that the ratchet cannot tell —
 *     the predicate this replaced said `'grew'` across the whole of it, which
 *     let a 0.9-point regression print the block that banks it permanently.
 *   - `'unfloored'` — the pin carries a `uncoveredLines`/`uncoveredBranches`
 *     ceiling for this metric but no ratio floor, so there is no comparison to
 *     make at all. Split out of `'unknown'` by #1168: the two reached the same
 *     value but not the same sentence, and `'unknown'`'s message opens "clears
 *     its floor", which on this path names a floor that does not exist.
 *
 * `'unknown'` is why this is not a boolean with a moved threshold: a two-state
 * version's `false` branch would have to keep asserting "vitest is failing it
 * as well", which is untrue across that band — trading one false claim for a
 * quieter one (CLAUDE.md Rule 12). `'unfloored'` is the same rule applied to
 * the residue that split left behind.
 *
 * Only `'grew'` unlocks the paste block, so splitting the value changes no
 * banking outcome — `withheldAreas` filters on `!== 'grew'` and both new values
 * are still `!== 'grew'`. It changes only which sentence prints.
 */
export function ratchetFindings(areaTotals, thresholds, { staleAbove }) {
  const findings = [];

  for (const area of areaTotals) {
    const pin = thresholds[area.glob];
    if (!pin) continue;

    for (const name of ['lines', 'branches']) {
      const { pct, uncovered } = area[name];
      const ceiling = pin[CEILING_KEY[name]];
      const floor = pin[name];

      if (typeof ceiling === 'number' && uncovered > ceiling) {
        findings.push({
          kind: 'ceiling',
          glob: area.glob,
          metric: name,
          uncovered,
          ceiling,
          ratio: ratioVerdict(pct, floor, staleAbove),
        });
      }

      if (
        typeof floor === 'number' &&
        hundredths(pct) - hundredths(floor) > hundredths(staleAbove)
      ) {
        findings.push({ kind: 'stale', glob: area.glob, metric: name, pct, floor });
      }
    }
  }

  return findings;
}

/**
 * Which of a list of areas are safe to hand back as a `pinEntry` paste block —
 * i.e. banking today's measurement would not lower either metric's ratio floor.
 *
 * Scoped to BOTH metrics on the area, never just the one a finding named:
 * `pinEntry` always emits `lines` and `branches` together, so an area that
 * regressed on one metric cannot be split into a safe partial paste. This is
 * "no pin here may go DOWN to make a build green" (the script's own words)
 * made mechanical rather than trusted to the surrounding prose: a `ceiling`
 * finding whose ratio also fell (`ratioHeld: false` — a plain regression)
 * computes a LOWER pct in `pinEntry` too, and nothing before this filtered on
 * that, so the block was offered even there (issue #1133 review, finding 1).
 *
 * An area with no pin at all is excluded rather than treated as vacuously
 * bankable — `ratchetFindings` never emits a finding for one, so it should
 * never reach here, but this stays defensive rather than assuming that.
 */
export function bankableAreas(areaTotals, thresholds) {
  return areaTotals.filter((area) => {
    const pin = thresholds[area.glob];
    if (!pin) return false;
    return ['lines', 'branches'].every((name) => {
      const floor = pin[name];
      return typeof floor !== 'number' || hundredths(area[name].pct) >= hundredths(floor);
    });
  });
}

/**
 * Which of the areas a run has findings for get the paste block, and which are
 * withheld — split by WHY, because the two reasons want different words.
 *
 * Two independent bars, and an area must clear both:
 *
 *   - `bankableAreas` above: banking today's measurement must not LOWER either
 *     ratio floor. It stays at `pct >= floor`, deliberately, because it answers
 *     "would this pin go down" — a different question. Raising ITS bar to
 *     `floor + staleAbove` would withhold #1133's stale-only banking flow
 *     whenever the other metric happened to sit exactly on its floor, and that
 *     flow is the entire point of the staleness red.
 *   - a `ceiling` finding must be certified as GROWTH (`ratio: 'grew'`). A
 *     breach the ratchet cannot tell apart from a regression must not be handed
 *     the block that banks it: without this the script prints "the fix is a
 *     test, never a bigger ceiling" and then immediately offers the bigger
 *     ceiling (issue #1161).
 *
 * `stale` findings are untouched by the second bar — an area that is only adrift
 * above its floor has no ceiling breach to certify, and withholding its block
 * would break the one flow the staleness red exists to drive.
 */
export function bankingDecision(areaTotals, findings, thresholds) {
  const affected = new Set(findings.map(({ glob }) => glob));
  const uncertified = new Set(
    findings
      .filter((finding) => finding.kind === 'ceiling' && finding.ratio !== 'grew')
      .map(({ glob }) => glob),
  );

  const areas = areaTotals.filter((area) => affected.has(area.glob));
  const clearsPin = bankableAreas(areas, thresholds);

  return {
    bankable: clearsPin.filter((area) => !uncertified.has(area.glob)),
    belowPin: areas.filter((area) => !clearsPin.includes(area)),
    uncertifiedGrowth: clearsPin.filter((area) => uncertified.has(area.glob)),
  };
}

/**
 * The entry to paste into `coverage.areas.mjs` for an area, at today's
 * measurement. Generated rather than hand-typed because a replacement pin that
 * is a hundredth off is a red build, and this is the only place those numbers
 * are ever written down for a human to copy.
 *
 * Emitted in the exploded form PRETTIER produces at `printWidth: 100`, not on
 * one line: a single-line entry is correct JavaScript that `pnpm format:check`
 * rejects, so a paste would go red for a reason that has nothing to do with
 * coverage.
 */
export function pinEntry(area) {
  return [
    `  '${area.glob}': {`,
    `    lines: ${area.lines.pct},`,
    `    branches: ${area.branches.pct},`,
    `    uncoveredLines: ${area.lines.uncovered},`,
    `    uncoveredBranches: ${area.branches.uncovered},`,
    '  },',
  ].join('\n');
}
