// The campaign pool heartbeat's arithmetic (#1587): the lib with an injected
// clock, the prose it must agree with, and the CLI spawned for real.
//
// Part of this file reads salt-campaign.md rather than restating it: the
// parser is run over the ledger template's own example table, lifted from the
// command file, so a change to the template's shape goes red here rather than
// in a live campaign. The budget itself is flat since #1612 (one phase per
// dispatch); campaignBudget.test.mjs pins the prose's number and the absence of
// the old `min(360, …)` formula, and BUDGET_MINUTES below pins the code's.
//
// WHAT THIS DOES NOT PIN (CLAUDE.md rule 12): that a coordinator actually runs
// the script, or acts on its output. That is prose, and a prose pin in
// campaignBudget.test.mjs's style is the most any test can hold for it. The
// same holds for `--may-adopt` (#1614): the termination guard's answer is
// tested here, but nothing makes a coordinator ask it before adopting —
// campaignAgents.test.mjs holds only that salt-campaign.md still says to.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  adoptionVerdict,
  BUDGET_MINUTES,
  dispatchCells,
  formatHHMM,
  heartbeat,
  parseStatusTable,
  report,
} from '../lib/campaignHeartbeat.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const SCRIPT = path.join(here, '..', 'campaign-heartbeat.mjs');
const campaign = () => readFileSync(path.join(repo, '.claude/commands/salt-campaign.md'), 'utf8');

/** A local-time instant on a fixed day; the lib reads local getters, so this is TZ-proof. */
const at = (hhmm, day = 25) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, day, h, m, 0, 0);
};

const HEADER = '| Issue | Branch | PR | State | Worker | Note |\n|---|---|---|---|---|---|';
const ledger = (...rows) =>
  `## Plan\nOrder: x\n\n## Status\n${HEADER}\n${rows.join('\n')}\n\n## Sweep\n`;
const row = (issue, state, worker, note) => `| ${issue} | b | — | ${state} | ${worker} | ${note} |`;
const run = (at_, body) => heartbeat(parseStatusTable(body), at_);

describe('BUDGET_MINUTES', () => {
  it('is a flat 90 minutes per dispatch (#1612)', () => {
    expect(BUDGET_MINUTES).toBe(90);
  });

  it('agrees with the number salt-campaign.md hands the worker', () => {
    expect(campaign()).toContain(`**${BUDGET_MINUTES} minutes per dispatch**`);
  });
});

describe('dispatchCells', () => {
  it('prints the Worker time and the Note for the current clock', () => {
    expect(dispatchCells(3, at('09:14'))).toEqual({
      budget: 90,
      worker: '09:14',
      note: 'phase 3, budget to 10:44',
    });
  });

  it('writes an end-time past midnight as the bare wall-clock time', () => {
    expect(dispatchCells(2, at('23:30')).note).toBe('phase 2, budget to 01:00');
  });

  it('gives every phase the same budget', () => {
    expect(dispatchCells(1, at('08:00')).note).toBe('phase 1, budget to 09:30');
    expect(dispatchCells(7, at('08:00')).budget).toBe(90);
  });

  it.each([0, -1, 1.5, NaN])('refuses phase %s', (phase) => {
    expect(() => dispatchCells(phase, at('08:00'))).toThrow(/positive integer/);
  });
});

