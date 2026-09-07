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
