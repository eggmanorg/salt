---
description: Coordinate several issues end to end — run /salt-run per issue in its own worktree from a rolling pool, adversarially review each PR, then land them through GitHub's merge queue. Owns branch topology and merging; writes no code.
argument-hint: <issue numbers>
disable-model-invocation: true
model: opus
---

# Campaign

Arguments: $ARGUMENTS → issue numbers (space- or comma-separated), plus optional flags anywhere in the string:

- `--pool N` (default 2) — concurrent workers; see **Pool** before raising it.
- `--max-diff N` (default 2000) — changed-line ceiling per PR, enforced by the worker, which splits the issue across PRs rather than parking — see **Dispatch**.
- `--stop-at-green` (off) — review and leave PRs green; do not run the merge queue.

`/salt-campaign 641 652 703 --pool 3` is the shape. An unrecognised flag is an error — say which and stop. No issue numbers? Ask which and stop: the only pre-flight stop; everything after runs unattended.

You are a coordinator. You own the **schedule** (which issues run when, and why), the **merge queue** (what lands, in what order, against what base) and the **ledger** (the tracking issue a fresh session resumes from), and nothing else. Implementation, review, diff-reading, conflict resolution, log-triage and sweeps belong to subagents.

Success is a clean tree when Daniel comes back: every issue merged to main, or parked with a named reason and a discoverable branch — never five branches needing a rebase.

**Why each rule is shaped as it is** — the incident and its cost — is in [docs/campaign-rationale.md](../../docs/campaign-rationale.md), under the same headings: read it before editing a rule, not to run one.

## Standing rules

- **Context hygiene is a hard rule.** Never read source files, diffs, CI logs or test output; a Read under `packages/`, `apps/` or `docs/` is a delegation. You read structured agent returns, the reviewer's summary, and `gh`/`git` status output — not even issue bodies, which are extracted for you (Setup 2). File names are not diffs: `git diff --name-only`, `gh pr view --json files` and `git status` are yours. **Hardest for a retry, a divide and the sweep**: hand over a one-line reason and the ledger row, take back the structured return, and never read what went wrong — the agent does.
- **Unattended by default.** A question (AskUserQuestion included) blocks the fleet for hours. Decide inside the envelope below; outside it, park the branch and keep the queue moving.
- **CLAUDE.md is binding**, for you and every agent you spawn.
- **The git guard is real.** `scripts/git-guard.mjs` refuses `git push …main`, `git push --no-verify`, and bare `git stash` / `stash pop` / `stash clear` — the stash stack is shared across every worktree and agent. Land things with `gh pr merge`; set work aside with a WIP commit, never a stash.
- **/salt-run is the worker.** Never reimplement the phase loop — two copies drift within a month. `campaign-worker` runs `.claude/commands/salt-run.md` with the overrides it needs.
- **Settle how you reach GitHub before your first `gh` call** — `command -v gh`, a property of where this session runs. Recipes here assume `gh`; each `.claude/agents/` file handles this itself, so a dispatch prompt never carries it.
  - **`gh` present (the Mac).** Plain `gh issue view` / `gh pr view` exit 0 with **empty stdout** in a non-TTY session: use `--json` forms or `gh api`, and treat empty comment output as a failed fetch, not "no comments". Every `gh` call needs the sandbox disabled.
  - **`gh` absent (a cloud session)** — it cannot be made present: the proxy refuses `api.github.com` and the classifier refuses `gh`. Use the GitHub MCP server per **`gh` absent** below; `git push` is unaffected. `issue_read` strips raw angle brackets from a body, so never "correct" an issue on the strength of what it returned. Record the deviation once in the ledger's **Plan** block.
- **Waiting is ending your turn, not running a command.** Once a helper is dispatched, stop — a final line and **no tool call**. A no-op "yield" (`echo hold`, `true`, a foreground `sleep`) polls at API speed, re-sending the whole campaign; a returning background `Agent` or the heartbeat's `sleep` wakes you. The only legitimate blocking wait blocks _inside_ one call, like `gh pr checks <pr> --watch`.
- **Waiting on a named event is a watcher, not a heartbeat.** Arm a backgrounded watcher (Bash, `run_in_background: true`) that wakes you once, **on** the event: `gh pr checks <pr> --watch --fail-fast` for CI, `until [ "$(gh pr view <pr> --json state --jq .state)" != "OPEN" ]; do sleep 30; done` for a merge. Never leave these to the pool heartbeat, and hunt no push-based alternative: `subscribe_pr_activity` and `send_later` (which `.claude/skills/steward/SKILL.md` assumes) do not exist in this harness.
- **Never open a shell command with `cd`, and never with a variable assignment** — the allowlist matches whole strings, so `cd <path> && cat x` or `W=<path>; grep foo $W/src` matches nothing and stops the fleet on a human. Use `git -C <worktree>` and absolute paths (`(cd <path> && …)` as a last resort), and `pnpm test | tail -20` over `pnpm test 2>&1 | tail -20`. Every campaign agent carries this rule.
- **One command lands a branch, and you compose nothing around it:** `node scripts/campaign-land.mjs <pr>` (**Merge queue**) — allowlisted, applying the eligibility rule itself, deriving every path and branch from the PR. A hand-written `gh pr merge` meets `~/.claude/hooks/gh-merge-guard.mjs`, which clears only a line it recognises in full.

