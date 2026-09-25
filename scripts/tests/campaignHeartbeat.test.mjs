// The campaign pool heartbeat's arithmetic (#1587): the lib with an injected
// clock, the prose it must agree with, and the CLI spawned for real.
//
// Two halves of this file read salt-campaign.md rather than restating it. The
// budget formula exists twice — prose a spec author reads, and the function the
// coordinator runs — so the prose's `Worked values:` line is asserted against
// the function, and the two cannot drift apart silently. Likewise the parser is
// run over the ledger template's own example table, lifted from the command
// file, so a change to the template's shape goes red here rather than in a live
// campaign.
//
// WHAT THIS DOES NOT PIN (CLAUDE.md rule 12): that a coordinator actually runs
// the script, or acts on its output. That is prose, and a prose pin in
// campaignBudget.test.mjs's style is the most any test can hold for it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  budgetMinutes,
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

describe('budgetMinutes', () => {
  it.each([
    [1, 180],
    [2, 180],
    [3, 270],
    [4, 360],
    [5, 360],
    [12, 360],
  ])('%i phases → %i minutes', (phases, minutes) => {
    expect(budgetMinutes(phases)).toBe(minutes);
  });

  it.each([0, -1, 1.5, NaN])('refuses %s', (phases) => {
    expect(() => budgetMinutes(phases)).toThrow(/positive integer/);
  });

  it('agrees with every value on salt-campaign.md\'s "Worked values:" line', () => {
    const line = campaign()
      .split('\n')
      .find((l) => l.includes('Worked values:'));
    expect(line, 'salt-campaign.md lost its "Worked values:" line').toBeDefined();
    const pairs = [...line.slice(line.indexOf('Worked values:')).matchAll(/(\d+)(\+?) → (\d+)/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(4);
    for (const [, n, plus, minutes] of pairs) {
      const probes = plus ? [Number(n), Number(n) + 1, Number(n) + 6] : [Number(n)];
      for (const p of probes) expect(budgetMinutes(p), `${p} phases`).toBe(Number(minutes));
    }
  });
});

describe('dispatchCells', () => {
  it('prints the Worker time and the Note for the current clock', () => {
    expect(dispatchCells(3, at('09:14'))).toEqual({
      budget: 270,
      worker: '09:14',
      note: '3 phases, budget to 13:44',
    });
  });

  it('writes an end-time past midnight as the bare wall-clock time', () => {
    expect(dispatchCells(4, at('22:30')).note).toBe('4 phases, budget to 04:30');
  });

  it('says "phase" for one', () => {
    expect(dispatchCells(1, at('08:00')).note).toBe('1 phase, budget to 11:00');
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
    const phases = Number(/^(\d+) phases?/.exec(row_.note)[1]);
    const cells = dispatchCells(phases, at(time));
    expect(row_.worker.endsWith(`, ${cells.worker}`)).toBe(true);
    expect(row_.note).toBe(cells.note);
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
        row('#1', 'dispatched', 'agent a1, 09:00', '4 phases, budget to 15:00'),
        row('#2', 'dispatched', 'agent a2, 09:30', '1 phase, budget to 12:30'),
        row('#3', 'dispatched', 'agent a3, 09:45', '3 phases, budget to 14:15'),
      ),
    );
    expect(verdict.live).toBe(3);
    expect(formatHHMM(verdict.earliest)).toBe('12:30');
    expect(verdict.sleepSeconds).toBe(150 * 60);
    expect(report(verdict)).toEqual({
      lines: ['LIVE 3', 'EARLIEST 12:30', 'SLEEP 9000'],
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
        row('#4', 'dispatched', 'agent a4, 09:00', '2 phases, budget to 12:00'),
      ),
    );
    expect(verdict.live).toBe(1);
    expect(formatHHMM(verdict.earliest)).toBe('12:00');
  });

  it('reads a retried row, whose Note carries more than the budget', () => {
    const verdict = run(
      at('10:00'),
      ledger(
        row('#5', 'dispatched', 'agent r2, 09:50', '2 phases, budget to 12:50; retried: timeout'),
      ),
    );
    expect(formatHHMM(verdict.earliest)).toBe('12:50');
  });

  describe('breach is at the end-time, not after it', () => {
    const body = ledger(row('#9', 'dispatched', 'agent z, 09:00', '1 phase, budget to 12:00'));

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
        lines: ['LIVE 1', 'EARLIEST 12:00', 'SLEEP 0', 'BREACHED #9 agent z, 09:00 ended 12:00'],
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
        row('#1', 'dispatched', 'agent a, 09:00', '1 phase, budget to 12:00'),
        row('#2', 'dispatched', 'agent b, 12:05', '1 phase, budget to 15:05'),
      ),
    );
    expect(verdict.sleepSeconds).toBe(0);
    expect(verdict.breached.map((b) => b.issue)).toEqual(['#1']);
  });

  describe('midnight rollover', () => {
    const body = ledger(row('#4', 'dispatched', 'agent n, 22:30', '4 phases, budget to 04:30'));

    it('dispatched before midnight, checked before midnight: the end is tomorrow', () => {
      const verdict = run(at('23:00'), body);
      expect(verdict.breached).toEqual([]);
      expect(verdict.sleepSeconds).toBe(330 * 60);
      expect(verdict.earliest.getDate()).toBe(26);
    });

    it('dispatched before midnight, checked after: the dispatch was yesterday', () => {
      const verdict = run(at('01:00', 26), body);
      expect(verdict.breached).toEqual([]);
      expect(verdict.sleepSeconds).toBe(210 * 60);
    });

    it('and breaches once the post-midnight end passes', () => {
      expect(run(at('04:31', 26), body).breached).toHaveLength(1);
    });
  });

  describe('an unparseable live row is an error, never skipped', () => {
    it.each([
      ['no dispatch time in Worker', 'agent a1', '2 phases, budget to 12:00', /Worker/],
      ['no end-time in Note', 'agent a1, 09:00', '2 phases', /budget to HH:MM/],
      ['an impossible time', 'agent a1, 25:00', '2 phases, budget to 12:00', /Worker/],
    ])('%s', (_, worker, note, message) => {
      const body = ledger(
        row('#1', 'dispatched', 'agent ok, 09:00', '1 phase, budget to 12:00'),
        row('#2', 'dispatched', worker, note),
      );
      expect(() => run(at('10:00'), body)).toThrow(message);
      expect(() => run(at('10:00'), body)).toThrow(/#2/);
    });
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
    const end = minutesFromNow(170);
    writeFileSync(
      file,
      ledger(
        row('#1', 'dispatched', `agent a, ${minutesFromNow(-10)}`, `1 phase, budget to ${end}`),
      ),
    );
    const res = cli([file]);
    expect(res.status).toBe(0);
    const out = res.stdout.trim().split('\n');
    expect(out[0]).toBe('LIVE 1');
    expect(out[1]).toBe(`EARLIEST ${end}`);
    expect(out[2]).toMatch(/^SLEEP \d+$/);
    expect(Number(out[2].split(' ')[1])).toBeGreaterThan(160 * 60);
    expect(out).toHaveLength(3);
  });

  it('reads stdin when given no file, and exits 1 on a breach', () => {
    const body = ledger(
      row(
        '#8',
        'dispatched',
        `agent h, ${minutesFromNow(-200)}`,
        `1 phase, budget to ${minutesFromNow(-20)}`,
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
      /^BUDGET 270\nWORKER \d\d:\d\d\nNOTE 3 phases, budget to \d\d:\d\d\n$/,
    );
  });

  it.each([[[]], [['0']], [['two']]])('--dispatch %j exits 2', (rest) => {
    expect(cli(['--dispatch', ...rest]).status).toBe(2);
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
    expect(dispatch()).toMatch(/node scripts\/campaign-heartbeat\.mjs --dispatch <phases>/);
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
