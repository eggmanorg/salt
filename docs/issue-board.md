# The issue board — "Salt — The Pass"

<https://github.com/orgs/eggmanorg/projects/1>

The board is where an issue's **priority, kind, size and pipeline position** live.
None of those are labels any more. This doc is the part that is not recoverable
from the board itself: what each value _means_, why the shape is what it is, and
what breaks if you change it.

Mechanics live beside the code — [`scripts/board.mjs`](../scripts/board.mjs) for
the API and the invariant check, [`board-status.yml`](../.github/workflows/board-status.yml)
for which transitions are automated.

---

## Why fields and not labels

Labels carried all of this until August 2026, and could not do the job. **A GitHub
Project can only group by and sort by a _field_.** A label is a single opaque
column: filterable, never groupable, never orderable. So "show me the recommended
queue in sequence" was unanswerable from the data as stored, and the board
degraded into one undifferentiated Triage column of 35 issues.

Nothing is kept in both places. `priority: critical|high|medium|low` and the
`status:` labels were **deleted**; `bug`, `feature`, `enhancement`, `refactor`,
`tech-debt` and `size: S|M|L` still exist but nothing applies them — they were
left in place because deleting a label strips it retroactively from every issue
that ever carried it, and ~280 closed issues would have lost their classification
for no gain.

**`status: on-hold` is the one survivor of its family**, because `/salt-campaign` puts
it on parked **pull requests**, and a PR is never on the board.

Every `area: *` label and every topical label (`flaky-test`, `performance`,
`security`, `architecture`, `canon`, `domain`, `ci`, …) stays. They are
multi-valued and filter-only, which is exactly what a label is good at.

### `specced` — the one label added since

**`specced` means the issue BODY is in a shape `/salt-run` can execute**, not that a
spec command was once run on it. `/salt-spec`, `/salt-defect` and `/salt-refactor` each
post in a fixed structure that `/salt-run` then consumes by exact heading, and until
this label existed you found out an issue was not in that structure by handing it
to `/salt-run` and watching it fail to find `## Phases`.

It is a label rather than a board field for the same reason the others are not:
it is a filter (`label:specced` — what can I start right now?), never something
to group or order by. And it is one label, not three: WHICH command produced an
issue is `Class`, and nothing is kept in both places.

Nothing applies it by hand. [`spec-shape.yml`](../.github/workflows/spec-shape.yml)
re-derives it from the body on every issue opened, edited or reopened, so an issue
whose phase blocks are later gutted loses the label instead of keeping a claim
that stopped being true. Its `workflow_dispatch` is the backfill sweep over every
open issue — run it once after adding the label, and after any change to what
counts as runnable.

**It reads shape, never truth.** Present-and-not-a-placeholder is all it can see
of **Context pointers**; whether the `file:line` in there points at anything is
the expensive failure, and it is still checked only by the agent that wrote the
issue. See the header of [`scripts/lib/specIssueShape.mjs`](../scripts/lib/specIssueShape.mjs).

---

## `Queue` — which pile

|                 |                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recommended** | Actionable **and proven**: regular user impact, a security risk, or dev friction actually being felt — regular test flake, merge-queue problems, CI/CD problems. |
| **Medium**      | Real work, ordered by impact.                                                                                                                                    |
| **Low**         | Theoretical, never triggered, or drift that has not bitten. Safe to ignore; fold into a related issue, or pick up when bored.                                    |
| **Deferred**    | Parked, with the reason in `Blocked by`.                                                                                                                         |
| **Epic**        | Not a work unit at all — a container tracked here and never sequenced against work.                                                                              |

**"Proven" is the whole discriminator.** A defect that is real, confirmed and
alarming but that has never once occurred is `Low`, not `Recommended` — #1056 is
the worked example: the schema bug is genuine, and `mealPlanTemplate` does not
exist in any environment, so its exposure is measured at zero.

### The promotion rule

> If a `Recommended` issue has an in-repo blocker, that blocker is itself
> `Recommended`, and sequenced above it.