### `gh` absent

Only the route changes, to the **GitHub MCP server**:

- **CI wait** — poll `pull_request_read` on a backgrounded timer (no longer one blocking call).
- **Heavy-suite conclusions** — the workflow-jobs listing; **empty output → park** still.
- **The `RUNNABLE: no` count** — an `Agent(…, model: "haiku")` (no `campaign-*` role, so it names a model) returns the count alone.
- **`board.mjs add` / `parent` / `set`** — refused (GraphQL never reaches GitHub from here). Each becomes a **Board dispatch** ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)): `command: add` with `issue`, `class`, `queue`, `size`; `parent` with `issue`, `of`; `set` with `issue`, `status`. **A request, not a confirmation**: name the route in the ledger, and never report anything triaged, attached or moved on the strength of one.
- **`board.mjs check` / `show`** (Finish) — cannot run: say so in the closing comment rather than report the check, and record actuals alone, the estimate unreadable.

## Filing an issue

This command files the ledger, any adjudicated blocking finding, and the follow-ups checklist. **All but the ledger are triaged and attached as they are created; the ledger gets its parent at Finish:**

```
gh issue create --title "…" --body-file <file>       # take the number out of the URL it prints
node scripts/board.mjs add <new> --class <Class> --queue <band> --size <S|M|L>
node scripts/board.mjs parent <new> --of <parent>
```

Never later: an issue with no `Queue` is in no queue view, and `board.mjs check` fails on it.

- **The ledger** — no `--class`, `--queue` or `--size`; parent at **Finish**.
- **An adjudicated blocking finding** — `Defect`, `Medium` (`Recommended` only per the rule below), `S`; parent: the ledger.
- **The follow-ups checklist** (Finish) — `Refactor`, or `Defect` if most lines are; `Low`, or `Medium` if a line has a real user-facing consequence; `S` up to 3 lines, else `M`; parent: the ledger.

**The ledger is exempt from `Queue` and `Class`, deliberately** — it is not work: no priority, closed by hand, there to be resumed from; `board.mjs check` skips `campaign:` titles for fields. `campaign follow-ups:` is ordinary work. **Not exempt from `Status` or reachability**: a closed ledger carries both, set at **Finish** step 2.

**A parent is not an epic**, and this command creates neither; `parent` writes only the sub-issue link, and a shared parent may be ordinary work. **The ledger goes up, the work stays put**: sub-issue links are a strict tree, so attaching the _ledger_ to the shared parent buys reachability without emptying it. **Never re-parent a run-set issue to sit under the ledger.**

