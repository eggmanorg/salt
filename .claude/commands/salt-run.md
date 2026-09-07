---
description: Execute a phased GitHub issue end to end — branch, then per phase implement, validate, commit, push, CI — landing as a draft PR. Owns the git history; never merges.
argument-hint: <issue number> [--max-diff <lines>]
disable-model-invocation: true
---

# Run Issue

Arguments: $ARGUMENTS → ISSUE_NUMBER, plus an optional `--max-diff <lines>`.

No argument given? If the current branch ends in `-<digits>`, that is the issue — say which and carry on. Otherwise ask which issue and stop until I answer; there is nothing safe to guess here.

`--max-diff` is this branch's diff ceiling in changed lines — **default 2000**, excluding `pnpm-lock.yaml` — checked at each phase boundary in step 9. A campaign dispatching this loop may pass its own value; nothing else sets it. It is not a wall. Over the ceiling with phases still unbuilt, the run cuts the built phases as their own PR and the rest become a second one; over it with nothing left to build, the branch ships as it stands. The default used to live only in `/salt-campaign`'s dispatch brief, which left a standalone `/salt-run` with no ceiling at all and improvising one — it lives here now, and the campaign overrides rather than owns it.

You own two things end to end: the **spec contract** (the issue's phases are the scope — nothing more, nothing less) and the **git history** (branch, commits, PR). Everything else is yours to delegate or do directly as the work warrants.

Delegate breadth — codebase sweeps, independent implementation work, CI-log triage — and keep judgment: validation against the real diff, the git operations, and every decision the issue's audit trail depends on. Search and mechanical fan-out can run on a cheaper model — `Agent(…, model: "haiku")`, or `"sonnet"` where the sweep has to reason about what it finds. Implementation and validation should not.

GitHub through the `gh` CLI throughout (`gh issue view`, `gh issue comment`, `gh pr create`). `command -v gh` settles which, and the answer is a property of where this session runs, not of the repo. Absent — a cloud session, where it cannot be made present — GitHub is reachable only through the GitHub MCP server; `git push` is unaffected, only the API layer substitutes. Two recipes below then have no equivalent, so substitute rather than skip: step 6's `gh pr checks --watch --fail-fast` becomes a backgrounded poll of `pull_request_read`, which makes it the one wait here that no longer blocks inside a single call; and step 8 reads the heavy suites' conclusions from the workflow-jobs listing rather than `gh run view --json jobs`, failing-step logs from `get_job_logs` rather than `--log-failed`, with empty output treated as a failed fetch and never as "no jobs".

Two things dominate what a run costs: re-deriving context the issue already holds, and waiting serially on things that could overlap. The loop below is ordered so neither happens — the ordering _is_ the optimisation, so keep it.

## Standing rules

- **CLAUDE.md is binding.** Layer map, hard rules, data-model and Zod conventions, dependency pinning. A phase that can only be delivered by breaking one of them is a pause condition, not a judgment call.
- **No bodges.** If the phase as specified can only be built by contorting the code, stop and raise the spec question. The cleanest, most maintainable code wins over a delivered phase.
- **Flag the simpler path.** If a rule change or a different shape would be materially _simpler and more maintainable_ (not merely easier or lazier), say so — in `DECISIONS` if you proceeded, as a pause if it changes the design.
- **Never open a shell command with `cd`.** Use `git -C <worktree>` and absolute paths; `(cd <path> && …)` only when nothing else will do. The permission allowlist matches whole command strings, so `cd <path> && cat x && sed -n y` matches none of the `cat`/`sed`/`git` entries that would each have run unprompted — and when you are a campaign worker, a permission stop blocks on a human who is not watching.
- Everything else: make the call, record it, continue.

### An invariant you state, you make mechanical — or you state its limits

Every code PR in campaign #1064 shipped the same defect: a safety property asserted in a header comment, a doc, a PR body or a test name, which the code did not actually guarantee. Five for five, all green on every gate. There is no lint rule for "this sentence is true", so this convention is the only control there is.

Before writing a sentence claiming the code always, never or only does something:

- **Pin it, or qualify it.** Either add a test that goes red when the property breaks — verified red by breaking the property first, not merely written — or state the claim with its actual boundary. The unqualified absolute nobody can falsify is the failure mode; a claim stated precisely enough to check is a good outcome even when checking falsifies it.
- **Read it as an adversary holding the diff.** Which input, which state, which second construction path makes the sentence false?
- **When you fix one instance, look at its neighbours.** The commonest way a true sentence goes false is a later fix introducing a second path the sentence never contemplated.

Worked example (#1067). The script printed `Mode : APPLY — one AI call per recipe` and its DoD called `--verify` a read-only pre-flight. `--verify` in fact `process.exit`ed before the production confirm gate and the write loop, so a real run reported `Still pending : 0 ✔` and exit 0 having written nothing. The pin was one test: spawn the real CLI with `--project prod --apply --redo --confirm production --verify` and assert it refuses.

Do not try to build a lint rule for this. The campaign's five instances were falsified by five different mechanisms — a wrong operand, a control-flow exit, a set membership that changes over time, a second construction path, a self-consistent assertion — and share no syntactic signature.

---

## Setup (once)

`gh issue view ISSUE_NUMBER --comments`. Read it in full and hold:

- the **baseline section** verbatim — the standard you validate every phase against. `/salt-spec` issues call it **Intended Experience**; `/salt-defect` issues, **Observed vs Expected** plus **Root Cause**; `/salt-refactor` issues, **Behavior Contract**.
- the phase list: names, scopes, must-not-touch lists, outcomes, and which phase is last

**The outcome field is named for the issue's kind.** A feature phase carries **User-testable outcome(s)**, a defect phase **Verifiable outcome(s)**, a refactor phase **Behavior-preserving check**. Wherever this command says "the phase's outcome(s)", read whichever one your issue actually uses — they are the same contract under three names, and looking for the feature spelling on a defect issue is how a run starts improvising.

A refactor phase carries a sixth field, **Safe to stop here?**. A `No` means the codebase is mid-migration and genuinely not shippable at that boundary: commit and push it as normal, but say so plainly in the handoff comment rather than implying a resting point that doesn't exist.

A phase may carry more than one outcome; all of them are in scope for that phase and all of them get validated. Do not split a phase into extra loop iterations of your own, and do not collapse two.

If the phase blocks are missing the fields this loop consumes — no scope, no outcome, no must-not-touch — stop and tell me. Filling them in yourself converts a spec contract into your own guess at one, which is precisely what this command exists to prevent.

Your held copy is authoritative. Don't re-read the issue mid-run and drift.

### Resume, don't restart

A multi-phase run outlives a session. Before touching anything, work out what has already landed — the comments you just fetched hold it:

- each `## Phase N complete` comment is a landed phase. Take its **Handoff contract** as your input for the next one, exactly as if you had written it this session;
- cross-check against `git log --oneline origin/main..HEAD` on the issue branch. A handoff comment with no commit behind it, or a phase commit with no comment, means something broke mid-phase — say which and ask before building on top of it.

Announce where you're picking up ("phases 1–2 landed, resuming at 3") and start there. Re-implementing a landed phase on top of itself is the worst outcome available in this loop.

### Working branch

```
git checkout -b <type>/<slug>-ISSUE_NUMBER
```

- `<type>`: `feat`, `fix`, `chore`, `docs`, or `perf` per the change's nature.
- `<slug>`: ≤4 kebab-case words from the issue title. Issue #261 "Add meal-planner drag reorder" → `feat/meal-planner-drag-reorder-261`.
- **Continuation run** — the phases left unbuilt when an earlier run hit the diff ceiling and split at a phase boundary (step 9). Same `<type>/<slug>`, with `-2` appended, then `-3`: `feat/meal-planner-drag-reorder-261-2`. Cut it from `main` once the preceding PR has merged, never from that PR's branch: a stacked base breaks the merge queue's assumptions and asks the coordinator to resolve conflicts it is barred from touching.

If the current branch is already dedicated to this issue (it ends in `-ISSUE_NUMBER`, or `-ISSUE_NUMBER-2` and up for a continuation), reuse it rather than nesting. If a branch for this issue exists on the remote, check that out instead of starting a second one, and look for its draft PR (`gh pr list --head <branch> --state open`) — reuse that too, so a resumed run doesn't try to open a second PR against the same branch at step 6. Never run phases on `main`.

All phase commits land on this branch; hold its name for the PR.

**Mark it started on the board**, once, when the branch is first cut:

```
node scripts/board.mjs set ISSUE_NUMBER --status "In progress"
```

**`gh` absent (a cloud session).** That line cannot run there, and no token fixes it: `board.mjs` reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy before any credential is evaluated. Dispatch the **Board dispatch** workflow ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server** instead — `command: set`, `issue: ISSUE_NUMBER`, `status: In progress`; an input you omit stays `(unchanged)`. Never a shell `curl` to the dispatches endpoint: the session credential gets 403 `Resource not accessible by integration` there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a dispatch is a request, not a confirmation** — name the route you took, and never report the board as moved on the strength of one. (`check` is the one board command that is deliberately **not** relayed; [docs/issue-board.md](../../docs/issue-board.md) says why.)

Nothing downstream needs a second call — the `Closes #ISSUE_NUMBER` you write into the PR body at step 6 is what `board-status.yml` reads to move the issue to `In review`, then `Merged`, then `Released` after a production deploy. This one line exists only because no event can observe the moment work starts. Skip it on a resumed run where the status is already `In progress` or later; setting it backwards is worse than leaving it.

**A merged PR leaves no ancestry — ask content, not lineage.** `main` is squash-merged, so the commit carrying your work is a _new_ commit with no parent link to the branch it came from. That branch is never an ancestor of `main` and never becomes one: `git branch --merged main` will not list it, `git log origin/main..HEAD` will keep showing every phase commit as unique, and `git merge-base --is-ancestor` will keep answering false — after the merge exactly as before it. Resume on a stale local branch, ask lineage whether the work landed, and you get a confident wrong _no_, then either re-implement landed phases or stack the next one on history that is already in `main`.

Ask the PR, and confirm against content — every squash subject ends in `(#PR)`:

```
gh pr list --search "ISSUE_NUMBER in:body" --state all --json number,title,state,headRefName,mergedAt
git log --oneline origin/main --grep='(#PR)'
```

Search the issue reference rather than a head branch. A split issue has more than one branch, so `--head <branch>` answers only for the branch you happened to guess and stays silent about the rest — and silence here reads exactly like "nothing landed". Confirm each hit against the squash subjects before believing it.

`merged` means that PR is finished: it cannot track new work and its branch must not be reused. If phases remain, start the continuation from `main` — `git checkout -B <type>/<slug>-ISSUE_NUMBER-2 origin/main` — and let the first push open a new PR.

---

## Per-phase loop (N = 1 to final)

### 1. Context

**The phase's Context pointers are your context.** Read the files they name and the doc sections they cite; for most phases that is the whole of this step. CLAUDE.md is already in your context — don't re-read it. Skip the step entirely for a phase whose ground you already covered in phase N-1.

Delegate an Explore only when one of these holds, and say which:

- the phase has no Context pointers, or they don't reach the deliverables it names;
- an earlier phase moved the ground under them;
- the deliverables name files the issue never located.

That gate matters because the sweep is not cheap and the issue was written to make it unnecessary — an Explore run out of habit re-buys what `/salt-spec` already paid for.

When you do delegate it, use `Agent(…, model: "haiku")` — or `"sonnet"` if the sweep has to reason about what it finds — and restrict the report to exactly these three, nothing else:

> 1. **Layers in play** — which packages the phase touches, and any layer-map boundary it crosses.
> 2. **Binding constraints** — the CLAUDE.md rules and doc contracts that bound _this_ phase, each named (rule number, `docs/…` section) rather than paraphrased.
> 3. **What to reuse or respect** — existing functions, types, patterns and tests already covering this ground, with `file:line`.
>
> No preamble, no restating the phase scope, no walkthrough of how the existing code works, no implementation proposal. If one of the three has nothing to report, say so in a line and move on.

### 2. Implementation

**Default: write it yourself, in-place on the issue branch.** You are already holding the phase spec, step 1's context and the previous phase's handoff contract. An implementer subagent starts from none of that — so delegating means re-serialising what you already have, paying a fresh full context to receive it, and then re-validating its self-report against the diff in step 3 regardless, because a report is a claim and `git diff` is evidence. On a typical phase that is an entire extra agent bought to save you nothing, and across a four-phase issue it is four of them.

Spawn an implementer only when the phase is genuinely large — as a rule of thumb **400+ changed lines across five or more files** — or when it divides into two independent chunks worth running at once. Below that, write the code.

Either way the work lands **on the issue branch with no worktree isolation**. Phases are a dependent chain, and `isolation: "worktree"` branches from `main`, not from `HEAD`: a worktree subagent would not see the previous phases' work.

Use `isolation: "worktree"` only for genuinely independent work you want to run in parallel, and land it with `git cherry-pick` (not merge) onto the issue branch — a worktree branch's merge base is `main`, so merging drags the whole diff-from-main with it. Never run two in-place subagents concurrently; they share one checkout and one `HEAD`.

When you do delegate, brief the implementer with **only** what the phase needs:

- Phase N spec — scope, technical deliverables, must-not-touch — not the whole issue
- the context from step 1
- the previous phase's handoff contract (omit for phase 1)

And instruct it:

> Implement exactly what is in scope. Do not read or implement any other phase.
> Make technical decisions autonomously — CLAUDE.md is your guide, and it is binding.
> If the scope can only be delivered by bending a rule in CLAUDE.md or contorting the code, stop and report that instead of doing it.
> Do not commit and do not post GitHub comments.
> Return:
> BUILT: [what was implemented]
> DECISIONS: [any choice not specified in scope, and why]
> UX_DELTA: [anything differing from the phase's stated outcome(s) — or NONE]
> FLAGS: [anything the next phase must know that isn't in the scope — or NONE]
> CONCERNS: [any rule the scope pushed against, or a simpler/more maintainable shape you'd recommend — or NONE]

### 3. Validate

Check the work, not just the report — a self-report is a claim, `git diff` is evidence.

- `git status --short` and `git diff --stat`: does the changed-file set match "Technical deliverables", and does it stay clear of "Must not touch"? Read the diff wherever the answer isn't obvious from the paths.
- **Run the whole mechanical set concurrently, in one message.** This is exactly what CI blocks on, minus the two heavy suites:

  `pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm check` (Svelte templates) · `pnpm test:coverage` · `pnpm depcruise` · `pnpm boundary:test` · `pnpm docsmap:check` · `pnpm context:check` · `pnpm theme:check` · `pnpm provenance:check`

  Then, once `test:coverage` has written the report they read: `pnpm coverage:files:check` · `pnpm coverage:ratchet:check`. These two are the only gates that cannot go in the concurrent batch, because they consume its output.

  Every package exports `./src/*.ts`, so nothing waits on a build. `test:coverage` and `check` are the only long poles and the other nine finish inside them, so the whole set concurrently costs roughly what `pnpm test:coverage` costs alone — against ~80s for even the core five run one after another. Run the suite **with** coverage rather than bare `pnpm test`: it costs ~6s more (33.0s → 39.3s, measured in `ci.yml`'s `unit` job header) and it is the only way to see the two coverage gates before CI does. Don't spend thought on which gates the change "implicates": that judgment costs more than the run, and getting it wrong costs a red CI five minutes later.

  The seven beyond the obvious six are there because they are the ones a phase trips _without noticing_: a new file under `docs/` fails `docsmap:check` unless `docs-map.md` gained a row, a paragraph added to `CLAUDE.md` fails `context:check` once it passes its budget, any `packages/ui-components` edit can fail `theme:check` or `provenance:check`, and an `eslint.config.*` or `.dependency-cruiser.*` change fails `boundary:test`. The two coverage gates are the ones that bit hardest: they run with near-zero slack, so deleting a well-covered file or adding an uncovered one goes red on the ratchet minutes after a locally-green phase (campaign #1176 lost one CI cycle on #1140 and two on #1137 to exactly this).

- **Add a production build when the phase touches `apps/web-pwa`'s entry, dependencies or asset pipeline:** `pnpm --filter @salt/web-pwa build`. CI's `boot-payload` job blocks on it, and it catches the class of failure `tsc` structurally cannot see — a bare specifier inside a CSS `url()`, a dynamic import that doesn't resolve. This one _is_ conditional, because unlike the rest it is slow.
- On a failure, fix it and re-run **only** the gate that failed; run the full set once more before committing. Do not commit red. A red `format:check` is not a thinking problem — `pnpm format` fixes it, and hand-editing whitespace the pre-commit hook would have rewritten anyway is pure waste.
- The set stops short of e2e and the emulator integration suite on purpose: those seize host-global singletons (see CLAUDE.md → _Worktree rules_), so they are **not** run here. They run in CI, at step 8.
- `UX_DELTA` against the phase's outcome(s), and `CONCERNS` against the standing rules.

Deliverables missing, or must-not-touch violated → do not commit. Comment on the issue describing the gap, stop, wait for me.
`UX_DELTA` non-empty → step 4 next, and pause there before committing anything.
`CONCERNS` naming a rule collision or a materially better shape → surface it to me before committing.

### 4. UX deviation (skip unless `UX_DELTA` is non-empty)

A comment of its own:

```
## ⚠️ UX deviation — Phase N

**Spec said:** [quote from the baseline section or the phase's outcome(s)]
**What was built:** [from UX_DELTA]
**Impact:** [user-visible effect; whether future phases are affected]
**Recommended path:** [continue / adjust spec / fix in next phase]
```

Then pause for me. I either confirm "continue" or redirect — never assume continuation. On "continue", carry on to step 5; on a redirect, rework and re-validate from step 3.

### 5. Commit

```
type(scope): short description (under 72 chars)

Phase N. [1-2 sentences on what this phase delivers and why.]

- [Key decision and why — the non-obvious part]
- [Another if needed]

Refs #ISSUE_NUMBER

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

`Refs #ISSUE_NUMBER` on every phase commit including the last — the PR closes the issue, not the commits. No `#N` anywhere but that footer.

**Keep the `Co-Authored-By` trailer the harness appends by default**, in the trailer block below `Refs`. Name the model you are actually running as. The trailer is the repo's convention throughout — and it is the only per-commit record of which model wrote a phase, which is how the Fable 5 campaign was identified after the fact (`git log --grep='Claude Fable 5' -i --all`). A squash carries one copy per phase commit plus GitHub's own deduped copy at the bottom; that repetition is expected and is not a reason to strip it.

The pre-commit hook is not a formality — it runs `lint-staged` (prettier `--write`, then eslint), and then `pnpm typecheck` and `pnpm depcruise` all over again. Three things follow:

- give the commit a generous Bash timeout. 40–60s is normal, and a commit that looks hung usually isn't.
- prettier **rewrites files during the commit**, so what lands can differ from what you validated a moment ago. Check `git status --short` afterwards and amend if the hook left anything behind.
- the overlap with step 3 is deliberate belt-and-braces, not licence to skip those gates earlier. By the time the hook catches something you have already written the commit message twice.
- **it covers typecheck and depcruise only.** There is no `pre-push` hook — it ran the full suite on every push, a third run of what step 3 had just run and CI would run again, and it was deleted for that. So step 3's `pnpm test` is the only local run of the suite there is: skip it and the first thing to notice a broken test is CI, seven minutes after you have moved on.

### 6. Push, and start CI in the background

The two heavy suites — `E2E (Playwright)` and `Vitest integration (emulator)` — exist only in CI. They are exactly what step 3's gates cannot cover, and CI is the only place they run without taking the host stacks off me.

```
git fetch --no-tags origin main
git rebase origin/main    # no-op when already current
git push -u origin <type>/<slug>-ISSUE_NUMBER
```

**Pushing runs no gates.** No hook fires on push, so the push itself proves nothing — step 3 is where the suite ran, and CI is what re-checks it. A push that takes minutes is the network, not a test run; do not kill it waiting for output that is not coming.

**Rebase every phase, before pushing.** CI skips both heavy suites when the branch is behind `origin/main` — the "Main" ruleset is strict, so a behind-branch must rebase before it can merge anyway, and that rebase re-triggers CI. `auto-update-prs.yml` does that automatically, but only for PRs with auto-merge enabled, which a `/salt-run` draft is not: yours is yours to rebase. Push while behind and you get a green tick for suites that never ran (step 8). Add `--force-with-lease` only when the rebase actually rewrote commits.

**Phase 1 only — open the PR, as a draft.** CI triggers on `pull_request` and on pushes to `main`, and on nothing else: **a pushed branch with no PR runs no CI at all.** The PR exists from phase 1 so every later phase gets a real signal; it stays draft until the final phase.

```
gh pr create --draft --base main --head <type>/<slug>-ISSUE_NUMBER \
  --title "type(scope): short description" \
  --body "Closes #ISSUE_NUMBER

WIP — phases land as commits. Full summary on the final phase."
```

**Open with `Closes`; swap to `Refs` only if this turns out to be an intermediate PR.** One PR per issue is the common case and `Closes #ISSUE_NUMBER` is right for it. If step 9's ceiling check later cuts this PR short with phases still unbuilt, that is the moment you swap the body to `Refs #ISSUE_NUMBER` and append ` (#ISSUE_NUMBER)` to the title. That ordering is safe for one mechanical reason: the swap happens before `gh pr ready`, and GitHub refuses to merge a draft PR — so an intermediate PR cannot reach `main` still carrying a closing keyword. Do the swap after `gh pr ready` and that guarantee is gone.

The distinction is load-bearing. `board-status.yml` derives the issue→PR link from the closing keyword alone ([its header comment says so](../../.github/workflows/board-status.yml)), so a `Refs` PR closes nothing and moves no board field — which is exactly right: the issue stays `In progress` until the PR that actually finishes it merges.

Then start the watch **in the background** and move on:

```
sleep 20 && gh pr checks --watch --fail-fast      # Bash tool, run_in_background: true
```

`--fail-fast` returns on the first failing check instead of waiting out the suites that are still green. On a broken phase that is four or five minutes you get back, and there is nothing you'd have done differently had you waited for the rest.

The `sleep` is not padding: GitHub takes a few seconds to register the run, and `gh pr checks` exits straight away with _"no checks reported"_ if none exist yet — which arrives looking exactly like a finished CI. If the watch does return within seconds, that is what happened; re-issue it rather than reading it as a result.

A run takes 5–7 minutes and you are re-invoked when the watch exits, so blocking here is the single largest waste in a multi-phase run. Do step 7 while it runs, then step 1 of phase N+1 if there is one — a context read is cheap and CI cannot invalidate it.

Stop there. **Do not start implementing N+1 until you have read phase N's CI result** (step 8): building on a red phase turns one rework into two.

### 7. Handoff comment

Comment on issue #ISSUE_NUMBER. This is the audit trail and the brief for the AI PR reviewers — keep every heading, drop any line that would be filler:

```
## Phase N complete

### Built
- [from BUILT]

### For AI PR reviewers
**What changed:** [2-3 bullets]
**Key decision:** [1 sentence — the non-obvious choice and why]
**Out of scope (do not suggest):** [what was intentionally deferred]

### Handoff contract — Phase N+1 must respect these
**Exports:** `functionName(param: Type): ReturnType` — `path/to/file.ts`
**Firestore paths:** `/collection/{id}` schema: `{ field: type }`
**Routes/components:** `/route` — `ComponentName.svelte`
**Invariants:** [anything the next phase must not break]

### Settled (do not modify)
- [file or module now locked]
```

For a single-phase issue there is no phase N+1, so drop **Handoff contract** and **Settled** entirely. Writing a contract for an audience that does not exist is exactly the filler this section tells you to cut.

### 8. Read CI — and check the heavy suites actually ran

Picks up when the backgrounded watch from step 6 returns.

**A green tick is not proof a suite ran.** `E2E (Playwright)` and `Vitest integration (emulator)` are required checks, and a _skipped_ required check reports as **passing** — deliberately, since that is how a docs-only PR merges. The e2e aggregator asserts "did not fail", not "succeeded". So read the job conclusions, not the check summary:

```
gh run list --branch <type>/<slug>-ISSUE_NUMBER --limit 1 --json databaseId --jq '.[0].databaseId'
gh run view <run-id> --json jobs \
  --jq '.jobs[] | select(.name | test("E2E|integration")) | "\(.name): \(.conclusion)"'
```

- `success` → verified.
- `skipped` → **not verified.** Either the branch is behind `origin/main`, or the phase touched only `docs/`, `*.md`, `.github/`, `.claude/`, `.vscode/` and the meta dotfiles — in which case the skip is correct and the phase simply has no e2e signal. Say which in the handoff comment. Never report it as green. A behind-branch is no longer yours to fix: the merge queue rebuilds the PR on current `main` and runs these suites there before it can land ([docs/ci.md](../../docs/ci.md)). Rebase only if you need the signal on this phase.
- `cancelled` → a later push superseded that run (PR runs cancel in progress). Not a defect — read the newer run.
- `failure` → `gh run view <run-id> --log-failed` gives you the failing steps alone; the full log runs to tens of thousands of lines you have no use for. Diagnose and fix on the issue branch (delegate the triage if even that is large), commit, push. Can't resolve it → stop and tell me.

Note the blind spot: a phase editing the e2e or integration job setup **inside `.github/workflows/ci.yml`** skips those very suites, so it cannot be validated green by its own run. Flag it and validate on a follow-up that also touches app code.

### 9. Continue or conclude

**Measure the branch first.** `--max-diff` (default 2000) is checked here, at every phase boundary:

```
git fetch --no-tags origin main
git diff --numstat origin/main...HEAD -- . ':(exclude)pnpm-lock.yaml' \
  | awk '{a+=$1; d+=$2} END {print a+d}'
```

Three outcomes, and only the first is new:

- **Over the ceiling, with unbuilt phases remaining → split here.** Do not start N+1. Finish this PR as an intermediate one, in this order: swap its body's `Closes #ISSUE_NUMBER` for `Refs #ISSUE_NUMBER` and write the summary for the phases that landed, append ` (#ISSUE_NUMBER)` to the title, then `gh pr ready`. Comment on the issue with the PR URL, the line count, and the numbers and names of the phases still to build. Then stop and report: those phases are a fresh run on a continuation branch, cut from `main` after this PR merges, and starting it is not this run's job.
- **Over the ceiling with nothing left to build → ship it as one PR.** A final phase that carries the branch to 2400 lines is not split for the sake of a number — there is no phase left to move into a second PR, and cutting one would produce a PR containing nothing. Note the count in the PR body so the reviewer knows what they are being handed, and conclude normally below.
- **Under the ceiling → carry on.**

The check is backward-looking on purpose: it never asks how large a phase will be before it is built, only whether what is already built has passed the ceiling while work remains. Which is also why a **single phase that on its own exceeds the ceiling** is a pause condition rather than a split — there is no phase boundary inside it to cut at, and the fix is a spec change, not a PR boundary.

More phases and under the ceiling → straight into N+1. Its step 1 is already done if you overlapped it during the CI wait; pick up at step 2.

Final phase done, CI green and the heavy suites confirmed run:

1. Fill in the PR body:
   ```
   gh pr edit --body "<see below>"
   ```
   ```
   Closes #ISSUE_NUMBER

   ## Summary
   [what was built across all phases — one bullet per phase]

   ## Phases
   - Phase 1: [outcome]
   - Phase N: [outcome]

   ## For reviewers
   [key decisions and anything intentionally out of scope]
   ```
   On a continuation PR, say which phases this one carries and link the PRs that carried the earlier ones — its base already contains them, and a reviewer who doesn't know that reads the missing phases as missing work.
2. `gh pr ready` — take it out of draft. Do **not** merge it, and do not enable auto-merge: that enqueues it.
3. One comment on the issue: the PR URL and a line per phase. The per-phase handoff comments already hold the detail — restating it just makes the thread longer to read.
4. Report done with the PR URL. Leave the PR open for me to review and merge — never merge it yourself.
5. **The run ends here — stop timing.** Stay subscribed to the PR so a review
   comment or a late CI failure still wakes you, but schedule no further
   check-in: on a green, mergeable, out-of-draft PR the only thing left to
   observe is me clicking merge, and nothing you would do depends on it.
   [`.claude/skills/steward/SKILL.md`](../skills/steward/SKILL.md) holds the
   full cadence rule, including when the timer earns its place back.

---

## Pause conditions (stop and wait for me)

- Deliverables missing or must-not-touch violated (step 3)
- A UX deviation (step 4) — always, before the commit and the next phase
- The phase can only be built by breaking a CLAUDE.md rule, or only by a bodge
- A **single phase** cannot be built under `--max-diff` on its own (step 9) — that phase was specced too big, and no PR boundary fixes it. Crossing the ceiling _across_ phases is not this: it splits (step 9) and never pauses
- Phase scope is ambiguous in a way that changes what gets built
- The issue's phase blocks are missing the fields this loop consumes (Setup)
- A rebase conflict against `origin/main` in code this run didn't author (step 6) — resolving someone else's concurrent change is not in this run's scope
- The resume check found a handoff comment and a phase commit disagreeing about what landed (Setup)
- CI failure you can't resolve

Otherwise: make the call, record it in `DECISIONS`/`FLAGS` or the handoff comment, continue.