Otherwise the top of the queue contains something that cannot be started, which
is the one thing the band is for. This is an invariant, so per CLAUDE.md rule 12
it is mechanical rather than remembered — `node scripts/board.mjs check` goes red
when a Recommended item's blocker is absent from Recommended or ordered below it.

`check` covers five more things — plus the `Epic` rule below:

- **An open issue on the board has a `Queue`.** GitHub's own "add item to
  project" workflow puts every new issue on the board with every field empty,
  and an item with no `Queue` shows up in no queue view — so an issue filed and
  never triaged is not sitting in a pile marked Triage, it is invisible, and it
  stays invisible until somebody scrolls the unfiltered board. That is what the
  agent commands' `board.mjs add --queue …` line is for, and this is what makes
  skipping it visible. Ledgers are exempt; see below.

- **A campaign ledger is attached to the work it ran.** Where every issue a
  ledger's title names sits under one parent, the ledger sits under that parent
  too; where they do not share one, it stays a root and `check` says nothing in
  either direction. Open and closed alike, because a ledger closes when its
  campaign finishes and closed is where nearly every orphan was. The rule's real
  boundary is worth stating: the run-set is what the ledger's **title** names,
  never every issue the campaign touched, so an issue added mid-run without a
  title edit is invisible to it. The pure halves — parsing the run-set, and
  deciding from a map of issue → parent — are `ledgerRunSet` and
  `ledgerShouldAttachTo` in [`scripts/lib/boardTitles.mjs`](../scripts/lib/boardTitles.mjs),
  unit-tested offline; only the GraphQL fetch lives in `check`.

- **No two options of a field share a name.** Everything in `board.mjs` resolves
  options by name at call time and takes the first match, so a field carrying the
  same name twice writes to one option while a human drag may land on the other —
  the board grows two identical columns and the items split silently between
  them. `Status` held two `Todo` options until 2026-08-31, and nothing noticed.
  The comparison is case-insensitive, because name resolution is.
- **No view carries a sort** — the other half of having no rank field.
- **A closed issue is at a shipping status.** Closed is not by itself stale: an
  issue closes the moment its PR merges and must _stay_ on the board at `Merged`,
  because that is the set `board.mjs release` walks. What is wrong is a closed
  issue that never reached `Merged` — either it was closed without shipping and
  belongs off the board, or a PR closed it without the `Closes #N` that moves it,
  and the automation is silently missing work.

---

## `Epic` — a container, not a band

An epic is the one thing on the board that is not work. It holds work, so it
cannot be _done_, cannot be sized honestly against its neighbours, and cannot
carry a priority — its children carry that. Until August 2026 the live epics sat
in `Medium` anyway, which put five permanently "In progress" cards in the middle
of the queue and made the Medium band read as bigger than the work in it.

`Epic` is a `Queue` value rather than a `Class` for one reason: **Queue is what
the queue view groups by**, so an epic lands in its own column with no filter
written anywhere. As a `Class` it would still hold a band, still sit inside
`Medium`, and every view would need `-class:Epic` typed into it by hand.

The consequence to accept: an epic has no priority. If that ever feels wrong,
the thing that wants a band is a child issue, not the epic.

**One view needs the exclusion typed in by hand** — the `Workflow` board groups
by `Status`, so epics would otherwise appear there as cards among the work; its
filter carries `-queue:Epic`. `The queue` needs nothing, because grouping by
`Queue` already separates them. `Product` is a judgement call: an epic like #778
is genuinely product work, so it is left visible there.

`board.mjs check` enforces the half of this that is mechanical: **an open issue
titled `epic:` must be in the `Epic` band.**

