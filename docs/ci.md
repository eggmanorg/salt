# CI, the `Main` ruleset, and the merge queue

What gates a merge, and where that configuration actually lives. Most of it is
**not in the tree**: the ruleset and code scanning are GitHub settings, and the
repo's only knowledge of them is this doc plus `scripts/check-merge-queue.mjs`.
For deploys — what happens _after_ a merge — see [releases.md](releases.md).

## The `Main` ruleset

One ruleset, `Main`, on `refs/heads/main`
([settings](https://github.com/eggmanorg/salt/rules/16697241)). Read it as data
rather than trusting this table, which is a copy:

```bash
gh api repos/eggmanorg/salt/rulesets/16697241
```

| Rule                           | Configuration                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `required_status_checks`       | The three contexts below. **Not strict** — see the merge queue.                  |
| `merge_queue`                  | Squash; see settings below.                                                      |
| `pull_request`                 | 0 required approvals; `allowed_merge_methods: [squash, rebase]`.                 |
| `required_linear_history`      | On. This is why the queue merges by squash.                                      |
| `code_scanning`                | CodeQL, `high_or_higher` / `errors`. **A rule, not a status check** — see below. |
| `code_quality`                 | Severity `errors`. Also a rule, not a status check.                              |
| `deletion`, `non_fast_forward` | On.                                                                              |

### The three required status checks

`Lint, typecheck, test, boundary`, `Vitest integration (emulator)` and
`E2E (Playwright)`. All three are produced by `ci.yml`, and the first and third
are **aggregator jobs** that exist only to keep those exact strings in the graph
while the real work is split across `static`/`types`/`unit`/`boot-payload` and
three e2e shards. Renaming one leaves every PR waiting forever on a context that
never reports, which is why `ci.yml`'s comments say so at each site and why
`pnpm mergequeue:check` fails on it.

Two properties are deliberate and easy to misread:

- **A skipped required check passes.** That is how a docs-only PR merges without
  paying for the emulator and Playwright suites. It also means a green tick is
  not proof a suite ran — read job conclusions, not the check summary
  (`.claude/commands/salt-run.md` step 8 has the recipe).
- **Both aggregators run `if: always()` and assert their dependencies
  themselves.** A plain `needs:` would _skip_ them when a dependency failed, and
  a skipped required check passes — the gate would silently stop gating.

## The merge queue

### How a PR enters it

**Nothing self-queues.** A green PR sits open until someone puts it in — being
green is not the trigger, and there is no state in which GitHub decides on its
own that a PR is ready to land.

Two ways in, and they are the same mechanism:

- **Press the green button**, which reads **"Merge when ready"** once a queue is
  required on the branch. That is the whole action; the queue does the rest.
- **Enable auto-merge**, which enqueues the PR the moment its required checks go
  green rather than making you wait for them. This is how
  `dependabot-auto-merge.yml`'s `gh pr merge --auto --squash` lands patch and
  minor bumps with nobody watching.

Once in, entries are **batched for testing, not combined into one commit**: up to
`max_entries_to_build` are stacked on `main` and tested as one group, then land as
**separate squash commits in queue order** — one `(#PR)` subject each, exactly as
before. If an entry fails, it is ejected and the rest re-form and carry on, so a
bad neighbour does not hold up a good PR.

GitHub builds each queued PR onto **current `main`** on a
`gh-readonly-queue/main/pr-N-<sha>` ref and runs `ci.yml` there; the PR merges
only if that combination is green. This is where the semantic collision that
"require branches to be up to date" exists to catch — two PRs each green apart,
broken together — is now caught, instead of on a hand-driven "Update branch"
round-trip, and never on `main` itself.

| Setting                                 | Value  | Why                                                                                                                                              |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merge method                            | Squash | `required_linear_history` is on and `main` is squash-linear (`(#PR)` subjects). A merge commit would violate the rule.                           |
| Maximum PRs to build                    | 5      | Speculation depth — the thing the serial predecessor could never do.                                                                             |
| Maximum PRs to merge                    | 5      | Matches build depth.                                                                                                                             |
| Minimum PRs to merge                    | 1      | The queue never holds a green group back waiting for company. Batching engages only when PRs happen to stack up; a lone PR is not delayed by it. |
| Wait time to meet minimum group size    | 5 min  | Moot at a minimum of 1.                                                                                                                          |
| Only merge non-failing PRs (`ALLGREEN`) | On     | Merge the batch only if every entry is green.                                                                                                    |
| Status check timeout                    | 60 min | CI's worst case is ~25 min (cold-cache e2e runs of 18 min are on record).                                                                        |

### Turning it on, in that order

The queue and the `merge_group:` trigger have to arrive in the right order, and
getting it wrong is quiet rather than loud. Enable the queue **after** a `ci.yml`
carrying `merge_group:` is on `main` — enable it first and the very next queued
PR waits 60 minutes on three contexts that cannot report, then gets ejected, with
nothing red anywhere to say why. The reverse order is harmless: the trigger sits
inert until a queue exists to fire it. That is exactly what happened in #1073,
which added the trigger with no queue to use it and was reverted in #1074.

Turning it off is the same in reverse: drop the queue rule and restore
`strict_required_status_checks_policy` together, or PRs can merge behind `main`
with nothing checking the combination.

**`strict_required_status_checks_policy` is off, and that is the point.** It
required every branch to be restacked before merging; the queue does that
restacking itself, speculatively, and tests the result. Leaving strict on would
reintroduce the manual step the queue exists to remove.

`ci.yml`'s `changes` job reads `github.event.merge_group.base_sha`/`head_sha`, so
the non-app allowlist keeps working in the queue: a docs-only batch still skips
the heavy suites rather than paying for them twice. Its up-to-date gate is
narrowed to `pull_request` — a queue candidate is up to date by construction, and
the queue run is where the suites a behind-branch skipped actually execute.

### Why CodeQL and `code_quality` do not gate the queue

This is the first thing to check if the queue ever behaves unexpectedly, and the
distinction is not cosmetic.

CodeQL runs through GitHub's **default setup**, which lives in repository
settings, and **default setup does not analyse `merge_group` events**. It is
enforced by the ruleset's `code_scanning` rule — _merge protection_ — and not as
a required status check. GitHub does not apply merge protection to merge queue
groups, so it is **skipped** there rather than left pending. The gate still runs
on every PR before it can be queued, and on every push to `main` after.

Had CodeQL been a required _status_ check, every queue entry would have sat
pending until the 60-minute timeout and then been ejected, and the fix would
have been a migration to advanced setup — a `.github/workflows/codeql.yml` with
its own `merge_group:` trigger. It is not, so no such migration exists. **Verify
which mechanism is in play before concluding otherwise**; the two look identical
in the merge box and behave completely differently in a queue.

### The failure mode default setup does have

Nothing in the tree says CodeQL exists or that it gates merges, which is what
makes this worth writing down:

- Default setup analyses on `push` to `main` and on `pull_request` targeting
  `main`. A PR head with no CodeQL result cannot satisfy merge protection, and
  **re-running CI does not help** — a re-run is not a new `pull_request` event,
  so no analysis is produced. The only way to get a result for a head is a new
  commit on the branch.
- So anything that disturbs default setup blocks every open PR, indefinitely,
  with no cause visible anywhere in the repo. Moving the repo to the eggmanorg
  organisation (2026-08-29) did exactly that: setup was re-provisioned about
  45 minutes after the transfer, and every PR head pushed in between was left
  permanently unmergeable until it was pushed to again.

If a PR is `blocked` with every visible check green, look for a missing CodeQL
result before looking anywhere else, and check
**Settings → Code security → Code scanning** rather than the workflow files.

## What the queue replaced

`auto-update-prs.yml` (deleted with the queue) fired on push to `main` and
dragged every auto-merge-enabled PR forward with `update-branch`, so strict
mode's requirement was satisfied without anyone clicking. It needed a
fine-grained PAT (`PAT_AUTO_UPDATE`) rather than `GITHUB_TOKEN`, because a
branch update made with `GITHUB_TOKEN` creates no workflow run — CI would never
report on the new head sha and auto-merge would hang rather than merge.

It was the incumbent, not the best available: updates were **serial**, so N
behind PRs cost N sequential update-and-re-run cycles rather than one batched
run. It was written when the queue was unavailable — the queue requires an
organisation-owned repository, and the repo was owned by a personal account
until the eggmanorg transfer. Public vs private was never the constraint; the
account type was.

Retiring it was not optional once the queue landed. A PR with auto-merge enabled
is now _in_ the queue, and pushing `update-branch` to a queued PR invalidates its
entry.

## Interactions worth knowing

- **`deploy-staging.yml` chains off `ci.yml`'s completion on `main`**
  (`workflow_run`, `branches: [main]`). Merge-queue runs happen on the readonly
  queue ref and never on `main`, so `ci.yml` must keep its `push: branches:
[main]` trigger or staging deploys stop silently. `pnpm mergequeue:check`
  asserts it.
- **`dependabot-auto-merge.yml`** calls `gh pr merge --auto --squash` for patch
  and minor bumps. Under a queue that enqueues rather than merges; the queue's
  own merge method applies. No change was needed.
- **`autofix.yml`** pushes prettier fixes to PR heads with a GitHub App token
  (a `GITHUB_TOKEN` push re-triggers nothing). It runs before a PR is queueable
  and is unaffected by the queue.
- **`chromatic.yml`** is deliberately never a required check — see
  [visual-regression.md](visual-regression.md).

## The guard, and its limit

`pnpm mergequeue:check` (`scripts/check-merge-queue.mjs`, a step in `ci.yml`'s
`static` job) fails on the four ways this repo can jam its own queue: a required
context that no job produces, one that two workflows produce, an owning workflow
without a `merge_group:` trigger, and an unconditional `cancel-in-progress` —
a cancelled required check ejects the entry. It also asserts the push-to-main
trigger above.

**It mirrors the ruleset; it cannot read it.** CI must not depend on a network
call, so the context list in `scripts/lib/mergeQueueGuard.mjs` is a hand-kept
copy. It catches the direction that actually happens — a renamed job, a lost
trigger — and is blind to a context added to the ruleset in the GitHub UI and to
nothing else. Re-check the copy against the live ruleset when you change either.
