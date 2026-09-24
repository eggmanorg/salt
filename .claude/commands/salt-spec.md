---
description: Design a feature and post it as a phased GitHub issue that /salt-run can execute. An architecture read, the forks put in front of the user, then the issue — no code.
argument-hint: <what you want to build>
disable-model-invocation: true
---

# Feature Spec

I want to build: $ARGUMENTS

You are designing, not building. The deliverable is a GitHub issue. Do not write code.

## When to use this

This is the heavyweight path — an architecture read, Explore agents, a tracked issue carrying a decision
audit trail. It earns that weight when at least one is true:

- the feature crosses a layer, or you don't yet know which layers it lands in;
- there is a real architecture fork worth deciding before any code exists;
- CLAUDE.md's issue-first rule already demands an issue (new package, new dependency, layer-map edit,
  cross-package refactor);
- the work is genuinely large enough to want phases.

If it is a contained change to a module you can already name, with no fork for me to decide, **do not run
this** — build it and report. A one-line change does not need a four-phase issue, and producing one is a
cost rather than a courtesy. When unsure, say so and ask before spinning up the full flow.

**The other direction, and it is the one nothing here used to ask.** The escape above runs downward —
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
pointed at [`.claude/commands/salt-epic.md`](salt-epic.md)**. Naming the route matters as much as
naming the destination: no agent can invoke one of these commands — every file in
`.claude/commands/` carries `disable-model-invocation: true` — so "hand back to `/salt-epic`" names
something that cannot happen, and leaves hand-writing the container body from in here as the path of
least resistance. That is the fallback CLAUDE.md names, not the default.

