---
description: Design a behavior-preserving refactor and post it as a phased GitHub issue that /salt-run can execute. Target shape, verification strategy, safe stopping points — no code.
argument-hint: <what you want to refactor>
disable-model-invocation: true
---

# Refactor Spec

I want to refactor: $ARGUMENTS

If `$ARGUMENTS` is empty, ask what I want restructured and stop here.

You are designing, not building. The deliverable is a GitHub issue. Do not write code.

## When to use this

This is the heavyweight path — an architecture read, Explore agents, a tracked issue carrying a
decision audit trail and a verification strategy. It earns that weight when at least one is true:

- the move crosses a layer, or you don't yet know every call site it touches;
- there is a real fork about the target shape worth deciding before any code moves;
- CLAUDE.md's issue-first rule already demands an issue (layer-map edits, cross-package refactors);
- the churn is large enough to want phases with safe stopping points between them.

If it is a contained tidy-up inside a module you can already name, with no fork for me to decide and
no call site outside it, **do not run this** — do it and report. A rename does not need a four-phase
issue. When unsure, say so and ask before spinning up the full flow.

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

- **CLAUDE.md is binding** — and a refactor is the most likely place to quietly drift from it. Layer map, adapter rules, data-model and Zod conventions all hold across the move.
- **No bodges.** If the target shape can only be reached by bending a rule in CLAUDE.md, that is the finding: surface it in Step 2 and get agreement to change the rule, rather than shipping a structure that violates it.
- **Flag the simpler path.** If the honest answer is a _different_ target shape than the one I asked for — or that the churn isn't worth it at all — say so with the trade-off. "Simpler and more maintainable" is the bar; "less work" is not.
- **GitHub through the `gh` CLI** (`gh issue list`, `gh issue create`, `gh label list`). `command -v gh` settles which, and the answer is a property of where this session runs, not of the repo: absent — a cloud session, where it cannot be made present — GitHub is reachable only through the GitHub MCP server. One trap there: `issue_read` strips raw angle brackets from the body it returns, so never "correct" an issue on the strength of what it read back.

## Step 0 — Behavior-preserving?

State up front: is this a **pure refactor** (no intended behavior change) or a **refactor + change**?
If any intended behavior change is mixed in, split it out into a separate feature issue.
Mixing structural churn with behavior change is the classic way refactors go wrong — keep them apart.

## Step 1 — Architecture read

Read the target area and what surrounds it. The routing table is `docs-map.md` at the repo root, which is not auto-loaded: read it, then open the docs whose _Tracks_ globs match the code you expect to move, plus `docs/salt-architecture.md` for anything crossing a layer boundary. Delegate breadth to Explore subagents when the target area is wide or its call sites are unknown; read directly when it's one module.

Note the repo's own trap here: Serena's semantic tools cannot see `.svelte` files, so "what consumes this?" answered by `find_referencing_symbols` alone is a confident, wrong answer for anything with UI call sites. Use `grep` over `**/*.svelte` for those, and treat `pnpm depcruise` / `pnpm typecheck` as the authority on what is actually connected.

Scope the output to five things and no others:

> 1. **Current structure** — what exists in the target area today, and which layers/packages it spans.
> 2. **Call sites** — everything that depends on it, `.svelte` included, with `file:line`.
> 3. **Existing coverage** — the tests over it now, and whether they are strong enough to prove behavior is preserved.
> 4. **Binding constraints** — the CLAUDE.md rules and doc contracts the target shape must honor, each named (rule number, `docs/…` section) rather than paraphrased.
> 5. **Riskiest cut points** — where this could go wrong mid-migration.
>
> No walkthrough of how the code works, no target-shape proposal yet.

**Keep the `file:line` as you go.** This read gets spent twice: once writing the issue, and once by `/salt-run`, which otherwise re-derives it once per phase. The call-site inventory in particular is the most expensive thing you will produce here and the thing every phase needs — record it against the phases in **Context pointers** and no one has to find those call sites again.

## Step 2 — Clarify with user

Ask about: the trigger (why now), the desired end state, blast-radius tolerance, and whether old and new must coexist during migration. Put the riskiest cut points in front of me before they get baked in — `AskUserQuestion` where the options are discrete, prose where they're open-ended. Do not propose implementation yet.

If the refactor adds or drops a dependency, check what is actually published (`npm view <pkg> version`) before it reaches the issue — never a version from memory.

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