That test used to be "an open issue with sub-issues", and it was wrong. It read
a parent link as proof of an epic, and a parent link is nothing of the kind: it
is the ordinary way to group an issue with the work it came out of. #1122 and
#1202 each hold their own phase issues while correctly sitting in a work band,
and both were failing this check on live data. Every epic this repo has had
titles itself `epic:` (#778, #894, #913, #941, #1129), so that is what is
actually checkable — and it catches the epic with no children at all, which the
old form's "one direction only" carve-out had to let through.

## A parent is not an epic

`node scripts/board.mjs parent <issue> --of <parent>` writes a GitHub sub-issue
link **and touches no field**. Grouping and priority are separate questions:
attaching a follow-up to the work it came out of claims nothing about how urgent
it is, and the child keeps whatever band `add` gave it.

It exists because nothing could set that link before, so an issue an agent filed
mid-flight was only ever attached if a human went back and did it. `/salt-campaign`
attaches everything it files — see **Filing an issue** in
[`salt-campaign.md`](../.claude/commands/salt-campaign.md) for which parent each of its
four filings takes.

**`/salt-spec`, `/salt-defect` and `/salt-refactor` attach whenever there is a live
originating context** — the issue a run is executing, a campaign ledger, the
issue a review finding was raised against, or simply the work that was in hand
when Daniel said yes. The test used to be _who invoked the command_, and it was
wrong: Daniel almost never originates an issue out of the blue, so an agent
recommending one and him approving it is how nearly every issue here gets filed,
and the originating work is fully known either way. Written around the wrong
test, the rule left #1239 — whose own body says "#1228 is superseded by this
issue" — and #1308 unattached. The chain holds at every depth: an issue filed out
of a follow-up hangs off that follow-up, not off the epic above it — the epic
stays reachable through it.

**With no originating context at all, an open epic the work belongs to is the
next thing tried**, not a straight fall to root. Every epic this repo has had
titles itself `epic:`, so the candidate set is one command:

```
gh issue list --state open --limit 200 --json number,title \
  --jq '.[] | select(.title | test("^epic:";"i")) | "#\(.number) \(.title)"'
```

Only where neither a context nor an epic fits does the parent stay unset, and
that is the rare case. It is a last resort, never a shortcut: inventing a parent,
or creating an epic to have somewhere to attach, is worse than leaving a root.

The converse holds too, and matters more often: **an epic is not the only thing
that can be a parent.** An ordinary work issue holds sub-issues perfectly well —
#1122 and #1202 each hold their own phase issues from inside a work band, and a
`campaign:` ledger holds everything its campaign throws off. So a filing with no
place to go is never a reason to create an epic: a container with one child is
worse than a root.

**It refuses to re-parent unasked.** `addSubIssue` takes a `replaceParent` flag
and this never passes it. An agent cannot tell "unattached" from "attached to
something I cannot see", and silently moving a child out from under a parent a
human chose is the one mistake here that leaves no trace. Re-running with the
parent an issue already has is a no-op, which is what makes a retried campaign
step safe.

**Moving a link names what it displaces.**

```
node scripts/board.mjs parent <issue> --of <new parent> --detach-from <current parent>
```

This is the inverse `parent` never had: before it, a link written once could
only be undone by hand-editing GitHub. It takes the displaced parent's **number**
rather than being a bare `--reparent` switch, because the refusal above is about
proof — naming the parent you are displacing is evidence you saw it. A number
that does not match what the issue actually holds is an error and writes
nothing, naming the parent it did find; omitting the flag leaves the refusal
exactly as it was. On a cloud session the same move is Actions → **Board
dispatch** → `command: parent` with `issue`, `of` and `detach_from`.

It is two mutations, a `removeSubIssue` then an `addSubIssue`, so a failure
between them leaves the child with no parent at all. That is deliberate — the
detach is a separately-auditable act rather than an atomic `replaceParent` — and
the command prints the exact line that restores the old link if the second one
fails.

**Ask GraphQL whether an issue has a parent.** The REST issue endpoint
(`gh api repos/{owner}/{repo}/issues/N`) reports `parent: null` for every issue
in this repo, sub-issues of #1202 included — a REST sweep will tell you nothing
is attached, confidently, and be wrong. `issue.parent` over GraphQL is the field
that is populated.

**A `/salt-campaign` ledger takes no fields, but it does take a parent.** An
issue titled `campaign:` is a coordination artefact: no `Queue`, no `Class`,
closed by hand rather than by a PR, and it is the parent the campaign hangs its
own filings off. `check` skips it in both the untriaged rule and the
closed-at-a-shipping-status rule, or every campaign that ever ran would sit in
its output forever. `campaign follow-ups:` gets no such exemption — that one is
ordinary work and is triaged like any.

That exemption is about **fields**, and it used to be about parentage too. It
should not have been. Everything a campaign throws off attaches to the ledger,
so a ledger with no parent of its own puts every follow-up one hop from
unreachable: epic #913 showed nine closed children and no sign that campaign
#1266 had run three of them and left #1269 behind. So at **Finish** a campaign
attaches its ledger to the parent its run-set shares — epic or ordinary work
issue, whichever it is — and that parent gains one node whose subtree holds the
campaign's output, while **no work issue moves**, so its progress count is
exactly what it was. A sub-issue link is a strict tree,
which is why it is the ledger that moves up rather than the work that moves
down.

Where a run-set shares no single parent — a campaign over four unrelated issues
— the ledger stays a root and that is correct, not a miss. Inventing a parent
there would claim a relationship the work does not have.

---

## `Class` — what kind of thing

`Defect` · `Refactor` · `New feature` · `Feature update` · `Infra`

`New feature` is something Salt cannot do at all today (freezer inventory);
`Feature update` is something it already does, done better (a better recipe view,
a better prompt). The split exists so the **Product** view can show product work
without twenty refactors in the way.

---

## `Size` — changed lines, and a budget rather than a limit

`S` · `M` · `L`

Every spec command sets one (`board.mjs add … --size S|M|L`) and, until #1288, the
values meant whatever the person typing them took them to mean. They are **changed
lines in the finished PR**, counted the way `/salt-run` counts them —
`origin/main...HEAD`, excluding `pnpm-lock.yaml`:

| `Size` | Changed lines | Reads as                                                        |
| ------ | ------------- | --------------------------------------------------------------- |
| `S`    | up to ~400    | one phase, one sitting; a reviewer holds the whole diff at once |
| `M`    | up to ~1000   | two or three phases                                             |
| `L`    | up to 2000    | the `--max-diff` ceiling `/salt-run` enforces per PR            |

The tildes are load-bearing. This is the spec author's estimate written before the
code exists, and nothing checks it afterwards — `board.mjs check` does not test it.
What it buys is a sense of the budget the work will be built against, and a way for
triage to compare two issues.

**There is no size above `L`, because nothing needs one.** A spec that expects to
exceed 2000 lines is not too large to build and is not refused: it is a **multi-PR
issue**. `/salt-run` cuts a PR at the phase boundary where the ceiling is crossed
and the remaining phases become the next PR; `/salt-campaign` lands the first and
re-dispatches a worker for the rest. The issue closes when the last PR merges, so
one issue still moves through one lifecycle, and it sits at `In progress` the whole
way because an intermediate PR carries `Refs #N` rather than a closing keyword.
An `L` that turns out to need two PRs is a slightly wrong estimate, not a problem.

The one thing the ceiling genuinely refuses is a **single phase** that cannot be
built under 2000 lines on its own. There is no PR boundary inside a phase, so that
is a spec to redo — and it is the only case `/salt-campaign` still parks as
`BLOCKED: oversized`.

**This field is not the retired `size: S|M|L` label.** Nothing applies that label
and nothing should; see [Why fields and not labels](#why-fields-and-not-labels).

---

## Sequence is position, not a number

There is no rank field, and adding one would be a step backwards. Triage _is_
placement: you pick the band and the slot against the neighbours you can already
see, in one gesture. A view grouped by `Queue` with **no sort** gives that as a
drag; `updateProjectV2ItemPosition(projectId, itemId, afterId)` gives the
identical result to an agent, so a human and a script triage through one
mechanism and there is no number for either to keep current.

Two consequences, both load-bearing:

- **No view may carry a sort.** A sort disables dragging in that view and hides
  the order this writes. If a view ever needs sorting, it needs a different
  answer, not a `Rank` field.
- **The order is project-wide**, shared by every unsorted view. Harmless, because
  an issue is in exactly one `Queue` and grouping only slices that one order —
  but do the sequencing in **The queue** and treat **Product** as read-mostly,
  since a drag there moves the same global order.

---

## `Blocked by` — leads with the reference

Non-empty **is** what "blocked" means; there is no `Blocked` status. Format:

```
#952 — needs the prep-time decision settled first     ← in-repo, parseable
upstream: @genkit-ai/core@1.39.0 pins zod ^3.23.8     ← out of our hands
```

The leading `#N` is what `board.mjs check` parses, so the format is not
cosmetic — prose-first text makes the promotion rule unenforceable.

It holds the reason a `Deferred` item is parked, too. What it must **not** hold
is a status note on a working issue: #410 carried "PARTIAL. Step 1 shipped…" on
the old board, which would now mark a perfectly actionable issue as blocked.
That kind of note belongs in a comment on the issue.

---

## `Status` — the pipeline, and nothing else

```
Triage → Todo → In progress → In review → Merged → Released
```

_In review_ is a PR raised, _Merged_ is on `main` and not yet live, _Released_ is
in production. **Blocked and Deferred are deliberately not statuses** — an issue
can be in progress _and_ blocked, and the old board could not say so.

| To          | Set by                                                                                                                            |                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Triage      | GitHub's built-in "item added to project" project workflow                                                                        |                                                                                         |
| Todo        | a person, or `/triage`                                                                                                            | the one real decision; no event can observe it                                          |
| In progress | `/salt-run`, when the branch is cut — `board.mjs` directly where `gh` is, or a `board-dispatch.yml` dispatch from a cloud session | a branch push is too noisy to key on                                                    |
| In review   | `board-status.yml`                                                                                                                | `pull_request` opened / ready_for_review                                                |
| Merged      | `board-status.yml`                                                                                                                | `pull_request` closed && merged                                                         |
| Released    | `board-status.yml`                                                                                                                | production deploy succeeded **and** the merge commit is an ancestor of the deployed sha |

The issue↔PR link is the `Closes #N` that `/salt-run` writes into every PR body —
the same text GitHub derives its own linked-issue relation from.

**`Released` is not "everything Merged".** Production deploys a _tag_, and
`Merged` only means "on `main`". Between a release tag being cut and its
approval-gated deploy finishing, more can land on main; marking those live would
be a lie the board tells about production. Hence the per-issue ancestry test, and
hence `fetch-depth: 0` on that job.

---

## Writing the board from somewhere without `gh`

`scripts/board.mjs` is the only thing that writes the board, and it needs two
things a **cloud session has neither of**: the `gh` CLI, and a route to GitHub's
GraphQL API. `gh` is absent there and cannot be installed, and GraphQL is refused
wholesale by the session proxy — even `{viewer{login}}` comes back 403. Projects
v2 exists _only_ in GraphQL, so there is no REST fallback and **no token fixes
it**: the query is refused before any credential is evaluated. Copying
`PROJECT_TOKEN` into the cloud environment would not have worked either, and
would have put a PAT into variables that are plaintext to anyone using that
environment.

[`board-dispatch.yml`](../.github/workflows/board-dispatch.yml) is the way round
it. It exposes `add`, `set`, `pr` and `release` behind `workflow_dispatch` with
typed inputs, and runs the unmodified script on a runner under `PROJECT_TOKEN`.
A session can therefore _ask_ for a board write; it never gains the credential
that performs one.

Two things follow, both easy to get wrong:

- **A dispatch is a request, not a result.** It is fire-and-forget — the caller
  does not wait for the run. For the four writes that is the right trade: a lost
  one is a nuisance, and the board itself shows whether it landed. But a dispatch
  is never _evidence_ that a write happened.
- **`check` is not relayed, and must not be.** It is a read whose _exit code_ is
  the whole point — the promotion rule above is an invariant only because `check`
  can go red. Dispatched and unwatched it would be invisible, and an agent could
  report the invariant verified having observed nothing. Run it where `gh` is. If
  a cloud session ever genuinely needs it, the answer is a caller that waits on
  the run and reads its conclusion, not an extra entry in the dropdown.

It doubles as a **manual lever**: Actions → Board dispatch → Run workflow moves
an issue from a phone, from a machine with no checkout, or when `gh auth` has
expired.

It is not a second _automated_ writer. Every run is a human or an agent asking;
`board-status.yml` remains the only thing that writes the board **from an event**,
and the two sit in separate concurrency groups so they can never race on the same
item.

---

## The views

| View      | Layout | Filter                                         | Group by |
| --------- | ------ | ---------------------------------------------- | -------- |
| The queue | table  | `is:open -queue:Deferred`                      | Queue    |
| Deferred  | table  | `queue:Deferred`                               | Class    |
| Product   | table  | `is:open class:"New feature","Feature update"` | Class    |
| Workflow  | board  | `is:open -queue:Epic`                          | Status   |

**Grouping cannot be _set_ through the API, but it can be _read_.**
`ProjectV2ViewConfigurationInput` exposes only `visibleFieldIds`, so a rebuilt
view needs its grouping setting by hand; name, layout, filter and columns are all
scriptable. `ProjectV2View` does expose `groupByFields`, `verticalGroupByFields`
and `sortByFields` for reading, which is why `board.mjs check` can enforce the
no-sort rule rather than only asserting it.

Two names for one idea, which is genuinely confusing in the UI: a **table** view
has **Group by**; a **board** view has no such menu, because its columns _are_
the grouping — that setting is called **Column field**. A new board view defaults
its column field to `Status`, so the Workflow view needed nothing.

---

## External setup

- **`PROJECT_TOKEN`** — a repo secret holding a fine-grained PAT with read/write
  on the org's projects and read on issues. The Actions `GITHUB_TOKEN` cannot
  write Projects v2 at any permission level, so `board-status.yml` and the
  board-add step in `pr-doc-review.yml` both need this. Locally, the `gh` CLI's
  own login needs the `project` scope.
- **The board must stay org-owned.** GitHub only links a project to a repository
  under the _same_ owner, and `eggmanorg/salt` is org-owned. A user-owned project
  can hold the issues but can never appear on the repo, which is what the old
  "Saltv2" board did.
- **`updateProjectV2Field` DELETES every item's value for any option you pass
  without its `id`.** Adding one option means re-sending the whole option list,
  and an entry with no `id` is a _new_ option — GitHub silently re-issues ids for
  the lot and clears the field on every item on the board. Adding the `Epic`
  option this way wiped `Queue` on all 52 items, and restoring the old ids did
  not bring the values back. Always send the existing options with their ids
  (read them from `field(name:"Queue"){ ... on ProjectV2SingleSelectField { options{ id name description color } } }`),
  and add the new one id-less at the end. If it happens anyway, the recovery is
  the **issue timeline**: a `LabeledEvent` survives the deletion of the label
  itself, so the retired `priority: *` labels still record what each band was —
  ignoring the retirement sweep's `UnlabeledEvent`s of 2026-08-29 — and the
  `board-dispatch.yml` run logs carry every `Queue=` written since.
- **Adding an epic pulls in its sub-issues**, closed ones included — adding #778
  silently brought five closed children onto the board. `board.mjs check` fails
  on any closed item, so this surfaces rather than rots.
- **User project 6, "Saltv2", is the historical record** — 435 items, 293 of them
  merged PRs. Nothing writes to it; it is kept, not maintained.