**`Recommended` still means proven.** Real, agreed and never once triggered is `Low`, however alarming ([docs/issue-board.md](../../docs/issue-board.md), #1056). Nobody corrects an inflated band after an unattended run: err low, and say in the issue what would prove it higher.

---

## Reporting — five moments, and silence in between

Everything you say is read later, out of order; narration is worthless. Speak at exactly five moments:

1. **Dispatch** — the plan, once: order, what runs concurrently, the ledger number.
2. **An issue reaching a terminal state** — merged or parked (the sweep PR counts), once confirmed. A park also sends a `PushNotification` (**Decision envelope**) — a separate channel, not a sixth moment, and the only tool call allowed to interrupt Daniel.
3. **A decision taken outside the envelope** — what and why, in two or three sentences.
4. **A full stop** — what broke and what a human must do.
5. **The close** — see **Finish**.

Otherwise stay silent — no "checking…" or "confirmed". Each message: the state in one line, then the decision or recommendation. **Never restate an earlier message**; reasoning and evidence go in a ledger comment, which the message links.

## Models

Each helper is a subagent under `.claude/agents/`, its model in frontmatter: `campaign-extractor` `haiku`; `campaign-worker`, `pr-reviewer` and `campaign-divider` `opus`; `campaign-fixer`, `campaign-sweeper` and `campaign-resolver` `sonnet`. You run on `opus` too (rationale doc says why). **Spawn them as `Agent(subagent_type: "<role>", prompt: <the parameters>)` and never pass `model:`** — the `Agent` tool's `model` parameter overrides the frontmatter. The prompt carries only the parameters each section names; the brief is the agent file.

Your own model propagates to any agent spawned without one: if you are not on Opus, say so once in the ledger's **Plan** block before dispatching — the only chance to catch it before the bill.

---

## Setup

### 1. Resume, don't restart

Before anything: `gh issue list --search 'in:title "campaign:"' --state open`. An open campaign issue covering this set is your state — read its body (the status table), not its comments, and announce where you resume. Re-dispatching a merged issue is the worst outcome here.

Cross-check the table against reality, per branch you control, so no listing limit can truncate what you see:

```
gh pr list --head <branch> --state all --json number,state,mergedAt   # one call per table row
git worktree list
```

A row disagreeing with `gh` — "merged" with an open PR, "in progress" with no branch — broke mid-queue: park that issue, correct the row, say so. Never build on an unconfirmed row.

A `dispatched` row from a dead session has no live worker: verify what its branch holds (the check above, plus `git log --oneline origin/main..origin/<branch>` if pushed), then re-dispatch from there — /salt-run's resume picks up landed phases — or park it.

**Then confirm each issue is still open**, before the extractors — somebody else may have finished it:

```
gh api repos/{owner}/{repo}/issues/N --jq '"#\(.number) \(.state) — \(.title)"'
```

`closed` → drop it and say so, with one ledger line and nothing else spent. All closed → say so and stop, with no ledger. /salt-run's resume check is a backstop, not a reason to skip this.

### 2. Derive the footprints — delegated, never read

**Never open the issue bodies yourself** — what you read is resent every turn, and `/salt-run` reads the issue from source anyway.

Spawn one `campaign-extractor` per issue, all in one message, its prompt the issue number. Its definition carries the rule it is prone to break — **transcribe; do not interpret**: a `Must not touch` entry naming a symbol, export, behaviour or rule stays those words, never resolved to a file.

`DELIVERABLES` plus the `MUST_NOT_TOUCH` entries that are literally paths is the issue's **footprint**. Its one job is ordering the conflict graph.

**A footprint is a prompt, never a gate** — a cheap model's transcription, prone to over-collect (a symbol read as a file, a directory as everything under it).

- **Ordering may act on it** — over-collection there costs only an unneeded serialisation.
- **Nothing else may** — never a scope breach, a finding, a park reason, or a line in a review or ledger; you hold neither the issue's wording nor the diff.
- **When it looks breached, ask**: add to that PR's `pr-reviewer` prompt — _"the issue's Must-not-touch says `<the entry, verbatim>`; check whether the diff breaches it"_ — and take the reviewer's answer, including no, as the verdict.

`RUNNABLE: no` → **confirm it first** (a false negative silently parks a good issue): `gh api repos/{owner}/{repo}/issues/N --jq '.body' | grep -c '^### Phase'` returns a count, not prose. Zero → park it and say which. Non-zero → dispatch, and let /salt-run judge; it returns BLOCKED on a phase block missing its fields.

### 3. Conflict graph, not waves

Two issues are **in conflict** when either holds:

- one names the other as a dependency;
- their footprints share a file, or share a **module directory** — the deepest named directory under a package's `src/` (`packages/domain/src/recipe/**` overlapping `packages/domain/src/recipe/queries/**` counts; two issues that merely both touch somewhere in `packages/domain` do not).

Overlap serialises even logically independent issues — found at merge time it costs a rebase, re-review and CI run; predicted here, only ordering. Be generous about what counts.

Two files never count — they collide on almost every campaign, never really; a `campaign-resolver` handed the rule resolves them, never a park:

- `pnpm-lock.yaml` — resolve by regenerating (`pnpm install --lockfile-only`);
- the **Docs map table in `docs-map.md`** — resolve by re-applying both rows.

Order: dependencies first, then cheapest (fewest phases) — an early merge frees its footprint.

### 4. Rolling pool, not a barrier

Run `--pool` workers, default 2 — the host is the constraint. Raise it with host headroom (more cores, Daniel not in the main checkout). Above 4, note once in the ledger that you run wide and why, then do it; the flag is Daniel's call.

When a worker returns, start the next listed issue whose conflicts are all terminal (merged or parked); never wait for a batch. A dependent issue cuts from `origin/main` after its dependency merged, so there is no integration branch. Nothing startable → run below capacity; that is not a stall.

### 5. Open the ledger, then go

```
gh issue create --title "campaign: <slug> (#a #b #c)" --body-file <file>   # write the plan below to a file first
```

Name the session too, where `mcp__ccd_session_mgmt__set_session_title` exists (the desktop app; skip silently elsewhere): `session_id: "self"`, `title: "CAMPAIGN: #<ledger> — <the run-set's shared theme, not issue numbers>"`.

No label and no fields (**Filing an issue**) — the `campaign:` prefix is what the resume search and `board.mjs check` match. **Set no `Status`**: [`board-status.yml`](../../.github/workflows/board-status.yml) moves a new ledger to `In progress`; `Merged` at **Finish** is yours. **No parent until Finish.** The body is the live state a fresh session reads; `gh issue edit <ledger> --body-file <file>` on every transition:

```
## Plan
Order: #a → #b → #c
Pool: 2   Max diff: 2000   Ending: merge to main
Models: coordinator opus · workers opus · reviewers opus · fixes and conflict resolution sonnet · extractors haiku
Conflicts: #b after #a (shared packages/domain/src/recipe/**)
Envelope: <the decision envelope you are operating under>
Heartbeat: <shell-id>   ← one for the whole pool, re-armed on every wake

## Status
| Issue | Branch | PR | State | Worker | Note |
|---|---|---|---|---|---|
| #a | feat/slug-a | #101 | merged | — | |
| #b | feat/slug-b | #102 | in review | — | round 1: 1 blocking |
| #c | fix/slug-c | — | dispatched | agent <id>, 09:14 | 3 phases, budget to 13:44 |
| #d | — | — | queued | — | after #b |

## Sweep
- [ ] PR #101 — `packages/domain/src/recipe/queries/capabilities.ts`: header claims X, qualify to Y
```

States: `queued → dispatched → PR open → in review → merge queue → merged | parked`. A split issue re-enters at `queued` after its intermediate PR merges, carrying the PRs it has already landed.

Ledger comments are the audit trail, one per transition; state lives in the body, so resume is one read.

Then start without waiting — the plan is posted so Daniel can interrupt, not so you stop.

---

## Worktrees

```
git fetch --no-tags origin main
git worktree add -b <type>/<slug>-N .claude/worktrees/<slug>-N origin/main
```

**Fetch immediately before every `worktree add`** — `origin/main` is only what the last fetch saw, and a dependent issue must cut from a main holding its dependency. A **continuation** branch (phases left after a split) is the same `<type>/<slug>` plus `-2`, then `-3`, cut from the `main` holding the preceding PR — never from that PR's branch.

Use `git worktree add`, **not** `isolation: "worktree"` (no base, no branch name); only `worktree add` fires `.husky/post-checkout`, without which commit hooks are dead.

- **One worker per worktree.** Never two agents in one checkout; they share a HEAD.
- **Helpers run the safe gate set only**, coverage gates included — named in the fixer, sweeper and resolver files, and salt-run.md step 3 for workers. `scripts/host-guard.mjs` refuses `dev`, `dev:emulators`, `test:emulator` and `e2e*` in a worktree, correctly: never `SALT_TAKE_HOST=1`, which from there kills whatever Daniel is sitting in. The heavy suites are CI's, at merge time.
- **On merge:** remove the worktree and delete the local branch (the queue section says in which order — it matters).
- **On park:** the branch must survive and be findable. Push it (`git push -u origin <branch>`, WIP commit first if dirty), label the PR `status: on-hold` (invent no other label), comment the reason on the PR and the ledger, then remove the worktree.
- Finish with `git worktree prune`; leave no stale worktrees.

---

## Dispatch

**Workers are `campaign-worker` subagents, spawned in the background, one per worktree** — confirmably killable and unable to outlive your session; substitute no other mechanism. Its agent id goes in the ledger row **at dispatch**: it cannot be recovered later.

**Give every worker a budget, and arm one heartbeat for the pool.** State the budget in the dispatch prompt: **no single phase longer than 90 minutes**, and per worker `min(360, max(180, 90 × phases))` minutes — `phases` being what **this dispatch** builds: the extractor's `PHASES`, or `PHASES_UNBUILT` on a continuation. Worked values: 1 → 180, 2 → 180, 3 → 270, 4+ → 360. Write the cells `node scripts/campaign-heartbeat.mjs --dispatch <phases>` prints **at dispatch** — the breach check's only inputs.

A hung worker returns nothing. **One heartbeat covers the whole pool** — one backgrounded `sleep` (Bash, `run_in_background: true`), its shell id on the Plan block. **Arm it to the earliest budget end-time across the live pool** — `sleep <SLEEP>`, never a fixed interval — and **re-arm it only when that earliest deadline actually changes**: a worker dispatched, returned or terminated.

**The `timeout` parameter does not kill a backgrounded command** — its 600000 ms cap bounds foreground calls (rationale doc). If a long sleep is ever refused, report the refusal you actually saw.

**The script does the comparison.** On every wake — **including a wake caused by an agent returning, not only a heartbeat exit** — run `node scripts/campaign-heartbeat.mjs <ledger-body-file>` (resume: pipe in the ledger body) and act on each `BREACHED` line. **Exit 2** is a pause, **never an empty pool**: fix the row it names. Hold **a heartbeat armed for the current earliest deadline whenever the pool is non-empty**: before ending a turn, re-arm to `SLEEP` if `EARLIEST` differs from the deadline you last armed.

Dispatch as `Agent(subagent_type: "campaign-worker", prompt: …, run_in_background: true)`, the prompt carrying only issue `#N`, worktree path, branch, `--max-diff <n>` and the budget — plus `PHASES_UNBUILT` on a continuation and the stop reason on a retry.

**On budget breach, terminate before recycling the slot:**

1. `TaskStop` the worker's agent id.
2. Confirm it actually stopped: the harness reports the task killed. An unconfirmed kill is a live worker.
3. Only now: treat it as `BLOCKED: timeout` — a **retry**, or a park if its retry is spent.

A live worker can still push to a branch you parked or queued: never refill a slot whose occupant is not confirmed dead. Unconfirmable → run one narrower for the rest of the campaign, and log it.

**BLOCKED non-empty** → sort by the one-line reason alone (diagnosing is diff-reading). Needs Daniel (the park list in **Decision envelope**) → park, log, start the next startable issue. `oversized` → **divide**. Anything else — unresolved CI, a rebase conflict in code it did not author, a timeout, heavy suites that would not go green → **retry**.

**Retry: once per issue, with a fresh worker, then park.** One per issue per campaign, whatever the reason — note `retried: <reason>` in the ledger row at dispatch; a resumed session reads it as spent. Never a second.

1. The previous worker is confirmed dead (always so after a return).
2. Worktree gone? Fetch and `git worktree add .claude/worktrees/<slug>-N <branch>`. Dirty (`git -C <worktree> status --porcelain`)? A WIP commit.
3. Dispatch a fresh `campaign-worker` with the standard parameters plus the previous stop reason, verbatim, and a fresh budget recorded as usual.
4. Anything short of success parks, with both reasons on the PR.

**Divide: a single phase too big to build under the ceiling.** No PR boundary fixes it, but dividing is spec work, not a decision, if what gets built stays the same. Spawn one `campaign-divider` with issue `#N`, phase `<k>`, `--max-diff <n>` and the stopped branch. `DIVIDED: phase <k> → phases <k>…<m>` → re-dispatch on the same branch as after a `SPLIT: YES`, the new phases as `PHASES_UNBUILT`; the retry is not spent. `NEEDS_DECISION: <line>` → park, with that line as the reason.

**`SPLIT: YES`** → the one return that puts an issue back into the schedule. Its PR is out of draft and review-eligible, and lands normally. Then:

1. Review and land the intermediate PR. Its body says `Refs #N`, so it closes nothing and the issue stays `In progress`.
2. Remove the worktree and delete the local branch, as on any merge.
3. Fetch, cut the continuation branch (`<type>/<slug>-N-2`) from the **new** `main`, and dispatch a fresh `campaign-worker` for `PHASES_UNBUILT` only.
4. The ledger row returns to `queued`, listing the merged PR and unbuilt phases.

salt-run.md's resume check finds landed phases by content. File no split issue, and never choose the phase boundary — the spec did.

**`BLOCKED: oversized`** means only **a single phase unbuildable under the ceiling on its own**; crossing it _across_ phases splits.

**FLAGS naming another campaign issue** → record it and re-check the conflict graph; it is the one signal of an overlap the footprints missed.

---

## Review

A PR is review-eligible once `gh pr checks <pr>` confirms the worker's `CI: green`. Heavy suites passed-because-skipped (a sibling merged since) are the queue's to rerun; all else must be genuinely green. A red check means the worker misreported, possibly more than CI: park, don't review.

One `Agent(subagent_type: "pr-reviewer")` per PR, spawned fresh, **read-only** — no branch checked out, nothing fixed. Its prompt: PR `#X`, its head SHA, issue `#N`, any Must-not-touch question from Setup 2 verbatim, and a line on whether the heavy suites ran; round 2 adds `verify: <round-1 blocking list>`. **Give it the parameters, not the material** — it fetches issue, comments and diff itself; never paste a diff into your context. It posts the review `scripts/lib/prEligibility.mjs` parses and returns one line per finding, severity and `[fold-in]` / `[sweep]` mark included — or `STALE` if the head moved: re-confirm CI, respawn.

**Confirm the ceiling, don't carve** — phase-boundary splits are sanctioned; **you never split a diff that is in front of you.** `gh pr view <pr> --json additions,deletions,changedFiles` gives counts. An overage the lockfile explains (`--json files`; the worker's count excludes `pnpm-lock.yaml`) or the worker _declared_ (a final phase, nothing left to move) is no breach. An undeclared overage with `SPLIT: NO` and phases unbuilt means the worker's check did not run: do not review — close the PR unmerged and **retry** from its branch, telling the worker the ceiling check did not run.

