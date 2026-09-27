# Spec writing — the text the issue-filing commands share

`/salt-spec`, `/salt-defect` and `/salt-refactor`
([salt-spec.md](../commands/salt-spec.md), [salt-defect.md](../commands/salt-defect.md),
[salt-refactor.md](../commands/salt-refactor.md)) each read this file once, at the start, and then
point into it by section name — `spec-writing.md` → _Section_ — at the step where that section
applies. Each command keeps its own steps, baseline heading, phase rules and issue-body template;
this file holds only the text that used to be copied into all three.

It sits outside `.claude/commands/`, the directory whose files become slash commands, so it is not
a command of its own. Where a line differs by kind it carries a placeholder, and the pointing
command supplies the value at its pointer: `<Class>` (the board class), `<SESSION>` (the session
prefix) and `<prefix>` (the issue title prefix).

What `scripts/tests/specCommandsShared.test.mjs` pins: each command points here, every pointer
names a section that exists, every command points at every section, and no paragraph of this file
has been pasted back into a command. What it cannot pin: that a command's own text still agrees
with this file in substance. That stays a reviewer's read.

## When the work is an epic

**The other direction, and it is the one nothing here used to ask.** The escape in the command's **When to use this** runs downward —
too small for this path. There is an upward one: some things are too big to be a **work issue at
all**. A programme whose increments each get specced, triaged and sequenced against other work
_independently_ is an **epic**, and an epic is a container that is never built.

The criterion is the board's own, so it is answerable about a specific proposal rather than felt: **if
the thing can hold a `Size` and a `Queue` band honestly, it is work.** An epic can do neither — it
cannot be _done_, cannot be sized against its neighbours, and carries no priority because its children
carry it ([docs/issue-board.md](../../docs/issue-board.md) → `Epic` — a container, not a band).

**The floor, stated as a rule:** a container with one child is worse than a root. Two phases of one
job is a work issue, however many phases it has. This is not a licence to file epics.

**If it is one, route — do not file this shape anyway.** Put the call to Daniel in one line (the
choice, a one-sentence reason, an offer to file the other shape), and on his yes **spawn a subagent
pointed at [`.claude/commands/salt-epic.md`](../commands/salt-epic.md)**. Naming the route matters as much as
naming the destination: no agent can invoke one of these commands — every file in
`.claude/commands/` carries `disable-model-invocation: true` — so "hand back to `/salt-epic`" names
something that cannot happen, and leaves hand-writing the container body from in here as the path of
least resistance. That is the fallback CLAUDE.md names, not the default.

