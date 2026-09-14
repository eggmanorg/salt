---
description: File a programme as an epic — a container that holds work issues and is never built itself. The children are named and ordered; no phases, no size, never runnable.
argument-hint: <the programme you want to track>
disable-model-invocation: true
---

# Epic

I want to track: $ARGUMENTS

You are filing a **container**, not a work unit. The deliverable is a GitHub issue that holds other
issues. Do not write code, and do not write a `## Phases` section — this issue is never executed.

## When to use this

An epic is the one thing on the board that is not work. It holds work, so it cannot be _done_, cannot
be sized honestly against its neighbours, and carries no priority — its children carry that
([docs/issue-board.md](../../docs/issue-board.md) → `Epic` — a container, not a band).

**The test is the board's own: if the thing can hold a `Size` and a `Queue` band honestly, it is
work — file it with `/salt-spec`, `/salt-defect` or `/salt-refactor` instead.** A programme whose
increments each get specced, triaged and sequenced against other work _independently_ is an epic. One
job with internal phases is a work issue, however many phases it has.

**The floor, and it is a rule rather than a preference: a container with one child is worse than a
root** ([docs/issue-board.md](../../docs/issue-board.md) → A parent is not an epic). Two phases of one
job is a work issue. An ordinary work issue holds sub-issues perfectly well — #1122 and #1202 each
hold their own phase issues from inside a work band — so "this needs somewhere to attach" is never a
reason to file one of these.