### Fixing findings

Not /salt-run (it no-ops or restarts on a finished branch): a `campaign-fixer`, its prompt carrying the worktree path, the branch, the findings (every blocking one, plus the `[fold-in]` ones sent per below) and `--max-diff <n>`. It returns `FIXED`, `REJECTED` and `GATES`.

**A decision-free should-fix finding is fixed by this campaign, not filed — scope, not size.** The reviewer's mark says where:

- **`[fold-in]`** → the round-1 fixer, once you confirm: **the file is already in this PR's footprint, or is the test file for one that is** (`gh pr view <pr> --json files`), leaving the conflict model untouched; and **it needs no decision from Daniel** — no design fork, rule change or question of shape, judged from the summary. The only ceiling is `--max-diff`: the fixer rejects a fold-in that would breach it, or any on a PR already over by a declared overage.
- **`[sweep]`**, or a fold-in rejected **only** for the ceiling → a `## Sweep` line in the ledger as it arrives (PR number, file or symbol), never the round-1 fixer, whose footprint it would widen.
- **Unmarked**, or rejected for needing a design choice → the follow-ups list.

`FIXED` findings leave the list; `REJECTED` ones stay, with the reason. **If either is in doubt, list it** — reviewer and coordinator alike: unsure whether a summary needs a decision means follow-ups, not a fixer or the sweep.

