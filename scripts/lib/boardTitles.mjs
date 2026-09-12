// Two title predicates `scripts/board.mjs check` decides on, extracted so they
// can be tested. Neither is a naming convention this file invented: both prefixes
// were already load-bearing elsewhere, which is exactly why they are checkable.

/**
 * A `/salt-campaign` ledger — the tracking issue that command opens so a fresh session
 * can resume, and the parent it hangs its own filings off. It is not work: no
 * `Queue`, no `Class`, closed by hand rather than through a PR, and GitHub's own
 * "add item to project" workflow puts it on the board regardless. `check` skips
 * it in the untriaged rule and the closed-at-a-shipping-status rule, or every
 * campaign that ever ran would sit in its output forever.
 *
 * The prefix is the test because `/salt-campaign` already resumes by searching for it
 * (`.claude/commands/salt-campaign.md` → Setup).
 *
 * `campaign follow-ups:` MUST NOT match. That issue is ordinary work and is
 * triaged like any — and it is one character class away from being exempted
 * here, which would quietly defeat the untriaged rule for the single kind of
 * issue an agent files most often.
 */
export const isLedger = (title) => /^campaign:/i.test(title ?? '');

/**
 * An epic — a container that must sit in the `Epic` band so it never competes
 * for sequence with the work it holds. See docs/issue-board.md.
 *
 * This used to be "has sub-issues", and that was wrong: a parent link is the
 * ordinary way to group an issue with the work it came out of, so #1122 and
 * #1202 were failing the check while correctly sitting in a work band. Every
 * epic this repo has had titles itself `epic:` (#778, #894, #913, #941, #1129).
 */
export const isEpicTitle = (title) => /^epic:/i.test(title ?? '');

/**
 * The issues a campaign dispatched, read out of its ledger's own title —
 * `campaign: <slug> (#a #b #c)`.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied (CLAUDE.md rule 12).
 * This is the DISPATCHED set, not everything the campaign touched. An issue
 * added to a campaign mid-run without a title edit is invisible here, and so is
 * anything the campaign filed along the way. The title is what `/salt-campaign`'s
 * own resume search already relies on, which is why it is the checkable thing —
 * but the rule built on it is "every issue the ledger's TITLE names", and it
 * must never be described as "every issue the campaign ran".
 *
 * Every `#N` counts, wherever it sits: #1009's live title is
 * `campaign: overnight next-5 sweep (#995 #1006 #1007 +#985)`, and that `+#985`
 * is a run-set member like any other.
 */
export const ledgerRunSet = (title) =>
  [...String(title ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/**
 * The parent a ledger should hang off, or `null` for "leave it a root".
 *
 * A sub-issue link is a strict tree — one parent, never two — so an issue sits
 * under its epic or under a ledger, and the choice was made in favour of the
 * epic keeping its work. Attaching the LEDGER upward is what buys reachability
 * instead: the epic keeps counting the same work issues and gains one node
 * whose subtree holds every follow-up, re-spec and mid-run defect the campaign
 * produced. Without it, #1269 hung off #1266, #1266 hung off nothing, and an
 * epic that looked finished was not.
 *
 * `null` — no shared parent — is a correct outcome, not a missing one. A
 * campaign over four unrelated issues belongs to nothing in particular, and
 * picking the first or the majority would fabricate a relationship the work
 * does not have. It is also what an unparseable title and an empty run-set
 * produce, both of which should pass rather than fail.
 *
 * `parentOf` is `issue number → parent number | null`. A run-set member missing
 * from it counts as unparented, which fails safe: the ledger stays a root.
 */
export function ledgerShouldAttachTo(runSet, parentOf) {
  if (!runSet.length) return null;
  const parents = runSet.map((n) => parentOf.get(n) ?? null);
  const [first] = parents;
  if (first === null) return null;
  return parents.every((p) => p === first) ? first : null;
}
