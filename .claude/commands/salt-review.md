---
description: Have the shared pr-reviewer agent adversarially review one green PR for the defects CI structurally cannot see and post them as a single PR review. Fixes every blocking and fold-in finding before merge; proposes the rest to Daniel as follow-ups.
argument-hint: <pr number | url | branch>
disable-model-invocation: true
model: opus
---

# Review PR

Argument: `$ARGUMENTS` → a PR number, a PR URL, or a branch name.

No argument? Resolve the current branch's PR: `gh pr view --json number,headRefName`. No PR on this branch → say so and stop; there is nothing safe to guess.

You are looking for the defects that **only a reader can find**. Every mechanical property of this diff has already been decided by a machine, twice — once locally by the pre-commit hook, once in CI — and it decided them better than you will. The reviewer's entire value is in its four lenses, and every sentence spent outside them is a sentence that makes the real findings harder to see.

This runs **once**. There is no second pass over your own fixes: a reviewer asked to look again always finds something, so the loop never terminates. What gates the fixed branch is CI and Daniel, never a second model opinion.

## Standing rules

- **CLAUDE.md is binding** — layer map, hard rules, data model, Zod and observability conventions. It is also the standard you review against.
- **Read-only until the findings are posted.** Nothing is edited before the review exists — the reviewer's brief says why. Fixing is step 4, after it.
- **`gh` traps.** Every `gh` call needs the sandbox disabled. Plain `gh pr view` / `gh issue view` exit 0 with **empty stdout** in this harness — use the `--json` forms or `gh api`, and treat empty output as a failed fetch, never as "no comments" or "no checks".
- **Never open a shell command with `cd`, or with a variable assignment.** Use `git -C <path>` and absolute paths. The permission allowlist matches whole command strings, so `cd x && cat y` matches none of the entries that would have let each part through.
- **Report to Daniel in the shape CLAUDE.md sets** — his decision first, in bold; two or three plain sentences; nothing else. The findings live in the PR review. The chat reply links it and moves on.

---

## 1. The CI gate — pass, or stop

A review of a PR whose CI has not finished is a review of a diff that is still moving. Establish green first, and **do not investigate a red one** — that is `/salt-run`'s job or Daniel's, and a review session that starts debugging CI has abandoned the thing it was called for.

```
gh pr view <pr> --json number,title,headRefName,headRefOid,isDraft,mergeStateStatus,additions,deletions,changedFiles,files
gh pr checks <pr>
```

Name the session from that first read, before judging anything — the gate below stops a good half of the time, and a session that stopped still sits in the list. `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"` and `title: "REVIEW: #<pr> — <subject>"`, `<subject>` being the PR's title with its conventional-commit prefix and trailing issue reference dropped, cut to what reads at a glance. That tool is the desktop app's; a terminal or cloud session does not have it, and there this step is skipped silently.

Three required contexts, all from `ci.yml`: `Lint, typecheck, test, boundary`, `Vitest integration (emulator)`, `E2E (Playwright)`. Judge:

