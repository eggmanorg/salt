// salt-campaign.md's queue-eligibility rule, as a function.
//
// The rule is stated in prose in `.claude/commands/salt-campaign.md` ("A branch is
// queue-eligible when: PR out of draft, review closed with no blocking findings
// outstanding...") and used to be enforced by nothing - the defect class
// CLAUDE.md Rule 12 exists for. It now has exactly one implementation, here,
// and two callers: `scripts/campaign-land.mjs`, which is how a campaign lands a
// branch, and the `gh pr merge` PreToolUse hook, which shells out to that
// script's `--check` mode for anything typed by hand.
//
// Kept apart from the IO so the rule can be tested against fixtures without a
// network, matching how every other guard under `scripts/` is split.

/**
 * Split a review body into its `## <severity>` sections. salt-campaign.md's reviewer
 * posts `## Blocking` / `## Should-fix` / `## Notes`; a body with no headings at
 * all cannot be counted and is reported as such rather than guessed at.
 */
export function reviewSections(body) {
  return body
    .split(/^##\s+/m)
    .slice(1)
    .map((s) => {
      const i = s.indexOf('\n');
      return {
        heading: (i < 0 ? s : s.slice(0, i)).trim(),
        body: (i < 0 ? '' : s.slice(i)).trim(),
      };
    });
}

/**
 * Does the `## Blocking` section name anything? A stub ("None", "n/a") and a
 * heading with nothing under it both mean no. The length floor is what stops a
 * one-word placeholder reading as a finding.
 */
export function hasBlockingFindings(sections) {
  const blk = sections.find((s) => /^blocking\b/i.test(s.heading));
  return !!blk && blk.body.length > 20 && !/^(none|n\/a|no blocking|nothing)\b/i.test(blk.body);
}

/**
 * Judge one PR against the rule.
 *
 * `pr` is the parsed output of
 * `gh pr view <n> --json isDraft,state,reviews,commits,statusCheckRollup,headRefName`.
 *
 * Returns `{ verdict, reason }` where verdict is:
 *   - `allow` — every condition positively verified; also carries `head` and
 *     `hasBlocking`.
 *   - `deny`  — a condition is definitely not met.
 *   - `ask`   — it cannot be determined from what GitHub returned. Never treat
 *     `ask` as a pass: the whole point is that ambiguity does not merge.
 *
 * `adjudicated` is salt-campaign.md's own escape hatch, not a loosening of the rule:
 * a blocking finding the coordinator judges safe to ship may merge, but only
 * once it has a filed issue number, which the caller must have confirmed open.
 * Without one, an outstanding blocking finding denies.
 */
export function judgePr(pr, { adjudicated = null } = {}) {
  if (pr.isDraft) {
    return {
      verdict: 'deny',
      reason:
        'still a draft; salt-campaign.md requires a PR out of draft before it is queue-eligible',
    };
  }
  if (pr.state !== 'OPEN') {
    return { verdict: 'ask', reason: `is ${pr.state}, not open` };
  }

  const failing = (pr.statusCheckRollup ?? [])
    .filter((c) => c.conclusion === 'FAILURE')
    .map((c) => c.name);
  if (failing.length) {
    return { verdict: 'deny', reason: `has failing checks: ${failing.join(', ')}` };
  }

  const reviews = pr.reviews ?? [];
  if (!reviews.length) {
    return {
      verdict: 'deny',
      reason:
        'has no review; salt-campaign.md requires an adversarial review before a branch is queue-eligible',
    };
  }

  const latest = reviews[reviews.length - 1];
  const body = latest?.body ?? '';
  if (!body.trim()) {
    return {
      verdict: 'ask',
      reason: 'the latest review has an empty body, so its findings cannot be read',
    };
  }

  const sections = reviewSections(body);
  if (!sections.length) {
    return {
      verdict: 'ask',
      reason: 'the latest review has no severity headings, so blocking findings cannot be counted',
    };
  }

  const hasBlocking = hasBlockingFindings(sections);
  if (hasBlocking) {
    const reviewedAt = Date.parse(latest.submittedAt ?? '');
    const lastCommit = pr.commits?.[pr.commits.length - 1]?.committedDate ?? '';
    const lastCommitAt = Date.parse(lastCommit);
    if (!Number.isFinite(reviewedAt) || !Number.isFinite(lastCommitAt)) {
      return {
        verdict: 'ask',
        reason:
          'has blocking findings and the timestamps needed to check whether they were addressed are unreadable',
      };
    }
    const addressed = lastCommitAt > reviewedAt;
    if (!addressed && !adjudicated) {
      return {
        verdict: 'deny',
        reason: `the review lists blocking findings and nothing has been pushed since (review ${latest.submittedAt}, last commit ${lastCommit}). Address them and push, or adjudicate them shippable and file the follow-up issue salt-campaign.md requires`,
      };
    }
    if (!addressed) {
      return {
        verdict: 'allow',
        head: pr.headRefName,
        hasBlocking: true,
        reason: `out of draft, no failing checks, reviewed; blocking findings adjudicated shippable against filed issue #${adjudicated}`,
      };
    }
  }

  return {
    verdict: 'allow',
    head: pr.headRefName,
    hasBlocking,
    reason: `out of draft, no failing checks, reviewed${
      hasBlocking ? ', blocking findings addressed by later commits' : ' with no blocking findings'
    }`,
  };
}