**Why the tie breaks toward asking:** the costs are unequal. A work issue filed as an epic costs a
thin container someone deletes. An epic filed as a work issue costs a stalled `/salt-run` and a human
driving a container phase by phase — which is what happened on 2026-09-14 (#1378).

## GitHub access

**GitHub through the `gh` CLI** (`gh issue list`, `gh issue create`, `gh label list`). `command -v gh` settles which, and the answer is a property of where this session runs, not of the repo: absent — a cloud session, where it cannot be made present — GitHub is reachable only through the GitHub MCP server. One trap there: `issue_read` strips raw angle brackets from the body it returns, so never "correct" an issue on the strength of what it read back.

## Checkpoint — is this still one work issue?

The gate in **When to use this** fires before any repo has been opened, and what settles the size
question is usually what you have just done: the architecture read, or the forks failing to
materialise. So ask it again here, where the answer is knowable and **before the body is drafted**.
Cheap to check twice; expensive to get wrong once — which is why the front gate stays and this is in
addition to it.

Can this hold a `Size` and a `Queue` band honestly? Or has it turned out to be a programme whose
increments each get specced, triaged and sequenced independently?

If the answer has changed, **route rather than carry on**: the call to Daniel in one line, then on his
yes a subagent spawned against [`.claude/commands/salt-epic.md`](../commands/salt-epic.md). Do not quietly draft a
phased body for a container — that is exactly the failure this checkpoint exists to catch.

## Board and parent

**`gh` absent (a cloud session).** The `board.mjs add` line cannot run there, and no token fixes it: `board.mjs` reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy before any credential is evaluated. Dispatch the **Board dispatch** workflow ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server** instead — `command: add` with `issue`, `class: <Class>`, `queue`, `size`; an input you omit stays `(unchanged)`. Never a shell `curl` to the dispatches endpoint: the session credential gets 403 `Resource not accessible by integration` there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a dispatch is a request, not a confirmation** — name the route you took in the transcript, and never report the board as written on the strength of one. (`check` is the one board command that is deliberately **not** relayed; [docs/issue-board.md](../../docs/issue-board.md) says why.)

- Parent: `node scripts/board.mjs parent <issue> --of <parent>` — **every issue gets one unless nothing fits**, and the search runs in this order:
  1. **The live originating context**, which is nearly always there: the issue a run is executing, the campaign ledger, the issue a review finding was raised against, or simply the issue that was being worked on when Daniel said yes. **Who invoked this command is not the test** — an agent recommending an issue and Daniel approving it is how nearly every issue in this repo gets filed, and the originating work is equally known either way. The chain holds at every depth: an issue filed out of a follow-up hangs off that follow-up, not off whatever epic sits above it, and the epic stays reachable through it.
  2. **An open epic the work belongs to**, when there is no originating context at all — a session opened to spec something unrelated to anything in flight. Look before concluding there is none; every epic this repo has had opens its title with `epic`, so the whole set is one command: `gh issue list --state open --limit 200 --json number,title --jq '.[] | select(.title | test("^epic";"i")) | "#\(.number) \(.title)"'`. The pattern is `^epic`, not `^epic:` — #941 is `epic(test):` and the tighter form drops it. It is a candidate list you then judge, so one extra costs nothing and a miss costs the link.
  3. **No parent**, only when neither fits. That is the rare case, not the default — and it is a last resort, never a shortcut: **never invent a parent to satisfy this rule, and never create an epic to have somewhere to attach.** A container with one child is worse than a root.

  Name the parent you chose — or why there is none — in your report. Nothing else in this repo sets a sub-issue link, so an issue filed mid-flight and left unattached is one nobody finds again from the work it came out of. **A parent is not an epic, and an epic is not the only thing that can be a parent** — `parent` writes the link and touches no field, so grouping an issue with its neighbours claims nothing about priority, and an ordinary work issue holds sub-issues perfectly well: #1122 and #1202 each hold their own phase issues from inside a work band. Attached to the wrong thing, a link is not permanent: `--detach-from <the parent it currently has>` moves it, and without that flag the command still refuses. (`gh` absent: the epic sweep is the GitHub MCP server's issue search, and the write is the same **Board dispatch** route as the line above — `command: parent` with `issue` and `of`, plus `detach_from` to move one.)

  **If that parent carries a `- [ ]` checklist, write this issue's number into the line it actions** — edit the line so it ends `(#<this issue>)`. The link alone is not enough: [`board-status.yml`](../../.github/workflows/board-status.yml) rolls a closed issue up to its parent, ticks the one line that NAMES it, and closes the parent once every line is ticked and every sibling is closed — so a line citing only the PR a finding came from can never tick, and the parent stays open with its work finished. That is exactly how #1335 and #1370 ended up done-but-open.

## Session name

**Then name the session**, now that the issue has a number: `<SESSION>: #<issue> — <subject>`, through `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`. `<subject>` is the title you just posted with its `<prefix>` prefix and imperative verb dropped, cut to the few words that make it recognisable in a list of sessions. That tool is the desktop app's; a terminal or cloud session does not have it, and there this step is skipped silently.

## Checking the posted body

```
gh issue view <n> --json body -q .body | node scripts/check-spec-shape.mjs
```

`spec-shape.yml` runs that on every issue opened or edited and applies the **`specced`** label when it
passes, removing it when it stops passing — so the label appearing on the posted issue is the
confirmation that the shape is right, which is worth knowing in a cloud session where the checker is not
reachable but the label still is. It reads shape, never truth: whether those paths are real is the part
it cannot see, and stays yours.
