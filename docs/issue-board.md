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

**An epic can never carry it, whatever its body says.** An epic is a container
that is never built, and a container filed in a `/salt-spec` shape is runnable
_by construction_ — #1372 was stamped `specced` eleven seconds after filing and a
`/salt-run` then picked it up as a single job. So the verdict reads the TITLE as
well as the body: a title opening `epic` is refused the label, the workflow's
step summary says the issue is a category error rather than a near-miss spec, and
the fix is to file the children as separate issues, leaving the epic itself with
no `## Phases` section at all. [`/salt-epic`](../.claude/commands/salt-epic.md) is
how one is filed in a shape that was never runnable to begin with.

The predicate there is the wide `^epic`, not the band rule's `^epic:`, because
the two have opposite cost asymmetries — see **Where that rule stops** below.

**Where the title half stops, and the second lens that covers it.** An epic filed
_without_ the prefix is invisible to the guard, and its body is judged on shape
alone. `board.mjs check` is the other lens: **an open issue in the `Epic` band
carrying `specced` is a failure**, whatever it is titled. That also catches a
stale label on an issue nobody has edited since the guard shipped, because the
workflow only re-checks an issue when it is edited — which is what the backfill
sweep above is for.

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
- **No view grouped by `Queue` carries a sort** — the other half of having no rank field.
- **A closed issue is at a shipping status.** Closed is not by itself stale: an
  issue closes the moment its PR merges and must _stay_ on the board at `Merged`,
  because that is the set `board.mjs release` walks. What is wrong is a closed
  issue that never reached `Merged` — either it was closed without shipping and
  belongs off the board, or a PR closed it without the `Closes #N` that moves it,
  and the automation is silently missing work.

  **A campaign ledger is in this rule** (2026-09-12). It used to be exempt, and the
  cost was 19 closed ledgers at no `Status` at once — one per campaign ever run,
  accumulating invisibly to the only check that could have said so and surfacing
  on the `Workflow` board as a column of cards nobody could account for. A ledger
  is not work, but it does ship: it closes when its campaign finishes, and a
  finished campaign means the work it ran merged. The exemption a ledger keeps is
  `Queue` and `Class`, nothing more.

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

**How one is filed.** [`/salt-epic`](../.claude/commands/salt-epic.md) — the fourth
issue-filing command, and the only one whose output is not a work unit. It posts a
container: a goal, a scope boundary, the ordered list of children and why that
order, the decision audit trail, and what closing it means. Three properties are
not stylistic:

- **The title must open `epic:`.** Both mechanical rules key off it — the band
  rule above, and the `specced` guard. A container that forgets the prefix is
  invisible to both.
- **No `--size`.** `board.mjs add <issue> --class "New feature" --queue Epic`, and
  nothing more. An epic cannot be sized honestly, which is the whole reason it is
  not work.
- **No `## Phases`, and none of the three spec signature headings.** That is what
  makes the body unclassifiable rather than merely unlabelled, and
  `scripts/tests/specIssueShape.test.mjs` pins it against the command's own
  template. The command's final step is the inverse of `/salt-spec`'s: it confirms
  the posted body **fails** `check-spec-shape.mjs` with exit 2.

It does not file the children. Each is filed by its own command — `/salt-spec`,
`/salt-defect` or `/salt-refactor` — and attached with `board.mjs parent`.

**One view needs the exclusion typed in by hand** — the `Workflow` board groups
by `Status`, so epics would otherwise appear there as cards among the work; its
filter carries `-queue:Epic`. `The queue` needs nothing, because grouping by
`Queue` already separates them. `Product` is a judgement call: an epic like #778
is genuinely product work, so it is left visible there.

`board.mjs check` enforces the half of this that is mechanical, and it is now two
rules rather than one — the same invariant approached from both ends:

- **An open issue titled `epic:` must be in the `Epic` band.** Title in, band out.
- **An open issue in the `Epic` band must not carry `specced`.** Band in, label
  out. An epic is a container, so "a robot may build this" is a category error
  about it — and this is the rule that still fires when the title guard in
  [`spec-shape.yml`](../.github/workflows/spec-shape.yml) cannot see the epic at
  all, because it was filed without the prefix.

The pair is deliberate. Each is blind to what the other sees, and the residue
they share — an epic that is both mis-titled and untriaged — falls to the
untriaged-`Queue` rule, which is why that rule has no epic carve-out.

