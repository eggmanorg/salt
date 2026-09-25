// The heavy-suite verdict, one fixture per verdict row, plus the pins that tie
// every string the classifier keys on to `.github/workflows/ci.yml` — so a job
// rename or a reworded log line goes red here instead of silently blinding the
// three command files that read the verdict (issue #1588).
//
// The two `*-ran.json` / `*-skipped.json` fixtures and the log are trimmed from
// real runs: 36130333805 (#1596's merge-queue run, suites ran) and 36102325167
// (#1585's PR run, `.claude/`-only, suites skipped). The rest are synthetic
// variations on them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BEHIND_LINE,
  DETECT_CHANGES_JOB,
  E2E_AGGREGATOR_JOB,
  E2E_SHARD_JOBS,
  E2E_SHARD_TEMPLATE,
  E2E_SHARDS,
  EXIT_CODES,
  INTEGRATION_JOB,
  NON_APP_LINE,
  classifyHeavySuites,
  jobsOf,
  logMessages,
  pickMergeGroupRun,
  reasonLines,
} from '../lib/heavySuites.mjs';
import { jobNames } from '../lib/mergeQueueGuard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', 'heavy-suites', name), 'utf8');
const CI_YML = readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const ranMergeGroup = JSON.parse(fixture('mcp-merge-group-1596-ran.json'));
const skippedPr = JSON.parse(fixture('gh-pr-1585-skipped.json'));
const nonAppLog = fixture('detect-changes-non-app.log');
/** The same log with CI's printed reason swapped for another printed line. */
const logPrinting = (line) => nonAppLog.replace(/(Z )Non-app change \(docs[^\n]*/, `$1${line}`);
const appLog = logPrinting('App-impacting changes detected — running full CI.');
const behindLog = logPrinting(BEHIND_LINE);

/** A gh-shaped job list: every heavy job at `conclusion`, overrides by name. */
function jobs(conclusion, overrides = {}, { shards = E2E_SHARD_JOBS } = {}) {
  const names = [DETECT_CHANGES_JOB, INTEGRATION_JOB, ...shards, E2E_AGGREGATOR_JOB];
  return {
    jobs: names.map((name, i) => ({
      databaseId: i + 1,
      name,
      status: 'completed',
      conclusion:
        name === DETECT_CHANGES_JOB || name === E2E_AGGREGATOR_JOB ? 'success' : conclusion,
      ...overrides[name],
    })),
  };
}

const verdict = (input) => classifyHeavySuites(input).verdict;

describe('pinned to ci.yml', () => {
  const names = jobNames(CI_YML);

  it('still names every job the classifier selects on, verbatim', () => {
    for (const name of [
      INTEGRATION_JOB,
      E2E_SHARD_TEMPLATE,
      E2E_AGGREGATOR_JOB,
      DETECT_CHANGES_JOB,
    ]) {
      expect(names).toContain(name);
    }
  });

  it('still runs the e2e matrix over exactly the shards the classifier expects', () => {
    const matrix = CI_YML.match(/^ {8}shard: \[([\d, ]+)\]$/m);
    expect(matrix).not.toBeNull();
    expect(matrix[1].split(',').map(Number)).toEqual(E2E_SHARDS);
    expect(E2E_SHARD_TEMPLATE).toMatch(new RegExp(`/${E2E_SHARDS.length}$`));
  });

  it('still prints both reason sentences verbatim', () => {
    expect(CI_YML).toContain(`echo "${NON_APP_LINE}"`);
    expect(CI_YML).toContain(`echo "${BEHIND_LINE}"`);
  });

  it('still runs the aggregator under always() — the reason it is never proof', () => {
    const at = CI_YML.indexOf(`    name: ${E2E_AGGREGATOR_JOB}\n`);
    expect(at).toBeGreaterThan(-1);
    const block = CI_YML.slice(at, at + 400);
    expect(block).toMatch(/^ {4}if: always\(\)$/m);
  });
});

describe('verdicts on real runs', () => {
  it('ran-green: #1596 merge-queue run, MCP-wrapped job list', () => {
    const result = classifyHeavySuites({
      jobs: ranMergeGroup,
      changesLog: appLog,
      event: 'merge_group',
    });
    expect(result.verdict).toBe('ran-green');
    expect(result.lines).toContain('E2E shard 2/3: success');
  });

  it('skipped-non-app: #1585 PR run — the aggregator says success, the verdict is still a skip', () => {
    const result = classifyHeavySuites({
      jobs: skippedPr,
      changesLog: nonAppLog,
      event: 'pull_request',
    });
    expect(result.verdict).toBe('skipped-non-app');
    expect(result.lines).toContain(`${E2E_SHARD_TEMPLATE}: skipped`);
    expect(result.lines).toContain(
      `${E2E_AGGREGATOR_JOB}: success (aggregator — not proof of a run)`,
    );
  });

  it('cannot-confirm: the same skipped run with no log to say why', () => {
    expect(verdict({ jobs: skippedPr, changesLog: null, event: 'pull_request' })).toBe(
      'cannot-confirm',
    );
    expect(verdict({ jobs: skippedPr, changesLog: '  \n', event: 'pull_request' })).toBe(
      'cannot-confirm',
    );
  });
});

describe('the echoed-script trap', () => {
  it('finds both sentences in the log as source text — so a substring test would lie', () => {
    expect(appLog).toContain(NON_APP_LINE);
    expect(appLog).toContain(BEHIND_LINE);
  });

  it('counts only a line CI printed', () => {
    expect(reasonLines(nonAppLog)).toEqual({ nonApp: true, behind: false });
    expect(reasonLines(appLog)).toEqual({ nonApp: false, behind: false });
    expect(reasonLines(behindLog)).toEqual({ nonApp: false, behind: true });
  });

  it('never reads a skip with only echoed source as non-app', () => {
    expect(verdict({ jobs: skippedPr, changesLog: appLog, event: 'pull_request' })).toBe(
      'cannot-confirm',
    );
  });

  it('reads `gh run view --log` output, whose lines carry job and step prefixes', () => {
    const ghLog = nonAppLog
      .split('\n')
      .map((line) => `${DETECT_CHANGES_JOB}\tRun set -euo pipefail\t${line}`)
      .join('\n');
    expect(logMessages(ghLog)).toContain(NON_APP_LINE);
    expect(verdict({ jobs: skippedPr, changesLog: ghLog, event: 'pull_request' })).toBe(
      'skipped-non-app',
    );
  });
});

describe('every verdict row', () => {
  it('ran-green needs integration and all three shards to succeed', () => {
    expect(verdict({ jobs: jobs('success'), event: 'pull_request' })).toBe('ran-green');
  });

  it('aggregator success over expanded-but-skipped shards is a skip, never ran-green', () => {
    expect(verdict({ jobs: jobs('skipped'), changesLog: nonAppLog, event: 'merge_group' })).toBe(
      'skipped-non-app',
    );
    expect(verdict({ jobs: jobs('skipped'), changesLog: null, event: 'merge_group' })).toBe(
      'cannot-confirm',
    );
  });

  it('skipped-behind on a pull_request run', () => {
    expect(verdict({ jobs: skippedPr, changesLog: behindLog, event: 'pull_request' })).toBe(
      'skipped-behind',
    );
  });

  it('cannot-confirm for the behind line on a merge_group run, which is never gated', () => {
    expect(verdict({ jobs: skippedPr, changesLog: behindLog, event: 'merge_group' })).toBe(
      'cannot-confirm',
    );
  });

  it('cannot-confirm when both reason lines were printed', () => {
    const both = `${nonAppLog}\n2026-09-25T06:19:54.0000000Z ${BEHIND_LINE}\n`;
    expect(verdict({ jobs: skippedPr, changesLog: both, event: 'pull_request' })).toBe(
      'cannot-confirm',
    );
  });

  it('pending while any heavy job is queued or running', () => {
    for (const status of ['queued', 'in_progress', 'waiting']) {
      const input = jobs('success', { 'E2E shard 3/3': { status, conclusion: '' } });
      expect(verdict({ jobs: input, event: 'pull_request' })).toBe('pending');
    }
  });

  it('pending when the heavy jobs are not listed yet and the run is known to be in progress', () => {
    const early = { jobs: [{ name: DETECT_CHANGES_JOB, status: 'in_progress', conclusion: '' }] };
    expect(verdict({ jobs: early, event: 'pull_request', runCompleted: false })).toBe('pending');
    expect(verdict({ jobs: early, event: 'pull_request' })).toBe('cannot-confirm');
  });

  it('cancelled when any heavy job was cancelled', () => {
    const input = jobs('success', { [INTEGRATION_JOB]: { conclusion: 'cancelled' } });
    expect(verdict({ jobs: input, event: 'pull_request' })).toBe('cancelled');
  });

  it('failed on failure or timed_out', () => {
    for (const conclusion of ['failure', 'timed_out']) {
      const input = jobs('success', { 'E2E shard 1/3': { conclusion } });
      expect(verdict({ jobs: input, event: 'merge_group' })).toBe('failed');
    }
  });

  it('conclusions are compared case-insensitively (REST and gh differ in places)', () => {
    const input = jobs('success', { 'E2E shard 1/3': { conclusion: 'FAILURE' } });
    expect(verdict({ jobs: input, event: 'merge_group' })).toBe('failed');
  });
});

describe('cannot-confirm is the default for anything unrecognised', () => {
  const cases = {
    'no job list at all': { jobs: { total_count: 0 } },
    'no heavy jobs (a rename in ci.yml)': {
      jobs: jobs('success', { [INTEGRATION_JOB]: { name: 'Vitest integration' } }),
    },
    'a shard missing': {
      jobs: { jobs: jobs('success').jobs.filter((j) => j.name !== 'E2E shard 2/3') },
    },
    'expanded shards and the skipped template together': {
      jobs: jobs('skipped', {}, { shards: [...E2E_SHARD_JOBS, E2E_SHARD_TEMPLATE] }),
      changesLog: nonAppLog,
    },
    'a job listed twice': { jobs: { jobs: [...jobs('success').jobs, ...jobs('success').jobs] } },
    'an unknown conclusion': {
      jobs: jobs('success', { [INTEGRATION_JOB]: { conclusion: 'neutral' } }),
    },
    'success mixed with skipped': {
      jobs: jobs('success', { [INTEGRATION_JOB]: { conclusion: 'skipped' } }),
      changesLog: nonAppLog,
    },
    'the skipped template reported as success': {
      jobs: jobs('success', {}, { shards: [E2E_SHARD_TEMPLATE] }),
    },
  };
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      expect(verdict({ event: 'pull_request', ...input })).toBe('cannot-confirm');
    });
  }
});

