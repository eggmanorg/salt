---
description: Adversarially review one green PR for the defects CI structurally cannot see, rank them by impact and size, and post them as a single PR comment. Fixes them before merge by default; files a follow-up only when fixing would bloat the PR.
argument-hint: <pr number | url | branch>
disable-model-invocation: true
model: opus
---

# Review PR

Argument: `$ARGUMENTS` → a PR number, a PR URL, or a branch name.

No argument? Resolve the current branch's PR: `gh pr view --json number,headRefName`. No PR on this branch → say so and stop; there is nothing safe to guess.

You are looking for the defects that **only a reader can find**. Every mechanical property of this diff has already been decided by a machine, twice — once locally by the pre-commit hook, once in CI — and it decided them better than you will. Your entire value is in the four lenses at step 4, and every sentence you spend outside them is a sentence that makes the real findings harder to see.

This runs **once**. There is no second pass over your own fixes: a reviewer asked to look again always finds something, so the loop never terminates. What gates the fixed branch is CI and Daniel, never a second model opinion.

## Standing rules

- **CLAUDE.md is binding** — layer map, hard rules, data model, Zod and observability conventions. It is also the standard you review against.
- **Read-only until the findings are posted.** Do not edit, do not run a formatter, do not "just fix that while I'm here". A reviewer holding a pencil stops reviewing and starts tidying, and the tidying is what buries the one real finding. Fixing is step 8, after the comment exists.
- **`gh` traps.** Every `gh` call needs the sandbox disabled. Plain `gh pr view` / `gh issue view` exit 0 with **empty stdout** in this harness — use the `--json` forms or `gh api`, and treat empty output as a failed fetch, never as "no comments" or "no checks".
- **Never open a shell command with `cd`, or with a variable assignment.** Use `git -C <path>` and absolute paths. The permission allowlist matches whole command strings, so `cd x && cat y` matches none of the entries that would have let each part through.
- **Report to Daniel in the shape CLAUDE.md sets** — his decision first, in bold; two or three plain sentences; nothing else. The findings live in the PR comment. The chat reply links it and moves on.

---

## 1. The CI gate — pass, or stop

A review of a PR whose CI has not finished is a review of a diff that is still moving. Establish green first, and **do not investigate a red one** — that is `/salt-run`'s job or Daniel's, and a review session that starts debugging CI has abandoned the thing it was called for.

```
gh pr view <pr> --json number,title,headRefName,headRefOid,isDraft,mergeStateStatus,additions,deletions,changedFiles,files
gh pr checks <pr>
```

Three required contexts, all from `ci.yml`: `Lint, typecheck, test, boundary`, `Vitest integration (emulator)`, `E2E (Playwright)`. Judge:

- **Anything still pending or in progress** → stop. "CI is still running — N of M checks pending."
- **Anything failed or cancelled** → stop, naming the check. Nothing more; you are not diagnosing it.
- **`E2E (Playwright)` or `Vitest integration (emulator)` reporting as skipped** → **not green, and not a red either.** A skipped required check _passes_, deliberately — it is how a docs-only PR merges without paying for the emulator ([docs/ci.md](../../docs/ci.md)). So a green tick is not proof a suite ran. Read the conclusions, not the summary:

  ```
  gh run list --branch <headRefName> --limit 1 --json databaseId --jq '.[0].databaseId'
  gh run view <run-id> --json jobs --jq '.jobs[] | select(.name | test("E2E|integration")) | "\(.name): \(.conclusion)"'
  ```

  `skipped` with every changed file under `docs/`, `*.md`, `LICENSE`, `.github/`, `.claude/`, `.vscode/` or the meta dotfiles → correct, and this PR simply has no runtime signal. Carry on, and say so in the comment. `skipped` with app code in the diff → the branch is behind `origin/main` (`mergeStateStatus: BEHIND` confirms it in one read). Stop: **"the heavy suites did not run — update the branch and re-run `/salt-review`."** That is a state report, not an investigation; do not go further.

Then take the head SHA. Before you post at step 7, read it again — if it moved, a push landed mid-review and your findings are against a diff that no longer exists. Say so and stop rather than posting them.

## 2. What CI already proves — none of it is reviewable

Anything a tool can find, a tool has already found on this exact commit. Re-reporting it is not a cautious second opinion; it is noise that costs Daniel the same attention as a real finding and teaches him to skim.

