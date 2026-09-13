// The arithmetic behind `scripts/check-coverage-platforms.mjs` (issue #1333),
// kept apart from the IO for the same reason the rest of `lib/` is: it can be
// unit-tested without first spending twenty minutes producing two coverage
// reports on two operating systems.
//
// WHAT THIS GUARDS, and why it is not the ratchet. `coverage.areas.mjs`' header
// says the pins carry NO margin, and the reason it gives is that the two
// platforms measure identically. Nothing checked that sentence, which is the
// CLAUDE.md Rule 12 shape: an absolute asserted in a comment and guaranteed by
// nothing. The ratchet cannot check it however many platforms it runs on,
// because it compares ONE measurement against a pin and never two measurements
// against each other — and its staleness tolerance means a platform measuring
// up to a full point ABOVE the pin passes exactly as quietly as one measuring
// the pinned figure. That band is precisely where a divergence hides.
//
// So this compares the two reports directly, file by file, on the four raw
// totals — not on percentages, which round two different disagreements into one
// number and can hide a compensating pair entirely.

import path from 'node:path';
import { fileTotals } from './coverageFileSet.mjs';

/** The four per-file totals compared, in the order they are printed. */
export const COMPARED_TOTALS = ['lineTotal', 'lineCovered', 'branchTotal', 'branchCovered'];

/**
 * Istanbul keys its report by ABSOLUTE path, and the two runners check out to
 * different roots (`/home/runner/work/salt/salt` against
 * `/Users/runner/work/salt/salt`, and a developer's machine to neither). Re-root
 * on the first repo-top-level segment so the two reports can be keyed alike.
 *
 * Returns `null` for a path holding no such segment rather than guessing: a key
 * this cannot place is a key that must not be silently paired with another.
 */
export function repoRelative(absolutePath, roots) {
  const parts = absolutePath.split(path.posix.sep === '/' ? /[\\/]/ : /[\\/]/);
  const index = parts.findIndex((part) => roots.includes(part));
  return index === -1 ? null : parts.slice(index).join('/');
}

/**
 * A report re-keyed repo-relative, plus the keys that could not be placed.
 *
 * `unplaceable` is surfaced rather than dropped. A report whose paths stopped
 * matching would otherwise make this guard pass by comparing two empty sets —
 * the failure mode where a check reports agreement because it measured nothing,
 * which is worse than the divergence it exists to catch.
 */
export function rekey(report, roots) {
  const keyed = {};
  const unplaceable = [];

  for (const [absolutePath, coverage] of Object.entries(report)) {
    const relative = repoRelative(absolutePath, roots);
    if (relative === null) unplaceable.push(absolutePath);
    else keyed[relative] = coverage;
  }

  return { keyed, unplaceable };
}

/**
 * Every way two reports disagree about the same file set.
 *
 * Three kinds, and they are three different failures:
 *
 *   - `moved`: a file both platforms measured, on which at least one of the four
 *     totals differs. The `#967` and `#977` shapes both land here — a test
 *     waiting on host timing changes `lineCovered`, a load-order difference
 *     changes `branchTotal`.
 *   - `onlyIn`: a file one platform measured and the other did not. A changed
 *     DENOMINATOR at file granularity, which moves an area's ratio without any
 *     file's own numbers moving.
 *   - `unplaceable`: paths neither side could re-root (see `rekey`).
 *
 * DELIBERATELY STRICTER than the sentence it guards. That sentence is about the
 * eight pinned areas; this compares every file in the report, unfloored areas
 * included. A divergence under `packages/shared-types/src` falsifies nothing in
 * the header and still reds this — on purpose, because the mechanism behind it
 * is the same one, and an area is unfloored for being small rather than for
 * being allowed to drift. Narrowing to the eight would need a second reading of
 * which files count, and that is the duplicate declaration this file's
 * neighbours exist to avoid.
 */
export function comparePlatforms(
  reportA,
  reportB,
  { roots = ['apps', 'packages', 'scripts'] } = {},
) {
  const a = rekey(reportA, roots);
  const b = rekey(reportB, roots);

  const files = [...new Set([...Object.keys(a.keyed), ...Object.keys(b.keyed)])].sort();
  const moved = [];
  const onlyIn = [];

  for (const file of files) {
    const inA = a.keyed[file];
    const inB = b.keyed[file];

    if (!inA || !inB) {
      onlyIn.push({ file, side: inA ? 'a' : 'b' });
      continue;
    }

    const totalsA = fileTotals(inA);
    const totalsB = fileTotals(inB);
    const differing = COMPARED_TOTALS.filter((key) => totalsA[key] !== totalsB[key]);

    if (differing.length > 0) moved.push({ file, differing, a: totalsA, b: totalsB });
  }

  return {
    compared: files.length,
    moved,
    onlyIn,
    unplaceable: { a: a.unplaceable, b: b.unplaceable },
  };
}

/**
 * Whether a comparison is a pass, and it is NOT simply "nothing differed".
 *
 * A comparison of zero files differs in nothing and proves nothing, so it fails
 * here. Two empty reports, a re-root that stopped matching, a download that
 * produced an empty directory — each arrives looking exactly like perfect
 * agreement, and each is the same defect as the one this guard was written for:
 * a green that means "unchecked" (CLAUDE.md Rule 12).
 */
export function platformsAgree(comparison) {
  return (
    comparison.compared > 0 &&
    comparison.moved.length === 0 &&
    comparison.onlyIn.length === 0 &&
    comparison.unplaceable.a.length === 0 &&
    comparison.unplaceable.b.length === 0
  );
}