- Title: `refactor: <concise target>` (imperative, no trailing period)
- Labels: the area and topical labels that fit (`gh label list` — e.g. `domain`, `area: web-pwa`, `architecture` when the layer map moves, `breaking-change` when back-compat is at stake). **Not** `refactor` or `tech-debt`, and **not** a `priority:` label — those facts live on the board as `Class` and `Queue`, and the labels that carried them are gone. **Not** `specced` either — that one is applied and removed by [`spec-shape.yml`](../../.github/workflows/spec-shape.yml) from the body itself, on every edit, not by whoever posted the issue.
- Board: `node scripts/board.mjs add <issue> --class Refactor --queue <band> --size <S|M|L>`. A refactor reaches `Recommended` only when the drift it describes is **proven** to be costing something now; the shape being wrong is not by itself proof. See [docs/issue-board.md](../../docs/issue-board.md).
  - **`gh` absent (a cloud session).** That line cannot run there, and no token fixes it: `board.mjs` reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy before any credential is evaluated. Dispatch the **Board dispatch** workflow ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server** instead — `command: add` with `issue`, `class: Refactor`, `queue`, `size`; an input you omit stays `(unchanged)`. Never a shell `curl` to the dispatches endpoint: the session credential gets 403 `Resource not accessible by integration` there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a dispatch is a request, not a confirmation** — name the route you took in the transcript, and never report the board as written on the strength of one. (`check` is the one board command that is deliberately **not** relayed; [docs/issue-board.md](../../docs/issue-board.md) says why.)
- Parent: `node scripts/board.mjs parent <issue> --of <parent>` — **every issue gets one unless nothing fits**, and the search runs in this order:
  1. **The live originating context**, which is nearly always there: the issue a run is executing, the campaign ledger, the issue a review finding was raised against, or simply the issue that was being worked on when Daniel said yes. **Who invoked this command is not the test** — an agent recommending an issue and Daniel approving it is how nearly every issue in this repo gets filed, and the originating work is equally known either way. The chain holds at every depth: an issue filed out of a follow-up hangs off that follow-up, not off whatever epic sits above it, and the epic stays reachable through it.
  2. **An open epic the work belongs to**, when there is no originating context at all — a session opened to spec something unrelated to anything in flight. Look before concluding there is none; every epic this repo has had opens its title with `epic`, so the whole set is one command: `gh issue list --state open --limit 200 --json number,title --jq '.[] | select(.title | test("^epic";"i")) | "#\(.number) \(.title)"'`. The pattern is `^epic`, not `^epic:` — #941 is `epic(test):` and the tighter form drops it. It is a candidate list you then judge, so one extra costs nothing and a miss costs the link.
  3. **No parent**, only when neither fits. That is the rare case, not the default — and it is a last resort, never a shortcut: **never invent a parent to satisfy this rule, and never create an epic to have somewhere to attach.** A container with one child is worse than a root.

  Name the parent you chose — or why there is none — in your report. Nothing else in this repo sets a sub-issue link, so an issue filed mid-flight and left unattached is one nobody finds again from the work it came out of. **A parent is not an epic, and an epic is not the only thing that can be a parent** — `parent` writes the link and touches no field, so grouping an issue with its neighbours claims nothing about priority, and an ordinary work issue holds sub-issues perfectly well: #1122 and #1202 each hold their own phase issues from inside a work band. Attached to the wrong thing, a link is not permanent: `--detach-from <the parent it currently has>` moves it, and without that flag the command still refuses. (`gh` absent: the epic sweep is the GitHub MCP server's issue search, and the write is the same **Board dispatch** route as the line above — `command: parent` with `issue` and `of`, plus `detach_from` to move one.)

  **If that parent carries a `- [ ]` checklist, write this issue's number into the line it actions** — edit the line so it ends `(#<this issue>)`. The link alone is not enough: [`board-status.yml`](../../.github/workflows/board-status.yml) rolls a closed issue up to its parent, ticks the one line that NAMES it, and closes the parent once every line is ticked and every sibling is closed — so a line citing only the PR a finding came from can never tick, and the parent stays open with its work finished. That is exactly how #1335 and #1370 ended up done-but-open.

**Then name the session**, now that the issue has a number: `REFACTOR: #<issue> — <subject>`, through `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`. `<subject>` is the title you just posted with its `refactor:` prefix and imperative verb dropped, cut to the few words that make it recognisable in a list of sessions. That tool is the desktop app's; a terminal or cloud session does not have it, and there this step is skipped silently.

**Issue body — use exactly this structure.** `/salt-run` consumes these headings; the phase blocks are its scope contract.

---

## Current State & Motivation

[What exists today and what's wrong with it. The cost of leaving it as-is. The target shape.
Decider-facing: written so a non-coder can judge whether this churn is worth it and the target is right.
NOT a UX description — a refactor changes structure, not what the user sees.]

## Behavior Contract

[The observable behavior that MUST be identical before and after, end to end.
This is the invariant the entire refactor is judged against.
If pure refactor: "no observable behavior changes." If refactor + change: that change lives in a
separate issue, linked here, not performed in this one.]

## Verification Strategy