That test used to be "an open issue with sub-issues", and it was wrong. It read
a parent link as proof of an epic, and a parent link is nothing of the kind: it
is the ordinary way to group an issue with the work it came out of. #1122 and
#1202 each hold their own phase issues while correctly sitting in a work band,
and both were failing this check on live data. Every epic this repo has had
opens its title with `epic` (#778, #894, #913, #941, #1129), so that is what is
actually checkable — and it catches the epic with no children at all, which the
old form's "one direction only" carve-out had to let through.

**Where that rule stops, stated rather than implied.** `isEpicTitle` matches
`^epic:` and nothing else, so a **scoped** epic title is outside it: #941 is
`epic(test): make the test suite safe for the #913 refactor`, and `check` would
not have made it hold the `Epic` band. Four of the five match, not five. The
band rule is deliberately left that narrow — widening what counts as an epic
title is a naming decision, not a check tweak — so read it as "an open issue
titled `epic:`", never as "every epic".

**The `specced` guard uses a wider predicate, and the difference is the point.**
`isEpicishTitle` matches `^epic`, so it catches #941 where the band rule does
not. The two are not drift: a miss in the band rule costs an epic sitting in the
wrong column where a person sees it, and a miss in the label guard costs a
container being handed to `/salt-run` as a job. Cheap and visible against
expensive and silent — so the band rule stays narrow and the guard is wide, and
an extra match there costs only that an issue whose title opens `epic` cannot be
called runnable.

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
opens its title with `epic`, so the candidate set is one command — and it is
`^epic`, not `^epic:`, because #941 is `epic(test):` and the tighter form drops
it:

```
gh issue list --state open --limit 200 --json number,title \
  --jq '.[] | select(.title | test("^epic";"i")) | "#\(.number) \(.title)"'
```

That is wider than the band rule above on purpose. This one produces a list a
person then judges, so offering one candidate too many costs nothing and missing
the only epic that fits costs the link.

Only where neither a context nor an epic fits does the parent stay unset, and
that is the rare case. It is a last resort, never a shortcut: inventing a parent,
or creating an epic to have somewhere to attach, is worse than leaving a root.

The converse holds too, and matters more often: **an epic is not the only thing
that can be a parent.** An ordinary work issue holds sub-issues perfectly well —
#1122 and #1202 each hold their own phase issues from inside a work band, and a
`campaign:` ledger holds everything its campaign throws off. So a filing with no
place to go is never a reason to create an epic: a container with one child is
worse than a root.

**`/salt-epic` existing is not a way around that.** The command states the floor
itself — two phases of one job is a work issue, and a container with one child is
worse than a root — and it asks the epic-vs-work-issue question of Daniel in one
line before it posts anything. It exists because an agent asked for an epic had
nothing correct to reach for and reached for `/salt-spec` instead (#1378), not
because containers became cheaper.

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

**A `/salt-campaign` ledger takes no work fields, but it does take a parent and a
Status.** An issue titled `campaign:` is a coordination artefact: no `Queue`, no
`Class`, closed by hand rather than by a PR, and it is the parent the campaign
hangs its own filings off. `check` skips it in the untriaged rule, or every
campaign that ever ran would sit in its output forever. `campaign follow-ups:`
gets no such exemption — that one is ordinary work and is triaged like any.

It does **not** skip it in the closed-at-a-shipping-status rule any more, and
the boundary is worth stating precisely, because a ledger cannot be promoted the
way work is. `release` moves `Merged` → `Released` by asking whether a closing
PR's merge commit is an ancestor of the deployed sha, and a ledger has no PR — so
left to that test alone it would sit at `Merged` for good. Its run-set is the
honest substitute: `ledgerFullyReleased` promotes a ledger once every issue its
**title** names is `Released`, in the same pass that released the last of them.
An empty run-set answers false rather than vacuously true, and one member the
query could not resolve answers false too — a ledger wrongly marked `Released`
claims a campaign shipped, and nothing re-checks it.

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

**`L` has no headroom, by construction.** Its top edge _is_ `--max-diff` — the same
2000 lines `/salt-run` refuses to carry past a phase boundary. So a correctly
estimated `L` sits exactly on the wall, and any estimation error at all crosses it.
That is why **a `/salt-run` split on an `L` issue is the expected outcome rather than
an estimation failure**: the mechanism below is what `L` is sized to invoke, not a
penalty for getting the number wrong. Read a split as the design working.

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

- **A view grouped by `Queue` may carry no sort.** That order is the only one
  anything writes, `check`'s promotion rule reads it, and a sort renders a
  different one in its place. If such a view ever needs sorting, it needs a
  different answer, not a `Rank` field.
- **The order is project-wide**, shared by every unsorted view. Harmless, because
  an issue is in exactly one `Queue` and grouping only slices that one order —
  but do the sequencing in **The queue** and treat **Product** as read-mostly,
  since a drag there moves the same global order.

**Everywhere else a sort is a display choice, and the rule deliberately stops
short of it.** It was "no view at all" until September 2026, which flagged the
`Workflow` board every time `check` ran. That was the check being wrong, not the
board: `Workflow` groups by `Status`, an issue reaches a `Status` column by
event rather than by placement, and its `Closed DESC, Created ASC` sort is what
makes Triage read oldest-first and the shipped columns read in the order they
closed. There is no triage order in that view for a sort to hide.

**What a sort actually costs, stated rather than overclaimed:** it disables
drag-to-**reorder** inside a group. Dragging a card **between** columns still
works and still writes the field — measured on the `Workflow` board, against the
old claim that it did not.

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

| To          | Set by                                                                                                                                                                                                             |                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Triage      | GitHub's built-in "Item added to project" project workflow — a **UI setting**, and `check` now asserts it is on                                                                                                    |                                                                                                                     |
| Todo        | a person, or `/triage`                                                                                                                                                                                             | the one real decision; no event can observe it                                                                      |
| In progress | `/salt-run`, when the branch is cut — `board.mjs` directly where `gh` is, or a `board-dispatch.yml` dispatch from a cloud session; **and `board-status.yml`** for the two kinds of issue no branch is ever cut for | a branch push is too noisy to key on                                                                                |
| In review   | `board-status.yml`                                                                                                                                                                                                 | `pull_request` opened / ready_for_review                                                                            |
| Merged      | `board-status.yml`                                                                                                                                                                                                 | `pull_request` closed && merged, **or** `rollup`'s `close` arm when a checklist parent's last box ticks (see below) |
| Released    | `board-status.yml`                                                                                                                                                                                                 | production deploy succeeded **and** the merge commit is an ancestor of the deployed sha                             |

The issue↔PR link is the `Closes #N` that `/salt-run` writes into every PR body —
the same text GitHub derives its own linked-issue relation from.

**The first rung is not code, and was silently missing.** `Triage` is set by one of
GitHub's built-in project workflows, which lives in the project's UI and can be
switched on and off there. It was **off** for weeks. New issues arrived with no
`Status` at all, four of them sat unset for their whole life, and this table plus
[`board-status.yml`](../.github/workflows/board-status.yml)'s header both went on
asserting it worked — a mechanism stated in two documents and guaranteed by
nothing, which is precisely what CLAUDE.md rule 12 is about.

It is enabled again, and `check` now asserts it rather than trusting it. Two
built-ins are pinned, because two are what these docs claim:

| Built-in workflow                | Why it is pinned                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Item added to project`          | the `Triage` rung in the table above                                                             |
| `Auto-add sub-issues to project` | how a parent link puts an issue on the board, which is what keeps a campaign's filings reachable |

The project's other five built-ins are deliberately off and stay passable — pinning
the whole set would fail the next time somebody enabled one for a good reason. A
required workflow that is **missing** from the list fails too: GitHub renaming one
is indistinguishable from switching it off, and means the same thing.

To change either, open the project on github.com → **⋯** → **Workflows**. There is
no API for it, which is why this is a check rather than a fix.

**`In progress` also has events, for the work no branch is cut for.** A campaign
ledger is in progress from the moment it opens — `/salt-campaign` opens one to
_be_ the running state of a campaign and closes it when the campaign finishes, so
there is no point in its life when it is waiting. And a multi-item issue — a
`campaign follow-ups:` list, a spec with phases — starts when its first box is
ticked: nobody cuts a branch for "the issue", agents land its items one at a
time, and the tick is the durable record that one of them did. `board-status.yml`
runs `board.mjs start` on every `issues` open and edit, which promotes **only**
from unset / `Triage` / `Todo` — so a body edit can never drag an issue back out
of a status a `pull_request` event established. What counts as started, and what
it cannot see, is in [`scripts/lib/boardProgress.mjs`](../scripts/lib/boardProgress.mjs).

The ledger half is also checked: `board.mjs check` fails on an **open** ledger at
a pre-work status, which is the case the webhook cannot cover — an item that
reached the board after the `issues.opened` run had already looked for it.

**`Released` is not "everything Merged".** Production deploys a _tag_, and
`Merged` only means "on `main`". Between a release tag being cut and its
approval-gated deploy finishing, more can land on main; marking those live would
be a lie the board tells about production. Hence the per-issue ancestry test, and
hence `fetch-depth: 0` on that job.

### Which closes go through a PR, and which do not

`check` fails a closed issue that never reached `Merged`, because either it shipped
without the `Closes #N` that moves it or it has no business on the board any more.
Several kinds of issue legitimately never go near a PR, though, and for weeks the
rule could not tell them apart — eleven of its twelve failures were that one blind
spot, which is the same as having no check at all.

What `closedItemVerdict` decides, and why each way:

| Closed issue                                 | `check` says | Because                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| at `Merged`                                  | nothing      | it shipped and must stay — `board.mjs release` walks exactly this set                                                                                                                                                                  |
| at `Released`                                | a note       | live; safe to take off the board whenever you like                                                                                                                                                                                     |
| item added **after** the issue closed        | a note       | a parent link auto-added it; it was never in the pipeline, so no PR could have moved it                                                                                                                                                |
| closed as **not planned**                    | a note       | won't-fix or superseded; nothing will ever ship it, so leaving the board is the only remedy                                                                                                                                            |
| `campaign:` ledger, not at a shipping status | **fails**    | it has no PR but it _does_ ship; set it from its run-set, or `release` promotes it                                                                                                                                                     |
| `epic:`, `campaign follow-ups:`, `question(` | a note       | these close by hand — children done, boxes ticked, question answered. No PR was ever coming. (A `campaign follow-ups:` list can also close itself now — see **A closed sub-issue rolls up to the checklist that asked for it** below.) |
| anything else, not at a shipping status      | **fails**    | a mechanism is broken: an automated move was missed, or the issue should be off the board                                                                                                                                              |

The three hand-closed kinds are a **title** test — `isHandClosed` in
`scripts/lib/boardTitles.mjs`, beside `isEpicTitle` and deliberately separate from
`isLedger`. Two things about that separation are load-bearing and neither is
optional:

- **`isLedger` must not widen to reach `campaign follow-ups:`.** It also gates the
  untriaged-`Queue` rule, so the day it matches is the day the kind of issue agents
  file most often stops being triaged. A unit test asserts it still does not match.
- **A note, not silence.** An exemption that printed nothing would recreate the
  problem the ledger correction fixed in the other direction: closed items piling
  up at no `Status`, filling the Workflow view with cards nobody can account for.
  The note says what to set and how.

**A not-planned close is GitHub's own `stateReason`**, read from the issue alongside
its state. It is whatever the person closing it picked, which is the rule's real
boundary: work abandoned under _Close as completed_ reads as completed here and
still fails. That is the safe direction — the rule fires and says so, rather than a
mislabelled close buying a permanent exemption. The note also wins over the ledger
advice, because telling an abandoned campaign to set itself `Merged` would be a lie.

A failure here always means code or automation has to change. Anything a person
could simply tidy up is a note — that is what keeps the exit code worth reading.

### Attaching a closed issue puts it on the board, with nothing filled in

The project has two of GitHub's built-in workflows enabled — **Auto-add to project**
and **Auto-add sub-issues to project**. The second one matters here and is easy to
miss: the moment anything links an issue as a sub-issue of another, GitHub adds it
to the board with no `Status`, no `Queue`, no `Class` and no `Size`. It does that
whether the issue is open or was closed months ago.

Since #1346 made attaching a parent the routine gesture for everything an agent
files, that happens often, and each long-closed issue it caught used to become a
permanent `check` failure demanding it reach `Merged` — incoherent, because the item
did not exist when its PR merged. #1123's PR merged **13 days** before its board item
was created, and `board.mjs pr` was right to do nothing at the time.

So the rule compares the board item's `createdAt` with the issue's `closedAt`.
Created strictly later means auto-added, and that is a note. **Equal or earlier is
not exempt** — the item was there while the issue was live, so the pipeline really
should have moved it, and the ambiguous case falls toward the rule firing.

### `board.mjs pr` no longer skips an absent issue in silence

The same investigation turned up the mirror-image hole. `pr` writes `Status` for
whatever the PR body's `Closes #N` names, and an issue that is not on the board used
to print one line and exit 0. That reads as a clean run, and it was covering two
opposite situations:

- the issue **closed before the PR was raised** — a back-reference to finished work,
  which many `campaign follow-ups:` bodies carry. There is genuinely nothing to
  move. Still a note, still exit 0.
- **anything else** — the issue is live, this PR is shipping it, and nothing ever
  triaged it onto the board. `board-status.yml` reported success having moved
  nothing. That now prints what is wrong and **exits 1**, after making every move it
  could still make.

A board job that is quietly out of date is worse than one that is visibly broken —
the same reasoning that makes a missing `PROJECT_TOKEN` fail loudly rather than skip.

### A closed sub-issue rolls up to the checklist that asked for it

`/salt-campaign` files a `campaign follow-ups:` issue at **Finish**, hangs the issues
that action its lines off it as sub-issues, and deliberately leaves it open. Nothing
afterwards owned it. `/salt-run` closes the issue it ran and never looks at a parent;
`check` reads only `Queue` and `Status`; the `- [ ]` lines are ticked by whoever
remembers. So a collector whose every item had shipped stayed open and unticked
indefinitely — **#1335** sat that way with all three children closed, and **#1370**
was closed by hand with six boxes still unticked.

`board.mjs rollup <closed issue>`, fired by the `rolled-up` job in
[`board-status.yml`](../../.github/workflows/board-status.yml) on `issues: closed`,
does three things and refuses to do a fourth:

1. **Ticks the one unticked line that names the closed issue.** One, not the first
   match: two lines naming the same issue is a body somebody wrote wrong, and ticking
   either would hide it.
2. **Closes the parent** — with a comment, and `Status=Merged`, which a closed board
   item must carry and which no PR was ever going to set here — but only once every
   sub-issue is closed **and** every line is ticked.
3. **Nudges instead** when the children are all closed and the body still claims open
   work, states no checklist at all, or is a `campaign:` ledger (a ledger closes by
   hand at **Finish**, because a parked branch is unfinished business its children
   cannot show). One comment, marked so a re-close does not repeat it.

**The line has to name the issue that actions it, and that is the part a human
writes.** #1335's lines cited the campaign's PR (`(#1334)`), and the issues that
actioned them were recorded only in a comment — so on that body this ticks nothing,
which is why the nudge arm exists rather than closing on sub-issue state alone.
`/salt-defect`, `/salt-spec` and `/salt-refactor` now say to write the new issue's
number into the line it actions at the moment they set the parent link.

Sub-issue state is not the whole of "done" either: #1335's item 6 shipped as #1362,
which was never attached as a sub-issue at all. A parent can have every sub-issue
closed and still hold real work — the unticked-line gate is what catches that.

**Two tokens, and neither will do alone.** `PROJECT_TOKEN` writes the project field
and can only _read_ issues; the Actions `GITHUB_TOKEN` writes the issue and cannot
touch an org project. `rollup` takes the issue half as `ISSUE_WRITE_TOKEN`, which is
also why the close does not cascade: a `GITHUB_TOKEN`-authored close raises no
further `issues` event, so a parent that is itself a sub-issue is left for its own
close to handle. One hop per close, deliberately.

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

| View         | Layout | Filter                                               | Group by | Sort                       |
| ------------ | ------ | ---------------------------------------------------- | -------- | -------------------------- |
| The queue    | table  | `is:open -queue:Epic -queue:Deferred`                | Queue    | —                          |
| Deferred     | table  | `queue:Deferred`                                     | Class    | —                          |
| Product      | table  | `is:open class:"New feature","Feature update"`       | Class    | —                          |
| Workflow     | board  | `-queue:Deferred -queue:epic`                        | Status   | `Closed DESC, Created ASC` |
| Ready to Run | table  | `is:open -queue:Deferred label:specced no:blocking`  | Queue    | —                          |
| Epic Status  | table  | `queue:Epic is:open`                                 | —        | —                          |
| Needs Spec   | table  | `is:open -queue:Deferred -queue:epic -label:specced` | Queue    | —                          |

**Grouping cannot be _set_ through the API, but it can be _read_.**
`ProjectV2ViewConfigurationInput` exposes only `visibleFieldIds`, so a rebuilt
view needs its grouping setting by hand; name, layout, filter and columns are all
scriptable. `ProjectV2View` does expose `groupByFields`, `verticalGroupByFields`
and `sortByFields` for reading, which is why `board.mjs check` can enforce the
no-sort rule rather than only asserting it — and why it can tell a `Queue`-grouped
view, where the rule bites, from every other view, where it does not.

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
