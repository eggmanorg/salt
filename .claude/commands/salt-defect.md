---
description: Investigate a defect to its root cause and post it as a phased GitHub issue that /salt-run can execute. Reproduce, trace, decide the forks — no fix.
argument-hint: <the defect or symptom>
disable-model-invocation: true
---

# Defect Spec

I want to investigate and fix: $ARGUMENTS

If `$ARGUMENTS` is empty, ask what is broken and stop here.

You are investigating and specifying, not fixing. The deliverable is a GitHub issue. Do not write the fix.

**Read [`.claude/shared/spec-writing.md`](../shared/spec-writing.md) once, now,** before anything below. It holds the text this command shares with the other two issue-filing commands. Each pointer into it below names the section that applies at that step, and supplies the words this command fills in.

## When to use this

This is the heavyweight path — Explore agents, a tracked issue, the decision audit trail. It earns its weight only when at least one is true:

- the root cause is non-obvious and needs tracing across files/packages to locate;
- there is a real scope fork the user should decide (targeted vs broad, hotfix vs full fix);
- blast radius matters — production data may already be corrupted, or a behavior contract changes;
- it needs a tracked issue anyway (CLAUDE.md issue-first: new deps, layer-map edits, cross-package refactors).

If the cause is obvious, the change is contained to a file or two, and there is no decision for the user to make, **do not run this** — just fix it inline (with a regression test) and report. When unsure, say so and ask before spinning up the full flow.

**A false sentence in a comment or a doc is not a defect this path takes.** It is real and it matters — rule 12 exists because of it — but the whole fix is prose, there is no fork to decide, and an issue body for one runs thirty times the length of its own diff. Fix it where you found it. And check whether the claim has been corrected before: **the second time a sentence is found false, the fix is to delete it, not to attempt a third wording.** `undrawnEquipment`'s header spent #1516, #1544 and #1548 on exactly that loop — three issues, three PRs, three reviews, three successive false absolutes, for a paragraph restating a resolution chain the code already expresses. The only comment-claim defect that earns this path is one whose correction changes _code_: the sentence becomes a mechanical check, and then it is the check that is the deliverable. #1463 → #1549 → #1550 is that shape and is not the loop above — a hand-counted enumeration became one checked list, and #1550 is a hole in the check rather than a fourth wording.

**Too big rather than too small?** An epic is not a work issue: `spec-writing.md` → _When the work is an epic_.

## Standing rules

- **CLAUDE.md is binding.** Layer map, hard rules, data-model and Zod conventions. A fix that requires bending one of them is a finding for Step 3, not a detail to settle during implementation.
- **Fix the mechanism, not the symptom.** No bodges: if the honest fix is larger than the bug looks, say so. Suppressing a symptom to close an issue is worse than leaving the issue open.
- **Flag the simpler path.** If the defect exists because the surrounding design is wrong, and a different shape would be _simpler and more maintainable_ (not merely quicker to patch), raise it with the trade-off — even when that means a second issue rather than this one.
- **GitHub access:** `spec-writing.md` → _GitHub access_.

## Step 1 — Reproduce & triage

Confirm the defect is real before theorising. Reproduce it (run the failing test, the command, the flow) and capture concrete evidence — error text, a failing assertion, a log line, a trace. Then state plainly:

- **Is it a real defect, a flake, or intended behavior?** If intermittent, characterize frequency. If the "buggy" behavior turns out to be intended, stop and report that instead of inventing a fix.
- **First-guess severity / blast radius:** who or what is affected, and is any production data being corrupted while the bug is live?

Check for prior art before investigating far: `gh issue list --search "<symptom keywords>" --state all`. This repo has known-flake history worth not rediscovering.

**Run the reproduction to its last step, including every branch of it.** Rule 12 applies to the issue body you are about to write as much as to code: a reproduction step asserted from a code read, with nothing having executed it, is an unfalsifiable claim that the builder falsifies for you later — at the price of a follow-on issue rather than a line. What you did not run gets marked `(unverified)` in the body; what you cannot run at all gets said plainly. Never silently generalise one verified path into a list of them.

Do not propose a fix yet.

## Step 2 — Root-cause investigation

