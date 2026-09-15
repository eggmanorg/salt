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
  const closed = [
    { number: 1364, state: 'CLOSED' },
    { number: 1365, state: 'CLOSED' },
  ];

  it('waits while any sub-issue is still open', () => {
    const v = verdict({
      title: 'campaign follow-ups: x (#1328)',
      body: '- [x] a (#1364)',
      subIssues: [{ number: 1365, state: 'OPEN' }, ...closed],
    });
    expect(v).toEqual({ action: 'wait', open: [1365] });
  });

  it('closes when every sub-issue is closed and every box is ticked', () => {
    const v = verdict({
      title: 'campaign follow-ups: x (#1328)',
      body: '- [x] a (#1364)\n- [x] b (#1365)',
      subIssues: closed,
    });
    expect(v).toEqual({ action: 'close', items: 2 });
  });

  // The #1335 case: children all closed, body still claiming open work. Closing
  // here would assert something nobody has.
  it('nudges rather than closing while a line is unticked', () => {
    const v = verdict({ title: 'campaign follow-ups: x', body: BODY_1335, subIssues: closed });
    expect(v.action).toBe('nudge');
    expect(v.why).toBe('2 items still unticked');
    expect(v.unticked).toHaveLength(2);
  });

  it('nudges a parent that states no checklist of its own', () => {
    const v = verdict({ title: 'epic: bread', body: 'prose only', subIssues: closed });
    expect(v).toMatchObject({ action: 'nudge', why: 'it states no checklist of its own' });
  });

  // A ledger closes at Finish by hand: a parked branch is unfinished business
  // its children cannot show.
  it('never closes a campaign ledger', () => {
    const v = verdict({ title: 'campaign: x (#1)', body: '- [x] all done', subIssues: closed });
    expect(v).toMatchObject({ action: 'nudge', why: 'a campaign ledger closes by hand at Finish' });
  });

  it('says one item singular', () => {
    const v = verdict({ title: 'campaign follow-ups: x', body: '- [ ] a', subIssues: closed });
    expect(v.why).toBe('1 item still unticked');
  });
});