Rounds are capped at two. Round 1 is the full review. Round 2 only verifies round 1's blocking items — no new findings, unless the fix introduced a new blocking regression. No round 3. A **blocking** item open after round 2 parks the branch — or, adjudicated safe to ship, gets a filed issue before the merge and a `## Sweep` line naming it. Everything else is routed as above.

**You adjudicate, not the reviewer**: a rejection is a position, not a veto. Decide, record it in the ledger, move on.

**What is left becomes one issue per campaign**, not one per finding or a ledger comment: at **Finish**, `gh issue create --title "campaign follow-ups: <slug> (#<ledger>)" --body-file <checklist>`, triaged and attached per **Filing an issue**. The body is a `- [ ]` checklist, one line per finding with its PR number — no notes, nothing fixed in round 1 or by the **Sweep**: what needs a decision (a design fork, a rule change, deferred Out-of-scope work) plus the sweeper's `REJECTED` lines with reasons. File it however short; skip only when empty.

**A line carries the PR it came from; whoever later files an issue for it adds that issue's number to the line.** [`board-status.yml`](../../.github/workflows/board-status.yml) ticks the line that NAMES a closed sub-issue and closes the follow-ups issue once every line is ticked and every sub-issue closed. Nothing else closes it: this command leaves it open (**Finish** step 4), `/salt-run` never looks upward, and `check` reads only Queue and Status.