| Green means proven                                                                                              | So never raise                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `format:check`                                                                                                  | formatting, whitespace, quote style, line length, import ordering                                                                          |
| `lint` + `boundary:test` + `depcruise`                                                                          | the import graph, the layer map, cycles, PostHog/Firebase SDK placement, `no-restricted-imports`                                           |
| `typecheck` + `check`                                                                                           | types, nullability the compiler proves, Svelte template errors, unused generics                                                            |
| `test:coverage` + `coverage:files:check` + `coverage:ratchet:check`                                             | the suite passing, coverage ratios, coverage floors, uncovered-line counts                                                                 |
| `docsmap:check` · `theme:check` · `provenance:check` · `typescale:check` · `context:check` · `mergequeue:check` | a missing docs-map row, raw hex/non-token colours, icon provenance, sub-12px type, CLAUDE.md size, a required context that stops reporting |
| `boot-payload`                                                                                                  | the production build, bundle weight, first-paint payload                                                                                   |
| `Vitest integration (emulator)` + `E2E (Playwright)` — when they genuinely ran                                  | runtime behaviour those suites exercise                                                                                                    |
| `pr-doc-review.yml`                                                                                             | documentation. It ran on this PR and owns the lens                                                                                         |

Two edges worth holding:

- **A doc point is only yours when the diff makes a specific existing sentence factually false and the doc review missed it.** A _false invariant_ is not a doc point — it is lens 1 below, wherever the sentence happens to live.
- **If this PR edits `ci.yml` or a `scripts/check-*.mjs`, the table above may be describing a gate that no longer does what it says.** That is the one case where a gate itself is in scope, and it is lens 1 too: the claim, against the code.

## 3. Gather your own material

Never paste a diff you were handed; fetch it yourself so you know what you are reading.

- the diff: `gh pr diff <pr>`
- the PR body and, if it names an issue, the issue: `gh api repos/{owner}/{repo}/issues/<n> --jq '.body'`
- **existing comments, from both endpoints** — conversation comments and review bodies live apart: `gh api "repos/{owner}/{repo}/issues/<pr>/comments"` and `gh api "repos/{owner}/{repo}/pulls/<pr>/reviews"`

Two things bind you from what you find there. A `/salt-run` PR's per-phase handoff comments carry **Out of scope (do not suggest)** — suggesting work the issue deliberately deferred is a defect in the review, not a finding. And a point already made on this PR is not made again, by you or anyone.

## 4. The four lenses

In this order. The first two are where real defects live and where nearly all your effort belongs.

1. **Correctness** — an input, a state or an ordering under which this code does the wrong thing. Concurrency, LWW clobbering a field a trigger wrote, partial failure, empty and boundary cases, a `Failure` swallowed, an unawaited promise, a listener that outlives its subscriber, an AI call without `withAiTimeout`. **Including a false invariant:** a safety property this diff asserts — in a header comment, a test name, a doc paragraph, the PR body — that the code does not actually guarantee. Read each such claim against the code meant to enforce it and name the input, state, or second construction path that falsifies it. Campaign #1064 shipped five of these, every one green on every gate, and three would have destroyed production data. This is the single highest-yield thing you do.
2. **Architectural intent** — legal by depcruise and wrong in spirit. Policy leaking into an adapter, a domain rule implemented in a component, branching on `recipes.kind` to decide whether something is _allowed_, a fourth browser-storage key, a per-user field on a family-shared collection, a rule that is true today and enforced by nothing tomorrow.
3. **Duplication** — semantic, not textual: the same rule expressed in two places that can now disagree. Not duplicated test scaffolding, not similar-looking code.
4. **Testing** — a gap **only** where a missing assertion means a real defect could ship undetected, and you can say what that defect would be. Do not audit against a checklist and do not open `docs/unit-test-spec.md` or `docs/e2e-test-spec.md`; 50 KB of checklist compels enumeration, and enumeration is what makes a review unreadable. Nothing about test style, naming, or helper duplication.

## 5. The bar a finding has to clear

**Write the failure scenario before you write the finding.** One sentence, concrete: _given this input or state, this code does this wrong thing, and here is who notices._ If you cannot write that sentence, you do not have a finding — you have a preference, and it does not go in the comment. This is the whole anti-nitpick mechanism, and it works because it is a test you either pass or fail rather than an instruction to be tasteful.

Never a finding, whatever the reasoning around it: naming, file layout, comment wording, a suggested extraction or helper, "consider", "might be worth", "for consistency", "could be simplified", a defensive check for a state the types exclude, an alternative you would have written instead, or a risk you can only describe as theoretical.