describe('the ledger template in salt-campaign.md', () => {
  // The fenced block holding `## Status`, lifted from the command file as is.
  const template = () => {
    const blocks = campaign()
      .split('```')
      .filter((_, i) => i % 2 === 1);
    const block = blocks.find((b) => /^## Status$/m.test(b));
    if (!block) throw new Error('no fenced ledger template with a "## Status" heading');
    return block;
  };

  it('parses, and its one dispatched row is the live pool', () => {
    const rows = parseStatusTable(template());
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const live = rows.filter((r) => r.state === 'dispatched');
    expect(live).toHaveLength(1);
    const verdict = heartbeat(rows, at('09:30'));
    expect(verdict.live).toBe(1);
    expect(verdict.breached).toEqual([]);
  });

  it('holds an example row whose cells are what --dispatch would have printed', () => {
    const [row_] = parseStatusTable(template()).filter((r) => r.state === 'dispatched');
    const time = /(\d\d:\d\d)\s*$/.exec(row_.worker)[1];
    const phase = Number(/^phase (\d+),/.exec(row_.note)[1]);
    const cells = dispatchCells(phase, at(time));
    expect(row_.worker.endsWith(`, ${cells.worker}`)).toBe(true);
    expect(row_.note).toBe(cells.note);
  });

  it('holds an adopted example row that parses and answers no (#1614)', () => {
    const rows = parseStatusTable(template());
    const adopted = rows.filter((r) => /\badopted\b/.test(r.issue));
    expect(adopted).toHaveLength(1);
    // Not `dispatched`, so the one-live-row assertion above still holds.
    expect(adopted[0].state).not.toBe('dispatched');
    const id = /#(\w+)/.exec(adopted[0].issue)[1];
    expect(adoptionVerdict(rows, id).adopt).toBe(false);
    expect(adoptionVerdict(rows, 'a').adopt).toBe(true);
  });
});

describe('parseStatusTable', () => {
  it('reads columns by header name, not position', () => {
    const body =
      '## Status\n| Note | Worker | State | Issue |\n|---|---|---|---|\n' +
      '| 2 phases, budget to 12:00 | agent a1, 09:00 | dispatched | #7 |\n';
    expect(parseStatusTable(body)).toMatchObject([
      { issue: '#7', state: 'dispatched', worker: 'agent a1, 09:00' },
    ]);
  });

  it('throws on a body with no ## Status heading', () => {
    expect(() => parseStatusTable('## Plan\nnothing')).toThrow(/no "## Status" heading/);
  });

  it('throws on a ## Status heading with no table', () => {
    expect(() => parseStatusTable('## Status\n\nprose only\n')).toThrow(/no table/);
  });

  it('throws when a column it reads is missing', () => {
    expect(() =>
      parseStatusTable('## Status\n| Issue | State |\n|---|---|\n| #1 | queued |'),
    ).toThrow(/"Worker", "Note"/);
  });
});

describe('heartbeat', () => {
  it('an empty pool: no deadline, nothing to sleep for', () => {
    const verdict = run(at('10:00'), ledger(row('#1', 'queued', '—', 'after #2')));
    expect(verdict).toEqual({ live: 0, earliest: null, sleepSeconds: null, breached: [] });
    expect(report(verdict)).toEqual({
      lines: ['LIVE 0', 'EARLIEST none', 'SLEEP none'],
      exitCode: 0,
    });
  });

  it('arms to the earliest end-time across several live rows', () => {
    const verdict = run(
      at('10:00'),
      ledger(
        row('#1', 'dispatched', 'agent a1, 09:40', 'phase 2, budget to 11:10'),
        row('#2', 'dispatched', 'agent a2, 09:00', 'phase 1, budget to 10:30'),
        row('#3', 'dispatched', 'agent a3, 09:50', 'phase 3, budget to 11:20'),
      ),
    );
    expect(verdict.live).toBe(3);
    expect(formatHHMM(verdict.earliest)).toBe('10:30');
    expect(verdict.sleepSeconds).toBe(30 * 60);
    expect(report(verdict)).toEqual({
      lines: ['LIVE 3', 'EARLIEST 10:30', 'SLEEP 1800'],
      exitCode: 0,
    });
  });

  it('ignores rows in every state but dispatched, however their cells look', () => {
    const verdict = run(
      at('10:00'),
      ledger(
        row('#1', 'merged', '—', ''),
        row('#2', 'PR open', 'agent old, 01:00', '2 phases, budget to 04:00'),
        row('#3', 'parked', 'garbage', 'garbage'),
        row('#5', 'CI wait', 'agent old2, 03:00', 'phase 1, budget to 04:30'),
        row('#4', 'dispatched', 'agent a4, 09:00', 'phase 2, budget to 10:30'),
      ),
    );
    expect(verdict.live).toBe(1);
    expect(formatHHMM(verdict.earliest)).toBe('10:30');
  });

  it('reads a retried row, whose Note carries more than the budget', () => {
    const verdict = run(
      at('10:00'),
      ledger(
        row('#5', 'dispatched', 'agent r2, 09:50', 'phase 2, budget to 11:20; retried: timeout'),
      ),
    );
    expect(formatHHMM(verdict.earliest)).toBe('11:20');
  });

  describe('breach is at the end-time, not after it', () => {
    const body = ledger(row('#9', 'dispatched', 'agent z, 10:30', 'phase 1, budget to 12:00'));

    it('one second before: no breach, sleep 1', () => {
      const verdict = run(new Date(at('12:00').getTime() - 1000), body);
      expect(verdict.breached).toEqual([]);
      expect(verdict.sleepSeconds).toBe(1);
    });

    it('at: breached, sleep 0, exit 1', () => {
      const verdict = run(at('12:00'), body);
      expect(verdict.breached).toHaveLength(1);
      expect(verdict.sleepSeconds).toBe(0);
      expect(report(verdict)).toEqual({
        lines: ['LIVE 1', 'EARLIEST 12:00', 'SLEEP 0', 'BREACHED #9 agent z, 10:30 ended 12:00'],
        exitCode: 1,
      });
    });

    it('after: still breached', () => {
      expect(run(at('13:30'), body).breached).toHaveLength(1);
    });
  });

  it('sleep is 0 when any row is breached, even with others still in budget', () => {
    const verdict = run(
      at('12:10'),
      ledger(
        row('#1', 'dispatched', 'agent a, 10:30', 'phase 1, budget to 12:00'),
        row('#2', 'dispatched', 'agent b, 12:05', 'phase 1, budget to 13:35'),
      ),
    );
    expect(verdict.sleepSeconds).toBe(0);
    expect(verdict.breached.map((b) => b.issue)).toEqual(['#1']);
  });

  describe('midnight rollover', () => {
    const body = ledger(row('#4', 'dispatched', 'agent n, 23:30', 'phase 4, budget to 01:00'));

    it('dispatched before midnight, checked before midnight: the end is tomorrow', () => {
      const verdict = run(at('23:45'), body);
      expect(verdict.breached).toEqual([]);
      expect(verdict.sleepSeconds).toBe(75 * 60);
      expect(verdict.earliest.getDate()).toBe(26);
    });

    it('dispatched before midnight, checked after: the dispatch was yesterday', () => {
      const verdict = run(at('00:30', 26), body);
      expect(verdict.breached).toEqual([]);
      expect(verdict.sleepSeconds).toBe(30 * 60);
    });

    it('and breaches once the post-midnight end passes', () => {
      expect(run(at('01:01', 26), body).breached).toHaveLength(1);
    });
  });

  describe('an unparseable live row is an error, never skipped', () => {
    it.each([
      ['no dispatch time in Worker', 'agent a1', '2 phases, budget to 12:00', /Worker/],
      ['no end-time in Note', 'agent a1, 09:00', '2 phases', /budget to HH:MM/],
      ['an impossible time', 'agent a1, 25:00', '2 phases, budget to 12:00', /Worker/],
    ])('%s', (_, worker, note, message) => {
      const body = ledger(
        row('#1', 'dispatched', 'agent ok, 09:00', 'phase 1, budget to 10:30'),
        row('#2', 'dispatched', worker, note),
      );
      expect(() => run(at('10:00'), body)).toThrow(message);
      expect(() => run(at('10:00'), body)).toThrow(/#2/);
    });
  });
});

describe('a retried row whose Note was appended rather than replaced (#1587 follow-up)', () => {
  it('throws when the Note holds more than one "budget to HH:MM"', () => {
    const body = ledger(
      row(
        '#5',
        'dispatched',
        'agent b2, 13:50',
        'phase 3, budget to 13:44; retried: timeout; phase 3, budget to 15:20',
      ),
    );
    expect(() => run(at('14:00'), body)).toThrow(/more than one "budget to HH:MM"/);
    expect(() => run(at('14:00'), body)).toThrow(/#5/);
  });

  it('throws when the resolved budget exceeds the 90-minute cap', () => {
    // A single, stale "budget to" combined with the day-roll means this row
    // resolves to a ~24h budget rather than a valid one.
    const body = ledger(row('#6', 'dispatched', 'agent c3, 13:50', 'phase 3, budget to 13:44'));
    expect(() => run(at('14:00'), body)).toThrow(/over the 90-minute cap/);
    expect(() => run(at('14:00'), body)).toThrow(/#6/);
  });

  it('refuses a whole-issue row written before #1612 as stale', () => {
    // `--dispatch 3` used to print a 270-minute budget. An open ledger carrying
    // one reads as stale under the flat cap — why #1612 lands between campaigns.
    const body = ledger(row('#8', 'dispatched', 'agent e5, 09:14', '3 phases, budget to 13:44'));
    expect(() => run(at('09:30'), body)).toThrow(/270-minute budget, over the 90-minute cap/);
  });

  it('does not throw on a normal row within the cap', () => {
    const body = ledger(row('#7', 'dispatched', 'agent d4, 09:00', 'phase 2, budget to 10:30'));
    expect(() => run(at('09:30'), body)).not.toThrow();
  });
});

describe('adoptionVerdict — the termination guard (#1614)', () => {
  const rows = parseStatusTable(
    ledger(
      row('#1601', 'merged', '—', ''),
      row('#1602', 'in review', '—', 'round 1'),
      row('#1640 adopted', 'queued', '—', 'from PR #1650, after #1601'),
    ),
  );

  it('an ordinary run-set row: yes', () => {
    expect(adoptionVerdict(rows, '1601')).toMatchObject({ adopt: true });
    expect(adoptionVerdict(rows, '#1602')).toMatchObject({ adopt: true });
    expect(adoptionVerdict(rows, 1602)).toMatchObject({ adopt: true });
  });

  it('a row marked adopted: no', () => {
    const verdict = adoptionVerdict(rows, '1640');
    expect(verdict.adopt).toBe(false);
    expect(verdict.reason).toMatch(/itself adopted/);
  });

  it("an issue with no row — the ledger, the sweep PR's scope: no", () => {
    const verdict = adoptionVerdict(rows, '1630');
    expect(verdict.adopt).toBe(false);
    expect(verdict.reason).toMatch(/no row/);
  });

  it('matches the whole id, not a prefix', () => {
    expect(adoptionVerdict(rows, '160').adopt).toBe(false);
    expect(adoptionVerdict(rows, '16400').adopt).toBe(false);
  });

  it('any adopted row for the issue wins over an ordinary one', () => {
    const dup = parseStatusTable(
      ledger(row('#7', 'merged', '—', ''), row('#7 adopted', 'queued', '—', '')),
    );
    expect(adoptionVerdict(dup, '7').adopt).toBe(false);
  });

  it.each(['', '1-2', '#', '1 2'])('refuses the issue %j', (issue) => {
    expect(() => adoptionVerdict(rows, issue)).toThrow(/issue must be/);
  });
});

describe('the CLI, spawned', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'campaign-heartbeat-'));
  const minutesFromNow = (m) => formatHHMM(new Date(Date.now() + m * 60_000));

  const cli = (args, input) => {
    try {
      const stdout = execFileSync('node', [SCRIPT, ...args], {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  it('reads a body file and prints the verdict, exit 0', () => {
    const file = path.join(dir, 'live.md');
    const end = minutesFromNow(80);
    writeFileSync(
      file,
      ledger(
        row('#1', 'dispatched', `agent a, ${minutesFromNow(-10)}`, `phase 1, budget to ${end}`),
      ),
    );
    const res = cli([file]);
    expect(res.status).toBe(0);
    const out = res.stdout.trim().split('\n');
    expect(out[0]).toBe('LIVE 1');
    expect(out[1]).toBe(`EARLIEST ${end}`);
    expect(out[2]).toMatch(/^SLEEP \d+$/);
    expect(Number(out[2].split(' ')[1])).toBeGreaterThan(70 * 60);
    expect(out).toHaveLength(3);
  });

  it('reads stdin when given no file, and exits 1 on a breach', () => {
    const body = ledger(
      row(
        '#8',
        'dispatched',
        `agent h, ${minutesFromNow(-100)}`,
        `phase 1, budget to ${minutesFromNow(-10)}`,
      ),
    );
    const res = cli([], body);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^SLEEP 0$/m);
    expect(res.stdout).toMatch(/^BREACHED #8 agent h, \d\d:\d\d ended \d\d:\d\d$/m);
  });

  it('prints SLEEP none for an empty pool, exit 0', () => {
    const res = cli([], ledger(row('#1', 'merged', '—', '')));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('LIVE 0\nEARLIEST none\nSLEEP none\n');
  });

  it('exits 2 on an unparseable live row, naming it, and prints no verdict', () => {
    const res = cli([], ledger(row('#3', 'dispatched', 'agent x', '2 phases')));
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/#3/);
    expect(res.stdout).toBe('');
  });

  it('exits 2 when there is no ## Status table', () => {
    const res = cli([], '## Plan\nnothing here\n');
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  });

  it('--dispatch prints the budget and both cells', () => {
    const res = cli(['--dispatch', '3']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(
      /^BUDGET 90\nWORKER \d\d:\d\d\nNOTE phase 3, budget to \d\d:\d\d\n$/,
    );
  });

  it.each([[[]], [['0']], [['two']]])('--dispatch %j exits 2', (rest) => {
    expect(cli(['--dispatch', ...rest]).status).toBe(2);
  });

  describe('--may-adopt (#1614)', () => {
    const body = ledger(
      row('#1601', 'merged', '—', ''),
      row('#1640 adopted', 'queued', '—', 'from PR #1650'),
    );
    const file = path.join(dir, 'adopt.md');
    writeFileSync(file, body);

    it('prints ADOPT yes for a run-set issue, exit 0', () => {
      const res = cli(['--may-adopt', '1601', file]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/^ADOPT yes — #1601 /);
    });

    it('prints ADOPT no for an adopted issue, exit 1', () => {
      const res = cli(['--may-adopt', '#1640', file]);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/^ADOPT no — #1640 is itself adopted/);
    });

    it('prints ADOPT no for the ledger (the sweep PR), reading stdin, exit 1', () => {
      const res = cli(['--may-adopt', '1630'], body);
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/^ADOPT no — #1630 has no row/);
    });

    it('exits 2 on an unreadable table, printing no verdict', () => {
      const res = cli(['--may-adopt', '1601'], '## Plan\nnothing here\n');
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toMatch(/Status/);
    });

    it.each([[[]], [['x']], [['-1']]])('--may-adopt %j exits 2', (rest) => {
      expect(cli(['--may-adopt', ...rest], body).status).toBe(2);
    });
  });
});

describe('salt-campaign.md → Dispatch sends the coordinator to the script', () => {
  // The prose half of #1587 Phase 2. It holds only that the section names the
  // two commands and the exit-2 rule; it cannot hold that a coordinator runs them.
  const dispatch = () => {
    const src = campaign();
    const start = src.indexOf('\n## Dispatch\n');
    if (start === -1) throw new Error('no "## Dispatch" heading in salt-campaign.md');
    const next = src.indexOf('\n## ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it('names the dispatch-time command and the wake-time command', () => {
    expect(dispatch()).toMatch(/node scripts\/campaign-heartbeat\.mjs --dispatch <k>/);
    expect(dispatch()).toMatch(/node scripts\/campaign-heartbeat\.mjs <ledger-body-file>/);
  });

  it('never lets exit 2 read as an empty pool', () => {
    expect(dispatch()).toMatch(/\*\*Exit 2\*\* is a pause, \*\*never an empty pool\*\*/);
  });

  it('re-arms only when EARLIEST moved', () => {
    expect(dispatch()).toMatch(
      /re-arm to `SLEEP` if `EARLIEST` differs from the deadline you last armed/,
    );
  });
});