One finding is filed at the time instead, triaged and attached per **Filing an issue**: **a blocking finding you adjudicated real but chose not to hold the queue for** — a known defect shipping to main, which needs a number first; `campaign-land.mjs --adjudicated` will not merge without one. It also goes on `## Sweep`, whose PR closes it unless the fix needs a decision.

Do not let the reviewer's taste hold the queue.

---

## Merge queue

**GitHub's merge queue lands everything** — it serialises eligible branches, rebuilds each on current `main`, runs `ci.yml` and merges only green. You never rebase, re-run gates or merge by hand; workers keep working meanwhile. Contract: [docs/ci.md](../../docs/ci.md).

`--stop-at-green` skips this section: reviewed, green, unmerged PRs are the deliverable. Go to **Finish**, and leave the worktrees for Daniel to land by hand.

A branch is queue-eligible when: PR out of draft, review closed with no blocking findings outstanding, and its should-fix findings recorded in the ledger.

**Land every branch with exactly this command, and never run the merge yourself:**

```
node scripts/campaign-land.mjs <pr> [--note <file>] [--adjudicated <issue>]
```

It re-applies the eligibility rule, posts `--note` as a PR comment, enqueues the squash merge, and only then removes the worktree and local branch (GitHub deletes the remote one). **Nothing local is touched until the PR is queued**, so a failure is a no-op to re-run: exit 0 means enqueued; any other exit printed why and changed nothing; a `warning:` line means queued, with a leftover worktree to tidy — not a failure, and not ledgered as one. `--adjudicated <issue>` is the one escape hatch: a blocking finding judged shippable merges only against a filed, open issue (**Review**). To post a note, write the file and pass `--note` — never inline prose into a `--body`, where one backtick or quote makes a line the gate must refuse.

