---
description: Execute a phased GitHub issue end to end — branch, then per phase implement, validate, commit, push, CI — landing as a draft PR. Owns the git history; never merges.
argument-hint: <issue number> [--max-diff <lines>]
disable-model-invocation: true
---

# Run Issue

Arguments: $ARGUMENTS → ISSUE_NUMBER, plus an optional `--max-diff <lines>`.

No argument given? If the current branch ends in `-<digits>`, that is the issue — say which and carry on. Otherwise ask which issue and stop until I answer.

`--max-diff` is this branch's diff ceiling in changed lines — **default 2000**, excluding `pnpm-lock.yaml`. A campaign dispatching this loop may pass its own value, overriding the default rather than owning it ([why](../../docs/campaign-rationale.md#the-diff-ceiling-default)); nothing else sets it. Step 9 checks it at each phase boundary; it is not a wall.

You own two things end to end: the **spec contract** (the issue's phases are the scope — nothing more, nothing less) and the **git history** (branch, commits, PR). Everything else is yours to delegate or do directly as the work warrants.

Delegate breadth — codebase sweeps, independent implementation, CI-log triage — and keep judgment: validation against the real diff, the git operations, and every decision the issue's audit trail depends on. Search and mechanical fan-out can run on a cheaper model — `Agent(…, model: "haiku")`, or `"sonnet"` where the sweep has to reason about what it finds. Implementation and validation should not.

GitHub through the `gh` CLI throughout, or — where `gh` is absent — the GitHub MCP server, per the table in _Standing rules_.

Keep the loop's order: it is built so a run neither re-derives what the issue holds nor waits serially on what could overlap.

## Standing rules

- **CLAUDE.md is binding.** A phase that can only be delivered by breaking one of its rules is a pause condition, not a judgment call.
- **No bodges.** If the phase as specified can only be built by contorting the code, stop and raise the spec question. The cleanest, most maintainable code wins over a delivered phase.
- **Flag the simpler path.** If a rule change or a different shape would be materially _simpler and more maintainable_ (not just easier or lazier), say so — in `DECISIONS` if you proceeded, as a pause if it changes the design.
- **A falsified premise is corrected here, not deferred.** See below.
- **Never open a shell command with `cd`.** Use `git -C <worktree>` and absolute paths; `(cd <path> && …)` only when nothing else will do ([why](../../docs/campaign-rationale.md#why-no-leading-cd-in-a-run)).
- Everything else: make the call, record it, continue.

### GitHub without `gh`

`command -v gh` settles the column — a property of where this session runs, not the repo; a cloud session cannot gain `gh`. `git push` is unaffected; only the API layer substitutes — a recipe is substituted, never skipped:

| Operation                        | `gh` present                       | `gh` absent                                |
| -------------------------------- | ---------------------------------- | ------------------------------------------ |
| Issues, comments, PRs            | `gh issue view`, `gh pr …`         | the GitHub MCP server                      |
| Board `set` (**Working branch**) | `node scripts/board.mjs set …`     | **Board dispatch** (below)                 |
| CI wait (step 6)                 | `gh pr checks --watch --fail-fast` | a backgrounded poll of `pull_request_read` |
| Heavy-suite verdict (step 8)     | `heavy-suites.mjs --branch`        | **Heavy-suite files** (below)              |
| Failing-step logs (step 8)       | `gh run view --log-failed`         | `get_job_logs`                             |

- **Empty output is a failed fetch**, never "no jobs". The CI poll is the one wait that no longer blocks inside a single call.
- **Heavy-suite files**: the newest `ci.yml` run on `<branch>` (`list_workflow_runs`, `workflow_runs_filter.branch`), its jobs (`list_workflow_jobs`) and `Detect changes` log (`get_job_logs`, `return_content: true`), saved to files, then `node scripts/heavy-suites.mjs --jobs <file> --changes-log <file> --event pull_request`.
- **Board dispatch** is [`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml) run through the MCP server: `command: set`, `issue: ISSUE_NUMBER`, `status: In progress`; an omitted input stays `(unchanged)`. No token fixes `board.mjs`: the session proxy refuses its `gh api graphql` before any credential is evaluated. **Never a shell `curl`** to the dispatches endpoint (403 `Resource not accessible by integration`; only the MCP path has `actions:write`). **A dispatch is a request, not a confirmation** — name the route you took; never report the board as moved on the strength of one. `check` is deliberately **not** relayed ([docs/issue-board.md](../../docs/issue-board.md) says why).

### An invariant you state, you make mechanical — or you state its limits

A safety property asserted in a header comment, a doc, a PR body or a test name, which the code does not guarantee, passes every gate. This convention is the only control there is ([campaign #1064](../../docs/campaign-rationale.md#invariants-campaign-1064)).

Before writing a sentence claiming the code always, never or only does something:

- **Pin it, qualify it, or delete it.** Either add a test that goes red when the property breaks — verified red by breaking the property first, not merely written — or state the claim with its actual boundary, or do not make the claim at all. A claim precise enough to check is a good outcome even when checking falsifies it.
- **A claim someone has already found false is deleted, not re-worded** ([the story](../../docs/campaign-rationale.md#deleted-not-re-worded)). If the phase you are building is _itself_ a correction to a prose claim, and the claim restates something the code already expresses, delete the sentence rather than attempt another wording — and say so in `DECISIONS`. A comment that has to be re-derived to be checked is the defect, not its wording.
- **Read it as an adversary holding the diff.** Which input, which state, which second construction path makes the sentence false?
- **When you fix one instance, look at its neighbours** — for the second path a later fix introduced that the sentence never contemplated.

Worked example (#1067). The script printed `Mode : APPLY — one AI call per recipe` and its DoD called `--verify` a read-only pre-flight. `--verify` `process.exit`ed before the production confirm gate and the write loop, so a real run reported `Still pending : 0 ✔` and exit 0 having written nothing. The pin was one test: spawn the real CLI with `--project prod --apply --redo --confirm production --verify` and assert it refuses.

Do not try to build a lint rule for this. The campaign's five instances were falsified by five different mechanisms — a wrong operand, a control-flow exit, a set membership that changes over time, a second construction path, a self-consistent assertion — and share no syntactic signature.

### A falsified premise is corrected here, not deferred

The issue's claims about the code were written **without building anything** — an unrun reproduction, a fixture assumed to be the negative case, an adjacent path assumed to work. Building is their first test.

**The default is to correct it inside this phase.** Do that when all three hold:

- it needs **no decision from Daniel** — no design fork, rule change or open question of shape;
- it stays inside the **files the phase already touches** — no new footprint;
- the branch stays under **`--max-diff`**.

Then make the correction, record it in `DECISIONS` with the premise it replaces, and name it in the PR body under the phase it landed in. A premise inside the issue's stated Expected that proves false is fixed or escalated, never noted as something the PR does not do.

**It becomes a follow-on issue only when it fails one of the three** — a genuine design fork, a second surface, a diff that no longer fits. Then it defers, and the PR body says which of the three it failed.

Tell the two apart by the three tests, not by which one the issue happened to mention ([why, and #1518 as the worked example](../../docs/campaign-rationale.md#falsified-premises-why-the-default-flips)).

**This is not a licence to widen scope.** A `Must not touch` entry is a decision and stays binding; an _improvement_ you noticed is not a falsified premise, and defers. Only a claim about the code that building has proved untrue moves.

---

## Setup (once)

`gh issue view ISSUE_NUMBER --comments`. Read it all and hold:

- the **baseline section** verbatim — your standard for every phase. `/salt-spec` issues call it **Intended Experience**; `/salt-defect` issues, **Observed vs Expected** plus **Root Cause**; `/salt-refactor` issues, **Behavior Contract**.
- the phase list: names, scopes, must-not-touch lists, outcomes, and which phase is last

**The outcome field is named for the issue's kind** — **User-testable outcome(s)** (feature), **Verifiable outcome(s)** (defect), **Behavior-preserving check** (refactor). "The phase's outcome(s)" here means whichever one your issue uses.

A refactor phase carries a sixth field, **Safe to stop here?**. A `No` means mid-migration, not shippable at that boundary: commit and push as normal, but say so in the handoff comment.

A phase's outcomes are all in scope and all validated. Never split a phase into extra loop iterations of your own, nor collapse two.

If the phase blocks are missing the fields this loop consumes — no scope, no outcome, no must-not-touch — stop and tell me. Never fill them in yourself.

Your held copy is authoritative. Don't re-read the issue mid-run and drift.

### Name the session

Rename this session — `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` and `title: "RUN: #<issue> — <subject>"`, `<subject>` being the issue's title minus its `feat:`/`fix:`/`refactor:` prefix and imperative verb, cut to the few words that make it recognisable: `RUN: #1333 — Chef's Specials in the data` ([why](../../docs/campaign-rationale.md#session-titles)). Without that desktop-app tool (terminal, cloud), skip this silently.

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

`gh` absent: **Board dispatch** instead (_Standing rules_ table).

Nothing downstream needs a second call: `board-status.yml` reads step 6's `Closes #ISSUE_NUMBER` to move the issue to `In review`, `Merged`, then `Released`. Skip it on a resumed run where the status is already `In progress` or later — never set it backwards.

**A merged PR leaves no ancestry — ask content, not lineage.** `main` is squash-merged, so the commit carrying your work is a _new_ commit with no parent link to the branch it came from. That branch is never an ancestor of `main` and never becomes one: `git branch --merged main` will not list it, `git log origin/main..HEAD` will keep showing every phase commit as unique, and `git merge-base --is-ancestor` will keep answering false — after the merge exactly as before it. Resume on a stale local branch, ask lineage whether the work landed, and you get a confident wrong _no_.

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

**The phase's Context pointers are your context.** Read the files and doc sections they cite; usually that is the whole step. Don't re-read CLAUDE.md. Skip the step for a phase whose ground phase N-1 already covered.

Delegate an Explore only when one of these holds, and say which:

- the phase has no Context pointers, or they don't reach the deliverables it names;
- an earlier phase moved the ground under them;
- the deliverables name files the issue never located.

Never Explore out of habit ([why](../../docs/campaign-rationale.md#the-context-gate)).

When you do delegate it, use `Agent(…, model: "haiku")` — or `"sonnet"` if the sweep has to reason about what it finds — and restrict the report to exactly these three, nothing else:

> 1. **Layers in play** — which packages the phase touches, and any layer-map boundary it crosses.
> 2. **Binding constraints** — the CLAUDE.md rules and doc contracts that bound _this_ phase, each named (rule number, `docs/…` section) rather than paraphrased.
> 3. **What to reuse or respect** — existing functions, types, patterns and tests already covering this ground, with `file:line`.
>
> No preamble, no restating the phase scope, no walkthrough of how the existing code works, no implementation proposal. If one of the three has nothing to report, say so in a line and move on.

### 2. Implementation

**Default: write it yourself, in-place on the issue branch** — you hold the phase spec, step 1's context and the last handoff contract; an implementer starts from none of it ([why](../../docs/campaign-rationale.md#why-write-the-phase-yourself)).

Spawn an implementer only when the phase is large — rule of thumb **400+ changed lines across five or more files** — or divides into two independent chunks worth running at once.

Either way the work lands **on the issue branch with no worktree isolation** — `isolation: "worktree"` branches from `main`, not `HEAD`, so it would miss earlier phases. Use it only for independent parallel work, landed by `git cherry-pick` (merging drags the whole diff-from-`main` with it). Never run two in-place subagents concurrently; they share one checkout and `HEAD`.

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

- `git status --short` and `git diff --stat`: does the changed-file set match "Technical deliverables" and stay clear of "Must not touch"? Read the diff where the paths don't settle it.
- **Run the whole mechanical set concurrently, in one message.** This is exactly what CI blocks on, minus the two heavy suites:

  `pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm check` (Svelte templates) · `pnpm test:coverage` · `pnpm depcruise` · `pnpm boundary:test` · `pnpm docsmap:check` · `pnpm context:check` · `pnpm theme:check` · `pnpm provenance:check`

  Then, once `test:coverage` has written the report they read: `pnpm coverage:files:check` · `pnpm coverage:ratchet:check` — the only two gates outside the batch.

  Nothing waits on a build (packages export `./src/*.ts`). Run the suite **with** coverage, not bare `pnpm test` — the only way to see the coverage gates before CI does. Don't pick gates by what the change "implicates" ([timings](../../docs/campaign-rationale.md#why-the-whole-gate-set-concurrently)).

  The seven beyond the obvious six are the ones a phase trips _without noticing_: a new `docs/` file without a `docs-map.md` row fails `docsmap:check`; `CLAUDE.md` past its budget fails `context:check`; any `packages/ui-components` edit can fail `theme:check` or `provenance:check`; an `eslint.config.*` or `.dependency-cruiser.*` change fails `boundary:test`. The coverage gates have near-zero slack: deleting a well-covered file or adding an uncovered one goes red on the ratchet.

- **Add a production build when the phase touches `apps/web-pwa`'s entry, dependencies or asset pipeline:** `pnpm --filter @salt/web-pwa build`. CI's `boot-payload` job blocks on it. This one _is_ conditional ([why](../../docs/campaign-rationale.md#the-conditional-production-build)).
- On a failure, fix it and re-run **only** the gate that failed; run the full set once more before committing. Do not commit red. A red `format:check` is fixed by `pnpm format`, never by hand-editing whitespace.
- e2e and the emulator integration suite are **not** run here: they seize host-global singletons (CLAUDE.md → _Worktree rules_). They run in CI, at step 8.
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

Then pause for me; never assume continuation. On "continue", carry on to step 5; on a redirect, rework and re-validate from step 3.

### 5. Commit

```
type(scope): short description (under 72 chars)

Phase N. [1-2 sentences on what this phase delivers and why.]

- [Key decision and why — the non-obvious part]
- [Another if needed]

Refs #ISSUE_NUMBER

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

`Refs #ISSUE_NUMBER` on every phase commit including the last — the PR closes the issue. No `#N` anywhere but that footer.

**Keep the `Co-Authored-By` trailer the harness appends by default**, below `Refs`, naming the model you are running as ([why](../../docs/campaign-rationale.md#the-commit-trailer)). A squash repeats it once per phase commit plus GitHub's deduped copy; that is expected, not a reason to strip it.

The pre-commit hook runs `lint-staged` (prettier `--write`, then eslint), then `pnpm typecheck` and `pnpm depcruise` again. So:

- give the commit a generous Bash timeout: 40–60s is normal.
- prettier **rewrites files during the commit**: check `git status --short` afterwards and amend if the hook left anything behind.
- the overlap with step 3 is belt-and-braces, not licence to skip those gates earlier.
- **it covers typecheck and depcruise only**, and there is no `pre-push` hook ([why](../../docs/campaign-rationale.md#no-pre-push-hook)): step 3's `pnpm test` is the only local suite run, so skip it and CI is the first to notice a broken test.

### 6. Push, and start CI in the background

The two heavy suites — `E2E (Playwright)` and `Vitest integration (emulator)` — run only in CI.

```
git fetch --no-tags origin main
git rebase origin/main    # no-op when already current
git push -u origin <type>/<slug>-ISSUE_NUMBER
```

**Pushing runs no gates** and proves nothing. A push that takes minutes is the network; do not kill it.

**Rebase every phase, before pushing.** CI skips both heavy suites when the branch is behind `origin/main`, and nothing rebases a `/salt-run` draft for you ([why](../../docs/campaign-rationale.md#rebase-every-phase)). Add `--force-with-lease` only when the rebase rewrote commits.

**Phase 1 only — open the PR, as a draft.** CI triggers only on `pull_request` and pushes to `main`: **a pushed branch with no PR runs no CI at all.** It stays draft until the final phase.

```
gh pr create --draft --base main --head <type>/<slug>-ISSUE_NUMBER \
  --title "type(scope): short description" \
  --body "Closes #ISSUE_NUMBER

WIP — phases land as commits. Full summary on the final phase."
```

**Open with `Closes`; swap to `Refs` only if this turns out to be an intermediate PR** — step 9's split does it, **before** `gh pr ready` and never after ([why](../../docs/campaign-rationale.md#why-closes-before-refs-is-safe)).

Then start the watch **in the background** and move on (`gh` absent: _Standing rules_ table):

```
sleep 20 && gh pr checks --watch --fail-fast      # Bash tool, run_in_background: true
```

The `sleep` is not padding: without it `gh pr checks` can exit at once with _"no checks reported"_, which looks like a finished CI. A watch that returns within seconds is that — re-issue it, never read it as a result ([why](../../docs/campaign-rationale.md#the-backgrounded-ci-watch)).

A run takes about 10 minutes — p50 over successful `ci.yml` `pull_request` runs, range 8–15 — and you are re-invoked when the watch exits, so blocking here is the single largest waste in a multi-phase run. Do step 7 while it runs, then step 1 of phase N+1 if there is one — a context read is cheap and CI cannot invalidate it.

Stop there. **Do not start implementing N+1 until you have read phase N's CI result** (step 8): building on a red phase turns one rework into two.

### 7. Handoff comment

Comment on issue #ISSUE_NUMBER — the audit trail and the AI PR reviewers' brief. Keep every heading, drop any filler line:

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

For a single-phase issue, drop **Handoff contract** and **Settled** entirely.

### 8. Read CI — and check the heavy suites actually ran

Picks up when the backgrounded watch from step 6 returns.

**A green tick is not proof a suite ran.** `E2E (Playwright)` and `Vitest integration (emulator)` are required checks, and a _skipped_ required check reports as **passing**. So take the verdict, never the check summary (`gh` absent: _Standing rules_ table):

```
node scripts/heavy-suites.mjs --branch <type>/<slug>-ISSUE_NUMBER
```

- `ran-green` → verified.
- `skipped-non-app` → **not verified**, correctly: only non-app paths changed, so no e2e signal. `skipped-behind` → **not verified**: the branch is behind `origin/main`, which is no longer yours to fix — the merge queue runs these suites on current `main` before it lands ([docs/ci.md](../../docs/ci.md)); rebase only if you need the signal. `cannot-confirm` → **not verified**; its `reason:` line says why. Say which in the handoff comment; never report any of the three as green.
- `pending` → re-read once the run finishes. `cancelled` → a later push superseded that run; re-run the command.
- `failed` → `gh run view <run-id> --log-failed` (id on the `run:` line) gives the failing steps alone, never the full log. Fix on the issue branch (delegate the triage if large), commit, push. Can't resolve it → stop and tell me.

Blind spot: a phase editing the e2e or integration job setup **inside `.github/workflows/ci.yml`** skips those suites. Flag it and validate on a follow-up that also touches app code.

### 9. Continue or conclude

**Measure the branch first**, against `--max-diff`, at every phase boundary:

```
git fetch --no-tags origin main
git diff --numstat origin/main...HEAD -- . ':(exclude)pnpm-lock.yaml' \
  | awk '{a+=$1; d+=$2} END {print a+d}'
```

Three outcomes:

- **Over the ceiling, with unbuilt phases remaining → split here.** Do not start N+1. Finish this PR as an intermediate one, in this order: swap its body's `Closes #ISSUE_NUMBER` for `Refs #ISSUE_NUMBER` and write the summary for the phases that landed, append ` (#ISSUE_NUMBER)` to the title, then `gh pr ready`. Comment on the issue with the PR URL, the line count, and the numbers and names of the phases still to build. Then stop and report: those phases are a fresh run on a continuation branch (**Working branch**), not this run's job.
- **Over the ceiling with nothing left to build → ship it as one PR** — there is no phase left to move into a second one. Note the count in the PR body and conclude normally below.
- **Under the ceiling → carry on.**

The check measures only what is built, never a forecast. A **single phase that alone exceeds the ceiling** is a pause condition, not a split — there is no boundary inside it to cut at ([why](../../docs/campaign-rationale.md#the-ceiling-looks-backward)).

More phases and under the ceiling → into N+1, at step 2 if step 1 overlapped the CI wait.

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
   On a continuation PR, say which phases this one carries and link the PRs that carried the earlier ones, so a reviewer does not read them as missing work.
2. `gh pr ready`. Do **not** merge it, and do not enable auto-merge: that enqueues it.
3. One comment on the issue: the PR URL and a line per phase — the handoff comments already hold the detail.
4. Report done with the PR URL, leaving the PR open for me to merge.
5. **The run ends here — stop timing.** Stay subscribed to the PR so a review
   comment or a late CI failure still wakes you, but schedule no further
   check-in. [`.claude/skills/steward/SKILL.md`](../skills/steward/SKILL.md)
   holds the full cadence rule.

---

## Pause conditions (stop and wait for me)

- Deliverables missing or must-not-touch violated (step 3)
- A UX deviation (step 4) — always, before the commit and the next phase
- The phase can only be built by breaking a CLAUDE.md rule, or only by a bodge
- A **single phase** cannot be built under `--max-diff` on its own (step 9); crossing it _across_ phases splits and never pauses
- Phase scope is ambiguous in a way that changes what gets built
- The issue's phase blocks are missing the fields this loop consumes (Setup)
- A rebase conflict against `origin/main` in code this run didn't author (step 6)
- The resume check found a handoff comment and a phase commit disagreeing about what landed (Setup)
- CI failure you can't resolve

Otherwise: make the call, record it in `DECISIONS`/`FLAGS` or the handoff comment, continue.
