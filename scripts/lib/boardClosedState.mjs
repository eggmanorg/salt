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