- **Anything still pending or in progress** → stop. "CI is still running — N of M checks pending."
- **Anything failed or cancelled** → stop, naming the check. Nothing more; you are not diagnosing it.
- **Then whether the heavy suites ran — a green tick is not proof.** A skipped required check _passes_, deliberately — it is how a docs-only PR merges without paying for the emulator ([docs/ci.md](../../docs/ci.md)) — and the `E2E (Playwright)` aggregator reports `success` even when every shard was skipped. Take the verdict, not the summary (no `gh`: `/salt-run`'s **Heavy-suite files** route):

  ```
  node scripts/heavy-suites.mjs --branch <headRefName>
  ```

  `ran-green` → carry on; your heavy-suite line at step 2 says both suites ran. `skipped-non-app` → correct, and this PR simply has no runtime signal; carry on, and say so in that line. `skipped-behind` → stop: **"the heavy suites did not run — update the branch and re-run `/salt-review`."** `cannot-confirm` → stop, quoting its `reason:` line. `pending`, `cancelled` or `failed` → the matching stop above. Each stop is a state report, not an investigation; do not go further.

Then take the head SHA. The reviewer reads it again before posting — if it moved, a push landed mid-review and the findings would be against a diff that no longer exists, so it posts nothing.

## 2. Spawn the reviewer

The review itself — what CI already proves, the four lenses, the bar a finding has to clear, severity, the posting shape and the head-SHA recheck — lives in one place, [`.claude/agents/pr-reviewer.md`](../agents/pr-reviewer.md), which `/salt-campaign` spawns too. Do not restate or second-guess it here.

```
Agent(subagent_type: "pr-reviewer", prompt: <the parameters>)
```

Never pass `model:` — it would override the agent's frontmatter. The prompt carries only these, never the diff (it fetches its own material):

- the PR number, and the head SHA from step 1;
- the scope issue — the one the PR body `Closes` or `Refs` — or "none";
- one heavy-suite line from step 1: that both heavy suites ran, or that they legitimately skipped on a docs-only diff.

It posts the review and returns one line per finding, or `STALE` if the head moved mid-review — then say so and stop: nothing was posted, and a re-run reviews the new head.

**When the `Agent` tool is unavailable** — this command is itself sometimes run as a subagent ([the follow-ups runbook](../../docs/runbooks/campaign-followups-cleanup.md) does), and a subagent's tool list need not include `Agent` — read `.claude/agents/pr-reviewer.md` and follow its brief in this session with the same parameters. Its read-only rule then binds you until the review is posted: nothing is edited before it exists.

## 3. Disposition

The review's grades decide what step 4 does, and there are only two outcomes:

- **Fix before merge** — every `## Blocking` finding and every `[fold-in]` should-fix. The first are material; the second need no decision and stay inside this PR's footprint, so fixing them now is cheaper than filing them.
- **Proposed follow-up** — every `[sweep]` should-fix and every unmarked one. A `[sweep]` fix reaches outside this PR's footprint, and widening a reviewed PR is Daniel's call, not yours; an unmarked one needs a decision. Propose a `[sweep]` as needing no decision beyond a yes to file it — the file or symbol its line names is the issue's scope.

`## Blocking` holds material findings only, so a PR whose findings are all `[fold-in]` reads as clear to the merge gate before step 4's fix is pushed. Step 4 still fixes them, in this session, before you report.

## 4. Fix, then report

**Fix everything marked `Fix before merge`, without asking.** It is the preference, it is pre-merge, and it is reversible.

The branch has to be checked out to fix it: `git worktree list` finds an existing one, otherwise create one — never touch a worktree that is on another branch. Then the safe gate set, which is what CI blocks on minus the two heavy suites, run concurrently in one message:

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm check` · `pnpm test:coverage` · `pnpm depcruise` · `pnpm boundary:test` · `pnpm docsmap:check` · `pnpm context:check` · `pnpm theme:check` · `pnpm provenance:check`

then, on the report `test:coverage` just wrote: `pnpm coverage:files:check` · `pnpm coverage:ratchet:check`. Never `e2e`, `test:emulator`, `dev` or `dev:emulators`, and never `SALT_TAKE_HOST=1` — they seize host-global singletons and would kill whatever Daniel is sitting in. Commit, push. CI re-runs; you do not re-review.

**A proposed follow-up is proposed, not filed.** It creates a durable artefact and it is the dispreferred branch, so it is Daniel's decision — put it in the reply and stop there. On his yes, file it the way this repo files everything: spawn a subagent pointed at `.claude/commands/salt-defect.md` (or `salt-refactor.md`), since only those shapes are executable by `/salt-run`, then **triage it and attach it in the same breath** — `node scripts/board.mjs add <new> --class <Class> --queue <band> --size S`, then `node scripts/board.mjs parent <new> --of <the issue this PR implements>`. Both lines, every time. An untriaged issue has no `Queue`, appears in no view, and is invisible rather than waiting; an unattached one is unreachable from the work that produced it. The issue the PR implements is the originating context here, and where there is one it is never in doubt — you are holding it. **A PR raised without an issue is the case that does occur** (a tooling or docs PR frequently is one): there is no originating context to hold, so the parent comes from the rest of the ladder in [`salt-defect.md`](salt-defect.md) — an open epic the work belongs to, then no parent. Never invent one to satisfy the rule. **`Recommended` still means proven:** a finding that is real, agreed and never once triggered is `Low`, however alarming it sounded ([docs/issue-board.md](../../docs/issue-board.md)).

Then report, in CLAUDE.md's shape:

- **Nothing found** → "**Nothing needed from you** — nothing found beyond what CI covers." and the review link. That is the whole reply.
- **Fixed** → what the defect would have done to someone using the app, in one or two plain sentences, then the link. Not a list of the fixes.
- **A follow-up proposed** → the question is the whole reply: what the finding costs if left, and what fixing it now would cost the PR.
