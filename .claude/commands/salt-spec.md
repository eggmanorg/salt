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

## Step 3 — Draft and post the issue

Once we've agreed, post it with `gh issue create`.

**Issue metadata:**

- Title: `feat: <concise feature name>` (imperative, no trailing period)
- Labels: the area and topical labels that fit (`gh label list` for the current set — e.g. `area: web-pwa`, `domain`, `architecture` when the layer map moves, `breaking-change` when back-compat is at stake). **Not** `feature`, and **not** a `priority:` label — those two facts live on the board as `Class` and `Queue`, and the labels that carried them are gone. **Not** `specced` either — that one is applied and removed by [`spec-shape.yml`](../../.github/workflows/spec-shape.yml) from the body itself, on every edit, not by whoever posted the issue.
- Board: `node scripts/board.mjs add <issue> --class "New feature" --queue <band> --size <S|M|L>`. `New feature` is something Salt cannot do at all today; `Feature update` is something it already does, done better. See [docs/issue-board.md](../../docs/issue-board.md).
  - **`gh` absent (a cloud session).** That line cannot run there, and no token fixes it: `board.mjs` reaches the board through `gh api graphql`, and GraphQL is refused wholesale by the session proxy before any credential is evaluated. Dispatch the **Board dispatch** workflow ([`board-dispatch.yml`](../../.github/workflows/board-dispatch.yml)) through the **GitHub MCP server** instead — `command: add` with `issue`, `class: New feature`, `queue`, `size`; an input you omit stays `(unchanged)`. Never a shell `curl` to the dispatches endpoint: the session credential gets 403 `Resource not accessible by integration` there, and only the MCP path is authorised for `actions:write`. It is fire-and-forget, so **a dispatch is a request, not a confirmation** — name the route you took in the transcript, and never report the board as written on the strength of one. (`check` is the one board command that is deliberately **not** relayed; [docs/issue-board.md](../../docs/issue-board.md) says why.)
- Parent: `node scripts/board.mjs parent <issue> --of <parent>` — **whenever there is a live originating context**, which is nearly always. The originating context is the work this filing came out of: the issue a run is executing, the campaign ledger, the issue a review finding was raised against, or simply the issue that was being worked on when Daniel said yes. Attach to it, and name it in your report. **Who invoked this command is not the test** — an agent recommending an issue and Daniel approving it is how nearly every issue in this repo gets filed, and the originating work is equally known either way. The chain holds at every depth: an issue filed out of a follow-up hangs off that follow-up, not off whatever epic sits above it. Only a genuinely context-free filing — a session opened to spec something unrelated to anything in flight — leaves the parent unset, and that is the exception rather than the rule. Nothing else in this repo sets a sub-issue link, so an issue filed mid-flight and left unattached is one nobody finds again from the work it came out of. A parent is **not** an epic — `parent` writes the link and touches no field, so grouping an issue with its neighbours claims nothing about priority. Attached to the wrong thing, a link is not permanent: `--detach-from <the parent it currently has>` moves it, and without that flag the command still refuses. (`gh` absent: the same **Board dispatch** route as the line above, `command: parent` with `issue` and `of`, plus `detach_from` to move one.)

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
- **too large to validate as one diff** — the reviewer (human or AI) can't reliably judge it in one pass.

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
**Must not touch:** [Explicitly out of scope]

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