describe('jobsOf', () => {
  const list = [{ name: 'x' }];
  it('accepts gh, REST, MCP-wrapped and bare shapes', () => {
    expect(jobsOf({ jobs: list })).toBe(list);
    expect(jobsOf({ total_count: 1, jobs: list })).toBe(list);
    expect(jobsOf({ jobs: { total_count: 1, jobs: list } })).toBe(list);
    expect(jobsOf(list)).toBe(list);
    expect(jobsOf({ nothing: true })).toBeNull();
  });
});

describe('pickMergeGroupRun', () => {
  const runs = [
    { databaseId: 3, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1597-abc' },
    { databaseId: 2, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-159-def' },
    { databaseId: 1, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1596-012' },
  ];

  it("picks this PR's newest queue run, not the newest queue run of any PR", () => {
    expect(pickMergeGroupRun(runs, 1596)?.databaseId).toBe(1);
  });

  it('does not let one PR number prefix-match another', () => {
    expect(pickMergeGroupRun(runs, 159)?.databaseId).toBe(2);
    expect(pickMergeGroupRun(runs, 15)).toBeNull();
  });

  it('ignores non-merge_group runs and reads the REST head_branch spelling', () => {
    expect(
      pickMergeGroupRun([{ id: 9, event: 'push', headBranch: 'gh-readonly-queue/main/pr-7-a' }], 7),
    ).toBeNull();
    expect(
      pickMergeGroupRun([{ id: 9, head_branch: 'gh-readonly-queue/main/pr-7-a' }], 7)?.id,
    ).toBe(9);
  });
});

describe('EXIT_CODES', () => {
  it('matches the issue #1588 verdict table', () => {
    expect(EXIT_CODES).toEqual({
      'ran-green': 0,
      'skipped-non-app': 0,
      failed: 1,
      'skipped-behind': 2,
      pending: 3,
      cancelled: 4,
      'cannot-confirm': 5,
    });
  });
});
