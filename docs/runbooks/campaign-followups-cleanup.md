# Runbook — clearing the open `campaign follow-ups:` lists (#1498 phase 2)

A one-off operation, run by one coordinator agent. It empties the
`campaign follow-ups:` checklists that seven campaigns left behind, using the
four-destination sort #1498 specifies — as closely as that sort can be run when
no campaign is in flight.

**This file holds only what the code and the issues cannot say:** which
substitute stands in for the reviewer's size mark now that the reviewers are
gone, which two of the buckets are Daniel's to decide rather than an agent's,
and why most of these lists will have to be closed by hand however well the
sort goes. The tick-and-close mechanism itself is documented at its declaration
in [`scripts/lib/boardRollup.mjs`](../../scripts/lib/boardRollup.mjs) — read
that before believing anything here about what closes automatically.

## Why a runbook rather than a campaign

`/salt-campaign` sorts findings at **Finish**, while a reviewer that has read
the diff is still available to size each one. That is the load-bearing part: the
coordinator deliberately never reads diffs, so it cannot size a finding itself,
and in #1498's design the reviewer's `[trivial]`/`[small]` mark is what makes
the sort mechanical rather than a guess.

Those reviewers are gone. The PRs merged days ago. **So the substitute is a
verification agent per list that reads the merged diff and the code as it stands
today** — which costs more than a mark on a line, and is the only honest way to
size these now. Everything else about the sort is unchanged from #1498.

## State at the time of writing (2026-09-20)

| List  | Campaign | Open lines | What it needs                                                |
| ----- | -------- | ---------- | ------------------------------------------------------------ |
| #1493 | #1486    | 6          | full sort                                                    |
| #1485 | #1466    | 8          | full sort                                                    |
| #1478 | #1467    | 9          | full sort                                                    |
| #1464 | #1443    | 9          | full sort                                                    |
| #1459 | #1440    | 5          | full sort                                                    |
| #1462 | #1447    | 0          | **nothing but a hand-close** — see below                     |
| #1442 | #1423    | 3          | **one parent fix** — every line is already placed; see below |

**37 lines across five lists.** Re-derive these counts before starting rather
than trusting the table: campaign #1494 or later may have filed another list,
and a line may have been actioned since. The sweep is one command —
`gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --jq '.[] | select(.title|startswith("campaign follow-ups"))|.number'`.

### Two mechanical fixes, before any sorting

Both were found by inspection on 2026-09-20 and neither needs a sort pass.

1. **#1472 is attached to the wrong parent.** Line 1 of #1442 names #1472, but
   #1472's parent is the campaign ledger #1423, not the list. `rollup` walks
   from a closed child to _its_ parent, so when #1472 closes the tick lands on
   #1423 and #1442 stays open with a finished line. Fix:

   ```
   node scripts/board.mjs parent 1472 --of 1442 --detach-from 1423
   ```

   Then #1442 needs nothing further: its other two open lines name #1471 and
   #1473, both correctly attached, and it closes itself when those close.

2. **#1462 can never close on its own.** Its single line is ticked (PR #1474
   merged as `79dff74d`) and it has no sub-issues at all. The `rolled-up` job in
   [`board-status.yml`](../../.github/workflows/board-status.yml) is keyed to
   `issues.closed` on a _child_, so a list with no children is never evaluated.
   Close it by hand with a comment naming the PR that resolved the line.

   This is the #1335/#1370 failure family recurring after the rollup fix
   shipped, by a route that fix structurally cannot cover. It is Open Question 2
   on #1498; do not fix the mechanism here, just close the issue.

## Pass 1 — verify and sort. Nothing is written.

One subagent per list, all five dispatched together. Each is handed its list
number and the campaign it came from, and returns a verdict per line. **No agent
in this pass files an issue, opens a PR, edits a body or ticks a box.** A sort
that writes as it goes cannot be reviewed before it has already happened.

Each agent must, for every line: read the line, read the diff of the PR the line
names (`gh pr diff <pr>` — merged PRs still serve it), read the code as it
stands on `main` today, then place the line in exactly one bucket.

| Bucket       | Test                                                                                     | Evidence it must return                                     |
| ------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **stale**    | the finding is no longer true — later work fixed it, or it was wrong when written        | the commit or PR that fixed it, or the code that refutes it |
| **trivial**  | ≤5 lines, mechanical, no judgement: a stale comment, a wrong glob, a sentence made false | the file and the lines it would touch                       |
| **work**     | a real change, or more than mechanical, but the shape is not in doubt                    | what would change, and roughly where                        |
| **decision** | there is a fork, a contract question, or a cost only Daniel can weigh                    | the question in one sentence, and what each answer costs    |

Three rules on the buckets, and they are what the pass is for:

- **`trivial` is a claim about the diff, not about the sentence.** #1051 is the
  shape to watch for: a chip icon clamp that read as one CSS selector and was in
  fact an app-wide `Chip` contract question. If the agent cannot show the lines
  it would touch, the line is not `trivial`.
- **No agent may conclude "not worth doing".** That verdict exists, and two of
  #1442's nine lines ended there legitimately — but it is a decision about what
  Salt is for, so it is `decision` and it goes to Daniel. An agent that can
  retire a line by judging it unimportant will retire the awkward ones.
