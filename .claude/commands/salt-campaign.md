---
description: Coordinate several issues end to end — run /salt-run per issue in its own worktree from a rolling pool, adversarially review each PR, then land them through GitHub's merge queue. Owns branch topology and merging; writes no code.
argument-hint: <issue numbers>
disable-model-invocation: true
model: opus
---

# Campaign

Arguments: $ARGUMENTS → issue numbers (space- or comma-separated), plus optional flags anywhere in the string:

| Flag              | Default | Meaning                                                                                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pool N`        | 2       | Concurrent workers. See **Pool** below before raising it.                                                                                    |
| `--max-diff N`    | 2000    | Changed-line ceiling per PR, enforced by the worker. Over it, the worker splits the issue across PRs rather than parking — see **Dispatch**. |
| `--stop-at-green` | off     | Review and leave PRs green; do not run the merge queue.                                                                                      |

`/salt-campaign 641 652 703 --pool 3` is the shape. Unrecognised flags are an error, not a guess — say which and stop.

No issue numbers given? Ask which issues and stop. This is the only pre-flight stop worth making; everything after it runs unattended.

You are a coordinator. You own three things and nothing else: the **schedule** (which issues run when, and why), the **merge queue** (what lands, in what order, against what base), and the **ledger** (the tracking issue that lets a fresh session resume this campaign). Implementation belongs to /run. Review belongs to a reviewer agent. Diff-reading, conflict resolution, log-triage and codebase sweeps belong to subagents.

The success condition is a clean tree when Daniel comes back: every issue merged to main, or parked with a named reason and a discoverable branch. Never five branches needing a rebase. That is the failure this command exists to prevent, and the merge queue is how it is prevented.

## Standing rules

- **Context hygiene is a hard rule, not an aspiration.** You do not read source files, diffs, CI logs, or test output. If you are about to Read something under `packages/`, `apps/`, or `docs/`, that is a delegation. You read: structured agent returns, the reviewer's summary, and `gh`/`git` status output — and not even the issue bodies, which are extracted for you (Setup 2). File names are not diffs — `git diff --name-only`, `gh pr view --json files` and `git status` are yours and you will need them. A coordinator that reads diffs runs out of context at issue three and restarts work that already landed.
- **Unattended by default.** Daniel is not watching. AskUserQuestion is unavailable to you in spirit even where it exists — a question blocks the fleet for hours. Decide inside the envelope below; outside it, park the branch and keep the queue moving.
- **CLAUDE.md is binding**, for you and every agent you spawn.
- **The git guard is real.** `scripts/git-guard.mjs` refuses `git push …main`, `git push --no-verify`, and bare `git stash` / `stash pop` / `stash clear` — the stash stack is shared across every worktree and concurrent agent. Land things with `gh pr merge`. Set work aside with a WIP commit, never a stash.
- **/salt-run is the worker.** Do not reimplement the phase loop. Point each worker at `.claude/commands/salt-run.md` and give it the overrides in **Dispatch**. Two copies of that loop will drift within a month.
- **Settle how you reach GitHub before you write a single brief.** `command -v gh` decides it, and the answer is a property of where this session runs, not of the repo. Every `gh` recipe in this file is written in the first form below; under the second, every brief you write carries the substitution in place of them.
  - **`gh` present (the Mac).** Use it throughout, with two harness traps that every brief must also carry: plain `gh issue view` / `gh pr view` exit 0 with **empty stdout** in a non-TTY session, so use the `--json` forms or `gh api` and treat empty comment output as a failed fetch rather than "no comments"; and every `gh` call needs the sandbox disabled.
  - **`gh` absent (a cloud session), and it cannot be made present.** `api.github.com` is refused by the session proxy and `gh` itself by the permission classifier. GitHub is reachable only through the GitHub MCP server. `git push` is unaffected — only the API layer is substituted. What changes: CI is waited on by polling `pull_request_read` on a backgrounded timer rather than `gh pr checks --watch`, which makes it the one blocking wait this command has that no longer blocks inside a single call; heavy-suite conclusions come from the workflow-jobs listing rather than `gh run view --json jobs`, with **empty output → park** unchanged; and `issue_read` strips raw angle brackets from the body it returns, so never "correct" an issue on the strength of what it read back. Record the deviation once in the ledger's **Plan** block and never again. Campaign #1064 established all of this the hard way; do not rediscover it.
- **Waiting is ending your turn, not running a command.** After you dispatch a worker, a reviewer, a fix agent or a conflict resolver there is nothing for you to do until it returns, so stop — a final line and **no tool call**. A tool call is what keeps a turn open, so a no-op "yield" (`echo hold`, `true`, a bare `sleep`) is not waiting; it is polling at API speed, re-sending the whole campaign context every few seconds. You do not need to poll, because you already armed the wake signals: a background `Agent` re-invokes you when it returns, and the watchdog's `sleep` re-invokes you when it exits. Campaign #1046 had this backwards and ran `echo hold` 1,304 times across eight hours — roughly $600 of cache reads to learn nothing, while its own transcript said "polling just burns turns". The only legitimate blocking wait is one that blocks _inside_ a single call, like `gh pr checks <pr> --watch` while a PR's CI runs.
- **Never open a shell command with `cd`, and never with a variable assignment.** Use `git -C <worktree>` and absolute paths; for a non-git command that needs a directory, `(cd <path> && …)` only when nothing else will do. The permission allowlist matches command strings, so `cd <path> && cat x && sed -n y` and `W=<path>; grep -rn foo $W/src` match none of the `cat`/`sed`/`grep` entries that would have let each part through unprompted — these two shapes are the largest source of permission stops in this command outside the merge queue, and every one of them blocks the fleet on a human. Redirection counts too: prefer `pnpm test | tail -20` to `pnpm test 2>&1 | tail -20`, since the allowlist carries the plain form. This applies to every brief you write, not just your own calls.
- **There is one command that lands a branch, and you do not compose around it.** `node scripts/campaign-land.mjs <pr>` — see **Merge queue**. It is allowlisted, it applies the queue-eligibility rule itself, and it derives every path and branch name from the PR. A hand-written `gh pr merge` still works and is still gated by `~/.claude/hooks/gh-merge-guard.mjs`, but that gate can only clear a line it recognises in full, and an agent composing fresh shell each time will always eventually write one it does not. That was ten stopped runs. Use the command.

## Filing an issue

This command files issues of its own — the ledger, a `BLOCKED: oversized` re-spec, an adjudicated blocking finding, and the follow-ups checklist at **Finish**. Creating one is two thirds of the job. **Every one of them except the ledger is triaged and attached in the same breath as it is created — and the ledger gets its own parent at Finish:**

```
gh issue create --title "…" --body-file <file>       # take the number out of the URL it prints
node scripts/board.mjs add <new> --class <Class> --queue <band> --size <S|M|L>
node scripts/board.mjs parent <new> --of <parent>
```

Neither of those lines is somebody else's job later. GitHub's own project workflow puts a new issue on the board with **every field empty**, and an item with no `Queue` appears in no queue view — so an issue filed and not triaged is not "waiting in Triage", it is invisible, and it stays invisible until someone happens to scroll the unfiltered board. `board.mjs check` fails on one now, which is how you find out you skipped this.

| What you filed                                                               | `--class`                                 | `--queue`                                                    | `--size`                    | `parent --of`            |
| ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | --------------------------- | ------------------------ |
| the **ledger**                                                               | — none of it —                            |                                                              |                             | at **Finish**, see below |
| **`BLOCKED: oversized`** re-spec (a single phase too big — see **Dispatch**) | the issue's own Class                     | the issue's own band                                         | `M` or `L`                  | the issue it came from   |
| **adjudicated blocking finding**                                             | `Defect`                                  | `Medium`, or `Recommended` only per the rule below           | `S`                         | the ledger               |
| **follow-ups checklist** (Finish)                                            | `Refactor`, or `Defect` if most lines are | `Low`; `Medium` if a line has a real user-facing consequence | `S` up to 3 lines, else `M` | the ledger               |

**The ledger is the one exception on fields, and it is deliberate.** It is not work: it carries no priority, it closes by hand rather than through a PR, and it exists to be resumed from and then finished with. `board.mjs check` skips any issue titled `campaign:` in its field rules for exactly that reason — so putting fields on one is not merely unnecessary, it puts a coordination artefact into a work queue. `campaign follow-ups:` does **not** get that exemption and is ordinary work.

**The exemption is about fields, not about reachability.** A ledger used to take no parent either, and the cost of that was the whole point of #1346: everything a campaign throws off attaches to the ledger, so a root ledger puts every follow-up, re-spec and mid-run defect one hop from being unreachable. Campaign #1266 ran #968, #971 and #993 — all three under epic #913 — and left #1269 behind where nobody opening #913 would ever see it. So the ledger is attached too, upward, at **Finish**.

**A parent is not an epic, and an epic is not the only thing that can be a parent** — and this command never creates one of either. `parent` writes the sub-issue link and touches no field, so attaching the follow-ups to the ledger groups them without claiming the campaign was a programme of work. A run-set frequently shares an ordinary work issue as its parent rather than an epic (#1122 and #1202 each hold their own phase issues from inside a work band); the ledger attaches to that exactly the same way. The `BLOCKED: oversized` re-spec is the exception in the other direction: it is the remaining work of the issue it came out of, so it hangs off that issue and inherits whatever epic that issue already sits under.

**The ledger goes up, the work stays put.** A GitHub sub-issue link is a strict tree — one parent, no second one — so an issue sits under the parent it already has, epic or ordinary issue, or under a ledger, never both. Attaching the _ledger_ to the run-set's shared parent is what buys reachability without emptying that parent of its own work: its progress count keeps counting the same issues and gains one extra node whose subtree holds everything the campaign produced. **Never re-parent a run-set issue away from the parent it already has to sit under the ledger.**

**`Recommended` still means proven.** A review finding that is real, agreed and never once triggered is `Low`, however alarming the reviewer made it sound — [docs/issue-board.md](../../docs/issue-board.md) has the discriminator and #1056 as the worked example. You are filing at the end of a long unattended run and there is nobody to correct an inflated band; err low, and say in the issue what would prove it higher.

**`gh` absent (a cloud session).** Both `board.mjs` lines are refused there for the reason **Standing rules** gives — GraphQL never reaches GitHub — so each becomes a **Board dispatch** ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server**: `command: add` with `issue`, `class`, `queue`, `size`, then `command: parent` with `issue` (the new one) and `of` (the parent). A dispatch is fire-and-forget — **a request, not a confirmation.** Name the route in the ledger and never report an issue as triaged or attached on the strength of one.

---

## Reporting — five moments, and silence in between

You are unattended, so everything you say is read later, out of order, by someone catching up. Narration is worthless to that reader and it is what makes a campaign unreadable: the last run spoke **68 times in 88 minutes**, median 144 characters, mostly "checking main's health" / "confirmed" / "waiting on #1021" — and closed with four messages in three minutes that all said the campaign had finished.

Speak at exactly five moments, and at no others:

1. **Dispatch** — the plan, once: order, what runs concurrently, the ledger number.
2. **An issue reaching a terminal state** — merged, or parked. One message per issue, after you have confirmed it, not while you are confirming it. A park additionally goes out as a `PushNotification` — see **Decision envelope**. That is a separate channel, not a sixth moment, and it is the only tool call in this command that is allowed to interrupt Daniel.
3. **A decision taken outside the envelope** — what you decided and why, in the two or three sentences it actually needs.
4. **A full stop** — what broke and what a human must do.
5. **The close** — see **Finish**.

Between those, work silently. No "checking…", no "spawning…", no "confirmed", no progress ping for a step whose outcome you do not yet have. Wait until you know, then say the thing once.

Each message: the state in one line, then the decision or the recommendation. **Never restate what an earlier message already said** — reasoning, evidence and measurements belong in the ledger comment, and the message links the ledger rather than reproducing it. If you find yourself writing a paragraph you have already written, you are writing the ledger into the terminal; cut it and post it to the ledger.

## Models

**Whatever model you are running on propagates to every agent you spawn** — a subagent with no `model:` inherits from its parent. One selection at the top silently sets the price of the entire tree, and a campaign spawns thirty-odd agents. Fable 5 is exactly twice Opus 5 on both input and output, so an unnoticed selection doubles the whole campaign and nothing in the run tells you it happened.

So this command names a model at **every** `Agent` call rather than letting one inherit:

| Spawn                | Model    | Why                                                                                                        |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| you, the coordinator | `opus`   | you adjudicate technical disputes without being allowed to read the code, and your merges are irreversible |
| footprint extractor  | `haiku`  | fixed extraction against a known heading set                                                               |
| worker (`/salt-run`) | `opus`   | owns validation and the git history                                                                        |
| reviewer             | `opus`   | the other genuine reasoning job in this command                                                            |
| fix agent            | `sonnet` | findings arrive enumerated and the scope is closed                                                         |
| conflict resolver    | `sonnet` | you have already classified the conflict; it applies a rule you handed it                                  |

Never omit `model:` and let it inherit. If you find yourself running on anything other than Opus, say so once in the ledger's **Plan** block before you dispatch anything — that line is the only chance anyone gets to catch it before the bill.

---

## Setup

### 1. Resume, don't restart

Before anything: `gh issue list --search 'in:title "campaign:"' --state open`. If an open campaign issue covers this set, it is your state — read its body (the status table, below), not its comments. Announce where you're resuming. Re-dispatching a merged issue is the worst outcome available in this command.

Cross-check the table against reality before trusting it. Match on the branch names you control, not on full-text search — per branch, so no listing limit can truncate what you see:

```
gh pr list --head <branch> --state all --json number,state,mergedAt   # one call per table row
git worktree list
```

Any row whose recorded state disagrees with what `gh` says — "merged" with an open PR behind it, "in progress" with no branch — means something broke mid-queue. Park that issue, correct the row, say so. Never build on a row you could not confirm.

Workers do not survive a session: a `dispatched` row from a dead session has no live agent behind it. Verify what its branch actually holds (the per-branch PR check above, plus `git log --oneline origin/main..origin/<branch>` if it was pushed), then either re-dispatch from where it stands — /salt-run's own resume logic picks up landed phases — or park it.

### 2. Derive the footprints — delegated, never read

**Do not open the issue bodies yourself.** A phased spec issue runs 10–25KB; you need about 200 tokens of it. Everything you read here stays in your transcript and is resent on every turn for the rest of the campaign — across a hundred-plus coordinator turns that is the single largest avoidable cost in this command, and it buys you nothing, because `/salt-run` reads the issue from source anyway.

Spawn one extractor per issue, all in one message so they run concurrently, each `Agent(…, model: "haiku")`:

> Read issue #N with `gh api repos/{owner}/{repo}/issues/N --jq '.body'` — the sandbox must be disabled, and plain `gh issue view` prints nothing in this harness. Return exactly this and nothing else. No prose, no summary of what the feature does, no opinion on whether it is a good idea:
>
> ```
> ISSUE: N
> TITLE: <title>
> KIND: <spec | defect | refactor — whichever baseline heading it carries>
> PHASES: <count>
> DELIVERABLES: [every path named across all phases' Technical deliverables]
> MUST_NOT_TOUCH: [every phase's Must not touch entries, copied verbatim — one per line, worded exactly as the issue words them]
> DEPENDS_ON: [issues the body names as a dependency — "depends on #N", "after #N", "supersedes #N" — or NONE]
> RUNNABLE: <yes | no — no if there are no phase blocks, or any phase block carries no Technical deliverables>
> ```

**Transcribe; do not interpret.** Say this in the brief, because it is the instruction the extractor breaks. A `Must not touch` entry may name a path, but it may equally name a symbol, an export, a behaviour or a rule — "do not change `RecipeMetadataSchema`", "preserve the current sort order". Copy those as written and never resolve one to the file that holds it: `RecipeMetadataSchema` is not `packages/domain/src/schemas/recipe.ts`, and turning it into that path widens a symbol-level prohibition into a file-level one — usually over a file the issue fully expects the work to edit. The same holds for `Technical deliverables`: a path where it gives a path, the words where it gives words. An entry that yields no path at all is a correct answer, not a gap to fill.

`DELIVERABLES` plus whatever `MUST_NOT_TOUCH` entries are literally paths is the issue's **footprint**. It has exactly one job — ordering the conflict graph below — and it is all you hold of an issue you are forbidden to read.

**A footprint is a prompt, never a gate.** It is a cheap model's transcription of prose written for a human, one step removed from the issue and two from any diff, and over-collection is the mistake it actually makes: a symbol read as a file, a directory read as everything beneath it. Campaign #1064 hit it twice in one day — once ruling `packages/domain/src/schemas/recipe.ts` untouchable when the issue only prohibited the `RecipeMetadataSchema` symbol, which the PR had left alone. So:

- **Ordering may act on it.** Over-collection there costs a serialisation you did not need, which is the cheap direction and the reason **Conflict graph** tells you to be generous.
- **Nothing else may.** A footprint is never grounds for a statement about a PR — not a scope breach, not a finding, not a park reason, not a line in a review or a ledger. You hold neither the issue's real wording nor the diff, so scope is not yours to adjudicate.
- **When it looks breached, hand it over as a question.** Add one line to that PR's reviewer brief — _"the issue's Must-not-touch says `<the entry, verbatim>`; check whether the diff breaches it"_ — and take the reviewer's answer as the verdict, including when the answer is no. The reviewer fetches both the issue and the diff, so it is the only actor in this command that can tell a real breach from an extraction artefact. A prohibition worth enforcing survives being asked as a question.

`RUNNABLE: no` → **confirm it before you act on it.** A false negative here silently parks a good issue and nothing downstream ever contradicts it, so spend the one call: `gh api repos/{owner}/{repo}/issues/N --jq '.body' | grep -c '^### Phase'` returns a count rather than prose, which keeps it inside your standing rule. Where there is no `gh` (see **Standing rules**), have a `haiku` agent fetch the body and return the count alone — never the body, and never into your context. Zero → park it and say which. Non-zero → the extractor was wrong; dispatch the issue and let /salt-run be the judge, since it reads the issue from source and returns BLOCKED on a phase block missing the fields its loop consumes.

### 3. Conflict graph, not waves

Two issues are **in conflict** when either holds:

- one names the other as a dependency;
- their footprints share a file, or share a **module directory** — the deepest named directory under a package's `src/` (`packages/domain/src/recipe/**` overlapping `packages/domain/src/recipe/queries/**` counts; two issues that merely both touch somewhere in `packages/domain` do not).

Footprint overlap serialises, even when the issues are logically independent. Overlap discovered at merge time costs a rebase, a re-review and a re-run of CI; overlap predicted here costs nothing but ordering. Be generous about what counts — the asymmetry is that lopsided.

Two files are excluded from footprint overlap, because otherwise they collide on almost every campaign and neither collision is real:

- `pnpm-lock.yaml` — any two issues adding a dependency touch it. At merge time, resolve by regenerating (`pnpm install --lockfile-only`), never by park.
- the **Docs map table in `docs-map.md`** — any two issues adding a doc row touch it. Resolve by re-applying both rows.

Both are delegated resolutions like any other; they are simply never a reason to stop.

Order the issues into a list: dependencies before dependents, and where neither depends on the other, cheapest (fewest phases) first — a short issue that merges early frees its footprint for everything behind it.

### 4. Rolling pool, not a barrier

Run a pool of `--pool` concurrent workers, default 2.

Two is the default because the constraint is the host, not the plan: each worktree needs its own `pnpm install`, and every worker runs `pnpm test` and `pnpm check` on the same laptop. Past the point where those saturate CPU or disk, a further worker makes all of them slower rather than the set faster — and slower workers hit their time budgets, which turns a throughput problem into parked branches.

Raise it when the host genuinely has the headroom (more cores, and Daniel not working in the main checkout at the same time). If `--pool` is above 4, say once in the ledger that you're running wide and why it was asked for — then do it. The flag is Daniel's call to make, not yours to second-guess.

When a worker returns, start the next issue in the list all of whose conflicts have reached a terminal state — merged, or parked. Do not wait for a batch to finish before starting the next: a fixed wave where one issue takes three times as long as the other leaves half your capacity idle for the difference. A dependent issue's worker cuts from `origin/main` after its dependency has merged, which is why there is no integration branch — dependency ordering falls out of the merge queue for free.

If no issue is currently startable (everything left is blocked behind something in flight), run the pool below capacity. That is correct, not a stall.

### 5. Open the ledger, then go

```
gh issue create --title "campaign: <slug> (#a #b #c)" --body-file <file>   # write the plan below to a file first
```

No label and no board fields — see **Filing an issue**; the `campaign:` title prefix is the discoverable marker, it is what the resume search matches, and it is what `board.mjs check` recognises to leave the ledger out of triage. **No parent yet either**, but for a different reason and only for now: the ledger's own parent is the run-set's shared one, which is not reliably known until every issue has reached a terminal state — so it is written at **Finish**, not here. The body is the live state of the campaign and it is what a fresh session reads. Keep it current with `gh issue edit <ledger> --body-file <file>` on every transition:

```
## Plan
Order: #a → #b → #c
Pool: 2   Max diff: 2000   Ending: merge to main
Models: coordinator opus · workers opus · reviewers opus · fixes and conflict resolution sonnet · extractors haiku
Conflicts: #b after #a (shared packages/domain/src/recipe/**)
Envelope: <the decision envelope you are operating under>

## Status
| Issue | Branch | PR | State | Worker | Note |
|---|---|---|---|---|---|
| #a | feat/slug-a | #101 | merged | — | |
| #b | feat/slug-b | #102 | in review | — | round 1: 1 blocking |
| #c | fix/slug-c | — | dispatched | agent <id>, watchdog <shell-id>, 09:14 | budget to 12:14 |
| #d | — | — | queued | — | after #b |
```

States: `queued → dispatched → PR open → in review → merge queue → merged | parked`. A split issue re-enters at `queued` after its intermediate PR merges — the same issue moving through the line a second time, carrying the PRs it has already landed.

Comments on the ledger remain the audit trail — one per transition, with the reasoning that doesn't fit in a table cell. But state lives in the body, so resume is one read of one field rather than a parse of thirty comments in indeterminate order.

Then start. Do not wait for confirmation — the point of posting the plan is that Daniel can interrupt, not that you stop.

---

## Worktrees

```
git fetch --no-tags origin main
git worktree add -b <type>/<slug>-N .claude/worktrees/<slug>-N origin/main
```

**The fetch is not optional, and it goes immediately before every `worktree add`.** `origin/main` here is the local remote-tracking ref — whatever the last fetch saw. The rolling pool creates worktrees over hours, and a dependent issue's whole premise is that it cuts from a main that already contains its merged dependency; skip the fetch and it builds against a base from before the merge.

For a **continuation** dispatch — the remaining phases after a worker split an issue at the ceiling — the branch is the same `<type>/<slug>` with `-2` appended, then `-3`, and the fetch matters twice over: it must be cut from the `main` that already contains the preceding PR. Never from that PR's branch.

Explicitly, with `git worktree add` — **not** the Agent tool's `isolation: "worktree"`. That flag branches from main with no way to choose a base and no way for you to name the branch, and /salt-run needs to own a branch it can push and PR.

`.husky/post-checkout` fires `ensure-checkout.mjs` on `worktree add`, which installs dependencies, writes the gitignored dev env files, and — the invisible one — restores `core.hooksPath` so the pre-commit gates actually run. A worktree created any other way has dead commit hooks.

- **One worker per worktree.** Never two agents in one checkout; they share a HEAD.
- **Workers run the safe gate set only.** `lint`, `typecheck`, `check`, `test:coverage`, `depcruise`, `boundary:test`, `format:check`, `docsmap:check`, `theme:check`, `provenance:check`, and then `coverage:files:check` + `coverage:ratchet:check` on the report `test:coverage` just wrote. The suite runs **with** coverage: the two coverage gates block CI's `unit` job, they run with near-zero slack, and a worker that skips them goes green locally and red in CI minutes later — that cost this campaign one CI cycle on #1140 and two on #1137. The guarded commands — `dev`, `dev:emulators`, `test:emulator`, `e2e*` — seize host-global singletons and `scripts/host-guard.mjs` refuses them in a linked worktree. That refusal is correct. Never set `SALT_TAKE_HOST=1` to get past it: from a worktree it kills whatever Daniel is sitting in. The heavy suites are CI's job, at merge time.
- **On merge:** remove the worktree and delete the local branch (see the queue for the ordering — it matters).
- **On park:** the branch must survive and be findable. Push it (`git push -u origin <branch>` — a WIP commit first if the tree is dirty), label the PR `status: on-hold` (the repo's parked label — do not invent a new one), comment the reason on the PR as well as the ledger, then remove the worktree. A parked issue whose state exists only in a ledger comment is a parked issue nobody finds.
- Finish the campaign with `git worktree prune`. This repo currently carries four stale prunable worktrees and an orphaned `integration/current-sprint` branch from an earlier attempt; do not add to them.

---

## Dispatch

**Workers are Agent-tool subagents on `opus`, spawned in the background — one per worktree.** This choice is load-bearing, so do not substitute a mechanism: a subagent has a task id the harness can kill (`TaskStop`) and _confirm_ killed, it cannot outlive your session — so a resumed campaign never inherits a live worker it cannot see — and it runs unattended without any permission-flag guesswork. Record the agent's id in the ledger row **at the moment you dispatch it**, before anything else. A handle you did not record at dispatch cannot be recovered afterwards, and you will not read logs to find it.

**Arm a watchdog with every dispatch.** Every worker carries a budget — state it in the brief (default: no single phase longer than 45 minutes, no worker longer than 3 hours) — but a budget nobody checks is dead text: a spinning worker does not return BLOCKED, it returns nothing, and nothing wakes you for a worker that has hung. So alongside each worker, start a backgrounded shell that is nothing but `sleep <budget-seconds>` (Bash, `run_in_background: true`), named for the issue. Its exit re-invokes you; record its shell id in the same ledger row. Worker returns on time → `TaskStop` its watchdog as part of processing the return. Watchdog fires first → the budget is breached.

Brief each worker with:

> Follow `.claude/commands/salt-run.md` verbatim for issue #N, with these overrides:
>
> - You are already in worktree `<path>` on branch `<branch>`, cut from `origin/main`. Skip salt-run.md's **Working branch** step; do not create or switch branches.
> - Your base is `origin/main`. salt-run.md's per-phase `git fetch origin main && git rebase origin/main` stands exactly as written.
> - Run the safe gate set only. Never `e2e`, `test:emulator`, `dev`, or `dev:emulators`, and never `SALT_TAKE_HOST=1`.
> - `gh` in this harness: plain `gh issue view` / `gh pr view` exit 0 with empty stdout — use the `--json` forms or `gh api` (issue comments: `gh api "repos/{owner}/{repo}/issues/N/comments"`), and every `gh` call needs the sandbox disabled. Empty output from a comments fetch is a failed fetch, not an empty thread.
> - Do run `gh pr ready` at the final phase, as salt-run.md says. It is what triggers `pr-doc-review.yml`, and that review is an input to the code review that follows.
> - Do not merge, and do not touch any branch but your own.
> - Diff ceiling: `--max-diff <n>` changed lines, excluding the lockfile. This is salt-run.md's own flag and its step 9 already implements the rule — pass the number, do not re-derive the behaviour. Its three outcomes reach me as three different returns: over the ceiling **with phases still unbuilt**, you finish the current phase, turn the PR into an intermediate one (`Refs #N`, title suffixed ` (#N)`), `gh pr ready` it, and return `SPLIT: YES` with the unbuilt phases named; over the ceiling with **nothing left to build**, there is no split — ship it as one PR and conclude normally; a **single phase** that alone exceeds the ceiling is a pause condition and returns `BLOCKED: oversized`.
> - salt-run.md's pause conditions are yours, with one change: you cannot wait for a human. On a pause condition, stop, commit what you have, leave the branch as it is, and return BLOCKED with the reason.
>
> Return, and nothing else:
>
> ```
> ISSUE: N
> BRANCH: <name>          PRS: <this run's PR, plus any earlier PR for this issue your resume check found — or NONE>
> PHASES_LANDED: <n of m>
> PHASES_UNBUILT: <numbers and names still to build — or NONE>
> SPLIT: <YES if you cut an intermediate PR at the ceiling, else NO>
> CI: <green | red | heavy-suites-skipped>
> DECISIONS: [choices not specified in the issue, and why]
> FLAGS: [anything another issue in this campaign must know]
> CONCERNS: [rules the scope pushed against, or a simpler shape you'd recommend — or NONE]
> BLOCKED: [pause condition hit, or NONE]
> ```

**On budget breach, terminate before recycling the slot.** In this order, and do not skip a step:

1. `TaskStop` the worker's agent id.
2. Confirm it actually stopped: the harness reports the task killed. An unconfirmed kill is a live worker.
3. Only now: park the branch as it stands (`BLOCKED: timeout`), and free the slot.

The slot is the smaller half of this. A worker you left running still holds a worktree, still runs `pnpm test` against the resources the next worker needs, and — the one that actually costs you — can still commit and push to a branch you have parked, or push to one sitting in the merge queue. That produces a `--force-with-lease` failure or a merged branch containing work nobody reviewed. Never start a replacement worker into a slot whose previous occupant you have not confirmed dead. If the kill cannot be confirmed, do not recycle the slot at all: run the pool one narrower for the rest of the campaign and log it.

**BLOCKED non-empty** → park the issue, log it, start the next startable issue. Do not diagnose it yourself; that is diff-reading.

**`SPLIT: YES`** → the issue is neither finished nor parked, and this is the one return that puts an issue back into the schedule rather than out of it. The PR it left behind is out of draft, green and review-eligible exactly like any other, so it goes through review and the merge queue unchanged — nothing about the landing path is special. What is special is what happens after it merges: **re-dispatch**.

1. Review and land the intermediate PR through the normal queue. Its body says `Refs #N`, so it closes nothing and moves no board field — the issue correctly stays `In progress`.
2. Remove the worktree and delete the local branch as on any merge.
3. Fetch, then create a fresh worktree on the continuation branch (`<type>/<slug>-N-2`) cut from the **new** `main`, and dispatch a fresh worker with the same brief, for `PHASES_UNBUILT` only.
4. The ledger row for #N goes back to `queued` with the merged PR listed and the unbuilt phases in the note; the states line below covers this.

The re-dispatched worker needs no special instruction to find its place: salt-run.md's resume check detects landed phases by content, not by lineage, and its own **Working branch** section covers the continuation form. File no split issue. Do not decide the phase boundary yourself — the spec already chose it, and the worker cut there.

**`BLOCKED: oversized`** now means one thing only: **a single phase that cannot be built under the ceiling on its own**. That is a phase specced too big, and no PR boundary fixes it — which is why it is a spec question and not a split. It is still the one blocked reason that gets an action rather than a bare park: file a follow-up issue proposing that phase be re-specced (what the phase asked for, what it cost, and the ceiling it hit), **triage and attach it per Filing an issue** — it is the remaining work of the issue it came out of, so it hangs off that issue, not off the ledger — reference it from the parked branch, and move on. Crossing the ceiling _across_ phases is not this: it splits, and never reaches you as a park.

**FLAGS naming another campaign issue** → record it in the ledger and re-check the conflict graph. A flag is the one signal that can reveal an overlap the footprints did not.

---

## Review

A PR is review-eligible only after you have verified what the review prompt asserts. The worker's `CI` field says green — check it agrees with reality now: `gh pr checks <pr>` (the heavy suites may show as passed-because-skipped if a sibling merged since the worker finished; that is the queue's problem — it rebuilds on current `main` and runs them there — so what must be genuinely green here is everything else). A red check means the worker's return was wrong, and a worker that misreported CI may have misreported anything: park, don't review.

One reviewer agent per PR, `Agent(…, model: "opus")`, spawned fresh, **read-only** — it must not have the branch checked out and must not fix anything. A reviewer that can fix things will, and you lose the signal.

**Give it the commands, not their output.** The brief below hands the reviewer a fetch list it runs itself. You run none of it — fetching the diff to paste it over would put 2000 lines into the context this whole command exists to protect, and this is the one place in the file where that mistake is easy to make.

A PR reaching review is already under the ceiling, or is the last PR of an issue with nothing left to move out of it — the worker enforced `--max-diff` at every phase boundary and cut a PR there if it had to.

**Splitting at a phase boundary is sanctioned; carving up a branch already built is not.** The two look alike and are not. A phase boundary was chosen by the spec, each side of it ends user-testable, and the reviewer of PR _k+1_ reads it against a base that already contains PR _k_ — merged, and reviewed on its own terms. Carving a finished branch in half has none of that: the boundary is arbitrary, and neither reviewer can see a duplication or an architectural drift that spans it. So the old rule survives exactly where it was true — **you never split a diff that is in front of you** — and the place a large issue gets divided is upstream, in the phase loop, before the code exists.

So: confirm, don't carve. `gh pr view <pr> --json additions,deletions,changedFiles` — counts, not content, and remember the worker's count excluded `pnpm-lock.yaml`: an overage the lockfile explains (check `--json files`) is not a breach. An overage the worker _declared_ is not a breach either — a final phase that carried the branch past the ceiling with no phases left ships as one PR by design, and the PR body says so. What is a breach is an undeclared overage with `SPLIT: NO` and phases unbuilt: that means the worker's check did not run, and a worker that skipped that check may have skipped anything. Park the branch and treat it as `BLOCKED: oversized`. Do not review it anyway.

> Review PR #X against issue #N adversarially. Assume it is wrong and find where.
>
> Gather your own material first — every `gh` call needs the sandbox disabled, and the plain `--comments` forms print nothing in this harness, so empty output is a failed fetch and never "no comments":
>
> - the issue: `gh api repos/{owner}/{repo}/issues/N --jq '.body'`
> - the per-phase handoff comments: `gh api "repos/{owner}/{repo}/issues/N/comments"`
> - the PR discussion, from **both** endpoints, because conversation comments and review bodies live apart: `gh api "repos/{owner}/{repo}/issues/<pr>/comments"` and `gh api "repos/{owner}/{repo}/pulls/<pr>/reviews"`
> - the diff: `gh pr diff <pr>`
>
> Do not re-litigate what the gates already prove. `lint` + `depcruise` + `boundary:test` prove the import graph and the layer map. `typecheck` + `check` prove the types. `docsmap:check` proves the Docs map has a row. `theme:check` and `provenance:check` prove the tokens. All green on this PR — verified before you were spawned. Re-reporting any of them is noise.
>
> Do not repeat findings already on the PR. Read the existing comments first.
>
> Scope is the issue's phases. The handoff comments carry **Out of scope (do not suggest)** — that list is binding. Suggesting work the issue deliberately deferred is a defect in the review, not a finding.
>
> **You are hunting defects, not auditing quality.** Anything a tool can find, a tool has already found. Look at the four things the gates structurally cannot see, in this order — the first two are where real defects live and where most of your effort belongs:
>
> 1. **Correctness** — an input, a state, or an ordering under which this code does the wrong thing. Concurrency, LWW clobbering, partial failure, empty and boundary cases, a `Failure` swallowed, a trigger racing a client write. **Including a false invariant:** a safety property this diff asserts — in a header comment, a test name, a doc paragraph or the PR body — which the code does not actually guarantee. Read each such claim against the code that is supposed to enforce it and name the input, state or second construction path that falsifies it. Campaign #1064 shipped five of these, every one green on every gate, and three would have destroyed production data.
> 2. **Architectural intent** — legal by depcruise but wrong in spirit: policy leaking into an adapter, a domain concern implemented in a component, a rule that will be true today and unenforced tomorrow.
> 3. **Duplication** — semantic, not textual: the same rule expressed in two places that can now disagree. Not duplicated test scaffolding, not similar-looking code.
> 4. **Testing** — report a gap **only** where a missing assertion means a real defect could ship undetected, and say what that defect would be. Do not audit against a checklist; do not open `docs/unit-test-spec.md` or `docs/e2e-test-spec.md` — 50KB of checklist compels enumeration, and enumeration is what makes a review unreadable. No findings about test style, test naming, or duplicated test helpers.
>
> **Documentation is not your lens.** `pr-doc-review.yml` has already run on this PR and is the tool that owns it. Raise a doc point only when the diff makes a specific existing sentence factually false _and_ the doc review did not catch it. A false invariant is not a doc point and this rule does not apply to it — it is lens 1, wherever the sentence happens to live.
>
> Severity, and be strict about the top one:
>
> - **blocking** — you can state a concrete failure: this input, this state, this wrong output or crash. If you cannot name one, it is not blocking.
> - **should-fix** — real, but ships safely and can be a follow-up. Append `[trivial]` to the line when the whole fix is **≤5 lines and mechanical** in a file this diff already touches — a stale line reference, a wrong glob, a sentence this PR made false. You are the only actor holding the diff, so you are the only one who can size it; the coordinator decides what to do with the mark.
> - **note** — style, taste, preference. Say them in one line each or not at all.
>
> **Write only findings.** No "what I verified and found sound" section, no summary of what the PR does, no restatement of the phases — the coordinator and the author both already know. If the honest answer is that you found nothing, the review is three lines saying so, and that is a good review rather than a failed one.
>
> Post one review: `gh pr review <pr> --comment --body-file <file>` (every `gh` call needs the sandbox disabled), findings grouped by severity, most severe first. Then return only the counts, the blocking findings' one-line summaries, and the should-fix findings' one-line summaries.

### Fixing findings

Do not re-dispatch /salt-run for this. salt-run.md is a phase loop keyed to an issue whose phases have all landed; pointed at a finished branch it either no-ops or restarts work. Spawn a plain `Agent(…, model: "sonnet")` instead — the findings arrive enumerated and the scope is closed, so there is no design judgement left in this step:

> In worktree `<path>` on branch `<branch>`, address these review findings — every blocking one, plus any marked `[trivial]`: [list]. Do not rebase, do not merge, do not touch another branch, and do not take work beyond the findings — the issue's Out of scope list still binds. Run the safe gate set, commit, push.
>
> Return:
>
> ```
> FIXED: [finding → what changed]
> REJECTED: [finding → why it is wrong, or why the fix is worse than the bug]
> GATES: <green | red>
> ```

**Trivial should-fix findings ride along.** Filing has a floor cost that a two-line edit does not clear. Send a `[trivial]`-marked **should-fix** finding to the fix agent in round 1, rather than listing it, once you have confirmed both of the things you can confirm without a diff:

- **the file is already in this PR's footprint** — `gh pr view <pr> --json files`, which is yours under **Standing rules**: file names are not diffs. No new footprint means the queue's conflict model is untouched, and that is the condition making the rest of this safe — /salt-run's scope discipline protects _footprint_, not line count, and **Dispatch** scores conflicts on deliverables;
- **it needs no decision from Daniel** — no design fork, no rule change, no question about what the right shape would be. Judge this from the finding's one-line summary; if you cannot tell, that is a no.

The third condition — ≤5 lines and mechanical — is the reviewer's `[trivial]` mark, because sizing a fix needs the diff and you do not read diffs. Unmarked should-fix findings are never sent, however small they sound.

Drop whatever comes back under `FIXED` from the should-fix list: a finding cannot both ship fixed and be filed as outstanding. Anything under `REJECTED` stays on the list, and the agent's reason goes on the line.

**If any of the three is in doubt, list it** — reviewer and coordinator alike. A finding that looks like one line and turns out to be a contract question is exactly what the list is for — #1051 (a chip icon clamp: one CSS selector, in fact an app-wide `Chip` contract question) is the shape to watch for. The asymmetry is deliberate: guessing wrong this way is a scope breach inside a PR that has already been reviewed, and guessing wrong the other way is a tracked issue whose body runs thirty times the length of its own diff.

The cost being paid for today is on the record. #1026 exists because the round-1 fix agent drafted both of its doc corrections, **reverted them as out of its assigned scope**, and left an issue behind for someone to redo the work later — three payments for two lines. #1022 ("add a single line in two places"), #1015 ("one-line CLAUDE.md edit") and #1045's "one-token fix" are the same shape.

Rounds are capped at two. Round 1 is the full review. Round 2 may only verify the blocking items from round 1 — no new findings, unless the fix introduced a new blocking regression. There is no round 3. A **blocking** item still open after round 2 parks the branch (see the envelope), or — if you adjudicate it as safe to ship — gets a filed issue before the merge. Everything else joins the should-fix list, which is filed as one issue at **Finish** — less anything the round-1 fix agent returned under `FIXED`.

**You adjudicate, not the reviewer.** A rejection is a position, not a veto; you decide, record the decision in the ledger, and move on. Reviewer-wins is a deadlock and this command runs unattended.

**should-fix findings go to one issue per campaign, not one issue each and not a comment on a closed ledger.** Collect them — one line each, with the PR number — and at **Finish** file a single issue:

```
gh issue create --title "campaign follow-ups: <slug> (#<ledger>)" --body-file <checklist>
```

Then triage and attach it per **Filing an issue** — `add` with a Class, band and size, then `parent --of <ledger>`. A list nobody can find is the failure this whole section exists to prevent, and an untriaged issue is not findable.

Body is a `- [ ]` checklist, one line per finding, PR number on each line. Notes are dropped entirely, and so is anything already fixed in round 1 under the `[trivial]` rule above. File it even when the list is short; skip it only when the list is empty.

This is a correction to a rule that lost its own output. The previous version said to put the list in the ledger's closing comment — but **Finish** closes the ledger when nothing is parked, so the list landed in a closed issue and left no trace anywhere a human looks. Campaign #1040 lost seven that way, two of them live prod risks.

That rule's stated grounds were also wrong, and the record is checkable: it claimed campaign #1009's seventeen filed follow-ups were "never actioned". Most were closed within a day — and #1021, #1023 and #1030, the entire contents of campaign #1040, were three of them. Filing is the mechanism that feeds the next campaign. One issue per campaign rather than seventeen is the concession to noise; not filing at all is not.

Two findings still get their own `gh issue create` at the time rather than waiting for the list — each triaged and attached per **Filing an issue** — because they are structural rather than taste:

- **`BLOCKED: oversized`** — the re-spec proposal for the single phase that would not fit, as described in **Dispatch**. A ceiling crossed across phases files nothing; it splits.
- **a blocking finding you adjudicated as real but chose not to hold the queue for** — that is a known defect shipping to main, and it needs a number before the merge, not after the campaign.

Do not let the reviewer's taste hold the queue.

---

## Merge queue

**GitHub's merge queue does the landing.** Enqueue every eligible branch; the
queue serialises them, rebuilds each on current `main`, runs `ci.yml` against
that combination, and merges only what is green. Do not rebase, re-run gates, or
merge by hand — that recipe is gone, and reintroducing it fights the queue rather
than helping it. Full contract: [docs/ci.md](../../docs/ci.md).

What this buys over the old serial loop is **speculation**: N queued branches are
built as one batch rather than N sequential update-and-re-run cycles. Enqueueing
does not idle the pool either — workers on other issues keep running. What is
serialised is landing, not working.

`--stop-at-green` skips this section entirely. Reviewed, green, unmerged PRs are
the deliverable; go straight to **Finish** and report them. Leave the worktrees
in place — Daniel will want them if he's landing these by hand.

A branch is queue-eligible when: PR out of draft, review closed with no blocking
findings outstanding, and its should-fix findings recorded in the ledger.

**Land every branch with exactly this command, and compose nothing around it:**

```
node scripts/campaign-land.mjs <pr> [--note <file>] [--adjudicated <issue>]
```

It re-applies the eligibility rule above and refuses a PR that fails it; posts
`--note` as a PR comment if you give one; enqueues the squash merge; and only
then removes the worktree and deletes the local branch. It derives the worktree
path and the branch name from the PR itself, so there is nothing for you to get
wrong. Squash, because `main` is linear and squash-merged: subjects end `(#PR)`,
and the per-phase history lives in the issue's handoff comments where salt-run.md put
it. The remote branch is deleted by GitHub when the queue merges it, not by the
command.

**The order is the guarantee: nothing local is touched until the PR is in the
queue** (issue #1207 — the first version had it the other way round, and since
`gh pr merge` refuses `--delete-branch` on any queue-enabled branch, every single
landing removed the worktree, deleted the branch, and then failed to enqueue).
So a failed landing is now a no-op you can simply re-run. Exit 0 means enqueued;
any other exit printed the reason and changed nothing. A `warning:` line means
the PR _is_ queued but a leftover worktree needs tidying — that is not a failed
landing and does not go in the ledger as one.

`--adjudicated <issue>` is the one escape hatch, and it is the **Review**
section's rule made mechanical: a blocking finding you judged shippable may
merge, but only against an issue you have already filed and which is open. No
issue, no merge.

**Do not build a shell line of your own around this, and do not run the merge
yourself.** Composing those steps by hand is what cost ten consecutive campaign
runs a permission stop each: every line came out slightly different, so the merge
gate could not recognise any of them, and each one blocked the fleet on Daniel.
One command, one allowlist entry, no prompt. If you want a note posted, write the
file and pass `--note` — never inline prose into a `--body`, where one backtick
or quote turns the line back into something the gate has to refuse.

Then watch the queue rather than each PR: `gh pr view <pr> --json state,mergedAt`
per enqueued PR, or the queue itself at
<https://github.com/eggmanorg/salt/queue/main>. Two outcomes matter.

**Merged.** Confirm the heavy suites actually ran before you record it green. A
skipped required check reports as passing, so read the job conclusions of the
merge-group run, never the check summary. (This recipe is salt-run.md step 8's, held
in lockstep deliberately — if the job names in `ci.yml` move, both files change
together, and `pnpm mergequeue:check` fails if the ruleset's contexts stop
reporting at all.)

```
gh run list --limit 25 --json databaseId,event,headBranch,status,conclusion \
  --jq '[.[] | select(.event=="merge_group")][0].databaseId'
gh run view <id> --json jobs --jq '.jobs[] | select(.name | test("E2E|integration")) | "\(.name): \(.conclusion)"'
```

**Do not reach for `--branch main` here.** A merge-queue build's `headBranch` is
`gh-readonly-queue/main/pr-<n>-<sha>`, not `main`, so `--branch main --limit 1`
returns the post-merge `push` run instead — which at that moment is still
`in_progress` with empty job conclusions. Read as written, salt-campaign.md's own
"empty output → park" rule then parks a perfectly good merge. Select on
`event == "merge_group"` and the right run is unambiguous.

- `success` → land it in the ledger.
- `skipped`, and the batch's changed files are only docs/CI/meta paths →
  legitimate skip: say so in the ledger. Under the queue this is the _only_
  reason a heavy suite skips; "the branch was behind" no longer exists.
- **empty output → park.** No matching jobs means the job names have moved and
  this check is now blind. Cannot-confirm is never green.

**Ejected.** The queue removed the entry because the branch rebuilt on current
`main` went red, or could not be rebuilt at all. This is the semantic-collision
catch firing — two branches green apart, red together — and it is exactly what
the queue is for, so treat it as signal, not noise. Read the merge-group run's
failure, then apply the same classification the old rebase step used: a failure
in files a merged sibling of this campaign changed, or in `pnpm-lock.yaml` or the
Docs map, is this campaign's own work — fix it on the branch, push, re-enqueue.
Anything else is someone's concurrent change and is **not yours to resolve**:
park it, log it, next.

Each merge to `main` triggers `deploy-staging.yml` off CI completion. That is
expected and it is what staging is for — but it means a campaign lands N staging
deploys, so do not queue a merge you would not want deployed.

---

## Decision envelope

Running unattended means most of salt-run.md's pause conditions become deadlocks. Resolve these yourself, record them, continue:

- a review finding's severity, and whether a rejection is reasonable;
- a queue ejection classified as this campaign's own work;
- a flaky CI job — re-run once, then treat a second failure as real;
- ordering among issues that don't conflict;
- whether a FLAG changes the conflict graph.

**Park the branch — not the campaign — for these:**

- a worker returns BLOCKED, or blows its budget (the watchdog fired — terminate and confirm first; see **Dispatch**);
- a PR over the `--max-diff` ceiling with phases unbuilt and `SPLIT: NO` — the worker's check did not run. A declared overage on a final phase is not this, and a ceiling crossed with phases remaining is a split, not a park;
- a UX deviation (salt-run.md step 4) — always a human call, never yours;
- a CLAUDE.md rule collision, or a phase that can only be built as a bodge;
- a queue ejection whose failure lies outside this campaign's merged footprints;
- gates red on the queue's rebuild (the semantic conflict);
- blocking findings still outstanding after round 2;
- heavy suites that will not run green, or cannot be confirmed to have run.

Parking never stops the queue — but it does have to reach Daniel while there is still a campaign to redirect. A park is the one outcome he might want to act on before the fleet finishes, and the ledger is not somewhere he is looking. So on every park, send one `PushNotification` alongside the ledger update, and lead with the decision rather than the status:

```
#1140 parked: UX deviation on the equipment tab, needs your call — branch feat/recipe-equipment-tab-1140
```

Issue number, the one-line reason, the branch; under 200 characters; one per park and **never on a merge** — a notification per landed PR is noise, and a channel that carries noise stops being read, which costs you the one message that mattered. A `not sent` result means he is at the terminal and has already seen it: that is the tool working, not a failure to retry.

**Stop the whole campaign** only for a systemic failure, meaning one of:

- main is red on its own — verify with `gh run list --branch main --limit 1` before believing it;
- two consecutive merges have gone bad, where bad means either the merge itself failed, or main's post-merge CI went red. Two in a row is not coincidence, and every further merge compounds it.

On a full stop: leave every branch pushed and every worktree intact, write the state into the ledger body, say plainly what needs a human, and send the `PushNotification` above with the systemic reason in place of the issue number. A full stop is the one thing here that is worth waking him for.

---

## Finish

When the queue is empty:

1. **File the should-fix issue first**, before anything closes — `campaign follow-ups: <slug> (#<ledger>)`, a `- [ ]` checklist, one line and one PR number per finding (see **Review**). Skip only if the list is empty. Its number goes in the closing comment below, so the ledger points at it rather than containing it.
2. **Attach the ledger to the work it ran.** Look up the parent of every issue in the run-set — the `#N` list in the ledger's own title — and where all of them share one parent, that is the ledger's parent too:

   ```
   node scripts/board.mjs parent <ledger> --of <the shared parent>
   ```

   Ask GraphQL, never REST: `gh api repos/{owner}/{repo}/issues/N` reports `parent: null` for every issue in this repo, sub-issues included ([docs/issue-board.md](../../docs/issue-board.md)). **Where the run-set shares no single parent — a campaign over four unrelated issues — leave the ledger a root and say so in the closing comment.** That is correct, not a miss: forcing a parent there would mean inventing a relationship the work does not have. Do this before the check below, so a campaign's own `check` passes. (`gh` absent: **Board dispatch**, `command: parent` with `issue` (the ledger) and `of`.)

3. **Confirm every issue this campaign filed is triaged and attached** — `node scripts/board.mjs check`. It fails on any open board item with no `Queue`, so a filing where you skipped **Filing an issue** shows up here by number. Fix yours; findings naming issues this campaign did not file are not your business and go unmentioned. Where `board.mjs` cannot run (a cloud session — see **Standing rules**), say so in the closing comment rather than reporting a check you did not run: the dispatches were fire-and-forget and nothing has confirmed them.
4. Final ledger comment, and set the body's table to its terminal state:
   ```
   ## Campaign complete
   **Landed:** #a (PR #1), #b (PR #2 → PR #3)   ← an issue split at the ceiling lists every PR that carried it, in order
   **Parked:** #c — [reason, what a human needs to decide, branch name]
   **Issues filed:** #f follow-ups; #d, #e — [oversized re-specs and shipped-known-defects; see Review]
   **Decisions taken:** [one line each]
   ```
   Close the ledger issue only if nothing is parked. A parked issue is unfinished business and the open ledger is where it lives. Nothing that must outlive the campaign may live only in this comment — the ledger closes, the follow-ups issue does not.
5. `TaskStop` any watchdog still running; `git worktree prune`; confirm no campaign worktrees remain, and that every remaining remote branch is one you deliberately parked (labelled `status: on-hold`, reason on the PR).
6. Report **once**, and stop. Landed, parked with reasons, the follow-ups issue number, and — if there is one — the single finding worth Daniel's attention, with your recommendation. Everything else is in the ledger and the follow-ups issue; do not reproduce either. A clean campaign is a sentence. Do not follow this message with a second one that says the same thing in different words: the last run closed with four.