Trace the symptom to the mechanism in code. Delegate breadth to Explore subagents when the trail crosses files or packages; follow it yourself when it's one module deep. The **Docs map** (`docs-map.md`, not auto-loaded) routes you to the doc that owns the area — read it before concluding, since these docs hold the deliberate asymmetries that look like bugs.

Verify the root cause empirically where you can (a probe, or a test that pinpoints it) rather than asserting it. Scope the report to these four, and nothing else:

> 1. **The mechanism** — the exact code path with `file:line`, and quoted code. State whether **more than one** bug contributes; investigations often surface a second.
> 2. **Behavior that must be preserved** — adjacent correct behavior the fix must not regress, and the tests that encode it.
> 3. **Binding constraints** — the CLAUDE.md rules and doc contracts bounding the fix, each named (rule number, `docs/…` section) rather than paraphrased.
> 4. **Blast radius** — what else this mechanism affects, and whether live data is already wrong.
>
> No preamble, no restating the symptom, no fix proposal yet.

**Keep the `file:line` as you go.** This investigation gets spent twice: once writing the issue, and once by `/salt-run`, which otherwise re-derives it per phase — re-tracing a root cause that is already known. Record it against the phases in **Context pointers**.

## Step 3 — Clarify with user

Ask me to decide the forks the investigation surfaced. Use `AskUserQuestion` where the options are discrete. Typical ones:

- **Fix scope** — minimal/targeted vs a broader retune of the surrounding logic.
- **Existing data** — does live/production data already need remediation, or fix-forward only?
- **Urgency** — minimal hotfix now vs the full fix.

Surface the regression risks. Do not propose implementation detail yet. If the fix needs a new or upgraded dependency, check what is actually published (`npm view <pkg> version`) before it reaches the issue.

## Checkpoint — is this still one work issue?

`spec-writing.md` → _Checkpoint — is this still one work issue?_

## Step 4 — Draft and post the issue

Once we've agreed, post it with `gh issue create`.

**Issue metadata:**

- Title: `fix: <concise defect description>` (imperative, no trailing period)
- Labels: the area and topical labels that fit (`gh label list` — e.g. `canon`, `domain`, `area: web-pwa`, `flaky-test`, `breaking-change` when the fix changes a behavior contract). **Not** `bug`, and **not** a `priority:` label — those two facts live on the board as `Class` and `Queue`, and the labels that carried them are gone. **Not** `specced` either — that one is applied and removed by [`spec-shape.yml`](../../.github/workflows/spec-shape.yml) from the body itself, on every edit, not by whoever posted the issue.
- Board: `node scripts/board.mjs add <issue> --class Defect --queue <band> --size <S|M|L>`. `Recommended` means actionable **and proven** — regular user impact, a security risk, or dev friction actually being felt. A defect that is real but has never been triggered is `Low`, however alarming it reads. See [docs/issue-board.md](../../docs/issue-board.md).
  - **`gh` absent (a cloud session):** `spec-writing.md` → _Board and parent_, with `class: Defect`.
- Parent: `spec-writing.md` → _Board and parent_.

**Then name the session**, now that the issue has a number: `spec-writing.md` → _Session name_, with `DEFECT` as `<SESSION>` and `fix:` as `<prefix>`.

**Issue body — use exactly this structure.** `/salt-run` consumes these headings; the phase blocks are its scope contract.

---

## Observed vs Expected

**Observed:** [The symptom, concretely, with a real example. Written so a non-coder recognises it.]
**Expected:** [What should happen instead.]

## Reproduction