**Why the tie breaks toward asking:** the costs are unequal. A work issue filed as an epic costs a
thin container someone deletes. An epic filed as a work issue costs a stalled `/salt-run` and a human
driving a container phase by phase — which is what happened on 2026-09-14 (#1378).

## Standing rules

- **CLAUDE.md is binding.** If the feature can only be built by bending a rule in it, that is a finding to surface in Step 2 — not a detail to settle quietly during implementation.
- **No bodges.** If the clean design needs the spec to change, say so and get agreement before the issue is posted. Never contort the architecture to fit a draft spec.
- **Flag the simpler path.** If a different shape — or changing a repo rule — would be materially _simpler and more maintainable_ (not merely easier or faster to write), raise it with the trade-off. Staying silent is a claim that the current shape is right.
- **GitHub through the `gh` CLI** (`gh issue list`, `gh issue create`, `gh label list`). `command -v gh` settles which, and the answer is a property of where this session runs, not of the repo: absent — a cloud session, where it cannot be made present — GitHub is reachable only through the GitHub MCP server. One trap there: `issue_read` strips raw angle brackets from the body it returns, so never "correct" an issue on the strength of what it read back.

## Step 0 — Read back before spending anything

If `$ARGUMENTS` is empty, ask what I want built and stop here.

Otherwise, before any sweep: one paragraph on what you take the ask to be and roughly where in the repo
you expect it to land. Correcting you here is free; correcting you after a wide Explore means the read
was aimed at the wrong surface, and Step 2 is too late to find that out.

If the ask is already unambiguous and you can name the module, say so in that same paragraph and carry
straight on to Step 1 — the point is that I _can_ interrupt, not that you stop and wait every time.

## Step 1 — Architecture read

Read what the feature actually touches. CLAUDE.md is already in your context — don't re-read it. The routing table is `docs-map.md` at the repo root, which is NOT in your context: read it, then open the docs whose _Tracks_ globs match the code you expect to change, plus `docs/salt-architecture.md` for anything crossing a layer boundary.

Read the long docs at section granularity. `docs/design/ui-spec-v02.md` is ~1800 lines and `-v04` ~1270 — grep their headings and read the section your change lands in. Whole-file reads are for the short docs.

Delegate breadth to Explore subagents when the surface is wide or you don't yet know where the feature lands; read directly when it's one known module. One Explore over the whole surface beats three overlapping ones — you pay for the overlap twice, once in tokens and again reconciling three reports. Search fan-out can run on a cheaper model; the design judgment stays with you.

Check for prior art too: `gh issue list --search "<keywords>" --state all`. Extending or superseding an existing issue beats duplicating it.

Scope the read's output to five things and no others: **layers involved**, **binding constraints** (named — rule number, `docs/…` section — not paraphrased), **existing patterns to reuse**, **anything that looks like it will fight the architecture**, and **whether it can ship dark**. No code walkthroughs, no implementation proposals — those come later, if at all.

**Mark what you read but did not run.** Rule 12 binds the issue body as much as it binds code: every claim you make about what the app does _today_ — this already works, that path already handles it, this helper is already generic over the case — is a premise the builder is the first person to test, and one that proves false costs a follow-on issue rather than a line. Where you inferred it from a code read, write it `(unverified — inferred from <file:line>)`. Never generalise one checked path into a set of them. The cost is on the record: #1518's reproduction offered two ways to reach a state, one of them checked, and PR #1546 shipped an Expected it does not deliver. `/salt-run` now corrects a falsified premise in place where it cheaply can — do not treat that as cover for asserting more.

**Can it ship dark?** Production is a deliberate promotion, so anything half-built on `main` holds
back everything merged behind it. A per-user flag is the release valve (#831), but a flag hides a
_surface_, never a _consequence_. Answer three questions, in order:

1. Does it own its own collections, or does it add fields to shared ones?
2. Does it _add_ surfaces, or modify existing ones?
3. **Does anything it writes get read by someone the feature is hidden from?**

Pass all three and it can be released to one person at a time for the cost of a feature key and a
few call sites. Question 3 is the one that decides it: meals freezes its expansion into
`day.recipeIds`, so a meal planned while hidden still puts five cards on everyone's planner — no UI
gate can reach that. Bread passes because `formulas`/`batches` are its own collections and the recipe
document is untouched, which `docs/formulas-schedules-batches.md` states as a design goal rather than
leaving to luck.

If it fails, raise it in Step 2 alongside the shape that would pass, and let me choose. Separability
is nearly free to design in and expensive to retrofit — once the schema has shipped it is a migration,
not a refactor.

**Keep the `file:line` as you go.** This read gets spent twice: once writing the issue, and once by `/salt-run`, which otherwise re-derives exactly these things once per phase — five architecture sweeps for a four-phase feature. Pointers recorded now are sweeps `/salt-run` never pays for again; the **Context pointers** field in each phase block is where they land.

## Step 2 — Clarify with user

Ask about intended UX and outcomes, and put the architecture forks in front of me _before_ they get baked in. Use `AskUserQuestion` for real forks with discrete options; plain prose for open-ended UX questions. Do not propose implementation yet.

If a new dependency is in the picture, check what is actually published (`npm view <pkg> version`) before it reaches the issue — never a version from memory.

## Checkpoint — is this still one work issue?

The gate in **When to use this** fires before any repo has been opened, and what settles the size
question is usually what you have just done: the architecture read, or the forks failing to
materialise. So ask it again here, where the answer is knowable and **before the body is drafted**.
Cheap to check twice; expensive to get wrong once — which is why the front gate stays and this is in
addition to it.

Can this hold a `Size` and a `Queue` band honestly? Or has it turned out to be a programme whose
increments each get specced, triaged and sequenced independently?

If the answer has changed, **route rather than carry on**: the call to Daniel in one line, then on his
yes a subagent spawned against [`.claude/commands/salt-epic.md`](salt-epic.md). Do not quietly draft a
phased body for a container — that is exactly the failure this checkpoint exists to catch.

## Step 3 — Draft and post the issue

Once we've agreed, post it with `gh issue create`.

**Issue metadata:**

- Title: `feat: <concise feature name>` (imperative, no trailing period)
- Labels: the area and topical labels that fit (`gh label list` for the current set — e.g. `area: web-pwa`, `domain`, `architecture` when the layer map moves, `breaking-change` when back-compat is at stake). **Not** `feature`, and **not** a `priority:` label — those two facts live on the board as `Class` and `Queue`, and the labels that carried them are gone. **Not** `specced` either — that one is applied and removed by [`spec-shape.yml`](../../.github/workflows/spec-shape.yml) from the body itself, on every edit, not by whoever posted the issue.
- Board: `node scripts/board.mjs add <issue> --class "New feature" --queue <band> --size <S|M|L>`. `New feature` is something Salt cannot do at all today; `Feature update` is something it already does, done better. See [docs/issue-board.md](../../docs/issue-board.md).
  - **`gh` absent (a cloud session).** That line cannot run there, and no token fixes it: `board.mjs` reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy before any credential is evaluated. Dispatch the **Board dispatch** workflow ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server** instead — `command: add` with `issue`, `class: New feature`, `queue`, `size`; an input you omit stays `(unchanged)`. Never a shell `curl` to the dispatches endpoint: the session credential gets 403 `Resource not accessible by integration` there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a dispatch is a request, not a confirmation** — name the route you took in the transcript, and never report the board as written on the strength of one. (`check` is the one board command that is deliberately **not** relayed; [docs/issue-board.md](../../docs/issue-board.md) says why.)
- Parent: `node scripts/board.mjs parent <issue> --of <parent>` — **every issue gets one unless nothing fits**, and the search runs in this order:
  1. **The live originating context**, which is nearly always there: the issue a run is executing, the campaign ledger, the issue a review finding was raised against, or simply the issue that was being worked on when Daniel said yes. **Who invoked this command is not the test** — an agent recommending an issue and Daniel approving it is how nearly every issue in this repo gets filed, and the originating work is equally known either way. The chain holds at every depth: an issue filed out of a follow-up hangs off that follow-up, not off whatever epic sits above it, and the epic stays reachable through it.
  2. **An open epic the work belongs to**, when there is no originating context at all — a session opened to spec something unrelated to anything in flight. Look before concluding there is none; every epic this repo has had opens its title with `epic`, so the whole set is one command: `gh issue list --state open --limit 200 --json number,title --jq '.[] | select(.title | test("^epic";"i")) | "#\(.number) \(.title)"'`. The pattern is `^epic`, not `^epic:` — #941 is `epic(test):` and the tighter form drops it. It is a candidate list you then judge, so one extra costs nothing and a miss costs the link.
  3. **No parent**, only when neither fits. That is the rare case, not the default — and it is a last resort, never a shortcut: **never invent a parent to satisfy this rule, and never create an epic to have somewhere to attach.** A container with one child is worse than a root.

  Name the parent you chose — or why there is none — in your report. Nothing else in this repo sets a sub-issue link, so an issue filed mid-flight and left unattached is one nobody finds again from the work it came out of. **A parent is not an epic, and an epic is not the only thing that can be a parent** — `parent` writes the link and touches no field, so grouping an issue with its neighbours claims nothing about priority, and an ordinary work issue holds sub-issues perfectly well: #1122 and #1202 each hold their own phase issues from inside a work band. Attached to the wrong thing, a link is not permanent: `--detach-from <the parent it currently has>` moves it, and without that flag the command still refuses. (`gh` absent: the epic sweep is the GitHub MCP server's issue search, and the write is the same **Board dispatch** route as the line above — `command: parent` with `issue` and `of`, plus `detach_from` to move one.)

  **If that parent carries a `- [ ]` checklist, write this issue's number into the line it actions** — edit the line so it ends `(#<this issue>)`. The link alone is not enough: [`board-status.yml`](../../.github/workflows/board-status.yml) rolls a closed issue up to its parent, ticks the one line that NAMES it, and closes the parent once every line is ticked and every sibling is closed — so a line citing only the PR a finding came from can never tick, and the parent stays open with its work finished. That is exactly how #1335 and #1370 ended up done-but-open.

**Then name the session**, now that the issue has a number: `SPEC: #<issue> — <subject>`, through `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`. `<subject>` is the title you just posted with its `feat:` prefix and imperative verb dropped, cut to the few words that make it recognisable in a list of sessions. That tool is the desktop app's; a terminal or cloud session does not have it, and there this step is skipped silently.

**Issue body — use exactly this structure.** `/salt-run` consumes these headings; the phase blocks are its scope contract.

---

## Intended Experience

[UX outcomes only. What the user will see and feel. Specific flows. What changes from today.
No implementation detail. Written for a non-coder deciding if this is right.]

## Architecture Notes

[Layer map references. Packages touched. Key decisions made. Constraints from CLAUDE.md.
What must NOT be done. Existing patterns to reuse. Whether it can ship dark behind a flag, and
what keeps it that way. Written for a fresh agent with no prior context.]

## Open Questions / Decisions

[Every architecture risk or fork raised in Step 2 goes here, each as:

- **Decision:** what was chosen
- **Why:** the reasoning
- **Rejected:** the alternative(s) and why not
  Unresolved items stay listed as open questions, not silently assumed away.
  This section is the audit trail — the "why" that Architecture Notes does not hold.]

## Phases

[One `### Phase` block per phase, numbered Phase 1 through Phase N.

Every phase must end user-testable — but that is a constraint on where a boundary may _fall_, not a
reason for one to exist. Phases are not free: each one costs a context read, a validation pass, a gate
run, a commit and a handoff contract, and that contract is a lossy hand-off of things the model would
otherwise simply hold in context. A phase may carry several user-testable outcomes when they form one
coherent unit of work.

Split only where there is a reason to:

- **an unresolved fork** — the increment rests on something in Open Questions the user should judge
  before more is built on it;
- **a learning dependency** — the next increment's design depends on what this one reveals in practice;
- **a point of no return** — after this, backing out gets expensive; or
- **too large to validate as one diff** — the reviewer (human or AI) can't reliably judge it in one pass; or
- **too large to build inside the budget** — a worker gets **90 minutes** per phase, and about 10 of those
  are the CI wait at the boundary rather than building (`/salt-run` pushes and waits at every phase, and
  forbids starting the next one before that result is read). If the increment cannot be built, gated and
  pushed through CI inside that, it is two phases. This is the builder's criterion; the four above are the
  reviewer's, and a phase has to pass both.

**A phase boundary is also a PR boundary**, so a large feature never has to fit in one PR: `/salt-run` cuts one
where its diff ceiling is crossed with phases still unbuilt, and the rest land as the next PR
([docs/issue-board.md](../../docs/issue-board.md) → `Size`). Keep a boundary the list above justifies rather than
collapsing phases to hold a total down — but that is never a reason to invent one.

None of those apply? Keep it together. A settled design with no open questions is often 1–2 phases;
an exploratory one with live forks earns more.]

### Phase 1: [Name]

**Scope:** [What gets built — precise, not vague]
**User-testable outcome(s):** [What the user can observe when this phase is done — one line each if several]
**Technical deliverables:** [Files, routes, Firestore paths, exported functions/types]
**Context pointers:** [What Step 1 already learned about _this_ phase, so `/salt-run` reads rather than re-sweeps:
`file:line` for the code to reuse or respect, and the named rules and `docs/…` sections that bound it.
Written for an agent arriving with no context — thin here buys a fresh Explore sweep there.]
**Must not touch:** [Explicitly out of scope, and every entry is a DECISION — something we chose not to do, which binds the builder and the reviewer. Never park an assumption here ("this path already works, so it needs no change"): that is a premise, it belongs in Architecture Notes marked `(unverified)` if you did not check it, and `/salt-run` corrects a falsified premise in place rather than deferring it.]

### Phase 2: [Name]

**Scope:** [...]
**User-testable outcome(s):** [...]
**Technical deliverables:** [...]
**Context pointers:** [...]
**Must not touch:** [...]

[...continue through Phase N...]

## Definition of Done

[User-perspective acceptance criteria for the complete feature]
---

## Step 4 — Verify the issue is runnable

`/salt-run` consumes this issue by exact heading, and nothing else checks that coupling. Read the posted body
back with `gh issue view <n>` and confirm:

- the top-level headings are present and spelled exactly as above — `/salt-run` looks for them literally;
- every phase block carries all five fields. A missing **Context pointers** is the expensive one: it
  costs `/salt-run` a fresh Explore sweep for that phase, which is the whole thing Step 1 paid to avoid;
- the paths in **Context pointers** actually exist — check them. A `file:line` written from memory is
  worse than no pointer at all, because `/salt-run` will trust it and read the wrong thing.

The first two are checked mechanically, and by the same code that decides the label:

```
gh issue view <n> --json body -q .body | node scripts/check-spec-shape.mjs
```

`spec-shape.yml` runs that on every issue opened or edited and applies the **`specced`** label when it
passes, removing it when it stops passing. So the label appearing on the posted issue is the
confirmation that the headings and phase fields are right — worth checking in a cloud session, where the
checker is not reachable but the label still is. What it cannot check is the third bullet, whether those
paths are real: it reads shape, never truth. That one stays yours.

Fix anything wrong with `gh issue edit` before handing it over.

Then share the issue URL and ask me to confirm **Intended Experience** before any implementation starts.
