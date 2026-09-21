import { describe, expect, it } from 'vitest';

import { taskLines, tickTask, verdict } from '../lib/boardRollup.mjs';

// #1335's real shape: lines citing the campaign's PR, not the issues that
// actioned them. It is the body this deliberately cannot tick, and the reason
// `verdict` has a `nudge` arm at all.
const BODY_1335 = [
  'These came out of the review rounds in campaign #1328.',
  '',
  '- [ ] (#1334) `BatchCookPage` still renders a skipped stage’s stale window.',
  '- [ ] (#1329) Percentage creep when a multi-member basis misses 100.',
  '- [x] Process: the worker brief should forbid ending a turn mid-command.',
].join('\n');

describe('taskLines', () => {
  it('reads every task item with its ticked state, in order', () => {
    expect(taskLines(BODY_1335).map((t) => t.ticked)).toEqual([false, false, true]);
  });

  it('ignores a checklist inside a fenced block', () => {
    // /salt-campaign's ledger template is a fenced block of exactly this shape.
    const body = ['```', '- [ ] template line', '```', '- [ ] a real one'].join('\n');
    expect(taskLines(body)).toHaveLength(1);
  });

  it('ignores a marker that does not open the line', () => {
    expect(taskLines('we will tick - [x] when it lands')).toHaveLength(0);
    expect(taskLines('- [x]no space, so not a task item')).toHaveLength(0);
  });
});

describe('tickTask', () => {
  const body = ['- [ ] the deck faults (#1365)', '- [ ] the percentage creep (#1364)'].join('\n');

  it('ticks the one line naming the closed issue and leaves the rest alone', () => {
    const out = tickTask(body, 1364);
    expect(out.body).toBe('- [ ] the deck faults (#1365)\n- [x] the percentage creep (#1364)');
    expect(out.text).toContain('#1364');
  });

  // Issues and PRs share one number sequence, so a line citing a PR can never
  // collide with the issue being rolled up — but a PREFIX can.
  it('does not treat #136 as a match for a line about #1364', () => {
    expect(tickTask(body, 136)).toBeNull();
    expect(tickTask('- [ ] about #21364', 1364)).toBeNull();
  });

  it('ticks nothing on a body whose lines name only the campaign PR', () => {
    expect(tickTask(BODY_1335, 1364)).toBeNull();
  });

  it('refuses to guess when two lines name the same issue', () => {
    expect(tickTask('- [ ] one #1364\n- [ ] two #1364', 1364)).toBeNull();
  });

  it('leaves an already-ticked line alone', () => {
    expect(tickTask('- [x] done (#1364)', 1364)).toBeNull();
  });
});

describe('verdict', () => {
  // Nothing open anywhere beneath the parent — what `openDescendants` returns
  // for a finished subtree, whatever its shape.
  const closed = [];

  it('waits while any sub-issue is still open', () => {
    const v = verdict({
      title: 'campaign follow-ups: x (#1328)',
      body: '- [x] a (#1364)',
      openBeneath: [1365],
    });
    expect(v).toEqual({ action: 'wait', open: [1365] });
  });

  // THE GRANDCHILD CASE. Before this, `verdict` filtered the parent's DIRECT
  // children, so a parent whose own children had all closed over an open
  // grandchild took the `close` arm — and `board-status.yml` fires this on
  // every `issues: closed`, so the automation re-created the exact state
  // `board.mjs check` now fails on. The caller hands down the whole subtree.
  it('waits on an open grandchild, not just an open child', () => {
    const v = verdict({
      title: 'campaign follow-ups: x (#1328)',
      body: '- [x] a (#1364)\n- [x] b (#1365)',
      openBeneath: [1529],
    });
    expect(v).toEqual({ action: 'wait', open: [1529] });
  });

  it('reports what is open in ascending order, whatever order the walk found it', () => {
    const v = verdict({ title: 'x', body: '- [x] a', openBeneath: [1529, 1488, 1493] });
    expect(v).toEqual({ action: 'wait', open: [1488, 1493, 1529] });
  });

  // THE ONLY MECHANICAL PART OF THE DEPTH RULE. Depth is the caller's to supply
  // and this function cannot verify it got a subtree rather than one level. What
  // it can refuse is a caller that did not update: left optional, the old
  // `subIssues:` call site would land `undefined`, read as nothing open, and
  // take the CLOSE arm — silent wrong closures instead of a stack trace.
  it('throws rather than reading a missing openBeneath as "nothing is open"', () => {
    expect(() => verdict({ title: 'x', body: '- [x] a' })).toThrow(/openBeneath/);
    expect(() =>
      verdict({ title: 'x', body: '- [x] a', subIssues: [{ number: 1, state: 'OPEN' }] }),
    ).toThrow(/not the parent’s direct sub-issues/);
  });

  it('closes when every sub-issue is closed and every box is ticked', () => {
    const v = verdict({
      title: 'campaign follow-ups: x (#1328)',
      body: '- [x] a (#1364)\n- [x] b (#1365)',
      openBeneath: closed,
    });
    expect(v).toEqual({ action: 'close', items: 2 });
  });

  // The #1335 case: children all closed, body still claiming open work. Closing
  // here would assert something nobody has.
  it('nudges rather than closing while a line is unticked', () => {
    const v = verdict({ title: 'campaign follow-ups: x', body: BODY_1335, openBeneath: closed });
    expect(v.action).toBe('nudge');
    expect(v.why).toBe('2 items still unticked');
    expect(v.unticked).toHaveLength(2);
  });

  it('nudges a parent that states no checklist of its own', () => {
    const v = verdict({ title: 'epic: bread', body: 'prose only', openBeneath: closed });
    expect(v).toMatchObject({ action: 'nudge', why: 'it states no checklist of its own' });
  });

  // A ledger closes by hand: a parked branch is unfinished business its
  // children cannot show, and since #1534 Finish leaves it open anyway.
  it('never closes a campaign ledger', () => {
    const v = verdict({ title: 'campaign: x (#1)', body: '- [x] all done', openBeneath: closed });
    expect(v).toMatchObject({ action: 'nudge', why: 'a campaign ledger closes by hand' });
  });

  it('says one item singular', () => {
    const v = verdict({ title: 'campaign follow-ups: x', body: '- [ ] a', openBeneath: closed });
    expect(v.why).toBe('1 item still unticked');
  });
});
