# Campaign rationale — why `/salt-campaign`'s rules are shaped the way they are

`/salt-campaign` ([`.claude/commands/salt-campaign.md`](../.claude/commands/salt-campaign.md)) is the coordinator's prompt, re-sent on every one of a campaign's hundred-plus turns, so it carries each rule as an instruction and nothing more. This doc holds the incident behind each rule — what went wrong, what it cost, and why the fix took the shape it did. The coordinator never needs it to run a campaign. Read it before **editing** a rule: most of these were written after a campaign re-learned a failure an earlier one had already paid for, and the reason is what stops the next edit re-introducing it.

Headings mirror the command's sections. The helper briefs live in [`.claude/agents/campaign-*.md`](../.claude/agents/), each with its own model in frontmatter; the reasons for a brief's rules stay beside them there.

## Standing rules

### Reaching GitHub

Campaign #1064 established the whole `gh`-present / `gh`-absent split the hard way: the empty-stdout trap on plain `gh issue view` / `gh pr view` in a non-TTY session, the sandbox requirement, the session proxy refusing `api.github.com` and the permission classifier refusing `gh` in a cloud session, and `issue_read` silently stripping raw angle brackets from an issue body. Each was rediscovered at least once before being written down; the command states them so nobody rediscovers them again.

The substitutions used to be scattered through six places in the command, and the coordinator was told to inject them into every brief it wrote. Since #1586 each helper's agent definition carries its own `gh` handling, and the coordinator's substitutions sit in one table.

### Waiting is ending your turn

Campaign #1046 had this backwards and ran `echo hold` 1,304 times across eight hours — roughly $600 of cache reads to learn nothing, while its own transcript said "polling just burns turns". A tool call keeps a turn open, so a no-op "yield" is polling at API speed, re-sending the whole campaign context every few seconds.

### Waiting on a named event is a watcher

Before the CI and merge watchers existed, the pool heartbeat was left to notice those events. In campaign #1495 that was 42 wasted wakes and up to ten minutes of latency on every CI result.

### Never open a shell command with `cd` or a variable assignment

These two shapes were the largest source of permission stops in the command outside the merge queue, and every one of them blocked the fleet on a human. The allowlist matches whole command strings, so a compound line matches none of the entries that would have let each part through.

### One command lands a branch

A hand-written `gh pr merge` is gated by `~/.claude/hooks/gh-merge-guard.mjs`, and that gate can only clear a line it recognises in full. Composing the landing steps by hand cost ten consecutive campaign runs a permission stop each: every line came out slightly different, so the gate recognised none of them, and each blocked the fleet on Daniel. `scripts/campaign-land.mjs` is one allowlisted command with nothing to compose.

## Filing an issue

**Why triage in the same breath.** GitHub's own project workflow puts a new issue on the board with every field empty, and an item with no `Queue` appears in no queue view — so an issue filed and not triaged is not waiting in Triage, it is invisible until someone scrolls the unfiltered board.

**Why the ledger's exemption stops at `Queue` and `Class`** (2026-09-12). Extending it to `Status` let 19 closed ledgers pile up at no Status, invisible to `check` and visible to Daniel as a column of cards on the `Workflow` board nobody could account for.

