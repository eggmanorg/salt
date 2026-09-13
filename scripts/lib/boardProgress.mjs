// "Work has started on this" — the half of `In progress` no branch ever proves.
//
// `board-status.yml` moves an issue whenever an EVENT already proves the move,
// and until now `In progress` had no event at all: `/salt-run` set it by hand
// when it cut a worktree, and everything else that starts work set nothing. Two
// kinds of issue fell straight through that gap and sat at `Triage` while being
// actively worked:
//
//   A CAMPAIGN LEDGER is in progress from the moment it exists. `/salt-campaign`
//   opens one to BE the running state of a campaign, edits it on every
//   transition, and closes it when the campaign finishes — there is no moment in
//   its life when it is waiting rather than running. Its exemption from board
//   fields is `Queue` and `Class` (it is not work and must not sit in a work
//   queue); `Status` was never part of that, which `boardTitles.mjs` already
//   says for the closed case.
//
//   A MULTI-ITEM ISSUE — a `campaign follow-ups:` list, a spec with phases —
//   starts when its first box is ticked. Nobody cuts a branch for "the issue";
//   agents land its items one at a time, and the tick is the durable record that
//   one of them did. #1335 had an item ticked and a body section headed
//   "re-checked against main" while the board still showed it untouched.
//
// WHAT THIS DOES NOT SEE, stated rather than implied (CLAUDE.md rule 12). A tick
// is evidence of work, never of ALL the work: nothing here can tell a
// half-finished issue from a finished one, and nothing here moves an issue
// backwards. This only ever answers "may this item be promoted to `In progress`
// from a pre-work status", so an issue already at `In review` or beyond is left
// exactly where the PR events put it.

import { isLedger } from './boardTitles.mjs';

/**
 * The statuses that mean "work has not started". Promotion is only ever FROM
 * one of these — `null` is an item GitHub's own workflow added and nobody has
 * triaged, and the rest is the pipeline before a branch exists. Anything past
 * `Todo` is a fact a `pull_request` event established, and a body edit must
 * never overwrite one.
 */
export const BEFORE_WORK = new Set([null, 'Triage', 'Todo']);

/**
 * Does this body carry a ticked task-list item?
 *
 * Fenced blocks do not count: an issue about markdown, or one quoting a body it
 * is proposing, contains `- [x]` without anything having been done — and
 * `/salt-campaign`'s own ledger template is a fenced block of exactly that
 * shape. An unterminated fence swallows the rest of the body rather than
 * leaking it, which is the safe direction: a truncated paste is precisely where
 * a stray tick sits.
 *
 * GitHub's own renderer requires the marker to open the line and be followed by
 * whitespace, and so does this: `[x]` mid-sentence is prose.
 */
export function hasTickedTask(body) {
  let fenced = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^[ \t]*[-*+][ \t]+\[[xX]\](?=[ \t]|$)/.test(line)) return true;
  }
  return false;
}

/**
 * Why this item should move to `In progress`, or `null` for "leave it alone".
 *
 * Returning the REASON rather than a boolean is what makes a no-op legible:
 * `board.mjs start` prints one line either way, so a run that moved nothing says
 * which of the three guards stopped it instead of looking like a lost write.
 *
 * `status` is the board's Status name or `null` for unset; `state` is the
 * issue's own `OPEN`/`CLOSED`.
 */
export function startReason({ title, state, status, body }) {
  if (state !== 'OPEN') return null;
  if (!BEFORE_WORK.has(status ?? null)) return null;
  if (isLedger(title)) return 'a campaign ledger is in progress from the moment it opens';
  if (hasTickedTask(body)) return 'a task on it is ticked';
  return null;
}
