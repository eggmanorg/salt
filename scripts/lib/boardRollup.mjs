// "Its last sub-issue just closed" — the half of a checklist issue's life that
// nothing owned.
//
// `/salt-campaign` files a `campaign follow-ups:` issue at Finish, attaches the
// issues that action its lines as sub-issues, and explicitly leaves it open
// ("the ledger closes, the follow-ups issue does not"). After that no command
// touches it again: `/salt-run` closes the issue it ran and never looks upward,
// and `board.mjs check` only reads Queue and Status. So a collector whose every
// item has shipped stays open, unticked, indefinitely — #1335 sat that way for
// two days with all three children closed, and #1370 was closed by hand with
// six boxes still unticked.
//
// WHAT THIS CANNOT SEE, stated rather than implied (CLAUDE.md rule 12).
//
//   A tick only ever follows a line that NAMES the issue that closed. #1335's
//   lines cited the campaign's PR (`(#1334)`) and the issues that actioned them
//   were recorded in a comment, so on that body this ticks nothing at all. That
//   is why `verdict` has a `nudge` arm rather than closing on sub-issue state
//   alone: an unticked line is a claim nobody has made, and guessing which line
//   a child actioned would tick the wrong one silently. The filing commands now
//   write the number into the line — see salt-campaign.md → Review — which is
//   what makes the `close` arm reachable for anything filed from here on.
//
//   Sub-issue state is not the whole of "done" either. #1335's item 6 shipped as
//   #1362, which was never attached as a sub-issue. A parent can therefore have
//   every sub-issue closed and still hold real work, which is exactly what the
//   unticked-line gate catches.
//
//   Nothing here ever un-ticks, re-opens, or closes a parent that states no
//   checklist of its own. An epic whose children all closed is a human's call.

import { isLedger } from './boardTitles.mjs';

/**
 * Every task-list line in a body, in order, as `{ index, ticked, text }`.
 *
 * Fenced blocks are skipped for the same reason `boardProgress.hasTickedTask`
 * skips them: `/salt-campaign`'s own templates are fenced blocks of exactly this
 * shape, and an issue quoting a checklist has not got one. An unterminated fence
 * swallows the rest of the body rather than leaking it — the safe direction,
 * since a truncated paste is precisely where a stray marker sits.
 *
 * The marker must open the line and be followed by whitespace or end-of-line,
 * as GitHub's own renderer requires.
 */
export function taskLines(body) {
  const out = [];
  let fenced = false;
  const lines = String(body ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const m = /^[ \t]*[-*+][ \t]+\[([ xX])\](?=[ \t]|$)/.exec(line);
    if (m) out.push({ index, ticked: m[1] !== ' ', text: line });
  });
  return out;
}

/**
 * Tick the one unticked line that names `#number`, or `null` for "no such line".
 *
 * `(?<!\d)#N(?!\d)` so `#136` does not match a line about `#1364`. Issues and
 * pull requests share one number sequence in a repo, so a line citing the
 * campaign's PR can never collide with the issue number being rolled up.
 *
 * Refuses to guess when two lines name the same issue: that is a body a human
 * wrote wrong, and ticking the first would hide it.
 */
export function tickTask(body, number) {
  const ref = new RegExp(`(?<!\\d)#${number}(?!\\d)`);
  const hits = taskLines(body).filter((t) => !t.ticked && ref.test(t.text));
  if (hits.length !== 1) return null;
  const [hit] = hits;
  const lines = String(body ?? '').split(/\r?\n/);
  lines[hit.index] = hit.text.replace(/\[ \]/, '[x]');
  return { body: lines.join('\n'), text: hit.text.trim() };
}

/**
 * What should happen to the parent now one of its children has closed.
 *
 * `wait`  — a sub-issue is still open. The common case, and silent.
 * `close` — every sub-issue closed and every box ticked. The issue's own record
 *           says it is finished, so finishing it invents nothing.
 * `nudge` — every sub-issue closed but the body still claims open work, or
 *           states no checklist at all. Says so on the issue and stops. A
 *           campaign ledger always lands here: it closes by hand at Finish
 *           because a parked branch is unfinished business its children cannot
 *           show.
 *
 * `subIssues` is `[{ number, state }]`; `state` is `OPEN`/`CLOSED`.
 */
export function verdict({ title, body, subIssues }) {
  const open = subIssues.filter((s) => s.state === 'OPEN');
  if (open.length) return { action: 'wait', open: open.map((s) => s.number) };

  const tasks = taskLines(body);
  const unticked = tasks.filter((t) => !t.ticked);

  if (isLedger(title))
    return { action: 'nudge', why: 'a campaign ledger closes by hand at Finish', unticked };
  if (!tasks.length) return { action: 'nudge', why: 'it states no checklist of its own', unticked };
  if (unticked.length)
    return {
      action: 'nudge',
      why: `${unticked.length} item${unticked.length === 1 ? '' : 's'} still unticked`,
      unticked,
    };
  return { action: 'close', items: tasks.length };
}

/** The hidden marker that makes the nudge idempotent across re-closes. */
export const NUDGE_MARKER = '<!-- board-rollup:nudge -->';
