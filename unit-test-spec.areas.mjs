// The unit-test-spec RATCHET: how many files in each area currently breach each
// of the nine mechanically-checkable `UT-*` rules in docs/unit-test-spec.md.
//
// One consumer: `scripts/tests/unitTestSpecGuard.test.mjs`, which scans the tree
// with `scripts/lib/unitTestSpec.mjs` and compares. Named and shaped after
// `coverage.areas.mjs`, whose per-area coverage ratchet (#943, #1133) is the
// pattern this copies — a number per area survives the renames and file moves
// that a checked-in list of 153 paths would not.
//
// ── What a number here means, and how to change it ──────────────────────────
//
// It is a count of FILES in that area breaching that rule, and the guard asserts
// EQUALITY, not `<=`. Both directions red for a reason:
//
//   - going UP is the drift the guard exists to stop. #1134 measured 76 new test
//     files in the week after the spec was written and the two countable rules
//     got worse in absolute terms, under a spec that said MUST;
//   - going DOWN without editing this file means the ratchet has stopped
//     ratcheting. The coverage ratchet learned this the hard way: its regression
//     half was mechanical from #943 and its RATCHETING half was remembered, and
//     firebase-sync sat 34 line-points of earned protection unbanked until #1133
//     went looking. A count that may only fall is worth nothing if nobody makes
//     it fall.
//
// So: fix a violation, then lower its number here in the same commit. The guard
// prints the exact number to write. Raising one is legitimate but is a
// DELIBERATE act that must carry its reason in the diff — see the UT-B1 note in
// `scripts/lib/unitTestSpec.mjs` for the one case the spec itself sanctions.
//
// Nothing here is a target. `apps/web-pwa` at 44 UT-B1 breaches is not
// acceptable; it is frozen. #941 is explicit that the fixes ride in the PR of
// the issue they protect, never as a global backfill, and #1134 fixed none of
// them on purpose — this file is the freeze, not the plan.
//
// ── The areas ───────────────────────────────────────────────────────────────
//
// Keyed by vitest PROJECT root, read out of the root `vitest.config.ts`'s
// `projects` array rather than listed here. A ninth project therefore arrives
// with no entry, and the guard reds asking for one instead of silently not
// scanning it. Keys are checked against that array both ways: a key naming no
// project is as much a defect as a project with no key.
//
// Every rule id appears in every area, including the zeros. A grid rather than
// only the non-zero rows, because a missing key is ambiguous — "nothing breaches
// this here" and "nobody thought about it here" must not look the same, and the
// zeros are the rows a future breach turns red.
//
// ── Measured 2026-08-31, at `1b6cb308` ──────────────────────────────────────
//
// Re-measured with the guard itself rather than trusted from #1134's table; it
// reproduced that table's UT-A1 (7), UT-B1 (75), UT-C1 (0), UT-C2 (38) and
// UT-C3 (31) totals exactly. UT-E4 is the one that differs, and it is a real
// finding rather than a matcher fault: #1134 read 0 real violations from a grep
// for four `../`, and there is a live escape at three — see the `apps/web-pwa`
// note below.
export const violationCeilings = {
  'packages/shared-types': {
    'UT-A1': 0,
    'UT-B1': 0,
    'UT-C2': 0,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  // One UT-C2: a `makeRecipe` in domain's own tests. Not obviously the same
  // defect as the other 37 — the builders it should use live in this package —
  // but it is the same shape and the rule draws no exception, so it is frozen
  // with the rest rather than exempted here.
  'packages/domain': {
    'UT-A1': 0,
    'UT-B1': 0,
    'UT-C2': 1,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  'packages/adapters/firebase-sync': {
    'UT-A1': 0,
    'UT-B1': 1,
    'UT-C2': 0,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  'packages/adapters/observability': {
    'UT-A1': 0,
    'UT-B1': 0,
    'UT-C2': 0,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  // UT-G1 was 1 here: `packages/ui-components/tsconfig.test.json` existed but the
  // root `typecheck` script did not run it. #1135 wired it in, so the breach is
  // gone — see that issue for the fixture work that came with it.
  'packages/ui-components': {
    'UT-A1': 0,
    'UT-B1': 0,
    'UT-C2': 0,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  // UT-E4 was 1 here: `subscriptionReportingGuard.test.ts` read firebase-sync's
  // barrel through `../../../packages/adapters/…`, and #1134 froze it rather
  // than fixing it because that issue edited no existing test file. #1163
  // resolved it through the `@salt/firebase-sync` specifier and dropped the
  // ceiling in the same commit, so the rule is pinned rather than exempted.
  //
  // Four files match a raw grep across the tree and are not counted,
  // correctly: they spell a `../../packages/` path inside a comment ABOUT
  // the rule. Three are here (`sharedHelperGuard`, `sheetCallSites`,
  // `subscriptionReportingGuard`); the fourth, `extractProcessStages`, is in
  // `apps/cloud-functions`. That is the must-not-match self-test case in the
  // guard.
  // UT-B1 44 → 45 and UT-C2 33 → 34 (issue #1122). ONE new file:
  // `RecipeViewPage.phases.test.ts`, a new suite for the phase strip. It carries
  // the same twelve-mock preamble every other RecipeViewPage suite carries and
  // the same `makeRecipe` factory — the page cannot render without them, which is
  // the one case the UT-B1 note in `scripts/lib/unitTestSpec.mjs` sanctions. The
  // alternative on offer was to hide the phase tests inside an unrelated suite
  // that already breaches both, which buys the counter and costs the reader.
  // UT-B1 45 → 46, and UT-C2 stays at 34 (issue #1141). ONE new file:
  // `RecipeViewPage.chatPane.test.ts`, covering the chef-chat pane's on/off
  // switch. Same reasoning as the row above — the page cannot render without the
  // twelve-mock preamble every RecipeViewPage suite carries, and folding these
  // tests into `RecipeViewPage.docked.test.ts` (which already breaches both)
  // would buy the counter at the reader's expense: that file is #933's
  // characterisation net for the media query, and this is a feature's behaviour.
  // UT-C2 does NOT move, because this suite builds its recipe with `@salt/domain`'s
  // `emptyRecipe` rather than copying the sibling's hand-rolled factory.
  // UT-B1 46 → 47, and UT-C2 stays at 34 (issue #1314). ONE new file:
  // `RecipeViewPage.scaling.test.ts`, covering reading a recipe at a different
  // number of servings. Same reasoning as the two rows above — the page cannot
  // render without the mock preamble every RecipeViewPage suite carries, and the
  // only alternative was to fold a feature's behaviour into a suite that already
  // breaches, which buys the counter at the reader's expense. UT-C2 does not move:
  // this suite builds its recipe with `emptyRecipe` too.
  // UT-B1 47 → 48, and UT-C2 stays at 34 (issue #1327). ONE new file:
  // `BatchCookPage.test.ts`, covering the batch cook page. The page joins THREE
  // stores that the two it is built from do not join together anywhere else — the
  // batch, its observation log and the live recipe — plus the canon/product-form
  // pair every ingredient tile needs and the wake lock, and it cannot render
  // without any of them. That is the case the UT-B1 note in
  // `scripts/lib/unitTestSpec.mjs` sanctions. The only alternative was to fold a
  // new page's whole behaviour into `BatchDetailPage.test.ts`, which already
  // breaches and is about a different screen. UT-C2 does not move: this suite
  // builds its recipe with `@salt/domain`'s `emptyRecipe`.
  // UT-C2 34 → 33 and UT-C3 31 → 30 (issue #1319 Phase 7). Both TIGHTEN, and
  // neither is a test deleted: `RecipeEditPage.mealReturn.test.ts` pinned the
  // `?meal=` attach at the retired editor's SAVE, and that attach moved onto the
  // recipe page — the import paths now attach the dish at creation, so the contract
  // was rewritten into `RecipeViewPage.mealComponents.test.ts`, which is the suite
  // that owns that surface and already drives its URL-import dialog end to end.
  // The relocated file took its hand-rolled `makeRecipe` with it (UT-C2 -1); the
  // suite it landed in also lost the redundant `document.body.style.pointerEvents`
  // reset `tests/setup.ts` already does (UT-C3 -1). Lowering both rather than
  // leaving slack is the point of an exact-equality ratchet.
  'apps/web-pwa': {
    'UT-A1': 5,
    'UT-B1': 48,
    'UT-C1': 0,
    'UT-C2': 33,
    'UT-C3': 30,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  // UT-A1 2 → 3 and UT-B1 30 → 31 (issue #1122). ONE new file:
  // `onRecipeWritten.phases.test.ts`, guarding the fix for the review finding
  // that the re-estimate branch could destroy a stored phase strip with an
  // answer that omitted one. It carries the same twelve-mock preamble its
  // sibling `onRecipeWritten.timesFloor.test.ts` already carries — the trigger
  // cannot run without stubbing Firestore, Storage and the sibling image/kit
  // flows — and every assertion is `toHaveBeenCalledWith`/`objectContaining`
  // against the actual merged `phases`/`timingSummary` payload, so UT-A1's
  // regex is catching an argument-checked write assertion, not a vacuous one.
  // Same shape as the `apps/web-pwa` note above, and the same reasoning.
  'apps/cloud-functions': {
    'UT-A1': 3,
    'UT-B1': 31,
    'UT-C2': 4,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
  // The `.mjs` suites (#1021). UT-G1 and UT-G2 do not reach them by the spec's
  // own stated limit; everything else does, and all of it is clean.
  scripts: {
    'UT-A1': 0,
    'UT-B1': 0,
    'UT-C2': 0,
    'UT-E4': 0,
    'UT-G1': 0,
    'UT-G3': 0,
    'UT-G4': 0,
  },
};
