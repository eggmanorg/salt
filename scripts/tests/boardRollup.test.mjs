import { describe, expect, it } from 'vitest';

import { rollupTargets, taskLines, tickTask, verdict } from '../lib/boardRollup.mjs';

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

  // A LEDGER CLOSES ON ITS OWN RECORD (#1606). It used to be refused outright,
  // "closed by hand", which in practice meant never: #1466, #1497 and #1565 sat
  // finished and open. Its done-ness is its run-set plus any `## Sweep` lines.
  describe('a campaign ledger', () => {
    const title = 'campaign: board fixes (#1587 #1588 #1589 #1590)';
    // #1466/#1497/#1565's real shape: no task lines at all outside the fence.
    const plain = ['## Plan', '```', '- [ ] template line', '```', '## Status', '| a |'].join('\n');

    it('closes with nothing beneath, its run-set closed and no task lines', () => {
      expect(verdict({ title, body: plain, openBeneath: closed, openRunSet: [] })).toEqual({
        action: 'close',
        items: 0,
      });
    });

    it('closes when every `## Sweep` line is ticked', () => {
      const body = `${plain}\n## Sweep\n- [x] a stale comment (#1598)`;
      expect(verdict({ title, body, openBeneath: closed, openRunSet: [] })).toEqual({
        action: 'close',
        items: 1,
      });
    });

    // THE PARKED CASE. A parked run-set issue is never attached beneath the
    // ledger, so only the title can hold the ledger open for it.
    it('waits on an open run-set issue, naming it', () => {
      const v = verdict({ title, body: plain, openBeneath: closed, openRunSet: [1590, 1588] });
      expect(v).toEqual({ action: 'wait', open: [1588, 1590] });
    });

    it('waits on open work beneath it before asking about the run-set', () => {
      const v = verdict({ title, body: plain, openBeneath: [1599], openRunSet: [1590] });
      expect(v).toEqual({ action: 'wait', open: [1599] });
    });

    it('nudges on an unticked `## Sweep` line', () => {
      const body = `${plain}\n## Sweep\n- [ ] a stale comment`;
      const v = verdict({ title, body, openBeneath: closed, openRunSet: [] });
      expect(v).toMatchObject({ action: 'nudge', why: '1 item still unticked' });
    });

    it('nudges rather than closing when its title names no run-set', () => {
      const v = verdict({ title: 'campaign: x', body: plain, openBeneath: closed, openRunSet: [] });
      expect(v).toMatchObject({ action: 'nudge', why: 'its title names no run-set' });
    });

    // Omitted, a parked campaign's ledger would read as "nothing parked" and
    // close — the same silent-wrong-closure shape the openBeneath guard refuses.
    it('throws rather than reading a missing openRunSet as "nothing parked"', () => {
      expect(() => verdict({ title, body: plain, openBeneath: closed })).toThrow(/openRunSet/);
    });

    it('does not demand openRunSet of anything that is not a ledger', () => {
      const v = verdict({ title: 'campaign follow-ups: x', body: '- [x] a', openBeneath: closed });
      expect(v).toEqual({ action: 'close', items: 1 });
    });
  });

  it('says one item singular', () => {
    const v = verdict({ title: 'campaign follow-ups: x', body: '- [ ] a', openBeneath: closed });
    expect(v.why).toBe('1 item still unticked');
  });
});

describe('rollupTargets', () => {
  const ledger = (number, title, state = 'OPEN') => ({ number, title, state });

  it('is the open sub-issue parent, then every open ledger naming the child', () => {
    const t = rollupTargets(1588, {
      parent: { number: 1586, state: 'OPEN' },
      ledgers: [
        ledger(1593, 'campaign: a (#1587 #1588)'),
        ledger(1600, 'campaign: b (#1500)'),
        ledger(1601, 'campaign: c (+#1588)'),
      ],
    });
    expect(t).toEqual([1586, 1593, 1601]);
  });

  it('lists an issue that is both the parent and a ledger naming the child once', () => {
    const l = ledger(1593, 'campaign: a (#1588)');
    expect(rollupTargets(1588, { parent: l, ledgers: [l] })).toEqual([1593]);
  });

  it('never targets a closed ledger or a closed parent', () => {
    const t = rollupTargets(1588, {
      parent: { number: 1586, state: 'CLOSED' },
      ledgers: [ledger(1593, 'campaign: a (#1588)', 'CLOSED')],
    });
    expect(t).toEqual([]);
  });

  // The search that feeds this matches words, not prefixes, so a follow-ups
  // issue naming the child can reach it. `isLedger` is the test, not the search.
  it('ignores a campaign follow-ups issue whose title names the child', () => {
    const t = rollupTargets(1588, {
      parent: null,
      ledgers: [ledger(1599, 'campaign follow-ups: a (#1588)')],
    });
    expect(t).toEqual([]);
  });

  it('matches the child exactly, not as a prefix', () => {
    const t = rollupTargets(158, { parent: null, ledgers: [ledger(1593, 'campaign: a (#1588)')] });
    expect(t).toEqual([]);
  });
});
