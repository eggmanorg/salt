// Did the heavy suites actually run? One verdict, from a CI run's job list and
// its `Detect changes` log. `scripts/heavy-suites.mjs` is the I/O around it.
//
// Two traps a reader of the raw jobs falls into, and why this is code:
//
// 1. `E2E (Playwright)` is an AGGREGATOR with `if: always()` that asserts "did
//    not fail", so it reports `success` when every shard was SKIPPED. It is
//    reported in `lines` and never counted as proof of a run. And a matrix job
//    skipped by its `if:` is never expanded: the run lists ONE job literally
//    named `E2E shard ${{ matrix.shard }}/3`, not three shards (verified on run
//    36102325167, #1585's PR run).
// 2. Why a suite skipped is decided by `ci.yml` and printed by its `Detect
//    changes` step — but GitHub also echoes the step's whole `run:` script into
//    the same log, so BOTH reason sentences appear in EVERY such log as source
//    text (`echo "Non-app change …"`). A substring search therefore finds the
//    non-app reason in an app run's log. Only a log line whose message is
//    exactly the sentence is CI's output; `reasonLines` below is that rule.
//
// Everything this module selects on is a string copied from `ci.yml`, and
// `scripts/tests/heavySuites.test.mjs` reads `ci.yml` and fails if any of them
// stops being there verbatim. THE LIMIT: it pins presence, not meaning — a
// change to WHEN ci.yml prints a sentence, or a new heavy job this file does
// not name, passes those pins and needs this file read alongside the change.

/** The integration suite's job name (`ci.yml` job `vitest-integration`). */
export const INTEGRATION_JOB = 'Vitest integration (emulator)';

/** The e2e matrix job's name template, as a skipped matrix job reports it. */
export const E2E_SHARD_TEMPLATE = 'E2E shard ${{ matrix.shard }}/3';

/** `ci.yml`'s `matrix.shard` values. */
export const E2E_SHARDS = [1, 2, 3];

/** The expanded shard job names — what a matrix that actually ran reports. */
export const E2E_SHARD_JOBS = E2E_SHARDS.map((n) =>
  E2E_SHARD_TEMPLATE.replace('${{ matrix.shard }}', String(n)),
);

/** The aggregator. Reported, never proof — see the header. */
export const E2E_AGGREGATOR_JOB = 'E2E (Playwright)';

/** The job whose log says why the heavy suites were skipped. */
export const DETECT_CHANGES_JOB = 'Detect changes';

/** Every job this module reads, by exact name. */
export const HEAVY_JOBS = [INTEGRATION_JOB, ...E2E_SHARD_JOBS, E2E_SHARD_TEMPLATE];

/** `Detect changes` output when the diff is docs / CI / tooling only. */
export const NON_APP_LINE =
  'Non-app change (docs / CI / tooling) — skipping emulator + e2e suites.';

/** `Detect changes` output when a pull_request branch is behind main. */
export const BEHIND_LINE =
  'Branch is behind origin/main — the merge queue will run the heavy suites against real main; skipping them this run.';

/** Verdict → exit code. The whole output vocabulary. */
export const EXIT_CODES = {
  'ran-green': 0,
  'skipped-non-app': 0,
  failed: 1,
  'skipped-behind': 2,
  pending: 3,
  cancelled: 4,
  'cannot-confirm': 5,
};

/** The head-branch prefix of a PR's merge-queue runs. */
export const mergeGroupBranchPrefix = (pr) => `gh-readonly-queue/main/pr-${pr}-`;

/**
 * The newest merge-queue run for `pr` out of `runs` (newest first, as
 * `gh run list` returns them), or null. Matching on the PR is the point: the
 * newest `merge_group` run of ANY PR is another entry's when two are queued.
 */
export function pickMergeGroupRun(runs, pr) {
  const prefix = mergeGroupBranchPrefix(pr);
  return (
    runs.find(
      (run) =>
        (run.event ?? 'merge_group') === 'merge_group' &&
        String(run.headBranch ?? run.head_branch ?? '').startsWith(prefix),
    ) ?? null
  );
}

/**
 * A job list in any shape a caller has: `gh run view --json jobs`
 * (`{ jobs: [...] }`), the REST `list_workflow_jobs` body
 * (`{ total_count, jobs: [...] }`), the GitHub MCP server's wrapper of that
 * (`{ jobs: { total_count, jobs: [...] } }`), or a bare array. Null when none.
 */
export function jobsOf(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.jobs)) return input.jobs;
  if (input && input.jobs && Array.isArray(input.jobs.jobs)) return input.jobs.jobs;
  return null;
}