[Smallest reliable steps / command / test that shows the defect. Note frequency if intermittent.
**Every step is one you ran, or it is marked `(unverified — <what you inferred it from>)`.** A step
inferred from reading the code and written as fact is a premise the builder will discover is false,
and by then correcting it costs an issue instead of a line. Where a step offers alternatives ("rename
it, _or_ change the words"), each alternative is verified separately or marked separately — one of
#1518's two was false, which is how PR #1546 shipped an Expected it does not deliver.]

## Root Cause

[The mechanism, with `file:line` references and quoted code. If multiple bugs contribute, list each.
Written for a fresh agent: enough to find and understand the fault without re-investigating.]

## Blast Radius

[What else the same mechanism affects. Is production data already corrupted — and if so, what would
remediation require? What is the risk of NOT fixing.]

## Architecture Notes & Constraints

[Layer map references, packages touched, constraints from CLAUDE.md (purity, schema/back-compat).
**Behavior that must be preserved**, and the tests that encode it. What must NOT be done.
Written for a fresh agent with no prior context.]

## Open Questions / Decisions

[Every fork raised in Step 3, each as:

- **Decision:** what was chosen
- **Why:** the reasoning
- **Rejected:** the alternative(s) and why not
  Unresolved items stay listed as open questions, not silently assumed away. This is the audit trail.]

## Phases

[One `### Phase` block per phase.

Every phase must end verifiable — but that is a constraint on where a boundary may _fall_, not a reason
for one to exist. Phases are not free: each costs a context read, a validation pass, a gate run, a commit
and a handoff contract. **Most defects are one phase**: the fix plus the regression test that proves it,
landing together. That is the default, not a compromise.

Split only where there is a reason to:

- **an unresolved fork** — the fix rests on something in Open Questions the user should judge first;
- **data remediation** — a migration or backfill is its own phase, and only if Step 3 chose to remediate;
- **a changed behavior contract** — docs or callers needing updating can be their own phase;
- **too large to validate as one diff** — a multi-bug fix the reviewer can't reliably judge in one pass; or
- **too large to build inside the budget** — a worker gets **90 minutes** per phase, to build, gate and push
  it; the CI wait at the boundary is the coordinator's, not part of the 90. A fix that cannot be built, gated
  and pushed inside that is two phases — which for a defect usually means the remediation is the one that splits off,
  not the fix and its regression test.

**A phase boundary is also a PR boundary**, so even a wide multi-bug fix never has to fit in one PR: `/salt-run`
cuts one where its diff ceiling is crossed with phases still unbuilt ([docs/issue-board.md](../../docs/issue-board.md)
→ `Size`). That is a reason not to merge two justified phases, never a reason to add one.

None of those apply? One phase.]

### Phase 1: [Name]

**Scope:** [What gets changed — precise, not vague]
**Verifiable outcome(s):** [What proves it is fixed — ideally a regression test that fails before the change and passes after]
**Technical deliverables:** [Files, functions, tests]
**Context pointers:** [What Step 2 already learned about _this_ phase, so `/salt-run` reads rather than re-investigates:
`file:line` for the faulty mechanism and the tests around it, and the named rules and `docs/…` sections
that bound the fix. Written for an agent arriving with no context — thin here buys a fresh Explore sweep
there, re-tracing a root cause you already found.]
**Must not touch:** [Explicitly out of scope; the preserved behavior. Every entry is a DECISION — something we chose not to do, which binds the builder and the reviewer. Never park an assumption here ("this path already works, so it needs no change"): that is a premise, it belongs in Architecture Notes & Constraints marked `(unverified)` if you did not check it, and `/salt-run` corrects a falsified premise in place rather than deferring it.]

### Phase 2: [Name]

**Scope:** [...]
**Verifiable outcome(s):** [...]
**Technical deliverables:** [...]
**Context pointers:** [...]
**Must not touch:** [...]

[...continue through Phase N...]

## Definition of Done

[Checkable acceptance criteria: the defect no longer reproduces; a regression test guards it;
preserved behavior stays green; no schema/data regressions.]
---

## Step 5 — Verify the issue is runnable

`/salt-run` consumes this issue by exact heading, and nothing else checks that coupling. Read the posted body
back with `gh issue view <n>` and confirm the top-level headings are spelled exactly as above, that every
phase block carries all five fields, and that the paths in **Context pointers** actually exist — check
them. A `file:line` written from memory is worse than no pointer, because `/salt-run` will trust it and go
re-investigate a root cause you already found. The headings and the phase fields are checked mechanically, by the same code that decides the label — `spec-writing.md` → _Checking the posted body_.

Fix anything wrong with `gh issue edit`.

Then share the issue URL and ask me to confirm the **Root Cause and Fix Approach** before any implementation starts.
