// The coverage AREAS: which files the unit-test coverage report measures, and
// what floor and ceiling each group of them carries. Three consumers:
// `vitest.config.ts` measures and enforces the RATIO floors;
// `scripts/check-coverage-files.mjs` proves the measurement reached every file
// named here; `scripts/check-coverage-ratchet.mjs` enforces the uncovered-count
// CEILINGS and reds a pin that has gone stale.
//
// Declared once, in plain ESM, because two copies would drift — and a drifted
// copy is worse than no check at all: it would report "stable" while the floors
// moved underneath it.

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------
// EXTENSIONS ARE NAMED, and that is load-bearing (issue #974). Vitest 4 dropped
// `coverage.extension` and defaults `coverage.exclude` to `[]`, so a bare
// `src/**` sweeps up every file that happens to live under a `src/` — not just
// the code. In this repo that was 18 `.webp` weather icons, three `.css` files
// and a `README.md`, none of which can carry a line of coverage:
//
//   - the images and stylesheets carry no executable line at all, so they moved
//     no percentage — they merely sat in the file set as measured "source" that
//     could never be covered, inflating every per-area count and the HTML report
//     with 21 rows of nothing. Harmless to the floors, fatal to being able to
//     state what the floors are computed over;
//   - `apps/web-pwa/src/lib/weather-icons/README.md` is the one that was not
//     harmless: markdown handed to a JavaScript parser fails, and a file that
//     fails to parse is dropped from the report entirely (see the guard
//     script's header for what "dropped" costs).
//
// `.ts` and `.svelte` are the only two extensions any measured area contains.
// Add one here when a third appears — do not widen back to a bare `src/**`.
export const coverageInclude = [
  'packages/*/src/**/*.{ts,svelte}',
  'packages/adapters/*/src/**/*.{ts,svelte}',
  'apps/*/src/**/*.{ts,svelte}',
];

// `apps/storybook` is the one `apps/*/src` tree with NO vitest project, and
// that is what makes it unmeasurable rather than merely untested (issue #974).
// Coverage transforms an untested file through the vite server of whichever
// project owns it; with no project of its own, storybook falls through to the
// ROOT project, whose vite config carries no `@sveltejs/vite-plugin-svelte`. So
// all 36 `stories/_wrappers/*.svelte` were read as raw Svelte, handed to a
// JavaScript parser, and dropped — 36 of the 37 parse failures on every run.
//
// Excluding them is narrow and costs nothing measurable: Storybook is dev-only
// (CLAUDE.md's layer map — typecheck + check in CI, no build, no e2e), nothing
// unit-tests it, and it matches none of the area globs below, so no floor moves.
// The alternative — giving storybook a vitest project purely so its demo
// wrappers could be reported at 0% — would add a project with no tests in it.
// `**/__boundary_tests__/**` are ESLint fixtures: each one is a deliberate
// architecture violation that `pnpm boundary:test` lints and asserts errors on.
// They are never imported and never executed, so every line in them is
// uncovered by construction — and because they live under a measured `src/`,
// that permanently-uncovered count was charged against the ratchet ceiling of
// whichever area owns them. Adding a fifth stage internal to
// `no-stage-internals.ts` is what turned `apps/cloud-functions/src/**` red in
// #971 while nothing about the app's testing changed; the ceiling had been
// partly budgeting for how Prettier chose to wrap an import list.
//
// Excluding them is the same narrow move as storybook above and rests on the
// same test (issue #974): a file that cannot carry a covered line is not
// untested code, so it is not code the ratchet has anything to say about.
//
// Four pinned areas own a fixture directory and measure slightly differently
// from this line onward — `packages/domain/src`, `packages/ui-components/src`,
// `packages/adapters/firebase-sync/src` and `apps/cloud-functions/src`.
// `apps/web-pwa`'s and `packages/shared-types`'s fixtures sit outside every
// pinned glob and move nothing.
//
// Three uncovered-LINE ceilings are tightened to the measured truth in the same
// commit (25→23, 54→53, 380→378, noted at each). Every ratio floor is left
// alone: the ratios rose because the basis changed, not because anything became
// better tested, and raising a floor stays the deliberate separate act the
// header describes. The ceilings are the opposite case — a ceiling carrying
// slack that no file can ever reclaim is a ceiling a later PR can spend, which
// is the erosion this whole file exists to stop.
export const coverageExclude = ['apps/storybook/src/**', '**/__boundary_tests__/**'];