[How behavior-preservation is PROVEN, per phase. Pick and state: existing coverage is sufficient /
characterization tests written first to lock current behavior / parity or snapshot check / manual
parity steps. This governs every phase below — a phase whose preservation can't be verified is a
red flag, not a phase.]

## Architecture Notes

[Target-state layer map. Packages touched. Migration approach: in-place / parallel-implementation
behind a flag / strangler (incremental call-site migration). Existing patterns to reuse.
Constraints from CLAUDE.md. Written for a fresh agent with no prior context.]

## Open Questions / Decisions

[Every cut-point or risk raised in Step 2, each as:

- **Decision:** what was chosen
- **Why:** the reasoning
- **Rejected:** the alternative(s) and why not
  Unresolved items stay listed as open questions, not silently assumed away.]

## Phases

[One `### Phase` block per phase, numbered Phase 1 through Phase N.

Every phase must end behavior-preserving and verifiable — that is a constraint on where a boundary may
_fall_. Unlike a feature, a refactor's boundaries are genuinely driven by structure: the useful question
is **"where can we safely stop?"**, and each such resting point is worth a phase even when the work either
side is small. A phase whose preservation can't be verified is a red flag, not a phase.

Split at:

- **safe resting points** — the codebase is consistent and shippable here, old and new coexisting if need be;
- **characterization-first** — locking current behavior in tests before moving anything is its own phase
  whenever existing coverage isn't strong enough to prove preservation;
- **a mechanical sweep** — a wide call-site migration separates cleanly from the structural change it follows;
- **dead-code removal** — deleting the old shape after the new one is proven, never in the same phase; or
- **too large to build inside the budget** — a worker gets **90 minutes** per phase, and about 10 of those
  are the CI wait at the boundary rather than building. A sweep that cannot be built, gated and pushed
  through CI inside that is two sweeps — and a mechanical migration is the easiest thing here to cut in
  half, since any point part-way through it is a safe resting point by construction.

**A phase boundary is also a PR boundary**, so a long migration never has to fit in one PR: `/salt-run` cuts one
where its diff ceiling is crossed with phases still unbuilt ([docs/issue-board.md](../../docs/issue-board.md) →
`Size`). Every safe resting point you name is available as a PR boundary too.

Do not split a single atomic move that has no safe midpoint — say so in **Safe to stop here?** instead.]

### Phase 1: [Name]

**Scope:** [What gets restructured — precise, not vague]
**Behavior-preserving check:** [How this phase proves behavior is unchanged — which tests, which parity check]
**Technical deliverables:** [Files moved/split/renamed, new boundaries, exported functions/types]
**Context pointers:** [What Step 1 already learned about _this_ phase, so `/salt-run` reads rather than re-sweeps:
the `file:line` call sites it must update, the tests that cover them, and the named rules and `docs/…`
sections that bound the target shape. Written for an agent arriving with no context — thin here buys a
fresh Explore sweep there, and on a refactor that sweep is the expensive one.]
**Must not touch:** [Explicitly out of scope]
**Safe to stop here?:** [Yes/No — is the codebase in a shippable, consistent state after this phase, or is this a point of no return mid-migration?]

### Phase 2: [Name]

**Scope:** [...]
**Behavior-preserving check:** [...]
**Technical deliverables:** [...]
**Context pointers:** [...]
**Must not touch:** [...]
**Safe to stop here?:** [...]

[...continue through Phase N...]

## Definition of Done

[Structural goal reached AND behavior unchanged per the Behavior Contract AND mechanical gates
(tests/types/lint/depcruise) green. Any dead code from the old structure removed or explicitly scheduled.]
---

## Step 4 — Verify the issue is runnable

`/salt-run` consumes this issue by exact heading, and nothing else checks that coupling. Read the posted body
back with `gh issue view <n>` and confirm the top-level headings are spelled exactly as above, that every
phase block carries all six fields — **Safe to stop here?** included, since `/salt-run` reads a `No` there as
"not shippable at this boundary" — and that the call sites listed in **Context pointers** actually exist.
Check them. That inventory is the most expensive thing Step 1 produced and the thing every phase needs;
a path written from memory sends `/salt-run` to find them all again. The headings and the phase fields are checked mechanically, by the same code that decides the label:

```
gh issue view <n> --json body -q .body | node scripts/check-spec-shape.mjs
```

`spec-shape.yml` runs that on every issue opened or edited and applies the **`specced`** label when it
passes, removing it when it stops passing — so the label appearing on the posted issue is the
confirmation that the shape is right, which is worth knowing in a cloud session where the checker is not
reachable but the label still is. It reads shape, never truth: whether those paths are real is the part
it cannot see, and stays yours.

Fix anything wrong with `gh issue edit`.

Then share the issue URL and ask me to confirm the **Behavior Contract** before any implementation starts.
