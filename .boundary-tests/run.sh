#!/bin/sh
# Verifies that boundary enforcement tools reject each deliberate violation.
# A test PASSES when the tool reports an error on that fixture.
# Run from the repo root: sh .boundary-tests/run.sh
#
# The lint fixtures are linted in ONE eslint invocation and the per-fixture
# verdicts are read back out of the JSON report. Previously each fixture got its
# own `pnpm eslint` spawn, and since every spawn re-resolves the flat config and
# rebuilds the type-aware program, nearly all of the runtime was startup paid 20
# times over (~26s in CI, ~16.7s locally → ~0.4s batched). Adding a fixture now
# costs a line here, not another process.

set -e
cd "$(dirname "$0")/.."

# "<path>|<description>", one per line. A fixture missing from the eslint report
# (renamed, deleted, or silently ignored by config) FAILS — absence is not a pass.
FIXTURES='packages/domain/src/__boundary_tests__/no-firebase.ts|domain cannot import firebase
packages/domain/src/__boundary_tests__/no-web-pwa.ts|nothing can import @salt/web-pwa
packages/shared-types/src/__boundary_tests__/no-domain.ts|shared-types cannot import @salt/domain
packages/ui-components/src/__boundary_tests__/imports-firebase.ts|ui-components cannot import Firebase SDKs
packages/domain/src/__boundary_tests__/no-indexeddb.ts|domain cannot import IndexedDB packages
packages/domain/src/__boundary_tests__/no-node-builtin.ts|domain cannot import Node built-ins (pure layer)
packages/domain/src/__boundary_tests__/no-browser-global.ts|domain cannot touch browser globals (pure layer)
packages/adapters/firebase-sync/src/__boundary_tests__/no-indexeddb.ts|firebase-sync cannot import IndexedDB packages
packages/adapters/firebase-sync/src/__boundary_tests__/no-raw-listener.ts|firebase-sync cannot reach onSnapshot/getFunctions/httpsCallable outside the three helpers
packages/domain/src/canon/__boundary_tests__/no-cross-module-subpath.ts|canon cannot import sibling module internals (subpath)
packages/domain/src/canon/__boundary_tests__/no-coordinator.ts|canon cannot import a coordinator
packages/domain/src/auth/__boundary_tests__/no-cross-module-subpath.ts|auth cannot import sibling module internals (subpath)
packages/domain/src/equipment/__boundary_tests__/no-cross-module-subpath.ts|equipment cannot import sibling module internals (subpath)
packages/domain/src/freezer/__boundary_tests__/no-cross-module-subpath.ts|freezer cannot import sibling module internals (subpath)
packages/domain/src/shoppingList/__boundary_tests__/no-cross-module-subpath.ts|shoppingList cannot import sibling module internals (subpath)
apps/cloud-functions/src/__boundary_tests__/no-observability.ts|cloud-functions cannot import the default @salt/observability subpath (browser SDK)
apps/web-pwa/src/__boundary_tests__/no-observability-server.ts|web-pwa cannot import @salt/observability/server (Node SDK)
apps/web-pwa/src/__boundary_tests__/no-observability-server.svelte|web-pwa .svelte <script> imports are subject to the boundary rules (#413)
apps/web-pwa/src/__boundary_tests__/no-ui-primitive.ts|web-pwa cannot import UI primitives directly — must go through @salt/ui-components (Rule 7)
apps/web-pwa/src/__boundary_tests__/no-firebase-sync-internal.ts|web-pwa cannot import firebase-sync internal subpaths
apps/web-pwa/src/__boundary_tests__/no-stage-internals.ts|web-pwa cannot import canon stage internals (must go through findClosestMatch)
apps/cloud-functions/src/__boundary_tests__/no-stage-internals.ts|cloud-functions cannot import canon stage internals (must go through findClosestMatch)'

echo "Running boundary tests..."
echo ""

REPORT=$(mktemp)
ERRLOG=$(mktemp)
trap 'rm -f "$REPORT" "$ERRLOG"' EXIT

# eslint exits non-zero precisely BECAUSE the fixtures error, which is the pass
# condition — so its exit code is deliberately ignored and the JSON report is the
# verdict. `--no-ignore` so the fixtures aren't skipped by ignore patterns.
# stderr is kept (not discarded) so that a run which produces NO report at all —
# a deleted fixture path, a broken flat config — can say why instead of dying on
# a JSON parse error.
pnpm exec eslint --no-ignore --format json $(echo "$FIXTURES" | cut -d'|' -f1) >"$REPORT" 2>"$ERRLOG" || true

LINT_FAIL=0
FIXTURES="$FIXTURES" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let report;
try {
  report = JSON.parse(readFileSync(process.argv[1], "utf8"));
} catch {
  console.log("  FAIL  eslint produced no usable JSON report — no fixture was checked.");
  console.log("        This is a HARD failure: enforcement was not verified at all.");
  console.log("        eslint stderr:");
  console.log(
    (readFileSync(process.argv[2], "utf8").trim() || "(empty)")
      .split("\n")
      .map((l) => `          ${l}`)
      .join("\n"),
  );
  process.exit(1);
}
// eslint reports absolute paths; key by absolute so matching is exact.
const errorsByFile = new Map(report.map((r) => [r.filePath, r.errorCount]));

let pass = 0;
let fail = 0;
for (const line of process.env.FIXTURES.split("\n")) {
  const [file, desc] = line.split("|");
  const count = errorsByFile.get(resolve(file));
  if (count === undefined) {
    console.log(`  FAIL  ${desc} — fixture was not linted (missing, renamed, or ignored?)`);
    fail++;
  } else if (count > 0) {
    console.log(`  PASS  ${desc}`);
    pass++;
  } else {
    console.log(`  FAIL  ${desc} — expected a lint error but got none`);
    fail++;
  }
}
console.log(`\n  ${pass} lint fixtures passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
' "$REPORT" "$ERRLOG" || LINT_FAIL=1

PASS=0
FAIL=0

expect_depcruise_error() {
  path="$1"
  desc="$2"
  if pnpm depcruise --config .dependency-cruiser.cjs "$path" 2>&1 | grep -qE "error|✗"; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc — expected a dependency-cruiser error but got none"
    FAIL=$((FAIL + 1))
  fi
}

expect_depcruise_error \
  ".boundary-tests/circular" \
  "circular imports are rejected"

echo ""
if [ "$LINT_FAIL" -gt 0 ] || [ "$FAIL" -gt 0 ]; then
  echo "BOUNDARY TESTS FAILED — enforcement is not working correctly." >&2
  exit 1
fi

echo "All boundary tests passed."
