import { describe, expect, it } from 'vitest';

import { hasTickedTask, startReason } from '../lib/boardProgress.mjs';

describe('hasTickedTask', () => {
  it('sees a ticked item in a follow-ups list', () => {
    // #1335's shape: five open items and one done.
    const body = [
      '- [ ] (#1334) `BatchCookPage` still renders a skipped stage’s stale window.',
      '- [x] Process: the worker brief should forbid ending a turn mid-command.',
    ].join('\n');
    expect(hasTickedTask(body)).toBe(true);
  });

  it('does not see a list where nothing has been done yet', () => {
    expect(hasTickedTask('- [ ] one\n- [ ] two')).toBe(false);
  });

  it('takes `*` and `+` bullets, indentation and a capital X', () => {
    expect(hasTickedTask('  * [X] nested and starred')).toBe(true);
    expect(hasTickedTask('+ [x] plus')).toBe(true);
  });

  // The marker has to open the line and be followed by whitespace, exactly as
  // GitHub's own renderer requires. Otherwise every issue DISCUSSING a checklist
  // reads as started.
  it('ignores a checkbox written mid-sentence', () => {
    expect(hasTickedTask('we should tick - [x] when it lands')).toBe(false);
    expect(hasTickedTask('- [x]no space, so not a task item')).toBe(false);
  });

  // /salt-campaign's ledger template is a fenced block, and a spec proposing a
  // checklist quotes one. Neither is work.
  it('ignores a tick inside a fenced block', () => {
    expect(hasTickedTask(['```', '- [x] a body this issue is proposing', '```'].join('\n'))).toBe(
      false,
    );
    expect(hasTickedTask(['~~~md', '- [x] tilde fence', '~~~'].join('\n'))).toBe(false);
  });

  it('counts a tick after a fence has closed', () => {
    expect(hasTickedTask(['```', '- [x] quoted', '```', '', '- [x] real'].join('\n'))).toBe(true);
  });

  // Failing safe: a truncated paste is exactly where a stray tick sits.
  it('treats an unterminated fence as swallowing the rest', () => {
    expect(hasTickedTask(['```', '- [x] quoted, and the fence never closes'].join('\n'))).toBe(
      false,
    );
  });

  it('survives a body that is missing', () => {
    expect(hasTickedTask(undefined)).toBe(false);
    expect(hasTickedTask(null)).toBe(false);
  });
});

describe('startReason', () => {
  const ledger = { title: 'campaign: batch cook deck faults (#1364 #1365)', state: 'OPEN' };

  it('starts a campaign ledger the moment it opens, body irrelevant', () => {
    expect(startReason({ ...ledger, status: 'Triage', body: '## Plan' })).toMatch(/ledger/);
    expect(startReason({ ...ledger, status: null, body: '' })).toMatch(/ledger/);
  });

  it('starts an issue whose first task has been ticked', () => {
    expect(
      startReason({
        title: 'campaign follow-ups: batch cook deck (#1328)',
        state: 'OPEN',
        status: 'Todo',
        body: '- [x] done\n- [ ] not',
      }),
    ).toMatch(/ticked/);
  });

  it('leaves an untouched issue alone', () => {
    expect(
      startReason({
        title: 'fix: something',
        state: 'OPEN',
        status: 'Todo',
        body: '- [ ] not yet',
      }),
    ).toBe(null);
  });

  // The guard that matters: this runs on EVERY body edit, for the life of the
  // issue. Without it, editing an issue whose PR is open drags it back out of
  // In review and the board contradicts an event GitHub itself observed.
  it('never moves an issue backwards from a status a PR event set', () => {
    for (const status of ['In progress', 'In review', 'Merged', 'Released']) {
      expect(startReason({ ...ledger, status, body: '- [x] done' })).toBe(null);
    }
  });

  it('never starts a closed issue', () => {
    expect(startReason({ ...ledger, state: 'CLOSED', status: 'Triage', body: '- [x] done' })).toBe(
      null,
    );
  });

  // `campaign follow-ups:` is ordinary work and is one character class away from
  // reading as a ledger — the same trap boardTitles.mjs guards.
  it('does not treat a follow-ups issue as a ledger', () => {
    expect(
      startReason({
        title: 'campaign follow-ups: formula yield agreement (#1328)',
        state: 'OPEN',
        status: 'Triage',
        body: 'no tasks here',
      }),
    ).toBe(null);
  });
});