**Why the ledger takes a parent** (#1346). A ledger used to take no parent. Everything a campaign throws off attaches to the ledger, so a root ledger put every follow-up and mid-run defect one hop from unreachable. Campaign #1266 ran #968, #971 and #993 — all three under epic #913 — and left #1269 behind where nobody opening #913 would ever see it.

**Why a parent need not be an epic.** A run-set frequently shares an ordinary work issue as its parent rather than an epic — #1122 and #1202 each hold their own phase issues from inside a work band — and the ledger attaches to that exactly the same way.

## Reporting

A campaign spoke **68 times in 88 minutes**, median 144 characters, mostly "checking main's health" / "confirmed" / "waiting on #1021" — and closed with four messages in three minutes that all said the campaign had finished. Narration is worthless to a reader catching up later, out of order; hence five moments and silence in between.

## Models

A subagent with no model of its own inherits its parent's, so one selection at the top silently sets the price of a thirty-agent tree. Fable 5 is exactly twice Opus 5 on both input and output, so an unnoticed selection doubles the whole campaign and nothing in the run says so. The per-role models used to be a table the coordinator had to remember at every spawn; #1586 made each one agent-definition frontmatter, pinned by `scripts/tests/campaignAgents.test.mjs`. The `Agent` tool's `model` parameter overrides frontmatter, which is why the command forbids passing one.

The coordinator itself runs on `opus` because it adjudicates technical disputes without reading the code, and its merges are irreversible.

## Setup

### Resume, and confirm each issue is still open

Campaign #1479 skipped the open-check and paid two extractors, two workers and two worktrees to be told by `/salt-run`'s own resume check what one call would have shown — both its issues had merged hours earlier, under the same epic. The resume check is the backstop and it held; a backstop is not a reason to skip the look.

### Footprints — delegated, never read

A phased spec issue runs 10–25 KB; the coordinator needs about 200 tokens of it. Everything it reads stays in its transcript and is resent on every turn for the rest of the campaign — across a hundred-plus turns that is the single largest avoidable cost in the command, and it buys nothing, because `/salt-run` reads the issue from source anyway.

**Why a footprint is a prompt, never a gate.** It is a cheap model's transcription of prose written for a human, and over-collection is the mistake it actually makes. Campaign #1064 hit it twice in one day — once ruling `packages/domain/src/schemas/recipe.ts` untouchable when the issue only prohibited the `RecipeMetadataSchema` symbol, which the PR had left alone.

### Pool of two

The constraint is the host, not the plan: each worktree needs its own `pnpm install`, and every worker runs `pnpm test` and `pnpm check` on the same laptop. Past saturation a further worker makes all of them slower, and slower workers hit their time budgets — a throughput problem turned into parked branches.

## Worktrees

**Why fetch before every `worktree add`.** The rolling pool creates worktrees over hours, and `origin/main` is only what the last fetch saw; a dependent issue's premise is that it cuts from a `main` already holding its merged dependency.

**Why `git worktree add`, not `isolation: "worktree"`.** That flag branches from `main` with no way to choose a base or name the branch, and `/salt-run` needs to own a branch it can push and PR. `.husky/post-checkout` fires `ensure-checkout.mjs` on `worktree add`, which installs dependencies, writes the gitignored dev env files, and restores `core.hooksPath`; a worktree created any other way has dead commit hooks.

**Why the coverage gates are in the safe set.** They block CI's `unit` job with near-zero slack. A worker that skipped them went green locally and red in CI minutes later — one CI cycle on #1140 and two on #1137.

**Stale worktrees.** An earlier attempt left four stale prunable worktrees and an orphaned `integration/current-sprint` branch; hence `git worktree prune` at Finish.

## Dispatch

**Why workers are Agent-tool subagents.** A subagent has a task id the harness can kill (`TaskStop`) and confirm killed, it cannot outlive the session — so a resumed campaign never inherits a live worker it cannot see — and it runs unattended without permission-flag guesswork. A handle not recorded at dispatch cannot be recovered afterwards.

**Why 90 minutes a phase.** About 10 minutes of every phase boundary is CI wait that `/salt-run` makes serial by design (step 6 pushes and waits, and it forbids starting phase N+1 before phase N's CI result is read), and merged campaign PRs put a real phase between 45 and 115 minutes. `scripts/tests/campaignBudget.test.mjs` explains why the number is pinned and what the pin does not claim.

**Why the heartbeat is armed to the earliest deadline.** Re-arming on a fixed short interval turns it into a polling clock: campaign #1495's coordinator spent 47 turns and 6.96M tokens — 23% of its session, ~$4.45 — on ten-minute cycles that learned nothing on 42 of them.

**The `timeout` observation.** In campaign #1495 (2026-09-20) a Bash `sleep 10800` carrying `timeout: 600000` was accepted, ran the full three hours and delivered a single completion at exit 0. That is one dated observation of this harness rather than a promise about every future version of it — so if a long sleep is ever refused, report the refusal actually seen. What is not evidence is the parameter name: inferring a cap from it, _after_ a three-hour sleep had already succeeded, is how a false claim got into the command, into a ledger and into a closed issue, all three agreeing with each other (#1541).

**Why retry once with a fresh worker.** A stuck worker is usually a worker that ran out of road, not an issue that cannot be built; a fresh one reading the branch cold gets past most of them. One retry, never two, keeps a genuinely unbuildable issue from eating the campaign.

**Why terminate before recycling a slot.** A worker left running still holds a worktree, still runs `pnpm test` against the resources the next worker needs, and can still commit and push to a branch that has been parked or is sitting in the merge queue — a `--force-with-lease` failure, or a merged branch containing work nobody reviewed.

## Review

**Why the reviewer is shared with `/salt-review`.** Until #1590 the campaign reviewer and `/salt-review` were two copies of nearly the same brief, written apart and already drifting: different lens examples, different severity buckets, differently shaped reviews, so one PR read differently depending on which command reviewed it. Both now spawn `.claude/agents/pr-reviewer.md`; each command keeps only what it does with the findings. Campaign's three headings won because the merge gate and the fold-in adjudication already parse them — the unattended caller is the one that cannot absorb a shape change — and `Blocking` became _material impact_ because once both commands' failure-scenario bar applies, every surviving finding has a concrete failure, so "a concrete failure can be named" no longer splits anything.

**Why split at a phase boundary but never carve a built branch.** A phase boundary was chosen by the spec, each side ends user-testable, and the reviewer of PR _k+1_ reads it against a base that already contains PR _k_, reviewed on its own terms. Carving a finished branch in half has none of that: the boundary is arbitrary, and neither reviewer can see a duplication or an architectural drift that spans it.

**Why fold-in is scope, not size.** A filed issue costs a spec pass, a board row, triage, a worktree, a run, a PR and a review, and that cost does not shrink with the fix. The old "≤5 lines" cap sent a two-test gap in a file its PR had already touched to #1561 in campaign #1552, and Daniel asked why it had not simply been fixed. #1026 exists because a round-1 fix agent drafted both of its doc corrections, reverted them as out of its assigned scope, and left an issue behind — three payments for two lines. #1022 ("add a single line in two places"), #1015 ("one-line CLAUDE.md edit") and #1045's "one-token fix" are the same shape. The footprint condition is what keeps it safe: `/salt-run`'s scope discipline protects footprint, not line count, and the conflict graph scores on deliverables.

**Why doubt goes to the list.** A finding that looks mechanical and turns out to be a contract question is what the list is for — #1051 (a chip icon clamp: one CSS selector, in fact an app-wide `Chip` contract question) is the shape. Guessing wrong toward fixing is a scope breach inside an already-reviewed PR; guessing wrong toward filing is an issue whose body runs thirty times the length of its diff.

**Why one follow-ups issue, and not the ledger's closing comment.** The previous rule put the list in the ledger's closing comment, but Finish closes the ledger when nothing is parked, so the list landed in a closed issue with no trace anywhere a human looks. Campaign #1040 lost seven that way, two of them live prod risks. That rule's stated grounds were also wrong: it claimed campaign #1009's seventeen filed follow-ups were "never actioned", when most closed within a day — and #1021, #1023 and #1030, the entire contents of campaign #1040, were three of them. Filing is the mechanism that feeds the next campaign; one issue rather than seventeen is the concession to noise.

**Why a line carries its issue number too.** [`board-status.yml`](../.github/workflows/board-status.yml) ticks the one line that names a closed sub-issue and closes the follow-ups issue once every line is ticked. #1335 and #1370 both reached every-child-closed and stayed open, unticked, because their lines named only a PR.

## Merge queue

**What the queue buys.** Speculation: N queued branches are built as one batch rather than N sequential update-and-re-run cycles, and the pool keeps working while they land.

**Why nothing local is touched until the PR is queued** (#1207). The first `campaign-land.mjs` had the order the other way round, and since `gh pr merge` refuses `--delete-branch` on any queue-enabled branch, every landing removed the worktree, deleted the branch, and then failed to enqueue.

**Why the reviewer does not win.** A rejection is a position, not a veto; reviewer-wins is a deadlock in a command that runs unattended, so the coordinator adjudicates and records it.

**Why the heavy-suite read selects by PR** (#1588). A merge-queue build's `headBranch` is `gh-readonly-queue/main/pr-<n>-<sha>`, so `--branch main --limit 1` returns the post-merge `push` run instead — still `in_progress` with empty job conclusions at that moment, which parks a good merge; `heavy-suites.mjs` refuses it. And the newest `merge_group` run of _any_ PR is another entry's when two are queued, so `--pr` matches that prefix rather than taking the newest.

## Finish

**Why the ledger stays open while its follow-ups issue is open** (#1534). A closed ledger over an open follow-up is a `check` failure the next morning and a family that vanishes from the `Hierarchies` view while its work is live: that view reads sub-issue progress, which counts direct children only, so it reads 100% done. Seven of the eight issues reopened by hand on 2026-09-21 were exactly this step.

**Why report once.** An earlier run closed with four messages that said the same thing.

## salt-run.md

[`/salt-run`](../.claude/commands/salt-run.md) is the worker every campaign dispatches and every standalone run loads, so it too carries each rule as an instruction. Moved here by #1589: the incident, cost or measurement behind each of its rules, under the rule it justifies. Headings follow the order the rules appear in the command.

### The diff ceiling default

The `--max-diff` default of 2000 used to live only in `/salt-campaign`'s dispatch brief, which left a standalone `/salt-run` with no ceiling at all and improvising one. It lives in the command now, and the campaign overrides rather than owns it.

### Why no leading `cd` in a run

The permission allowlist matches whole command strings, so `cd <path> && cat x && sed -n y` matches none of the `cat`/`sed`/`git` entries that would each have run unprompted — and when the run is a campaign worker, a permission stop blocks on a human who is not watching.

### Invariants, campaign #1064

Every code PR in campaign #1064 shipped the same defect: a safety property asserted in a header comment, a doc, a PR body or a test name, which the code did not actually guarantee. Five for five, all green on every gate. There is no lint rule for "this sentence is true", so the convention is the only control there is. The worked example (#1067) and why no lint rule is possible stay in the command, where `CLAUDE.md` rule 12 points.

### Deleted, not re-worded

Of pin, qualify or delete, deletion is the option that gets skipped, and re-wording is the expensive reflex: `undrawnEquipment`'s header comment burned three issues on three successive re-wordings, each shipping a different false absolute (#1516, #1544, #1548). A fourth wording was the obvious next move, and the reason the rule says delete.

### Falsified premises: why the default flips

The reason the default is to correct a falsified premise in-phase is pure cost. A deferred premise is not a note: it is a spec pass, a board row, a triage, a worktree, a run, a PR and a review, to deliver what was frequently two lines.

#1518 is the worked example in both directions — its reproduction said renaming an entry would show the stale-picture banner, and the build proved it does not. That gap was correctly deferred (it is a Cloud Functions change with three candidate shapes — a real fork). But the same PR also found the issue's `DESCRIBED` fixture does not serve as the "current, not stale" case it was promised as, and folding _that_ in was correct and cost nothing.

### Session titles

The title a session is given automatically is the prompt that started it, so a sidebar of `salt-run 1333` rows is unreadable at the four concurrent sessions the command is normally run at.

### The Context gate

The Explore sweep is not cheap, and the issue was written to make it unnecessary — an Explore run out of habit re-buys what `/salt-spec` already paid for.

### Why write the phase yourself

An implementer subagent starts from none of what the run already holds, so delegating means re-serialising it, paying a fresh full context to receive it, and then re-validating its self-report against the diff in step 3 regardless. On a typical phase that is an entire extra agent bought to save nothing, and across a four-phase issue it is four of them.

### Why the whole gate set, concurrently

`test:coverage` and `check` are the only long poles and the other nine gates finish inside them, so the whole set run concurrently costs roughly what `pnpm test:coverage` costs alone — against ~80s for even the core five run one after another. Coverage costs ~6s over bare `pnpm test` (33.0s → 39.3s, measured in `ci.yml`'s `unit` job header). Guessing which gates a change "implicates" costs more than the run, and guessing wrong costs a red CI five minutes later.

The two coverage gates are the ones that bit hardest: campaign #1176 lost one CI cycle on #1140 and two on #1137 to a locally-green phase going red on the ratchet.

### The commit trailer

The `Co-Authored-By` trailer is the repo's convention throughout, and the only per-commit record of which model wrote a phase — which is how the Fable 5 campaign was identified after the fact (`git log --grep='Claude Fable 5' -i --all`).

### No pre-push hook

There used to be a `pre-push` hook. It ran the full suite on every push — a third run of what step 3 had just run and CI would run again — and it was deleted for that.

### Rebase every phase

A behind-main branch's run skips the heavy suites; the merge queue supplies that signal at landing.

### Why Closes before Refs is safe

The swap to `Refs` happens before `gh pr ready`, and GitHub refuses to merge a draft PR — so an intermediate PR cannot reach `main` still carrying a closing keyword. Do the swap after `gh pr ready` and that guarantee is gone.

The distinction is load-bearing. `board-status.yml` derives the issue→PR link from the closing keyword alone ([its header comment says so](../.github/workflows/board-status.yml)), so a `Refs` PR closes nothing and moves no board field — which is exactly right: the issue stays `In progress` until the PR that actually finishes it merges.

### The backgrounded CI watch

`--fail-fast` on a broken phase is four or five minutes back, and there is nothing a run would have done differently had it waited for the rest. The `sleep` covers the few seconds GitHub takes to register the run.

### The ceiling looks backward

The step 9 check is backward-looking on purpose: it measures what is built, never a forecast of what a phase will be.

### The conditional production build

`pnpm --filter @salt/web-pwa build` catches the class of failure `tsc` structurally cannot see — a bare specifier inside a CSS `url()`, a dynamic import that doesn't resolve — which is why CI's `boot-payload` job blocks on it. It is the one conditional gate because, unlike the rest, it is slow.

### Smaller reasons, by step

Trimmed from the command by #1589 Phase 2, each beside the rule it explains.

- **No argument, no guess.** Without an issue number there is nothing safe to guess.
- **Loop order.** The two things that dominate what a run costs are re-deriving context the issue already holds and waiting serially on things that could overlap; the ordering _is_ the optimisation.
- **Falsified premises.** The builder is the actor who finds out, and the answer arrives with the cheapest possible fix already in hand. The no-new-footprint test is what keeps a reviewed PR reviewable and the merge queue's conflict model intact.
- **Outcome field names.** Looking for the feature spelling on a defect issue is how a run starts improvising.
- **Missing phase fields.** Filling them in converts a spec contract into the builder's own guess at one — precisely what `/salt-run` exists to prevent.
- **`Safe to stop here?: No`.** Saying so plainly avoids implying a resting point that doesn't exist.
- **Invariants.** The unqualified absolute nobody can falsify is the failure mode; the commonest way a true sentence goes false is a later fix introducing a second path it never contemplated.
- **Format.** Hand-editing whitespace the pre-commit hook would rewrite anyway is pure waste.
- **Pre-commit hook.** A commit that looks hung usually isn't; prettier's rewrite means what lands can differ from what was validated; and by the time the hook catches something the commit message has been written twice. Skipping step 3's suite leaves CI to notice a broken test, seven minutes after the run has moved on.
- **Heavy suites.** They are exactly what step 3's gates cannot cover, and CI is the only place they run without taking the host stacks off Daniel. Pushing while behind `origin/main` earns a green tick for suites that never ran (step 8).
- **Draft PR at phase 1.** It exists so every later phase gets a real CI signal. One PR per issue is the common case, which is why it opens with `Closes`.
- **Handoff comment.** A contract written for a phase N+1 that does not exist is filler.
- **Step 8.** A skipped required check passes deliberately — that is how a docs-only PR merges. `cancelled` is PR runs cancelling in progress, not a defect. The full log runs to tens of thousands of lines nobody needs.
- **Step 9.** A final phase carrying the branch to 2400 lines is not split for the sake of a number: cutting one would produce a PR containing nothing. A continuation PR's base already contains the earlier phases, and a reviewer who doesn't know that reads them as missing work. The per-phase handoff comments hold the detail, so restating it only lengthens the thread. On a green, mergeable, out-of-draft PR the only thing left to observe is Daniel clicking merge.
- **Pause conditions.** A single oversized phase was specced too big, and no PR boundary fixes it. Resolving someone else's concurrent change is not a run's scope.