const ANSI = /\u001b\[[0-9;]*m/g;
/** `gh run view --log` prefixes `<job>\t<step>\t`; the raw log does not. */
const GH_PREFIX = /^[^\t]*\t[^\t]*\t/;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** The message of each log line: prefixes, timestamp and colour stripped. */
export function logMessages(log) {
  return String(log)
    .split(/\r?\n/)
    .map((line) => line.replace(GH_PREFIX, '').replace(TIMESTAMP, '').replace(ANSI, '').trim());
}

/** Which of the two reason sentences CI actually PRINTED (not merely echoed as source). */
export function reasonLines(log) {
  const messages = new Set(logMessages(log));
  return { nonApp: messages.has(NON_APP_LINE), behind: messages.has(BEHIND_LINE) };
}

const norm = (value) => String(value ?? '').toLowerCase();

/**
 * @param {{ jobs: unknown, changesLog?: string | null, event?: string,
 *           runCompleted?: boolean }} input
 *   `jobs` in any shape `jobsOf` accepts; `changesLog` the `Detect changes`
 *   job's log (null when it could not be fetched); `event` the run's trigger;
 *   `runCompleted` false only when the caller KNOWS the run is still going
 *   (heavy jobs are not listed until `Detect changes` finishes).
 * @returns {{ verdict: keyof typeof EXIT_CODES, lines: string[] }}
 */
export function classifyHeavySuites({ jobs, changesLog = null, event, runCompleted = true }) {
  const list = jobsOf(jobs);
  if (!list) return { verdict: 'cannot-confirm', lines: ['reason: no job list in the input'] };

  const byName = new Map();
  for (const job of list) {
    const name = String(job?.name ?? '');
    if (!HEAVY_JOBS.includes(name) && name !== E2E_AGGREGATOR_JOB) continue;
    if (byName.has(name)) {
      return { verdict: 'cannot-confirm', lines: [`reason: job "${name}" listed twice`] };
    }
    byName.set(name, { status: norm(job.status), conclusion: norm(job.conclusion) });
  }

  const show = (name) => {
    const job = byName.get(name);
    return `${name}: ${job.status === 'completed' ? job.conclusion || '(none)' : job.status}`;
  };

  const expanded = E2E_SHARD_JOBS.filter((name) => byName.has(name));
  const template = byName.has(E2E_SHARD_TEMPLATE);
  const shards =
    expanded.length === E2E_SHARD_JOBS.length && !template
      ? E2E_SHARD_JOBS
      : expanded.length === 0 && template
        ? [E2E_SHARD_TEMPLATE]
        : null;
  const heavy = byName.has(INTEGRATION_JOB) && shards ? [INTEGRATION_JOB, ...shards] : null;

  const record = HEAVY_JOBS.filter((name) => byName.has(name)).map(show);
  if (byName.has(E2E_AGGREGATOR_JOB)) {
    record.push(`${show(E2E_AGGREGATOR_JOB)} (aggregator — not proof of a run)`);
  }
  const done = (verdict, reason) => ({ verdict, lines: [...record, `reason: ${reason}`] });

  if (!heavy) {
    if (!runCompleted) return done('pending', 'heavy jobs not created yet — run still in progress');
    return done(
      'cannot-confirm',
      byName.has(INTEGRATION_JOB) || expanded.length || template
        ? 'heavy job set incomplete or mixed (shard names must be all three, or the one skipped template)'
        : 'no heavy jobs in this run — a ci.yml rename, or the wrong run',
    );
  }

  const jobsNow = heavy.map((name) => byName.get(name));
  if (jobsNow.some((job) => job.status !== 'completed'))
    return done('pending', 'a heavy job has not completed');
  const conclusions = jobsNow.map((job) => job.conclusion);
  if (conclusions.includes('cancelled')) return done('cancelled', 'a heavy job was cancelled');
  if (conclusions.some((c) => c === 'failure' || c === 'timed_out')) {
    return done('failed', 'a heavy job failed');
  }
  if (conclusions.every((c) => c === 'success') && shards === E2E_SHARD_JOBS) {
    return done('ran-green', 'integration and every e2e shard succeeded');
  }
  if (!conclusions.every((c) => c === 'skipped')) {
    return done(
      'cannot-confirm',
      `unrecognised conclusion mix: ${[...new Set(conclusions)].join(', ')}`,
    );
  }

  if (changesLog === null || changesLog === undefined || String(changesLog).trim() === '') {
    return done('cannot-confirm', 'heavy jobs skipped and no Detect changes log to say why');
  }
  const { nonApp, behind } = reasonLines(changesLog);
  if (nonApp && !behind) return done('skipped-non-app', 'Detect changes printed the non-app line');
  if (behind && !nonApp) {
    return event === 'pull_request'
      ? done('skipped-behind', 'Detect changes printed the behind-main line')
      : done(
          'cannot-confirm',
          `behind-main line on a ${event ?? 'unknown'} run, which is never gated`,
        );
  }
  return done(
    'cannot-confirm',
    nonApp
      ? 'Detect changes printed both reason lines'
      : 'heavy jobs skipped and Detect changes printed neither reason line',
  );
}