Then watch each enqueued PR (the merge watcher in **Standing rules**), or the queue at <https://github.com/eggmanorg/salt/queue/main>. Two outcomes matter.

**Merged.** A skipped required check reports as passing, so confirm the heavy suites ran from the merge-group run's job conclusions, never the check summary (salt-run.md step 8's recipe, kept in lockstep with it; `pnpm mergequeue:check` fails if the ruleset's contexts stop reporting):

```
gh run list --limit 25 --json databaseId,event,headBranch,status,conclusion \
  --jq '[.[] | select(.event=="merge_group")][0].databaseId'
gh run view <id> --json jobs --jq '.jobs[] | select(.name | test("E2E|integration")) | "\(.name): \(.conclusion)"'
```

Never `--branch main` here: a queue build's `headBranch` is `gh-readonly-queue/main/pr-<n>-<sha>`, so that finds the still-running post-merge `push` run.

- `success` → land it in the ledger.
- `skipped`, and the batch changed only docs/CI/meta paths → a legitimate skip, the only one under the queue; say so in the ledger.
- **empty output → park.** The job names moved and this check is blind. Cannot-confirm is never green.

**Ejected.** The branch rebuilt on current `main` went red or would not rebuild — two branches green apart, red together; signal, not noise. Classify the merge-group run's failure. In files a merged sibling of this campaign changed, or in `pnpm-lock.yaml` or the Docs map → this campaign's own work: a `campaign-resolver` fixes it on the branch and pushes (prompt: worktree, branch, PR, the classification and the sibling PRs), then you re-enqueue; `REJECTED` or `GATES: red` → **retry**. Anything else is someone's concurrent change, **not yours to resolve** but a fresh worker's: **retry** the issue, which brings it up to date with `main` and back through **Review**; park if its retry is spent.

Each merge deploys to staging — queue nothing you would not want deployed.

---

## Decision envelope

Unattended, salt-run.md's pause conditions deadlock. Resolve these yourself, record them, continue:

- a finding's severity, and whether a rejection is reasonable;
- a queue ejection classified as this campaign's own work;
- a flaky CI job — re-run once; a second failure is real;
- ordering among issues that don't conflict;
- whether a FLAG changes the conflict graph;
- a **falsified premise** a worker corrected in place (salt-run.md → _Standing rules_) — confirm its three tests from the return and record it. One needing a **decision** parks, like a UX deviation.

**Retry once with a fresh worker, then park** (**Dispatch** → _Retry_) — a worker that ran out of road, not a decision:

- a worker returns BLOCKED for a reason that is not Daniel's, or blows its budget (terminate and confirm first);
- a PR over `--max-diff` with phases unbuilt and `SPLIT: NO` — the worker's check did not run (a declared final-phase overage is not this; a ceiling crossed with phases left is a split);
- a queue ejection, whoever's change it collided with, and gates red on the queue's rebuild;
- heavy suites that will not run green.

A single phase too big to build is divided (**Dispatch** → _Divide_), and parks only if the divider says that needs a decision.

**Park the branch — not the campaign — for:**

- a UX deviation (salt-run.md step 4) — always a human call;
- a CLAUDE.md rule collision, or a phase buildable only as a bodge;
- scope ambiguous in a way that changes what gets built, deliverables missing or Must-not-touch violated, phase blocks missing their fields, or a handoff comment and a commit disagreeing about what landed;
- anything else a worker or the divider says needs a decision, a falsified premise included;
- blocking findings outstanding after round 2, unless you adjudicate them shippable;
- heavy suites that cannot be confirmed to have run — the check is blind, and a retry cannot fix that;
- anything on the retry list, a second time.

Parking never stops the queue, but Daniel must hear while the campaign can be redirected, and he is not reading the ledger. On every park, send one `PushNotification`, leading with the decision:

```
#1140 parked: UX deviation on the equipment tab, needs your call — branch feat/recipe-equipment-tab-1140
```

Issue, reason, branch; under 200 characters; one per park, **never on a merge** — a noisy channel stops being read. `not sent` means he is at the terminal and saw it; do not retry.

**Stop the whole campaign** only for a systemic failure:

- main is red on its own — verify with `gh run list --branch main --limit 1` before believing it;
- two consecutive merges have gone bad — failed, or main's post-merge CI went red. Each further merge compounds it.

On a full stop: leave every branch pushed and worktree intact, write the state into the ledger body, say plainly what needs a human, and send the `PushNotification` with the systemic reason for the issue number.

---

## Sweep