**Calibrate.** These PRs arrive green, scoped by an issue, and usually built by `/salt-run` against a spec. **Zero findings is the common case and the correct output.** One or two is normal. Six means your bar slipped, not that the PR is bad — go back and delete every line that cannot carry a failure scenario. The pull toward writing _something_ because you were asked to review is the failure mode this command exists to resist, and it is strongest exactly when the PR is clean.

If the honest answer is that you found nothing, the comment is three lines saying so. That is a good review, not a failed one.

## 6. Rank: impact × size

Two axes, judged per finding.

**Impact** is material when someone feels it: wrong data, lost data, a user-visible failure, a security or privacy hole, a gate that has stopped gating. It is not material when the consequence is confined to future maintenance. Alarming is not material — a defect that is real but cannot be triggered by anything the app does today is not material, and saying so is not softening it.

**Size** is trivial when the whole fix is ≤5 lines, mechanical, and lands in a file this diff already touches. You are the only actor holding the diff, so you are the only one who can size it honestly. Any design question, any new file, any second call site → not trivial, however few characters it is.

Then the disposition falls out, and there are only three:

|                        | **trivial fix**      | **non-trivial fix**                                                           |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------- |
| **material impact**    | **Fix before merge** | **Fix before merge**                                                          |
| **no material impact** | **Fix before merge** | **Fix before merge**, unless it would bloat the PR — then propose a follow-up |

**Fix before merge is the preference, and the bar for departing from it is real bloat**, not mere size: the fix pulls in files outside this PR's footprint, or it needs a design decision that would turn a reviewed PR into an unreviewed one. Sizing the diff back is Daniel's call, not yours to take by filing. Every finding is ranked most-severe first: material before immaterial, and within each, blocking failure modes before latent ones.

## 7. Post exactly one comment

```
gh pr comment <pr> --body-file <file>
```

Findings ranked, most severe first, each one: the failure scenario, then the file and line, then the fix in a sentence. Mark each `Fix before merge` or `Proposed follow-up`. Note a heavy-suite skip if step 1 found a legitimate one, so the record says what was and was not exercised.

Write **only findings**. No summary of what the PR does, no restatement of the phases, no "what I verified and found sound" section — Daniel and the author both already know, and a verification list is the most common disguise a nitpick wears. Nothing found is:

```
## Review — no findings

Read for correctness, architectural intent, semantic duplication and test gaps.
Nothing found that CI does not already cover.
```

## 8. Fix, then report

**Fix everything marked `Fix before merge`, without asking.** It is the preference, it is pre-merge, and it is reversible.

The branch has to be checked out to fix it: `git worktree list` finds an existing one, otherwise create one — never touch a worktree that is on another branch. Then the safe gate set, which is what CI blocks on minus the two heavy suites, run concurrently in one message:

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm check` · `pnpm test:coverage` · `pnpm depcruise` · `pnpm boundary:test` · `pnpm docsmap:check` · `pnpm context:check` · `pnpm theme:check` · `pnpm provenance:check`

then, on the report `test:coverage` just wrote: `pnpm coverage:files:check` · `pnpm coverage:ratchet:check`. Never `e2e`, `test:emulator`, `dev` or `dev:emulators`, and never `SALT_TAKE_HOST=1` — they seize host-global singletons and would kill whatever Daniel is sitting in. Commit, push. CI re-runs; you do not re-review.

**A proposed follow-up is proposed, not filed.** It creates a durable artefact and it is the dispreferred branch, so it is Daniel's decision — put it in the reply and stop there. On his yes, file it the way this repo files everything: spawn a subagent pointed at `.claude/commands/salt-defect.md` (or `salt-refactor.md`), since only those shapes are executable by `/salt-run`, then triage it in the same breath — `node scripts/board.mjs add <new> --class <Class> --queue <band> --size S`. An untriaged issue has no `Queue`, appears in no view, and is invisible rather than waiting. **`Recommended` still means proven:** a finding that is real, agreed and never once triggered is `Low`, however alarming it sounded ([docs/issue-board.md](../../docs/issue-board.md)).

Then report, in CLAUDE.md's shape:

- **Nothing found** → "**Nothing needed from you** — nothing found beyond what CI covers." and the comment link. That is the whole reply.
- **Fixed** → what the defect would have done to someone using the app, in one or two plain sentences, then the link. Not a list of the fixes.
- **A follow-up proposed** → the question is the whole reply: what the finding costs if left, and what fixing it now would cost the PR.
