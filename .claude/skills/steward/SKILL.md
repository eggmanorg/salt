---
name: steward
description: How proactive to be on a PR this repo's sessions opened — what to act on, and when to stop scheduling check-ins. Read on every PR activity event and every self check-in.
---

# PR stewardship

Read on PR activity events and self check-ins for PRs opened from this repo.
It adjusts **cadence only**. Everything the harness contract says about _what_
to act on — merge conflicts, red CI, review comments, the Claude Approvals
rows, never skipping a test, never merging — stands unchanged.

## Act on events; do not poll for a merge

A PR here is handed to Daniel to review and merge (`/salt-run` step 9, and the same
for `/salt-campaign` and `/salt-defect`). The merge itself is not a state worth waiting
on: nothing you would do differs between "open, green, awaiting review" and
"merged".

So once the PR's current head is **green, mergeable, and out of draft**, with
no open review thread left for you to answer:

- **Stay subscribed.** `subscribe_pr_activity` is push-based and costs nothing
  while idle. Do not `unsubscribe_pr_activity` — a review comment or a
  base-branch conflict arriving tomorrow is still yours.
- **Stop re-arming the check-in.** Do not schedule another `send_later`. End
  the turn; an event will wake the session if there is anything to do.
- **Say nothing.** No "still awaiting review" comment on the PR, no message
  here. The handoff already reported done.

## When the timer earns its place again

Re-arm a check-in only while one of these holds, and drop it as soon as it
clears:

- The head is **red or conflicted** — the drive-to-green loop owns it, and
  webhooks do not reliably announce a CI run turning green. Keep checking
  until it is green, per the harness contract.
- You are waiting on something **external you cannot be woken by** — a
  base-branch fix landing, a re-run you triggered, a blocker you reported.
- The PR is **still draft** and a phase is mid-flight.

## The trade this accepts

Webhook delivery for CI success and merge-state transitions is best-effort, so
dropping the timer on a green PR means a problem that surfaces without an event
— a required check that reports late, a conflict introduced by someone else's
merge — may sit unnoticed until Daniel next looks at the PR. That is the
intended trade: a human is reviewing this PR anyway, and hourly wake-ups on a
finished PR cost more than that delay does.

It is **not** a licence to leave a red PR alone. A failure you have seen is
work now, at every event, exactly as the harness contract says.