- **`stale` needs a citation, not a reading.** "I could not see the problem" is
  `work` with a note, never `stale`. The whole exercise is worthless if a real
  finding is ticked because nobody could reproduce it in five minutes.

## Pass 2 — Daniel sees one page, and decides two things

The coordinator consolidates all five returns into a single page: every line,
its bucket, one sentence, grouped by bucket rather than by list. Then it stops.

Daniel approves the sort, and he owns outright:

- every **decision** line — including any that should be recorded as
  deliberately not being done;
- every **stale** line — ticking a line nobody fixed is a claim about the
  codebase, and he is the one who pays if it is wrong.

`trivial` and `work` he is approving in bulk, not line by line. Say so, so he
knows which part of the page needs his attention.

**Report to him as CLAUDE.md requires** — his decision first, the counts, and
nothing about mechanism. The page itself is the artefact; it does not get
narrated in chat.

## Pass 3 — execute the approved sort

- **trivial → one PR per list.** Not one PR for all five: a reviewable diff, and
  a wrong item blocks only its own list. Branch from `main`, fix the lines, tick
  each one with `**Done in PR #n**` on the line, run the safe gate set
  (`lint`, `typecheck`, `check`, `test`, `depcruise`, `boundary:test`), and get a
  review before merging — spawn a subagent against
  [`.claude/commands/salt-review.md`](../../.claude/commands/salt-review.md),
  since that command is user-invoked and no agent can call it. The `gh pr merge`
  hook enforces the review through
  [`scripts/lib/prEligibility.mjs`](../../scripts/lib/prEligibility.mjs), so an
  unreviewed PR stops on a prompt rather than merging quietly.

  **This is the one deliberate deviation from #1498, and the reason is filing
  cost.** #1498 has the batch ride in a runnable `/salt-refactor` issue, because
  in a live campaign nothing else exists to carry it. Here the list itself is
  already the tracking issue and already holds the lines, so a second issue per
  list would buy nothing but four more filings. The PR references the list.

- **work → its own issue.** A subagent per issue, against
  [`salt-defect.md`](../../.claude/commands/salt-defect.md) or
  [`salt-refactor.md`](../../.claude/commands/salt-refactor.md); triaged with
  `board.mjs add`; parented **to the list, not to the campaign ledger and not to
  an epic** — that is the #1472 mistake above, and it is the whole tick
  mechanism. Then write the new number into the line. Both, every time: a line
  naming only a PR can never tick.

- **decision → Daniel's answer decides the route.** An answer that is work
  becomes an issue on the `work` route. An answer of "not doing this" ticks the
  line with the reason written on it, the way #1442's two were.

## Pass 4 — close, mostly by hand

A list closes itself only when a **sub-issue closes** while every line is ticked
and every other sub-issue is already closed. Both halves matter, and the first
is the one that catches people out: the event is a child closing. So a list
whose lines were all resolved by a batch PR, or by decision, raises no event and
**will sit open with every box ticked**. Close those by hand, with a comment
naming what resolved each line.

A list holding filed `work` issues is the case that does close itself — once the
last of them merges. Leave those open and let the mechanism do it; that is the
mechanism working, and a hand-close there hides whether it does.

Finish with `node scripts/board.mjs check` and fix anything it names that this
operation filed. Findings about issues this operation did not file are not its
business.

## What this operation cannot do, stated rather than implied

- **It cannot re-review the PRs.** A finding nobody wrote down is not recovered
  here. The lists are the input, and a campaign that under-reported has already
  under-reported.
- **`stale` is only as good as the agent that judged it.** There is no gate
  behind it — no test goes red if a line is ticked wrongly. That is why it is a
  Daniel decision and not an agent's, and it is the operation's real risk.
- **Nothing here changes the mechanism.** #1462's un-closable shape, the
  `isHandClosed` exemption that #1498 makes false, and the missing
  `scripts/lib/boardProgress.mjs` row in [docs-map.md](../../docs-map.md) are
  all #1498's phase 3. Fixing them mid-operation would move the target the
  operation is being measured against.
- **It is a one-off, and this file expires with it.** When the last list closes,
  this runbook and its docs-map row are deleted in the same commit as the last
  tick. A runbook for an operation that cannot recur is a trap for the next
  agent that greps for it.

## Standing rules for the coordinator

- Every `gh` call needs the sandbox disabled, and `gh issue view` / `gh pr view`
  exit 0 with **empty stdout** in a non-TTY session. Use `gh api` with `--jq`;
  empty output is a failed fetch, never "nothing there".
- `gh api repos/{owner}/{repo}/issues/N` reports `parent: null` for every issue
  in this repo. Ask GraphQL for a parent or a sub-issue list.
- This runs from a linked worktree. Everything up to `pnpm -r build` runs freely;
  `dev`, the emulators and the e2e scripts seize host-global singletons and
  [`scripts/host-guard.mjs`](../../scripts/host-guard.mjs) refuses them. None of
  them is needed here — if a batch PR seems to want e2e, that item is not
  `trivial`.