**Put the call to Daniel in one line before you file, and never make it silently.** Which shape this
is decides whether a `/salt-run` can ever pick it up, it is cheap to ask and expensive to undo, and it
is the judgement that failed on 2026-09-14 in the other direction (#1378). One sentence: the choice,
why, and an offer to file the other shape instead.

## Standing rules

- **CLAUDE.md is binding.** If the programme can only be delivered by bending a rule in it, that is a
  finding for Step 2, not a detail to settle quietly later.
- **No bodges.** If the clean shape needs the ask to change, say so and get agreement before the issue
  is posted.
- **Flag the simpler path.** If one work issue would do, say so — see **When to use this** above.
- **GitHub through the `gh` CLI** (`gh issue list`, `gh issue create`, `gh label list`). `command -v gh`
  settles which, and the answer is a property of where this session runs, not of the repo: absent — a
  cloud session, where it cannot be made present — GitHub is reachable only through the GitHub MCP
  server. One trap there: `issue_read` strips raw angle brackets from the body it returns, so never
  "correct" an issue on the strength of what it read back.

## Step 0 — Read back before spending anything

If `$ARGUMENTS` is empty, ask what I want tracked and stop here.

Otherwise, before any sweep: one paragraph on what you take the programme to be, and your first cut at
what its children are. Correcting you here is free. If that list has one entry, say so now — that is
the floor above, and the answer is a work issue.

## Step 1 — Read enough to name the children

An epic's value is the ordered list of work it holds, so read enough to name that list honestly and no
more. CLAUDE.md is already in your context — don't re-read it. `docs-map.md` at the repo root is the
routing table and is NOT in your context: read it, then the docs whose _Tracks_ globs match the ground
the programme covers.

Delegate breadth to Explore subagents when the surface is wide; read directly when it is one known
area. Search fan-out can run on a cheaper model.

Check for prior art: `gh issue list --search "<keywords>" --state all`. An existing epic that already
holds this work is the answer, and adding children to it beats filing a second container. Every epic
this repo has had opens its title with `epic`, so the whole open set is one command:

```
gh issue list --state open --limit 200 --json number,title \
  --jq '.[] | select(.title | test("^epic";"i")) | "#\(.number) \(.title)"'
```

Scope the read's output to three things: **what the programme covers**, **the increments it breaks
into and why that order**, and **where the boundary falls** — what is deliberately outside it. No code
walkthroughs, no implementation proposals; those belong to the children, and each child gets its own
`/salt-spec`, `/salt-defect` or `/salt-refactor` later.

## Step 2 — Clarify with user

Put the scope boundary and the child list in front of me before either is baked in. Use
`AskUserQuestion` for real forks with discrete options; plain prose for open-ended ones.

## Checkpoint — is this still a programme?

The gate in **When to use this** fires before any repo has been opened, and what settles the size
question is usually what you have just done: the read, or the child list collapsing. So ask it again
here, where the answer is knowable and **before the body is drafted**. Cheap to check twice; expensive
to get wrong once — which is why the front gate stays and this is in addition to it.

Can any of this hold a `Size` and a `Queue` band honestly? Did the child list come out at one or two
increments of the same job? A container with one child is worse than a root.

If the answer has changed, **route rather than carry on**. Put it to Daniel in one line, and on his
yes **spawn a subagent pointed at the right command file** — and name which of the three, because that
is a second judgement and "it is work" does not answer it:

- something Salt cannot do at all today, or does and would do better →
  [`.claude/commands/salt-spec.md`](salt-spec.md)
- something broken, with an observed wrong behaviour → [`.claude/commands/salt-defect.md`](salt-defect.md)
- a shape change with no behaviour change → [`.claude/commands/salt-refactor.md`](salt-refactor.md)

**Spawning a subagent against the file is the route, because no agent can invoke one of these
commands** — every file in `.claude/commands/` carries `disable-model-invocation: true`, so "hand back
to `/salt-spec`" names something that cannot happen. Writing that shape's body yourself from in here
is the fallback CLAUDE.md names, not the default: a body produced by a command that never ran is the
failure this whole family exists to stop. If you do fall back, verify it with
`node scripts/check-spec-shape.mjs`.

The costs are unequal, which is why the tie breaks toward asking: a work issue filed as an epic costs
a thin container someone deletes; an epic filed as a work issue costs a stalled `/salt-run` and a human
driving a container phase by phase, which is what happened on 2026-09-14 (#1378).

## Step 3 — Draft and post the issue

Once we've agreed, post it with `gh issue create`.

**Issue metadata:**

- Title: **must open `epic:`** — `epic: <concise programme name>`. This is mandatory, not stylistic:
  `board.mjs check` demands an `epic:`-titled issue sit in the `Epic` band, and
  [`spec-shape.yml`](../../.github/workflows/spec-shape.yml) refuses the `specced` label on an
  `epic`-opening title. A container that forgets the prefix is invisible to both.
- Labels: the area and topical labels that fit (`gh label list`). **Not** `specced` — the workflow
  applies and removes that from the body, and on an epic it refuses it outright.
- Board: `node scripts/board.mjs add <issue> --class "New feature" --queue Epic` — **and no `--size`**.
  An epic cannot be sized honestly against its neighbours, and a container in the `Epic` band never
  competes for sequence with the work it holds ([docs/issue-board.md](../../docs/issue-board.md)).
  Pick the `Class` that describes the programme; `New feature` is the usual one.
  - **`gh` absent (a cloud session).** That line cannot run there, and no token fixes it: `board.mjs`
    reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy
    before any credential is evaluated. Dispatch the **Board dispatch** workflow
    ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP
    server** instead — `command: add` with `issue`, `class: New feature`, `queue: Epic`; an input you
    omit stays `(unchanged)`, which is how the size is left unset. Never a shell `curl` to the
    dispatches endpoint: the session credential gets 403 `Resource not accessible by integration`
    there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a
    dispatch is a request, not a confirmation** — name the route you took, and never report the board
    as written on the strength of one.
- Parent: `node scripts/board.mjs parent <issue> --of <parent>`. An epic takes one on the same terms as
  anything else — a live originating context first, a wider open epic second, no parent third. **Never
  invent a parent, and never create an epic to have somewhere to attach**; that prohibition is
  unchanged by this command existing, and a container with one child is worse than a root. Name the
  parent you chose, or why there is none, in your report. (`gh` absent: the write is the same **Board
  dispatch** route — `command: parent` with `issue` and `of`.)
- Children: each child issue is filed separately, by its own command, and attached with
  `node scripts/board.mjs parent <child> --of <this epic>`. **This command does not file them.** An
  epic posted with its children still hypothetical is the normal and correct state — the `## Children`
  section below is the plan, and the links appear as each one is actually specced.

**Then name the session**, now that the issue has a number: `EPIC: #<issue> — <subject>`, through
`mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`. `<subject>` is the title you just
posted with its `epic:` prefix dropped, cut to the few words that make it recognisable in a list of
sessions. That tool is the desktop app's; a terminal or cloud session does not have it, and there this
step is skipped silently.

**Issue body — use exactly this structure.** It carries **no `## Phases` section** and none of the
three spec signature headings, which is what makes it unrunnable by construction rather than by
anyone's care. `scripts/tests/specIssueShape.test.mjs` pins that.

---

## Goal

[What the programme is for, in outcomes. What becomes true when every child has shipped. Written for a
non-coder deciding whether this is worth doing at all. No implementation detail.]

## Scope boundary

[What is inside this container and — more usefully — what is deliberately outside it, and where that
work lives instead. The boundary is what stops an epic growing until it means nothing.]

## Children

[The ordered list of work issues this holds, and **why that order** — a dependency, a learning that the
next one needs, or a deliberate sequencing call. One line each.

Each is filed separately through `/salt-spec`, `/salt-defect` or `/salt-refactor` and attached with
`board.mjs parent`. List the ones already filed as `#N — <title>`; list the ones still to come as a
name and a sentence. A child that is still hypothetical is fine here and is the normal state.

There must be more than one. A container with one child is worse than a root.]

## Open Questions / Decisions

[Every fork raised in Step 2, each as:

- **Decision:** what was chosen
- **Why:** the reasoning
- **Rejected:** the alternative(s) and why not
  Unresolved items stay listed as open questions, not silently assumed away.]

## Definition of Done

[What closing this epic means — which children must have shipped, and what is checked at the end that
no individual child could check on its own. An epic closes by hand when its children are done; no PR
ever closes one.]

---

## Step 4 — Verify the epic is NOT runnable

This is the inverse of `/salt-spec` Step 4, and it is the point of the whole command. Read the posted
body back and confirm the container is a container:

```
gh issue view <n> --json body -q .body | node scripts/check-spec-shape.mjs
```

**Exit 2 — "not a spec issue" — is the pass.** Exit 0 or 1 means the body carries a spec signature
heading and the issue is a category error: something in it reads as `## Intended Experience`,
`## Observed vs Expected` or `## Behavior Contract`. Fix the body with `gh issue edit`, do not argue
with the checker.

Then confirm the two things the checker cannot:

- the issue carries **no `specced` label**. With an `epic:` title the workflow refuses it outright, so
  seeing it there means the title is wrong — check the prefix.
- the board item sits in `Queue=Epic` with **no `Size`**. `node scripts/board.mjs check` fails an open
  `Epic`-band item that carries `specced`, and fails an `epic:`-titled issue that is in any other band.

Then share the issue URL and ask me to confirm **Goal** and **Children** before any child is specced.