// ---------------------------------------------------------------------------
// What floor each area carries
// ---------------------------------------------------------------------------
// Per-area coverage RATCHET (issue #943; the baseline it descends from is
// recorded in the #941 sub-epic, which measured the whole suite).
//
// These are floors meaning "do not go backwards", NOT targets. Nothing
// here says 57.82% is acceptable for firebase-sync — it says the refactor
// programme in #913 must not make it 57.81%. Raising a pin after coverage
// genuinely improves is a deliberate, separate act; never lower one to get
// a PR green.
//
// PER-AREA and not one global number, because a global number is the exact
// failure mode this guards against: `domain` at 98.74% over 291 files would
// comfortably absorb `firebase-sync` at 57.82% rotting further, and
// firebase-sync is where #928, #931 and #939 all land. Each area carries
// its own floor so a regression is attributed to the area that caused it —
// vitest names the matched glob in the failure message.
//
// Numbers are EXACT measurements. Repeat runs on one machine are
// byte-identical, and every area below measures identically on macOS and on
// CI's ubuntu-latest — same figure to the last decimal, both metrics. So
// they carry NO margin: a margin would only buy room for a real regression
// to hide in.
//
// `apps/web-pwa/src/lib/**` used to be the exception, pinned one line and
// one branch low because `deck.svelte.ts` and `savedTick.svelte.ts` landed
// differently under CI's scheduler — the whole cross-platform delta in the
// repo was those two files. Both were tests waiting on host timing rather
// than driving it, and #967 fixed them at the source: `savedTick`'s 1.5 s
// clear is now advanced with fake timers instead of outlived, and the
// planner's day sheet waits for bits-ui to take focus before anything is
// typed, so an Escape meant for the dialog can no longer be dispatched from
// the deck row underneath it. The headroom went with them.
//
// Re-pinning it at TODAY's measurement also banks the coverage that area has
// earned since #943 measured it (67.51/60.99 on 2026-08-24 → 71.44/63.91),
// which is a raise and therefore deliberate: leaving the pin at the older
// figure would hand back four points of hiding room to close a gap of four
// hundredths, which is the opposite of what the ratchet is for.
//
// Both web-pwa pins were then re-measured for #994, which moved well-covered
// code ACROSS the two globs — the cook lifecycle, the timers, the step deck
// and the ingredient rows left `src/routes/**` for `src/lib/**` — and lifted
// both (73.91/63.24 → 76.08/64.12 and 71.44/63.91 → 73.37/65.6). Measured
// once on the finished branch, deliberately not per phase: mid-refactor the
// two globs are in motion against each other, so a per-phase re-pin banks a
// number that the next phase invalidates.
//
// UNCHANGED by #974, which is the point of it. That issue narrowed the measured
// FILE SET — 21 assets out, 36 unparseable storybook wrappers out — without
// moving a single figure below: the assets carried no executable line, and the
// wrappers had never reached the report in the first place, having failed to
// parse. Measured both ways over the full suite, every area reports identically
// to the last decimal. A measurement repair that moved a floor would have been
// the bug, not the fix.
//
// BULK RE-PIN, 2026-08-31 (issue #1133): all eight areas, both metrics, moved
// to a measurement taken on that branch. Everything above this line is a single
// area re-measured for a single reason; this is the first time all sixteen
// numbers moved at once, and the reason is that they never had. The ratchet's
// regression half has been mechanical since #943 — vitest enforces it on every
// PR. Its RATCHETING half was remembered, and remembering had failed.
//
// `packages/adapters/firebase-sync/src` is where it failed worst. Pinned
// 57.82/63.02 the day #966 set it and untouched since, while #984 (the
// #928/#931/#939 sprint) and #1084 rewrote that suite to 92/85.65 — so a pull
// request could have deleted every test those two issues wrote and landed
// green, the area having to fall 34 line-points before the floor noticed. That
// is the area #941 singled out as the sharpest risk in the repo. Across all
// eight, ~50 line-points and ~32 branch-points of earned protection were
// sitting unbanked.
//
// Banked, NOT relaxed: no pin here moved down, and the header rule above is
// unchanged — these remain floors, not targets. Like every pin in this file
// they are exact measurements carrying no margin, and that was checked rather
// than assumed: each of the sixteen was first pinned one hundredth HIGHER, and
// vitest reported all sixteen red naming the value one hundredth below. So
// `pnpm test:coverage` is green at these numbers and red at any of them +0.01.
//
// Deriving a pin by hand: the figure is istanbul's `percent()`
// (`Math.floor(((1000 * 100 * covered) / total) / 10) / 100`), FLOORED to two
// decimals and not rounded. Six of these eight areas read a hundredth higher if
// you round, and a pin a hundredth high is a red build — so take the number
// vitest prints, never one you computed. The obvious-looking rewrite
// `Math.floor((covered / total) * 10000) / 100` is NOT this formula: it is a
// different float path that reads a hundredth low on thousands of
// `(covered, total)` pairs (`scripts/lib/coverageFileSet.mjs`'s
// `coveragePercent` learned this the hard way — see its docstring).
//
// ---------------------------------------------------------------------------
// The uncovered-count CEILINGS, and the staleness tolerance (issue #1133)
// ---------------------------------------------------------------------------
// Each entry carries FOUR numbers, not two. `lines` and `branches` are the
// ratio floors vitest enforces natively and everything above is about them.
// `uncoveredLines` and `uncoveredBranches` are ceilings — the most this area
// may leave untested — enforced by `scripts/check-coverage-ratchet.mjs`, which
// vitest ignores. (It reads only `lines`, `branches`, `functions` and
// `statements` off a per-glob entry and drops the rest, so the extra keys are
// safe on the same object; one declaration, as the top of this file requires.)
//
// BOTH, because neither subsumes the other. A ratio catches untested code
// added to a growing area, where the count would rise but so would the
// denominator. A count catches the one operation a ratio structurally cannot
// see — deleting a well-covered duplicate, which removes covered lines from the
// denominator and drags the percentage down without anything becoming less
// tested. That is the #929/#1113 case written up at the `ui-components` entry
// below, whose 217 uncovered branches were the invariant it turned on; the
// number is unchanged today and is now pinned rather than asserted, which is
// what CLAUDE.md Rule 12 asks for. `scripts/tests/coverageFileSet.test.mjs`
// reproduces that exact shape and the one-more-branch version that must fail.
//
// The counts are measurements on the same run as the ratios beside them, and
// they inherit the `.svelte` caveat below in full: v8 counts the compiled
// output, so an absolute count over a Svelte-bearing area is approximate in the
// same way its percentage is. The DELTA is exact, which is all a ceiling needs.
//
// STALENESS TOLERANCE — `staleAbovePoints` below, one coverage point. It
// reds an area sitting more than a point ABOVE its floor, so coverage that was
// earned can no longer go unbanked the way firebase-sync's 34 points did. Read
// it as what it is: this is NOT margin on the floor. The floors carry none,
// deliberately, and the paragraph above saying so is unchanged and still true.
// The two numbers point in opposite directions — the floor tolerates nothing
// below it, the tolerance permits a little above it — and conflating them turns
// a staleness allowance into exactly the hiding room the no-margin rule exists
// to deny. Zero tolerance was rejected because it reds every PR that improves
// coverage at all, which trains reflexive re-pinning and destroys the
// deliberateness "never lower a pin" depends on.
//
// Areas deliberately unfloored: `packages/shared-types/src` (4 covered
// lines in total — a pin there is noise, not a signal) and `apps/storybook`,
// which is excluded from measurement outright (see `coverageExclude`).
//
// NOTE for the two Svelte-bearing areas below (`apps/web-pwa/src/routes`,
// `apps/web-pwa/src/components`; `packages/ui-components/src` likewise):
// v8 measures the COMPILED output of a `.svelte` file, not its source, so
// the absolute percentage is approximate and should not be read as "how
// much of this component is tested". The DELTA is still exact and still a
// valid ratchet — the same compiler runs on both sides of a change.
export const coverageThresholds = {
  // Uncovered LINES tightened 25 → 23 in #1269, which is not a ratchet release
  // but the same measurement reaching fewer files: `**/__boundary_tests__/**`
  // left the measured set, and every line it took with it was uncovered by
  // construction. Ratios untouched — see the note beside `coverageExclude`.
  //
  // BANKED in #1285 (98.84 → 99.06 lines, 91.78 → 92.81 branches), because the
  // merge-queue run of that PR was the re-measurement. The branch coverage had
  // drifted 1.03 points above the floor — past the 1.00-point staleness
  // tolerance — and the ratchet stopped the merge, which is exactly its job:
  // coverage earned and never banked is coverage a later PR could delete and
  // still land green. The rise is #1285's own `setEquipmentEnvironment`,
  // `stageTemperature` and `diffProcess` tests compounding with what #1287 and
  // #1289 earned in the same area and likewise did not bank.
  //
  // BOTH UNCOVERED COUNTS ARE UNCHANGED at 23 and 143, which is what says this
  // is a denominator that grew under new tested code rather than anything
  // becoming less tested. Nothing moved down.
  'packages/domain/src/**': {
    lines: 99.06,
    branches: 92.81,
    uncoveredLines: 23,
    uncoveredBranches: 143,
  },
  // Branches CORRECTED DOWN 74.74 → 74.47 in #929, and like observability's
  // lines below this is NOT a ratchet release. #929 deleted duplicated code —
  // three byte-identical field-state headless modules became one, four Sheet
  // part components became Dialog's, and the two anchored listboxes stopped
  // carrying two copies of the portal and floating-ui blocks. Every branch it
  // removed was already COVERED, so the ratio fell while the testing did not:
  //
  //     before   649 / 866 branches   →   217 uncovered
  //     after    633 / 850 branches   →   217 uncovered
  //
  // **The uncovered count is the invariant, and it is unchanged.** Sixteen
  // fully-covered branches left the denominator, which drags a 74.7% pool down
  // by construction: restoring the two deleted field-module copies alone puts
  // the area back at 74.94%. Nothing became less tested — #929 added four test
  // files and edited none, and every file it introduced measures 100% or
  // carries no branch at all.
  //
  // This is the one operation that lowers a coverage RATIO without lowering
  // coverage: removing a duplicate that was better covered than its area's
  // average. The ratchet cannot see it, because a ratio over a shrinking file
  // set is not the quantity the ratchet means to protect. Re-measure once, on
  // the finished branch, exactly as #994 did when it moved well-covered code
  // across the two web-pwa globs — that raised both pins and this lowers one,
  // but the reason for re-measuring is identical: the refactor moved the basis.
  //
  // What this does NOT license: lowering a pin because a PR is red. The header
  // above says never, and it means it. The test that separates the two cases is
  // the uncovered count — if it had risen by even one branch, this would be a
  // regression wearing a dedup's clothes, and the fix would have been a test.
  // Lines were UNMOVED at 88.03: the same deletions left that metric above its
  // floor, and a pin that does not need to move does not move.
  //
  // The two figures on the line below are #1133's, not #929's — kept as history
  // because they are the worked example of the one operation the ratio cannot
  // see, and #1133's Phase 2 turns that worked example into a test.
  // Branches RE-PINNED 74.53 → 74.52 when the Combobox anchor mechanism was
  // rewritten to two slots (the fix for the effect_update_depth_exceeded loop
  // svelte 5.56.10 exposed). Same operation as #929's above, and it passes the
  // same test — this time with room, because the uncovered count did not merely
  // hold, it FELL:
  //
  //     before   635 / 852 branches   →   217 uncovered
  //     after    632 / 848 branches   →   216 uncovered
  //
  // Four branch-paths left the denominator because they were DEAD, not because
  // a duplicate went. `ComboboxInput` used to ask `if (ctx.anchorEl === null)`
  // before registering, and both it and `ComboboxField` guarded their teardown
  // with `if (ctx.anchorEl === <own el>)`. Reading the anchor to decide whether
  // you may write it is what made the effect depend on the state it assigns, so
  // deleting those reads IS the bug fix; a slot each, with the precedence
  // declared once in `Combobox.svelte`, cannot express the cycle. Two of the
  // deleted paths were covered only by the loop's own spurious re-runs —
  // coverage the defect was manufacturing — and the `fieldAnchorEl ??
  // inputAnchorEl` that replaced them is covered both ways.
  //
  // So the ratio fell by 0.01 while one more branch became covered. Per the
  // header's rule this is the deliberate act, not a red PR being papered over:
  // had the uncovered count risen by even one, the fix would have been a test.
  // Lines UNMOVED at 89.14 (measured 89.15) — a pin that does not need to move
  // does not move.
  'packages/ui-components/src/**': {
    lines: 89.14,
    branches: 74.52,
    uncoveredLines: 191,
    uncoveredBranches: 216,
  },
  // Lines CORRECTED DOWN 83.56 → 82.58 in #977, and this is the one case
  // where that is not a ratchet release. 83.56 was never measured: it was
  // the output of a corrupted v8 merge. `browserTracer.ts` loads its OTel
  // implementation with a fire-and-forget `import()`, and seven tests left
  // that load in flight at worker teardown, so V8 reported
  // `browserTracerImpl.ts` a second time with every count at zero. Merging
  // that entry misaligned the statement maps and credited five lines that
  // CANNOT have run — including the `pagehide` registration, inside a guard
  // this project's `node` environment sends the other way. Whether the race
  // was lost decided whether the pin was met, hence cold-cache red / warm
  // green. Draining the load (observability's tests/setup.ts) makes the
  // measurement identical cold and warm; 82.58% is what it has always
  // honestly been. Branches gained the same way (77.78 → a true 78.59) and
  // the pin was left at 77.77 rather than swept up in the correction —
  // raising a pin stays a deliberate, separate act, and #1133 is that act.
  // The two figures below are #1133's; #977's correction is the reason the
  // lines pin can be read as honest at all.
  'packages/adapters/observability/src/**': {
    lines: 82.77,
    branches: 77.88,
    uncoveredLines: 87,
    uncoveredBranches: 90,
  },
  // Lines RE-PINNED 92 → 91.98 in #1056, and this is NOT a ratchet release —
  // it is the #929/#994 shape described at the head of this file, in its
  // smallest possible form. #1056 deleted exactly one line of source here: the
  // read-boundary cast `(template) => onTemplate(template as MealPlanTemplate |
  // null)`, which became a bare `onTemplate` once the entity stopped narrowing
  // the schema's partial weekday map into a total one. That line was COVERED.
  //
  //     before   621 / 675 lines   →   54 uncovered   →   92.00%
  //     after    620 / 674 lines   →   54 uncovered   →   91.98%
  //
  // **The uncovered count is the invariant, and it is unchanged** — 54 before,
  // 54 after, still exactly at the ceiling below. That is the test this file
  // names for separating a moved basis from a regression wearing its clothes,
  // and one covered line leaving a 92% pool drags the ratio by construction.
  // Nothing here became less tested: #1056 added no untested code to this
  // package and removed no test.
  //
  // What was rejected, explicitly: keeping an identity wrapper
  // `(template) => onTemplate(template)` so the line would still be counted —
  // dead code held solely to hold a number, which is the bodge CLAUDE.md
  // forbids; and buying the 0.02 back with an unrelated firebase-sync test,
  // which this file already says is the WRONG fix when the uncovered count has
  // not risen. Branches, uncovered lines and uncovered branches are all
  // unmoved, and a pin that does not need to move does not move.
  // Uncovered LINES tightened 54 → 53 in #1269, which is not a ratchet release
  // but the same measurement reaching fewer files: `**/__boundary_tests__/**`
  // left the measured set, and every line it took with it was uncovered by
  // construction. Ratios untouched — see the note beside `coverageExclude`.
  'packages/adapters/firebase-sync/src/**': {
    lines: 91.98,
    branches: 85.65,
    uncoveredLines: 53,
    uncoveredBranches: 34,
  },
  // Banked by #840: the chef's two tools arrived with the two suites that pin
  // their claims — `chefChat.findRecipes.test.ts` (the projected read, the
  // trimmed line, the skip-invalid and degrade paths) and
  // `chefChat.readRecipe.test.ts` (the shared renderer, the not-found mapping).
  // Ten lines and fifteen branches of `chefChat.ts` went from uncovered to
  // covered; banking stops a later PR deleting those tests and landing green.
  //
  // RE-PINNED in #1249, and it is the #1113/#1056 shape this file's header and
  // `scripts/check-coverage-ratchet.mjs` both name: BOTH RATIOS FELL while
  // nothing became less tested. #1249 retired the `categoriseRecipe` flow — a
  // job the app never ran, listed on the admin Fast-model card as if it did —
  // and `src/flows/categoriseRecipe.ts` was WELL covered by the flow test
  // deleted alongside it, so its covered lines left the denominator:
  // 86.49 → 86.43 and 79.11 → 79.07.
  //
  // The invariant this file names for telling a moved basis from a regression
  // wearing its clothes holds on both sides: uncovered lines are UNCHANGED at
  // 380, and uncovered branches FELL 353 → 352 (the deleted file carried one).
  // No test was removed from any surviving file and no untested code was added.
  // The branch ceiling is banked at the lower figure rather than left slack.
  // All four measured by `pnpm test:coverage` on this branch and pasted from
  // the ratchet's own block.
  // Uncovered LINES tightened 380 → 378 in #1269, which is not a ratchet release
  // but the same measurement reaching fewer files: `**/__boundary_tests__/**`
  // left the measured set, and every line it took with it was uncovered by
  // construction. Ratios untouched — see the note beside `coverageExclude`.
  // Banked by #1299: `chefChat`'s third tool and the flow's declaration reader
  // arrived with their own suite, and `ai/fakeModel.ts` — the e2e seam, which no
  // unit test reached at all before — gained one for the declaring turn it now
  // emits. All four numbers moved the right way; the seam is the bulk of it.
  // Re-derived by #1310, which reverted that tool: the RATIOS give back 0.10 and
  // 0.16 because the covered code went with it, while both uncovered COUNTS hold
  // exactly — nothing untested was added, and `ai/fakeModel.ts` keeps the three
  // stub-encoding tests that outlive the declaring turn. Measured by
  // `pnpm test:coverage` on this branch and pasted from the ratchet's own block.
  'apps/cloud-functions/src/**': {
    lines: 87.24,
    branches: 80.29,
    uncoveredLines: 368,
    uncoveredBranches: 347,
  },
  // Banked by #935: `AppSettingsPage.svelte` had no test at all and now has one
  // (the role cards' job lists are generated from the registry, and that claim
  // needed a pin). Rendering the page covers most of it, so all four numbers
  // moved the right way at once — lines 77.46 → 79.34, branches 65.86 → 67.08,
  // uncovered lines 2080 → 1915, uncovered branches 1859 → 1799. Measured by
  // `pnpm test:coverage` on this branch and pasted from the ratchet's own block.
  // RE-PINNED in #1221, and every figure moved the GOOD way — this is banking
  // coverage that was earned, which is the staleness half of the ratchet doing
  // exactly its job. `RecipeEditPage.minuteBoxes.test.ts` put 21 cases through
  // three minute boxes in `RecipeEditPage.svelte`, one of which (the step timer's
  // duration) had no unit coverage at all before it, and the new
  // `MinutesField.svelte` arrives fully covered. Branches rose 1.02 points, past
  // the 1.00 tolerance, which is what tripped CI.
  // CEILING RAISED BY ONE in #1275, and only the branch ceiling. The skipped-stage
  // row on `BatchDetailPage.svelte` adds one text interpolation,
  // `Skipped {formatWhen(skip.at)}`, and Svelte's compiler emits an
  // instrumentation branch per interpolation of that shape that NO TEST CAN REACH.
  // The claim is checkable rather than asserted: lines 586, 590 and 608 in the same
  // file are the identical construction (`In progress since {formatWhen(startedAt)}`,
  // `Starts {formatWhen(stage.plannedStartAt)}`, `Ends {formatWhen(stage.plannedEndAt)}`),
  // all three report uncovered in the very run that raised this ceiling, and
  // `BatchDetailPage.test.ts` renders and asserts on every one of them. The two
  // reachable branches this issue added — the `{#if stage.skipped !== null}` row and
  // the note's `{#if skip.note !== ''}` — are both covered, and one dead branch was
  // REMOVED rather than pinned (`status === 'inProgress' && stage.actualStartAt !== null`
  // became a hoisted `{@const}`, since `stageStatus` already guarantees the second
  // operand). Both ratios ROSE in the same run — lines 80.28 → 80.49, branches
  // 68.1 → 68.61 — and the uncovered LINE count did not move, which is what says
  // this is a new uncoverable branch rather than lost coverage. The floors are
  // deliberately left where they are: the rise is real but the merge base was not
  // re-measured, and banking a floor on an unmeasured base is what the staleness
  // tolerance exists to prevent.
  //
  // Banked by #935: `AppSettingsPage.svelte` had no test at all and now has one, and
  // re-pinned in #1221 — both histories are above.
  //
  // BANKED in #1279, which is the merge the paragraph above anticipated. #1287 and
  // #1274 each earned coverage on `BatchDetailPage.svelte` and each declined to bank
  // it against a merge base it had not re-measured; merged, the two rises compound to
  // 1.12 points of branch coverage above the floor, past the 1.00-point staleness
  // tolerance, and the ratchet is right to stop it — unbanked coverage a later PR
  // could delete and still land green is exactly what it guards. This IS a
  // re-measurement of the merge, so the figures below are banked. Both ratios rose
  // and BOTH UNCOVERED COUNTS FELL (lines 1846 → 1833, branches 1760 → 1741), which
  // is what says this is coverage earned by new tests rather than a denominator that
  // shrank. Nothing moved down.
  //
  // BANKED AGAIN in #1324, and for the same reason in the same direction. Lifting
  // the identity card out of `RecipeViewPage.svelte` into its own component let
  // `RecipeIdentityCard.test.ts` drive that markup directly instead of only
  // through a 3,600-line page, so branches rose 1.02 points past the tolerance and
  // tripped the staleness half. EVERY FIGURE MOVED THE SAFE WAY and both uncovered
  // COUNTS FELL — lines 1832 → 1826, branches 1751 → 1748 — which is what
  // distinguishes earned coverage from a denominator that shrank, and it is why
  // this is a bank and not a ceiling being raised to admit untested code. No pin
  // here went down. Measured by `pnpm test:coverage` on this branch and pasted
  // from the ratchet's own block.
  'apps/web-pwa/src/routes/**': {
    lines: 82.13,
    branches: 71.37,
    uncoveredLines: 1826,
    uncoveredBranches: 1748,
  },
  // RE-PINNED in #1233, and it is the dedup shape this file's header and
  // `scripts/check-coverage-ratchet.mjs` both name (the #1113 precedent): the
  // BRANCH RATIO FELL while nothing became less tested. `recipeAmend.ts` stopped
  // merging `prepTimeMinutes` / `cookTimeMinutes` / `totalTimeMinutes`, which
  // removed three fully-covered `??` branches from the denominator — so
  // 67.82 → 67.71 with the UNCOVERED BRANCH COUNT UNCHANGED AT 604, which is the
  // invariant that makes the lower ratio correct rather than a regression. The
  // line side moved the right way in the same edit and is banked: 75.95 → 76.06,
  // uncovered lines 798 → 795. All four measured by `pnpm test:coverage` on this
  // branch and pasted from the ratchet's own block.
  'apps/web-pwa/src/lib/**': {
    lines: 76.93,
    branches: 68.82,
    uncoveredLines: 773,
    uncoveredBranches: 596,
  },
  // RE-PINNED 54.58/38.81 → 61.22/46.02 in #947. `EquipmentPhotoDialog.svelte`
  // landed with real tests from the start (`EquipmentPhotoDialog.test.ts`,
  // 8 cases covering capture, describe, the not-ready-yet crop, the busy
  // state and cancel) rather than joining `ImagePromptDialog`/`ImageUploadDialog`
  // as untested siblings — so the area's ratio rose by more than the
  // 1.00-point staleness tolerance can absorb, and the header rule says that
  // earned coverage gets banked, not left to rot as unpinned headroom.
  // Uncovered LINE count is unchanged at 114 (the new file's own lines are
  // all covered, so the ratio moved only because the denominator grew).
  // Uncovered BRANCH count rose 93 → 95: `handleFileChange`'s `|| busy` and
  // `handleDescribe`'s `|| busy` guards each have an early-return side that
  // cannot fire through the UI (the file input and the Describe button are
  // both absent/disabled exactly when `busy` is true) — the same
  // structurally-unreachable defensive shape `RecipeImportPhotoDialog.svelte`
  // already carries at its own `useCurrentPage` guard, kept for the same
  // reason: the type only proves the OTHER two disjuncts, `busy` still has to
  // be re-checked in case a click and the busy flip land in the same tick.
  'apps/web-pwa/src/components/**': {
    lines: 61.22,
    branches: 46.02,
    uncoveredLines: 114,
    uncoveredBranches: 95,
  },
};

/** The area globs, in the order the ratchet declares them. */
export const coverageAreas = Object.keys(coverageThresholds);

/**
 * How far above its floor an area may drift before `check-coverage-ratchet.mjs`
 * reds the build and prints the block to paste. Declared here, beside the
 * paragraph that explains it and the floors it is measured against, for the
 * reason at the top of this file — a second copy would drift, and this one
 * would drift silently, since nothing enforces it but the script that reads it.
 *
 * It is a STALENESS allowance, not margin on the floor. See above.
 */
export const staleAbovePoints = 1.0;
