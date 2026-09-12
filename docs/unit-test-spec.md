# Vitest Unit Suite — Non-Functional Specification

This is the **quality contract** for the Vitest suite: every `*.test.ts` under `packages/**/tests/`
and `apps/**/tests/`, plus every `*.test.mjs` under `scripts/tests/` — the untyped-ESM `scripts`
project (#1021). UT-G1 and UT-G2 are the only two rules that do not reach those `.mjs` files, and
each states that limit where it is written. Like [docs/e2e-test-spec.md](e2e-test-spec.md) it is a
_non-functional_ spec — it does not say what a test should assert (that is the test's job), it says
what qualities every test must have to be **behaviour-anchored, cheap to read, and safe to refactor
around**.

**How to use it.** Apply this checklist to any new or changed test file _before_ a functional review
of what it asserts. A file that fails a `MUST` is not ready for review. The condensed
[Reviewer checklist](#reviewer-checklist) at the end is the fast path; the numbered requirements
below are the rationale and the verification recipe for each line.

**Why this exists.** The two halves of the test estate had wildly different governance. 9,246 lines
of e2e have had a 418-line binding spec with a 27-item reviewer checklist since the #297 flake wave;
the unit suite reached **96,262 lines with no written convention at all**. #941 measured what that
asymmetry produced: 30.6% of the suite is preamble before the first `it(`, 60 files each declared
their own 17-line `makeStore`, `it.each` appeared 4 times across web-pwa's 1,809 tests, and 1,565
assertions check only that a mock was called. The e2e suite has rules and does not drift; the unit
suite had none and drifted.

**And writing it down changed nothing, which is why the guard exists.** #1134 re-measured seven days
after this document landed, with the two rules the spec supplies its own grep for:

|                                             | `1e5026e2` 2026-08-24, the day this doc landed | `ff423e21` 2026-08-31 |
| ------------------------------------------- | ---------------------------------------------- | --------------------- |
| test files                                  | 451                                            | 527                   |
| `UT-B1` breaches (>5 `vi.mock` in one file) | 66                                             | **75**                |
| `UT-C2` breaches (hand-rolled `makeRecipe`) | 34                                             | **38**                |

Not a proportion — an absolute rise, under a spec saying `MUST`. Nine of the ten files that newly
breached the cap **did not exist when this was written**; they were created already in violation,
and every one went through a PR that routed to this document. Do not repeat the experiment: a
convention with no mechanism measured zero effect here, on this suite, over its first week. That is
CLAUDE.md Rule 12 in its own words, so nine of these rules are now counted by a test.

**Conventions.** Each requirement is `MUST` (a green-light blocker) or `SHOULD` (justify a deviation
in the PR). IDs are stable (`UT-A1` …) so reviews and follow-ups can cite them. Every rule carries
the measurement that justifies it, and the `_Verify:_` line is the command that re-measures it.
**Two provenances, kept apart deliberately** — the spec's own UT-A4 forbids conflating them: counts
derived from the tree (files, assertions, `vi.mock` calls) were **re-measured on 2026-08-24 at `main`
@ `4a408fb3`** and several have moved since #941; every **percentage** is from #941's
`pnpm test:coverage` run at `cbc6efd9` and is marked as such, because a grep cannot produce one.

**Enforcement, per rule.** Every rule below carries one of two markers, and there is no third.

- **`guarded`** — a test reds when it breaks. Nine rules:
  [`scripts/tests/unitTestSpecGuard.test.mjs`](../scripts/tests/unitTestSpecGuard.test.mjs) walks
  every test file in every vitest project, matches with
  [`scripts/lib/unitTestSpec.mjs`](../scripts/lib/unitTestSpec.mjs), and compares each area against
  the ceilings in [`unit-test-spec.areas.mjs`](../unit-test-spec.areas.mjs). It runs inside
  `pnpm test` — no new job, no new dependency. The **153 breaches that existed on 2026-08-31 are
  frozen, not fixed** (#941: the safety net rides per issue, never as a global backfill), so a
  guarded rule reds on a **new** breach and on a fixed one whose ceiling was not lowered with it.
  Where the matcher sees less than the prose says, the marker says so — read it, because three of
  the nine are narrower than they look.
- **`review-only`** — nothing checks it. Twenty-two rules, and they are the valuable half: `UT-B4`,
  `UT-F2` and `UT-H1` each encode an investigation no scanner can express. They are stated here with
  their limit rather than deleted or left as absolutes nothing enforces, which is the second branch
  CLAUDE.md Rule 12 permits.

`guarded` is not permission to stop thinking. The guard counts shapes; the reason a rule exists is
still the reviewer's to apply, and a file can satisfy every matcher and still be the thing UT-A1 is
about.

**The `guarded` markers are pinned; the sentences around them are not.**
[`scripts/tests/unitTestSpecGuard.test.mjs`](../scripts/tests/unitTestSpecGuard.test.mjs) parses the
rule headers below and asserts that the set marked `guarded` equals `RULE_IDS` in
[`scripts/lib/unitTestSpec.mjs`](../scripts/lib/unitTestSpec.mjs) — both directions, so demoting a
marker to `review-only` reds it and so does adding a rule to `FILE_RULES`/`AREA_RULES` without
marking it here (#1162, which measured the gap: demoting `UT-E4` left all 92 tests green). It matches
the header **form**, never the word `guarded`, which also appears in prose on several other lines of
this file.

What it does **not** check is whether a rule's prose describes what its matcher actually does. Each
of the nine carries a `_Guard:_` line saying what the matcher really sees — three of them narrower
than the rule reads — and nothing verifies those sentences either. That half is still the reviewer's.

**Routing is not enforcement, and reading it as such is how the week above happened.**
[`pr-doc-review.yml`](../.github/workflows/pr-doc-review.yml) routes a PR touching a test file to
this document and asks exactly one question of it: **is the doc stale?** All three of its verdicts
are about the state of this prose. A PR adding nine files that each break `UT-B1` earns "everything
is fine" — correctly, because the doc is accurate and it is the code that is out of compliance,
which is a question that job does not ask and never did. #941's "done when" read the _so_ in "exists
and is in the docs map, **so** `pr-doc-review.yml` routes to it" as producing enforcement. It does
not, for any doc.

**What this spec does not do.** It does not restate the harness.
[`apps/web-pwa/tests/setup.ts`](../apps/web-pwa/tests/setup.ts) already documents, at length and
next to the code, why `asyncUtilTimeout` is 5 s, why `document.body.style.pointerEvents` is reset
after every test, and why `matchMedia` is stubbed. Read it once; this spec points at it and never
paraphrases it.

---

## A. Behaviour over implementation

A unit test earns its place by failing when behaviour changes. An assertion that a function was
called fails when the _wiring_ changes — which is precisely what a behaviour-preserving refactor
does, and precisely what it must not fail on.

- **UT-A1 (MUST · guarded) — A test's assertions may not consist only of `toHaveBeenCalled*`.**
  Every `it(` must assert at least one observable fact: a returned value, a rendered DOM state, a
  store's new contents, or the argument payload a collaborator received. "The mock was called" is
  not a fact about behaviour; it is a fact about the current call graph.
  **Evidence:** 1,565 of 10,796 assertions (14.5%) are `toHaveBeenCalled*`. In `firebase-sync` it is
  36% — the package with the worst coverage (51.3% lines, #941's coverage run) and three #913
  refactors landing on it.
  `onCookTimerWrite.test.ts` was 11 assertions out of 11; `onKitchenTimerWrite.test.ts` 18 of 20 —
  neither would have noticed if the trigger wrote the wrong document. Fixed in #987, which deleted
  both in favour of `timerWrite.test.ts`'s table-driven behavioural net.
  _Verify:_ in the changed file, every `it(` body must contain an `expect` that is not
  `toHaveBeenCalled*`. `grep -c 'toHaveBeenCalled' <file>` against `grep -c 'expect(' <file>` is the
  smell test; a ratio near 1.0 is a block.
  _Guard:_ the guard counts a FILE with at least one assertion and none that is not
  `toHaveBeenCalled*`. Narrower than the rule, which is per `it(` — finding an `it(` body needs a
  parser, so a file with one all-mock-call `it(` beside a behavioural one passes the guard and is
  still a breach for you.

- **UT-A2 (SHOULD · review-only) — Prefer `toHaveBeenCalledWith` over `toHaveBeenCalled`.** When a
  collaborator call genuinely is the behaviour under test — a Cloud Function enqueueing a task, an
  adapter issuing a `setDoc` — assert the _payload_. The bare call is satisfied by a call with
  entirely wrong arguments.

- **UT-A3 (MUST · review-only) — Do not assert on a private helper the public entry point already
  covers.** Reach for the exported surface. A test bound to an internal name pins the refactor it is
  supposed to protect. (`ssrf.ts` names none of its 8 exports in any test and was **97.3% covered**
  in #941's coverage run, through the `@salt/domain` barrel — that is the shape to aim for, not a
  defect.)

- **UT-A4 (MUST · review-only) — Use the coverage report, not grep-by-symbol, to argue about
  coverage.** A claim that "nothing tests X" derived from grepping for `X` is unsound in a
  barrel-exporting codebase and has already produced two refuted findings in #941.
  _Verify:_ `pnpm test:coverage`.

---

## B. Mocking

- **UT-B1 (MUST · guarded) — At most 5 `vi.mock` calls per test file.** Above that the file is
  testing a wiring diagram, not a unit, and every module path in it is a tripwire that a future
  refactor detonates without touching the behaviour under test. Exceed it only with a comment naming
  why the seam cannot be narrowed.
  **Evidence:** 66 of 451 files mock more than 5 modules — web-pwa 40 of 141, cloud-functions 25 of 92. The worst are `equipment.tracePropagation.test.ts` and `extractRecipeFromPhoto.test.ts` at 25
  each; the RecipeViewPage suites sit at 13–14. `domain` (126 files), `ui-components` (39) and
  `observability` (21) each have **zero** files over the cap — and are the three best-covered areas
  in #941's coverage run, which is why no #913 refactor is blocked on them.
  _Verify:_ `grep -c 'vi\.mock(' <file>`.
  _Guard:_ the count is guarded; the comment escape above is NOT. Matching a sentence is forbidden
  by UT-E3, so the sanctioned way to exceed the cap is to raise that area's ceiling in
  `unit-test-spec.areas.mjs` — the same act, in a place review can see.

- **UT-B2 (MUST · review-only) — Never mock a module the file could import for real.** A mock that
  exists because mocking is the local habit is pure cost.
  **Evidence:** `auth.svelte` is mocked in 55 test files and imported **unmocked in none** — the
  three files that import it also mock it, which is the ordinary `vi.mock`-then-import-the-mock
  shape, not a real use. `canonService` is mocked in 54 and imported for real in 7.
  _Verify:_ for each `vi.mock` in the diff, ask what breaks if it is deleted. If the answer is
  "nothing", delete it.

- **UT-B3 (MUST · review-only) — Mock at a seam the architecture already defines.** Mock the port,
  the adapter boundary, or the service module — never a deep transitive path a layer below the unit
  under test. A path-shaped mock two layers down encodes the import graph into the test.

- **UT-B4 (MUST · review-only) — Stub a house rule's implementation only where a source guard
  enforces the rule independently.** Replacing a wrapper with a pass-through is legitimate and often
  necessary — a flow test must not wait out a 55 s deadline. What makes it safe is that something
  else, which the stub cannot reach, still enforces the rule.
  **Evidence:** 18 CF test files pass `withAiTimeout` straight through
  (`vi.mock('../../src/adapters/withAiTimeout.js', …)`), and that is **fine**, because
  [`aiTimeoutGuard.test.ts`](../apps/cloud-functions/tests/aiTimeoutGuard.test.ts) reads the source
  off disk and never imports the modules it checks — its header says in terms that those 18 stubs
  cannot make it vacuously green. Stub a rule with no such guard behind it and the suite goes green
  over a violated rule with nothing to say so.
  _Verify:_ name the guard in the PR. If you cannot, write it (UT-E1) or do not stub.

---

## C. Preamble and shared fixtures

Preamble is the code before the first `describe(`/`it(`. It is 30.6% of the suite, and it is what
makes a refactor's noise indistinguishable from its breakage.

- **UT-C1 (MUST · guarded) — Use the shared kit; do not re-declare what it owns.** The
  readable-store stand-in is
  [`apps/web-pwa/tests/support/testStore.ts`](../apps/web-pwa/tests/support/testStore.ts)
  (`makeStore`), imported by 61 files. Its header documents the `vi.hoisted` async-import pattern
  that a top-level import cannot satisfy — follow it rather than reinventing a local variant.
  **Evidence:** 60 files once declared their own 17-line copy — ~1,020 duplicated lines in four
  variants differing only in whether the setter was `set` or `_set` (#922).
  _Verify:_ `grep -rn 'function makeStore\|const makeStore' <area>` — in `apps/web-pwa` the only
  legal hit is the kit itself. (`packages/domain`'s three `makeStore` functions are a different
  thing entirely: in-memory `CanonLocalStorePort` fakes, not Svelte stores. Not a violation.)
  _Guard:_ a declaration named `makeStore` in a `*.test.ts` file under `apps/web-pwa/tests` — the
  guard walks only `*.test.ts`/`*.test.mjs`, deliberately: widening it would flag
  `tests/support/testStore.ts` itself, the kit this rule points at, along with the other nine
  non-test files under a `tests/` tree (`setup.ts`, fixtures, type-shims). A local stand-in under
  another name, or one moved into a non-test helper file such as `tests/support/`, is invisible to
  the guard and review-only.

- **UT-C2 (MUST · guarded) — Build domain objects with the real builders.** `emptyRecipe`,
  `duplicateRecipe`, `emptyIngredientGroup`, `newIngredient` and `newStep` are exported from
  [`packages/domain/src/recipe/commands/builders.ts`](../packages/domain/src/recipe/commands/builders.ts).
  A hand-rolled literal drifts from the schema silently and produces the #838 failure mode below.
  **Evidence:** **34** test files still declare a hand-rolled `makeRecipe` while the real builders
  sit unused — up from the 30 #941 counted, which is drift continuing in the absence of this rule.
  _Guard:_ a declaration named `makeRecipe` in a `*.test.ts`/`*.test.mjs` file, in every area — the
  guard walks only files with those suffixes under `<area>/tests`, so a hand-rolled `makeRecipe`
  moved into a non-test helper file (`tests/support/`, a fixture module) before being imported is
  invisible to it, the same as one declared under another name. Both are review-only.

- **UT-C3 (MUST NOT · guarded) — Do not repeat what shared setup already does.**
  `document.body.style.pointerEvents = ''` appears in **34** files while
  [`tests/setup.ts`](../apps/web-pwa/tests/setup.ts) already does it globally in an `afterEach`.
  Before adding any file-level `beforeEach`/`afterEach`, read that file.
  _Guard:_ an assignment to `document.body.style.pointerEvents` in a `*.test.ts` file under
  `apps/web-pwa/tests` — the guard walks only `*.test.ts`/`*.test.mjs`, so `tests/setup.ts` itself,
  where the real assignment lives, is not scanned; widening the walk would flag the very file this
  rule points at. That one duplication, repeated in a test file, is the guarded case; the rule's
  wider claim — do not repeat ANYTHING `setup.ts` does, including from a non-test helper file — is
  review-only.

- **UT-C4 (SHOULD · review-only) — A new helper used by a third file moves to `tests/support/`.**
  Two copies is a coincidence; three is a shared helper that has not been extracted yet. Put it
  beside `testStore.ts` with a header saying what it is for. Note the constraint that put it there:
  `@salt/testing-utils` had zero importers and was deleted under #923, and a replacement package
  would need an issue-first layer-map edit. The kit is deliberately app-local.

---

## D. Table-driven over copied bodies

- **UT-D1 (MUST · review-only) — Three or more `it(` blocks differing only in data are one
  `it.each`.** Copied bodies are where drift starts: each copy is later edited independently until
  no extraction is possible without a rewrite.
  **Evidence:** `.each` is used 47 times across 451 files; 4 of those are in web-pwa's 1,809 tests.
  Meanwhile **15 of 27** firebase-sync unit files repeat the same ~35-line `vi.hoisted` +
  `vi.mock('firebase/firestore')` block, each differing just enough to block extraction — 13 of 25
  when #941 measured it, so this one is still growing too.
  _Verify:_ read consecutive `it(` bodies in the diff; if a diff between two is only a literal, it
  is a table row.

- **UT-D2 (MUST · review-only) — A table's case must name itself in the test title.** Use
  `it.each(cases)('$name …')` or a template table, so a failure names the row. A table that reports
  "case 7" costs more to diagnose than the copies it replaced.

- **UT-D3 (SHOULD · review-only) — Derive the table from the source of truth where one exists.** A
  table over "all 28 `subscribe*` exports" should read the barrel, not a hand-typed list — see
  UT-E1. This is what makes a table a guard rather than a snapshot of what someone remembered.

---

## E. Source-scanning guards

A guard test that scans source for a rule violation is the strongest recurrence prevention this repo
has. It is also the easiest to render vacuously green.

- **UT-E1 (MUST · review-only) — Derive the scan surface from the tree or from the rules file, never
  from a hand-maintained list.** A hard-coded list of files or factories silently stops covering
  whatever is added next.
  **Evidence and the model to copy:**
  [`apps/cloud-functions/tests/aiTimeoutGuard.test.ts`](../apps/cloud-functions/tests/aiTimeoutGuard.test.ts)
  used to scan `src/flows/` flat — which is why it did not catch #915 — and now walks every `.ts`
  under `src`, with a test asserting the walk still finds AI calls outside `src/flows` so a
  re-narrowing fails loudly. Copy that shape.

- **UT-E2 (MUST · review-only) — A guard must fail when its target moves.** Add a test that asserts
  the scan found something. A guard that greens on an empty match set has stopped guarding, and
  nothing else in CI will say so.
  **Evidence:** five guards were measured drifting in #941 — `functionMemoryPin` listed 12 factories
  and omitted `makeTracedCallable`; `appCheckEnforcement` carried a hand-maintained
  `MIN_EXPECTED_CALL_SITES = 15` with an in-comment instruction to raise it; `imagePromptSingleSource`
  and `extractProcessStages` matched verbatim English sentences that go green on a reworded prompt.

- **UT-E3 (MUST NOT · review-only) — Do not match prose.** Assert on structure — an identifier, an
  import, a call shape — never on a sentence copied out of a prompt constant. Prose is edited for
  tone by people who will never think to look at a test.

- **UT-E4 (MUST · guarded) — No `../../../../packages/...` path escapes.** Resolve through the
  package specifier. A relative path out of a package breaks on any file move and encodes the
  layout.
  _Guard:_ two or more `../` reaching `packages/` or `apps/`, with comments stripped so a mention of
  the rule is not an instance. Note that four is not the threshold: the only escape this guard has
  ever frozen climbed three, which is why #1134's grep for four read zero violations off a tree that
  had one. #1163 resolved that one through the `@salt/firebase-sync` specifier and dropped the
  ceiling in the same commit, so every area in `unit-test-spec.areas.mjs` now pins `UT-E4` at 0 — the
  rule is pinned, not exempted, and the threshold is what holds it there.

---

## F. Async, determinism, and the jsdom harness

- **UT-F1 (MUST · review-only) — Never tune a wait budget to make a test pass.** The suite's
  `asyncUtilTimeout` is 5 s, set globally and reasoned about in `setup.ts`. **A failure whose
  duration moves with the budget is a test bug, not a starved wait** — the predicate does not gate
  what the test then asserts. Fix the predicate.
  **Evidence:** #793/#804. Measure a suspected flake rather than arguing about it, by the route that
  exists for the suite in question. `pnpm soak` (`scripts/soak-unit-tests.mjs`) re-runs `pnpm test`
  under CPU contention, so it reaches every project in the root `projects` list and nothing else.
  For the `*.emulator.test.ts` files it reaches nothing at all — neither emulator config is in that
  list — and the route there is `pnpm flake:emulator` (`scripts/emulator-flake-rate.mjs`), which
  reports a rate for the `Vitest integration (emulator)` **job** from real cold CI history rather
  than per file. This rule governs that suite's budgets (`testTimeout`, `hookTimeout`,
  `CONVERGENCE_MS`, `WARMUP_MS`) exactly as it governs `asyncUtilTimeout`.

- **UT-F2 (MUST · review-only) — Inside a bits-ui focus trap, type with `fireEvent`, not
  `userEvent.type`.** A Sheet or Dialog focus trap eats `userEvent`'s per-keystroke events, so the
  input receives a truncated value and the test fails on an assertion that looks unrelated.
  **Evidence:** #793/#804, the second of that investigation's two root causes.
  **And a helper that OPENS one must wait for focus to land in it before it returns.** bits-ui takes
  the dialog on a tick of its own; until it does, `document.activeElement` is still the trigger, so a
  key pressed in that window is dispatched from wherever the trigger sits and runs every handler on
  the way up. Wait on `dialog.contains(document.activeElement)`, not on the dialog merely existing.
  **Evidence:** #967 — the planner's Escape reached the day sheet on one machine and the cook deck
  underneath it on another, and passed both times.

- **UT-F5 (MUST · review-only) — Drive a production timer; never wait for it.** A module that sets a
  real `setTimeout` to undo itself (a flash, a debounce, an idle settle) fires only if the worker
  outlives the delay, which is a property of the host, not of the test. Use fake timers and
  `vi.advanceTimersByTime` so the callback runs on both platforms or on neither.
  **Evidence:** #967 — `savedTick`'s 1.5 s clear ran on CI's runner and not on macOS, so the module
  measured 7/7 lines on one and 6/7 on the other with the suite green either way.

- **UT-F6 (MUST · review-only) — If the component reads the clock, freeze the clock.** A suite that
  computes its expectations from `new Date()` at module load while the component under test goes on
  reading the live clock is not deterministic, however the comment beside it is worded: a run that
  straddles local midnight freezes the expectation on one date and renders the next. Freeze with
  `vi.useFakeTimers({ toFake: ['Date'], now: FIXED })` — `toFake: ['Date']` leaves `setTimeout` real,
  so `waitFor`, `userEvent` and CSS animations are unaffected — and derive the date constants from
  that same instant. Then **pin it**: assert the production accessor (`todayIso()`, not a re-derived
  copy) equals the constant, so removing the freeze reds a named test rather than a random 21.
  Choose an instant at noon UTC: that keeps the date the same across the zones this repo is
  actually run in — UTC on CI, Europe/London on the machine it is developed on — and NOT across
  every zone, since noon UTC is already the next day from UTC+12 eastward. If a suite ever needs
  to be zone-proof rather than merely zone-stable here, derive its constants through the same
  accessor the component uses instead of formatting the instant yourself.
  **Evidence:** #1341 — `MealPlanWeekPage.test.ts` failed 21 date-keyed assertions at once on PR
  #1340 and passed on a re-run minutes later; its own comment called the approach "deterministic",
  making it a Rule 12 instance as well as a flake. This is the third unit-suite flake family, after
  the unset `asyncUtilTimeout` (UT-F1) and `userEvent` keystrokes eaten by a bits-ui focus trap
  (UT-F2).

- **UT-F3 (MUST NOT · review-only) — No arbitrary sleeps.** Wait on the real signal: `await
waitFor(...)`, `findBy*`, or `vi.advanceTimersByTime` under fake timers. A bare `setTimeout` race
  resolves differently under the ~nCPU thread pool this suite runs on.

- **UT-F4 (MUST · review-only) — Restore global state you mutate.** Fake timers, `vi.stubEnv`,
  `vi.stubGlobal`, and any direct `window` assignment must be undone in an `afterEach`. Files run in
  a shared worker; leakage lands on an unrelated file and reads as flake.

---

## G. Tooling invariants

- **UT-G1 (MUST · guarded) — A new test directory is typechecked.** Test code is not in a package's
  build `tsconfig.json` (`rootDir: "src"`, `composite`, emits to `dist`), so it is invisible to
  `tsc` unless a `tsconfig.test.json` is added **and wired into the root `typecheck` script**.
  **Evidence:** #942 wired `apps/web-pwa/tsconfig.test.json` in and 174 fixture defects fell out of a
  suite that had been green for 41k lines. #1135 then did the remaining five packages at once and
  **507** more fell out, including a type import #923 had left dangling and two `expectTypeOf`
  assertions that were simply false. `packages/ui-components/tsconfig.test.json` was the sharpest
  case: added in `84270a98`, correct, and invoked by nothing until #1135 named it.
  **Enforced, not merely written down** (CLAUDE.md rule 12).
  [`scripts/tests/testsAreTypechecked.test.mjs`](../scripts/tests/testsAreTypechecked.test.mjs)
  fails when a `tests/` directory under `packages/**` or `apps/**` holding TypeScript is covered by
  no tsconfig the root `typecheck` script runs, and when that script names a config that does not
  exist. Both directions matter: this rule was broken for months by a config that existed and was
  never run.
  _Verify:_ `pnpm test` — the guard runs in the `scripts` project. `grep typecheck package.json`
  still shows the pairing by hand.
  **Limit — TypeScript test directories only.** `scripts/tests/` is untyped ESM by design, and
  [`scripts/vitest.config.ts`](../scripts/vitest.config.ts) states why next to the `include` that
  makes it so. The obligation there is that the config keeps saying so, not that a
  `tsconfig.test.json` appears; adding one would pull an untyped `.mjs` subject into a TypeScript
  program for no gain. Nothing else in this spec is narrowed by that — A through F, G3 and H bind
  those files exactly as written.
  _Guard:_ a `tsconfig.test.json` that the root `typecheck` script does not name. It cannot tell you
  a test directory is MISSING one — the absence of a config looks the same as a package with no
  TypeScript tests.
  **See also —** the same mechanism over SCRIPT directories is
  [one-shot-scripts.md](one-shot-scripts.md) §1 (#1118). A separate rule over separate directories;
  it narrows nothing here, and nothing here reaches it.

- **UT-G2 (MUST · review-only) — Note what the typecheck does not cover.** `tsconfig.test.json`
  types the test file against the module under test, but `src/env.d.ts`'s `*.svelte` shim types
  every component as a bare `Component` — **props passed from a test are not checked**. Prop
  checking is `svelte-check` (`pnpm check`), a separate job. Do not read a green `typecheck` as "the
  props are right".
  **Limit —** same boundary as UT-G1, and narrower still: it is about a Svelte component's props, so
  it has nothing to say outside `apps/web-pwa` and `packages/ui-components`.

- **UT-G3 (MUST NOT · guarded) — Never raise a retry count to green a unit test.** The unit suite
  has no retries and must not gain any. A retry-pass is a finding.
  _Guard:_ `retry` appearing in any vitest project config named by the root `vitest.config.ts`.

- **UT-G4 (MUST · guarded) — A `.test-d.ts` type-assertion file needs its own typecheck wiring, not
  UT-G1's.** `expectTypeOf` assertions under `tests/**/*.test-d.ts` are inert at runtime — `vitest
run` executes them as ordinary code, where `expectTypeOf` returns a no-op object, so a broken
  assertion never fails the suite. UT-G1's `tsconfig.test.json` wired into the root `typecheck`
  script does not cover them either: a package's own `tsconfig.json` is `composite`, rooted at
  `src/`, and cannot see `tests/` at all. The mechanism is a package-local `tsconfig.typetest.json`
  (`noEmit`, `composite: false`, `include: ["tests/**/*.test-d.ts"]`) referenced from a
  `test.typecheck` block in that package's `vitest.config.ts` (`enabled: true`, its own `include`,
  `tsconfig` pointing at the new file) — this folds the type check into `vitest run` itself, so it
  runs with `pnpm test`, not `pnpm typecheck`. Used by `packages/ui-components` (issue #922) and
  `packages/domain` (issue #932).
  **Evidence:** #932 demonstrated that asserting `CanonItem['schemaVersion']` is `number[]` passed both
  `pnpm typecheck` and every domain test before this wiring existed.
  _Verify:_ a package with `.test-d.ts` files has a `tsconfig.typetest.json` **and** its
  `vitest.config.ts` sets `test.typecheck.enabled: true` pointing at it — either alone leaves the
  assertions unrun.
  _Guard:_ derived from the tree: any area with a `tests/**/*.test-d.ts` must have
  `tsconfig.typetest.json` AND `typecheck: { enabled: true }` in its vitest config. Either alone
  reds.

---

## H. Triage — suspect the fixture, not the source

- **UT-H1 (MUST · review-only) — When a test dies on a bare `TypeError`, suspect the fixture
  first.** Six tests sat failing that way because their objects were not valid `Recipe`s. The
  instinct — make the domain helper defensive so it tolerates the malformed input — is wrong twice
  over: it hides the broken fixture and it adds a branch to pure code that production can never
  reach.
  **Evidence:** #838, closed by #942's typecheck rather than by a defensive helper.

- **UT-H2 (SHOULD · review-only) — Reproduce before claiming a fix.** `pnpm soak` for a suspected
  unit flake; `pnpm flake:emulator` for an `*.emulator.test.ts` one, which `pnpm soak` cannot reach
  (UT-F1); `--repeat-each` is the e2e equivalent (NF-H2).

---

## Reviewer checklist

Run top-to-bottom on any new/changed test file before reviewing what it asserts. Any unticked `MUST`
is a block.

**`[ci]` is already ticked for you** — those nine reds `pnpm test` on a new breach, so a reviewer's
job on them is only to check the guard's stated boundary above hasn't been walked around (a
hand-rolled recipe called something other than `makeRecipe`, a hand-rolled recipe or store moved
into a non-test helper file under `tests/` — the guard sees only `*.test.ts`/`*.test.mjs` — an
all-mock-call `it(` in a file that has behavioural ones elsewhere). Every `[ ]` line is yours alone;
nothing else checks it.

```
Behaviour over implementation
[ci] UT-A1  No it() whose assertions are all toHaveBeenCalled*
[ ] UT-A2  Collaborator-call assertions check the payload (toHaveBeenCalledWith)
[ ] UT-A3  Asserts the exported surface, not a private helper
[ ] UT-A4  Coverage claims come from pnpm test:coverage, not grep-by-symbol

Mocking
[ci] UT-B1  <= 5 vi.mock per file (or a comment naming why the seam can't narrow)
[ ] UT-B2  No mock of a module the file could import for real
[ ] UT-B3  Mocks sit on an architectural seam, not a deep transitive path
[ ] UT-B4  A stubbed house rule (e.g. withAiTimeout) has a named source guard behind it

Preamble & shared fixtures
[ci] UT-C1  Uses tests/support/testStore.ts; no local makeStore
[ci] UT-C2  Domain objects via domain builders, not hand-rolled literals
[ci] UT-C3  No beforeEach/afterEach duplicating tests/setup.ts
[ ] UT-C4  A helper reaching its third file moved to tests/support/

Table-driven
[ ] UT-D1  3+ it() blocks differing only in data are one it.each
[ ] UT-D2  Each row names itself in the test title
[ ] UT-D3  Table derived from the source of truth where one exists

Guards (only if the test scans source)
[ ] UT-E1  Scan surface derived from the tree/rules file, never a hand-kept list
[ ] UT-E2  A test asserts the scan found something (fails when the target moves)
[ ] UT-E3  Matches structure, not prose copied from a constant
[ci] UT-E4  No ../../../../packages/... path escape

Async & harness
[ ] UT-F1  No wait budget tuned to pass; a budget-sensitive failure is a test bug
[ ] UT-F2  fireEvent (not userEvent.type) inside a bits-ui focus trap
[ ] UT-F3  No arbitrary sleeps; waitFor/findBy/fake timers
[ ] UT-F4  Fake timers, stubEnv, stubGlobal, window writes restored in afterEach
[ ] UT-F5  A production timer is driven with fake timers, never waited out
[ ] UT-F6  A clock-reading component is tested against a frozen clock, with the freeze pinned

Tooling (only if a test directory or config is added)
[ ] UT-G1  New TS tests/ dir has a tsconfig.test.json (guard can't see one that's simply missing)
[ci] UT-G1  An existing tsconfig.test.json is wired into root `typecheck`
           (n/a to scripts/tests/ — untyped ESM by design)
[ ] UT-G2  Svelte props still unchecked by tsc — pnpm check is the prop gate
[ci] UT-G3  No retries added
[ci] UT-G4  .test-d.ts files have tsconfig.typetest.json + vitest test.typecheck.enabled wired

Triage
[ ] UT-H1  A bare TypeError means fix the fixture, not soften the source
[ ] UT-H2  Suspected flake measured with pnpm soak before a fix is claimed
```

---

## Appendix — what is deliberately NOT a rule

Kept honest in the same spirit as the e2e spec's appendix: rules considered and rejected, so nobody
re-proposes them as oversights.

| Candidate rule                                  | Verdict                    | Reason                                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A per-file line cap                             | **Rejected**               | `CookModePage.test.ts` is 1,894 lines and is the best-protected code in the #913 programme (#925 was dropped from the refactor because of it). Length is not the defect; preamble ratio is, and UT-C1–C4 target that directly.                       |
| A blanket ban on `vi.mock`                      | **Narrowed → UT-B1/B2/B3** | `domain`, `ui-components` and `observability` reached 98.7% / 88.0% / 83.2% in #941's coverage run with 0, 0 and 12 mocks — but `cloud-functions` and `web-pwa` genuinely sit on Firebase and Genkit seams. The rule is a cap and a seam, not a ban. |
| Mandate a coverage floor per file               | **Rejected here**          | A per-area coverage ratchet is #941 Track A4's job, in CI where it can block. A per-file number in a prose spec is unenforceable and gameable.                                                                                                       |
| Ban `toHaveBeenCalled*` outright                | **Narrowed → UT-A1/A2**    | For a CF trigger whose entire behaviour is "enqueue this task", the call _is_ the behaviour. The defect is a test where it is the **only** assertion.                                                                                                |
| Require AAA / given-when-then comment structure | **Rejected**               | Adds preamble to fix a preamble problem, and nothing can check it in a minute.                                                                                                                                                                       |
| Forbid snapshot tests                           | **Not needed**             | The suite has no meaningful snapshot usage to govern; adding a rule for an absent practice is spec bloat.                                                                                                                                            |
| Require a test per exported symbol              | **Rejected**               | This is exactly the grep-by-symbol error UT-A4 exists to prevent — `ssrf.ts` measured 97.3% covered while naming none of its exports.                                                                                                                |
