#!/usr/bin/env node
/**
 * Did CI's heavy suites — `Vitest integration (emulator)` and the e2e shards —
 * actually run on a run, or only report green?
 *
 *   node scripts/heavy-suites.mjs --pr <n>        # newest merge-queue run for PR n
 *   node scripts/heavy-suites.mjs --branch <name> # newest CI run on a PR branch
 *   node scripts/heavy-suites.mjs --run <id>
 *   node scripts/heavy-suites.mjs --jobs <file> --changes-log <file> --event <merge_group|pull_request>
 *
 * The first three fetch with `gh`. The fourth is the route for a session with
 * no `gh` (cloud): fetch the run's jobs (`list_workflow_jobs`) and the
 * `Detect changes` job's log (`get_job_logs`) with the GitHub MCP server, save
 * each to a file, and pass them here. Either way the same classifier decides.
 *
 * Prints the verdict word on the first line, then one `name: conclusion` line
 * per heavy job and a `reason:` line. Exit codes:
 *
 *   0 ran-green | skipped-non-app    1 failed    2 skipped-behind
 *   3 pending    4 cancelled    5 cannot-confirm    64 usage
 *
 * `cannot-confirm` is never green: no matching run or jobs, a fetch that
 * failed, a skip with no reason CI printed, or anything else unrecognised.
 *
 * WHY THIS EXISTS. Three command files each told an agent to hand-type a
 * `gh run view --json jobs` filter and judge its output from prose. The prose
 * missed that the `E2E (Playwright)` aggregator reports `success` when every
 * shard was skipped, and nothing checked the job names it matched against
 * `ci.yml`. The judgement is in `scripts/lib/heavySuites.mjs`, pinned to
 * `ci.yml` by `scripts/tests/heavySuites.test.mjs`; this file only fetches.
 *
 * `--branch main` is refused (exit 64): a merge-queue run's branch is
 * `gh-readonly-queue/main/pr-<n>-…`, so it would read the post-merge `push`
 * run instead. Use `--pr`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  DETECT_CHANGES_JOB,
  EXIT_CODES,
  classifyHeavySuites,
  jobsOf,
  pickMergeGroupRun,
} from './lib/heavySuites.mjs';

const USAGE =
  'usage: node scripts/heavy-suites.mjs --pr <n> | --branch <name> | --run <id>\n' +
  '       node scripts/heavy-suites.mjs --jobs <file> --changes-log <file> --event <merge_group|pull_request>';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : (argv[i + 1] ?? '');
};

function emit({ verdict, lines }) {
  console.log([verdict, ...lines].join('\n'));
  process.exit(EXIT_CODES[verdict]);
}

const cannotConfirm = (reason) => emit({ verdict: 'cannot-confirm', lines: [`reason: ${reason}`] });

function usage(msg) {
  console.error(`${msg}\n${USAGE}`);
  process.exit(64);
}

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 });
  return res.status === 0 && res.stdout.trim() ? res.stdout : null;
}

function ghJson(args) {
  const out = gh(args);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// --- file mode (no gh) -------------------------------------------------------

const jobsFile = flag('--jobs');
if (jobsFile !== null) {
  const logFile = flag('--changes-log');
  const event = flag('--event');
  if (!jobsFile || !logFile || !event) usage('--jobs needs --changes-log and --event');
  let jobs;
  try {
    jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
  } catch (err) {
    cannotConfirm(`cannot read --jobs ${jobsFile}: ${err.message}`);
  }
  let changesLog = null;
  try {
    changesLog = readFileSync(logFile, 'utf8');
    // `get_job_logs --return_content true` wraps the log as JSON
    // (`{"logs_content":"…\n…",…}`) instead of the raw text `gh` gives.
    // Unwrap it so a skip's marker lines are still on their own lines.
    try {
      const parsed = JSON.parse(changesLog);
      if (typeof parsed?.logs_content === 'string') changesLog = parsed.logs_content;
    } catch {
      // Not JSON: already the raw log text.
    }
  } catch {
    // Missing log: the classifier says cannot-confirm if it needed one.
  }
  // No run status in file mode, so infer it from the jobs: any job not yet
  // completed means the run is still going. The converse does not hold (a run
  // between job batches lists only completed jobs), and that case stays
  // `cannot-confirm` — the safe side.
  const runCompleted = (jobsOf(jobs) ?? []).every((job) => job?.status === 'completed');
  emit(classifyHeavySuites({ jobs, changesLog, event, runCompleted }));
}

// --- gh mode -----------------------------------------------------------------

const pr = flag('--pr');
const branch = flag('--branch');
let runId = flag('--run');
if ([pr, branch, runId].filter((v) => v !== null).length !== 1) {
  usage('give exactly one of --pr, --branch, --run, or the --jobs file form');
}
if (pr !== null && !/^\d+$/.test(pr)) usage('--pr needs a PR number');
if (runId !== null && !/^\d+$/.test(runId)) usage('--run needs a run id');
if (branch !== null && (!branch || branch === 'main'))
  usage('--branch needs a PR branch; use --pr for the merge queue');

const RUN_FIELDS = 'databaseId,headBranch,event,status';
if (pr !== null) {
  const runs = ghJson([
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--event',
    'merge_group',
    '--limit',
    '50',
    '--json',
    RUN_FIELDS,
  ]);
  if (!runs) cannotConfirm('gh run list failed or returned nothing');
  const run = pickMergeGroupRun(runs, pr);
  if (!run) cannotConfirm(`no merge_group run for PR #${pr} among the newest 50`);
  runId = String(run.databaseId);
} else if (branch !== null) {
  const runs = ghJson([
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--branch',
    branch,
    '--limit',
    '1',
    '--json',
    RUN_FIELDS,
  ]);
  if (!runs?.[0]) cannotConfirm(`no CI run on branch ${branch}`);
  runId = String(runs[0].databaseId);
}

const run = ghJson(['run', 'view', runId, '--json', 'event,status,jobs']);
if (!run) cannotConfirm(`gh run view ${runId} failed or returned nothing`);

// The log is only read for a skip, but fetching it unconditionally keeps the
// decision of when it matters in one place — the classifier.
const detect = (jobsOf(run) ?? []).find((job) => job.name === DETECT_CHANGES_JOB);
let changesLog = null;
if (detect?.databaseId) {
  changesLog =
    gh(['run', 'view', runId, '--log', '--job', String(detect.databaseId)]) ??
    // `gh run view --log` can refuse while the run as a whole is in progress;
    // the job's own log endpoint serves any completed job.
    gh(['api', `repos/{owner}/{repo}/actions/jobs/${detect.databaseId}/logs`]);
}

const result = classifyHeavySuites({
  jobs: run,
  changesLog,
  event: run.event,
  runCompleted: run.status === 'completed',
});
emit({ ...result, lines: [`run: ${runId} (${run.event}, ${run.status})`, ...result.lines] });
