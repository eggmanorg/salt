// `scripts/heavy-suites.mjs`, spawned for real: the exit code IS the contract
// the command files branch on, and the module does its argument handling and
// `process.exit` as top-level side effects an import cannot observe (the
// reason checkSpecShapeCli.test.mjs gives).
//
// File mode is the cloud route, so it runs end to end on the real-run
// fixtures. The `gh` route runs against a fake `gh` put first on PATH, which
// answers the three calls the script makes from the same fixtures.
//
// WHAT THIS DOES NOT PIN (CLAUDE.md rule 12): that the real `gh` still accepts
// these flags and prints these JSON fields. The fake answers whatever it is
// asked, so a `gh` CLI change passes here and is caught only by a live run.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BEHIND_LINE, EXIT_CODES } from '../lib/heavySuites.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'heavy-suites.mjs');
const FIXTURES = path.join(here, 'fixtures', 'heavy-suites');
const fx = (name) => path.join(FIXTURES, name);
const dir = mkdtempSync(path.join(tmpdir(), 'heavy-suites-'));

function file(name, contents) {
  const full = path.join(dir, name);
  writeFileSync(full, contents);
  return full;
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const nonAppLog = readFileSync(fx('detect-changes-non-app.log'), 'utf8');
const behindLog = file(
  'behind.log',
  nonAppLog.replace(/(Z )Non-app change \(docs[^\n]*/, `$1${BEHIND_LINE}`),
);

describe('heavy-suites.mjs — file mode (no gh)', () => {
  it('ran-green, exit 0, verdict on the first line', () => {
    const result = run([
      '--jobs',
      fx('mcp-merge-group-1596-ran.json'),
      '--changes-log',
      fx('detect-changes-non-app.log'),
      '--event',
      'merge_group',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('ran-green');
    expect(result.stdout).toContain('Vitest integration (emulator): success');
  });

  it('skipped-non-app, exit 0, for the aggregator-green skipped run', () => {
    const result = run([
      '--jobs',
      fx('gh-pr-1585-skipped.json'),
      '--changes-log',
      fx('detect-changes-non-app.log'),
      '--event',
      'pull_request',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('skipped-non-app');
  });

  it('skipped-behind, exit 2', () => {
    const result = run([
      '--jobs',
      fx('gh-pr-1585-skipped.json'),
      '--changes-log',
      behindLog,
      '--event',
      'pull_request',
    ]);
    expect(result.status).toBe(EXIT_CODES['skipped-behind']);
    expect(result.stdout.split('\n')[0]).toBe('skipped-behind');
  });

  it('skipped-non-app, exit 0, when the log file is MCP-wrapped JSON (`return_content: true`)', () => {
    const wrapped = file(
      'mcp-log.json',
      JSON.stringify({ job_id: 107967409443, logs_content: nonAppLog }),
    );
    const result = run([
      '--jobs',
      fx('gh-pr-1585-skipped.json'),
      '--changes-log',
      wrapped,
      '--event',
      'pull_request',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('skipped-non-app');
  });

  it('cannot-confirm, exit 5, when the log file does not exist', () => {
    const result = run([
      '--jobs',
      fx('gh-pr-1585-skipped.json'),
      '--changes-log',
      path.join(dir, 'absent.log'),
      '--event',
      'pull_request',
    ]);
    expect(result.status).toBe(5);
    expect(result.stdout.split('\n')[0]).toBe('cannot-confirm');
  });

  it('cannot-confirm, exit 5, when the jobs file is not JSON (an empty MCP fetch)', () => {
    const result = run([
      '--jobs',
      file('empty.json', ''),
      '--changes-log',
      fx('detect-changes-non-app.log'),
      '--event',
      'pull_request',
    ]);
    expect(result.status).toBe(5);
  });

  it('failed, pending and cancelled carry their own exit codes', () => {
    const ran = JSON.parse(readFileSync(fx('mcp-merge-group-1596-ran.json'), 'utf8'));
    const shard = (patch) => {
      const copy = structuredClone(ran);
      Object.assign(
        copy.jobs.jobs.find((j) => j.name === 'E2E shard 1/3'),
        patch,
      );
      return file(`jobs-${Object.values(patch).join('-')}.json`, JSON.stringify(copy));
    };
    const args = (jobsFile) => [
      '--jobs',
      jobsFile,
      '--changes-log',
      behindLog,
      '--event',
      'merge_group',
    ];
    expect(run(args(shard({ conclusion: 'failure' }))).status).toBe(1);
    expect(run(args(shard({ status: 'in_progress', conclusion: null }))).status).toBe(3);
    expect(run(args(shard({ conclusion: 'cancelled' }))).status).toBe(4);
  });

  it('exit 64 when --jobs comes without --changes-log and --event', () => {
    expect(run(['--jobs', fx('gh-pr-1585-skipped.json')]).status).toBe(64);
  });
});

/** A fake `gh` answering from fixtures, first on PATH. */
function fakeGh({ runs, view, log }) {
  const bin = mkdtempSync(path.join(dir, 'bin-'));
  const data = file(`gh-data-${path.basename(bin)}.json`, JSON.stringify({ runs, view, log }));
  const gh = path.join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const d = JSON.parse(require('fs').readFileSync(${JSON.stringify(data)}, 'utf8'));
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(data)} + '.calls', a.join(' ') + '\\n');
if (a[0] === 'run' && a[1] === 'list') process.stdout.write(JSON.stringify(d.runs));
else if (a[0] === 'run' && a[1] === 'view' && a.includes('--log')) { if (d.log === null) process.exit(1); process.stdout.write(d.log); }
else if (a[0] === 'run' && a[1] === 'view') process.stdout.write(JSON.stringify(d.view));
else process.exit(1);
`,
  );
  chmodSync(gh, 0o755);
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    calls: () => readFileSync(`${data}.calls`, 'utf8'),
  };
}

describe('heavy-suites.mjs — gh mode, against a fake gh', () => {
  const skipped = JSON.parse(readFileSync(fx('gh-pr-1585-skipped.json'), 'utf8'));

  it("--pr reads that PR's queue run, not the newest queue run", () => {
    const gh = fakeGh({
      runs: [
        { databaseId: 222, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1597-aaa' },
        { databaseId: 111, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1585-bbb' },
      ],
      view: { event: 'merge_group', status: 'completed', ...skipped },
      log: nonAppLog,
    });
    const result = run(['--pr', '1585'], gh.env);
    expect(result.stdout.split('\n')[0]).toBe('skipped-non-app');
    expect(result.status).toBe(0);
    expect(gh.calls()).toContain('run view 111 --json event,status,jobs');
    expect(gh.calls()).toContain('run view 111 --log --job 107967409443');
  });

  it('--pr with no matching queue run is cannot-confirm', () => {
    const gh = fakeGh({ runs: [], view: null, log: null });
    const result = run(['--pr', '1585'], gh.env);
    expect(result.status).toBe(5);
  });

  it('--run on a skipped run whose log cannot be fetched is cannot-confirm, never green', () => {
    const gh = fakeGh({
      runs: [],
      view: { event: 'pull_request', status: 'completed', ...skipped },
      log: null,
    });
    const result = run(['--run', '36102325167'], gh.env);
    expect(result.stdout.split('\n')[0]).toBe('cannot-confirm');
    expect(result.status).toBe(5);
  });

  it('refuses --branch main, which would read the post-merge push run', () => {
    expect(run(['--branch', 'main']).status).toBe(64);
  });

  it('refuses no selector, and two selectors', () => {
    expect(run([]).status).toBe(64);
    expect(run(['--pr', '1', '--run', '2']).status).toBe(64);
  });
});
