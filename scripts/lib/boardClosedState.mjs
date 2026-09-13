import { isHandClosed, isLedger } from './boardTitles.mjs';

/**
 * What `board.mjs check` should say about one CLOSED board item.
 *
 * This is the closed-at-a-shipping-status rule, extracted as a pure function of
 * the item so that every branch is testable without the live org project. It is
 * not a refactor for tidiness: the rule now has five outcomes where it had two,
 * and CLAUDE.md rule 12 wants each of them pinned by a test rather than asserted
 * in a comment. The live board can only ever exercise whichever branches
 * today's data happens to hit.
 *
 * A closed issue is NOT by itself stale. An issue closes the moment its PR
 * merges, and it then has to STAY on the board at `Merged` — that is exactly the
 * set `board.mjs release` walks to find what a production deploy made live. What
 * is wrong is a closed issue that never reached the merge states AND was
 * supposed to get there through a PR.
 *
 * `level` is one of:
 *
 * - `'ok'`     — nothing to print.
 * - `'note'`   — prints, does not fail. Either there is nothing to do, or the
 *                something is a one-off tidy-up rather than a broken mechanism.
 * - `'failure'`— `check` exits 1.
 *
 * THE NOTE/FAILURE LINE IS THE WHOLE POINT OF THIS FILE. `check` spent weeks
 * exiting 1 on every run with eleven expected lines in it, which is the same as
 * having no check at all: the twelfth, real failure had nowhere to be seen. A
 * failure here means a MECHANISM is broken and code or automation has to change.
 * Everything a human could simply tidy away is a note.
 */
export function closedItemVerdict(item) {
  const status = item.status ?? null;

  if (status === 'Released') {
    return {
      level: 'note',
      message: `#${item.number} is Released — safe to remove from the board`,
    };
  }
  if (status === 'Merged') return { level: 'ok', message: null };

  // THE ITEM ARRIVED AFTER THE ISSUE HAD ALREADY CLOSED, so nothing the board
  // automates could ever have moved it. Attaching a closed issue as a sub-issue
  // makes GitHub's "Auto-add sub-issues to project" workflow add it with every
  // field empty, and the rule then demanded it reach `Merged` — for #1123 that
  // was flatly wrong: its PR merged 13 days before its board item existed, and
  // `board.mjs pr` correctly did nothing because there was nothing to move.
  //
  // This branch comes FIRST among the exemptions because it is the only correct
  // explanation for an item like that, whatever its title or close reason says.
  //
  // STRICTLY AFTER, and the boundary matters (CLAUDE.md rule 12). An item
  // created in the same second as the close — or before it — is NOT exempt and
  // still goes through the rules below. Equality is the ambiguous case, and it
  // falls toward the rule firing, which is the visible direction. A missing
  // timestamp on either side is likewise not exempt.
  if (item.closedAt && item.createdAt && item.createdAt > item.closedAt) {
    return {
      level: 'note',
      message: `#${item.number} was added to the board after it had already closed (item ${item.createdAt}, closed ${item.closedAt}) — a parent link auto-added it, so no PR could ever have moved it; take it off the board or set its Status by hand`,
    };
  }

  // A NOT_PLANNED close — won't-fix, superseded, duplicate — is a different
  // thing, and for weeks the rule could not say so: it told you the issue's PR
  // was missing a `Closes #N` when there was never going to be a PR at all.
  // Nothing will ever ship it, so reaching `Merged` is not the remedy and
  // demanding it is incoherent; leaving the board is.
  //
  // A NOTE rather than a failure, chosen deliberately (2026-09-13, Daniel). The
  // alternative — failing with honest wording — keeps `check` red until someone
  // clears the board by hand, which is the cry-wolf problem this whole change
  // exists to end, wearing better words. `Released` is handled the same way for
  // the same reason.
  //
  // IT TAKES GITHUB'S WORD FOR IT, which is the claim's real boundary (CLAUDE.md
  // rule 12). `stateReason` is whatever the person closing the issue picked, so
  // work abandoned under "Close as completed" reads as `COMPLETED` here and
  // still fails. That is the safe direction: the rule fires and the output says
  // so, rather than a mislabelled close buying a permanent exemption.
  if (item.stateReason === 'NOT_PLANNED') {
    return {
      level: 'note',
      message: `#${item.number} was closed as not planned at Status="${status ?? 'unset'}" — nothing is going to ship it, so take it off the board`,
    };
  }

  // A ledger has no PR either, but unlike the kinds `isHandClosed` names it is
  // not exempt — it DOES ship, and `ledgerFullyReleased` is how it gets promoted
  // without one. Leaving it out of this rule cost 19 closed ledgers sitting at
  // no Status at once; see `isLedger`.
  if (isLedger(item.title)) {
    return {
      level: 'failure',
      message: `#${item.number} is a closed campaign ledger at Status="${status ?? 'unset'}" — a ledger has no PR, so set it by hand from its run-set: \`board.mjs set ${item.number} --status Merged\` (or Released if every issue its title names is already Released)`,
    };
  }

  if (isHandClosed(item.title)) {
    return {
      level: 'note',
      message: `#${item.number} closes by hand and has no PR, so it sits at Status="${status ?? 'unset'}" — set it from the work it covers with \`board.mjs set ${item.number} --status Merged\`, or take it off the board`,
    };
  }

  return {
    level: 'failure',
    message: `#${item.number} is closed at Status="${status ?? 'unset'}" — it never reached Merged, so either it was closed without shipping (remove it) or its PR had no "Closes #${item.number}"`,
  };
}

/**
 * What `board.mjs pr` should say about a `Closes #N` target that is NOT on the
 * board — the other half of Cause D, and a hole that looked exactly like a
 * green run.
 *
 * `cmdPr` used to print `#N is not on the board — skipped` and exit 0 for every
 * absent target. That is right for one case and silently wrong for the other,
 * and the two were indistinguishable:
 *
 * - the issue had ALREADY CLOSED before this PR existed — a back-reference to
 *   finished work, of the kind `campaign follow-ups:` bodies are full of. There
 *   is genuinely nothing to move, and saying so is correct.
 * - anything else — the issue is live work, its PR is shipping it, and the board
 *   has never heard of it. `board-status.yml` then reported success having moved
 *   nothing, which is how #1123 shipped without the board ever knowing.
 *
 * THE TEST IS THE PR'S OWN CREATION TIME, not the merge. A PR that closes an
 * issue necessarily opens before that issue closes, so `closedAt < prCreatedAt`
 * can only mean the close came from somewhere else — which is exactly the
 * back-reference case. An issue with no `closedAt` is open, and an open issue
 * whose PR is in flight belongs on the board, so it fails.
 *
 * WHAT THIS DOES NOT CATCH: an issue closed by hand a minute before its own PR
 * was raised reads as a back-reference and is let through. Nobody works that
 * way, but the claim is "closed before the PR existed", never "closed by someone
 * else".
 */
export function absentTargetVerdict({ number, closedAt, prNumber, prCreatedAt }) {
  if (closedAt && prCreatedAt && closedAt < prCreatedAt) {
    return {
      level: 'note',
      message: `#${number} is not on the board, and closed before PR #${prNumber} was raised — a back-reference to finished work, nothing to move`,
    };
  }
  return {
    level: 'failure',
    message: `#${number} is live and NOT on the board, so PR #${prNumber} is shipping work nothing triaged — add it with \`board.mjs add ${number} --queue <band>\``,
  };
}