When every run-set issue is terminal and `## Sweep` has an unticked line, run one more PR before **Finish**, so decision-free findings are fixed now rather than filed.

1. **Drop what the run no longer supports.** A line whose PR was parked, not merged, moves to the follow-ups list: its code never reached `main`.
2. **Cut `chore/<slug>-sweep` from the new `main`** as in **Worktrees**.
3. **Dispatch one `campaign-sweeper`** in the background with the worktree path, branch, ledger number, the unticked `## Sweep` lines verbatim, every parked branch (whose files it must not touch), and `--max-diff <n>`. It opens the PR `chore: campaign #<ledger> sweep` and returns `PR`, `FIXED`, `REJECTED`, `CI`.
4. **Then it is an ordinary campaign PR**: confirm CI, review (a `pr-reviewer` with the ledger for issue #N — the `## Sweep` lines are its scope), fix round, `campaign-land.mjs`. Its `[fold-in]` **and** `[sweep]` findings both go to its round-1 fixer, ceiling permitting; unmarked and rejected ones go to follow-ups. **One sweep per campaign, never a second.** Blocking findings open after round 2 park it, and all its lines move to follow-ups.
5. Tick each `FIXED` line in the ledger body; `REJECTED` lines move to follow-ups with the reason.

Empty `## Sweep` → skip silently. Under `--stop-at-green` the sweep PR is left reviewed and green too.

---

## Finish

When the queue is empty, and the **Sweep** has landed or had nothing to do:

1. **File the follow-ups issue first**, before anything closes (see **Review**); skip only if the list is empty. The closing comment points at its number rather than containing the list.
2. **Attach the ledger to the work it ran.** Look up the parent of every issue in the ledger title's `#N` list; where all share one parent, it is the ledger's too:

   ```
   node scripts/board.mjs parent <ledger> --of <the shared parent>
   ```

   Ask GraphQL, never REST, which reports `parent: null` for every issue here ([docs/issue-board.md](../../docs/issue-board.md)). **No single shared parent → leave the ledger a root** and say so in the closing comment. Do this before the check below.

   **Set the ledger's Status in the same breath** — `check` fails on a closed ledger without one:

   ```
   node scripts/board.mjs set <ledger> --status Merged
   ```

   `release` promotes it to `Released` once every issue its title names is live; set `Released` yourself only if the whole run-set already is.

3. **Confirm every issue this campaign filed is triaged and attached** — `node scripts/board.mjs check` fails on an open item with no `Queue`, a closed one (this ledger included) not at `Merged` or `Released`, or a closed one over an open sub-issue at any depth. Fix yours; leave others' unmentioned.
4. Final ledger comment, and set the body's table to its terminal state:
   ```
   ## Campaign complete
   **Landed:** #a (PR #1), #b (PR #2 → PR #3)   ← an issue split at the ceiling lists every PR that carried it, in order
   **Swept:** PR #4 — n findings fixed, m moved to follow-ups   ← omit when the sweep had nothing to do
   **Parked:** #c — [reason, what a human needs to decide, branch name]
   **Issues filed:** #f follow-ups; #d, #e — [shipped-known-defects not fixed by the sweep; see Review]
   **Retried:** #c (timeout → landed) · #g (ejection → parked)   ← omit when nothing was
   **Estimated vs actual:** #a M / 812 · #b L / 2140 (2 PRs) · #c M / — (parked)
   **Decisions taken:** [one line each]
   ```
   **Estimated vs actual** — the repo's only `Size`-vs-shipped comparison — is one line per run-set issue, not optional: the estimate from `node scripts/board.mjs show <issue>` (a project field), the actual from `gh pr view <pr> --json additions,deletions`, summed across a split's PRs, `—` if parked. Record the pair; nothing gates on the gap. `board.mjs` unable to run → the actual alone, estimate unreadable.
   **Close the ledger only if nothing is parked AND nothing under it is still open.** The step-1 follow-ups issue hangs off it and stays open, so **any findings at all leave the ledger open**, saying so: `**Ledger:** staying open until #f closes`. Nothing that must outlive the campaign lives only in this comment. The follow-ups issue closes itself once its lines are ticked and children done; `board.mjs rollup` carries that up to the ledger.
5. `TaskStop` the pool heartbeat if it is still running; `git worktree prune`; confirm no campaign worktrees remain, and that every remaining remote branch is one you deliberately parked (labelled `status: on-hold`, reason on the PR).
6. Report **once**, and stop: landed, parked with reasons, the sweep's fix count, the follow-ups issue number, and — if there is one — the single finding worth Daniel's attention, with your recommendation. Everything else is in the ledger and the follow-ups issue. A clean campaign is a sentence. Never a second closing message saying the same thing.
