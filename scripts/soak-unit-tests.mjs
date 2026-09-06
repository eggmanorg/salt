#!/usr/bin/env node
// Soak the unit suite under deliberate CPU contention (issue #793).
//
// WHY THIS EXISTS
// The unit suite used to fail a different arbitrary test on every run, but only
// when the machine was busy, and every victim passed in isolation immediately
// afterwards. That is unanswerable by re-running: "it passed twice" and "it is
// stable" look identical from one green run. This reproduces the conditions on
// purpose and counts, so the question has a number instead of an opinion.
//
// WHAT IT DOES
// Runs `pnpm test` — the exact command step 3 of `/salt-run` and CI's unit job run, so
// the thing being measured is the gate itself — N times back to back, with K spinner processes
// saturating the CPU throughout. It reads Vitest's JSON reporter after each run
// and aggregates every failure by test name, with the durations it failed at.
//
// READING THE OUTPUT
// Duration is the classifier, and the two classes want opposite fixes:
//
//   Class B — failed at ≈ the `asyncUtilTimeout` in apps/web-pwa/tests/setup.ts.
//     A correct wait that ran out of budget. The budget is still too low; raise
//     it. Do NOT patch the individual test.
//   Class A — failed far below the budget. The test is wrong: it asserts
//     something its `await` never gated, or it drives the DOM in a way that
//     races. A bigger budget can never fix one of these. Fix the test.
//
// The classifier reads the budget out of `setup.ts` rather than hardcoding it,
// so the two cannot drift apart.
//
// ONE TRAP THE DURATION HEURISTIC CANNOT SEE. A test whose awaited condition
// never becomes true also burns the whole budget, so it reports as Class B while
// being Class A. The discriminator is whether the duration MOVES WITH the budget:
// soak once, change `asyncUtilTimeout`, soak again. A starved wait resolves with
// the extra room; a condition that never holds just fails at the new ceiling
// instead. Measured on #793: this test failed at ~1095ms on a 1000ms budget and
// ~5105ms on a 5000ms one — same bug, wearing whatever number it was given.
//
// THIS IS A DELIBERATE, MANUAL INSTRUMENT. It is not wired into a git hook or any
// CI workflow and must not be: it saturates the machine for as long as it runs.
//
//   pnpm soak                      # 10 runs, one spinner per core
//   pnpm soak --runs=25 --load=24  # longer, heavier
//   pnpm soak --runs=5 --load=0    # no synthetic load, for a baseline
//   pnpm soak --project=@salt/web-pwa   # one Vitest project instead of all 8
//   pnpm soak --help

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_FILE = join(REPO_ROOT, 'apps/web-pwa/tests/setup.ts');

function parseArgs(argv) {
  const opts = { runs: 10, load: cpus().length, project: null, help: false };
  for (const arg of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Unrecognised argument: ${arg}`);
    const [, key, value] = m;
    if (key === 'help') opts.help = true;
    else if (key === 'runs' || key === 'load') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} needs a non-negative integer`);
      opts[key] = n;
    } else if (key === 'project') {
      if (!value) throw new Error('--project needs a value, e.g. --project=@salt/web-pwa');
      opts.project = value;
    } else throw new Error(`Unrecognised option: --${key}`);
  }
  if (opts.runs < 1) throw new Error('--runs needs to be at least 1');
  return opts;
}

/**
 * The configured wait budget, read from source so the classifier cannot drift
 * away from what the suite actually runs with.
 *
 * Comment lines are skipped deliberately: `setup.ts` explains the number in prose
 * directly above it, and a soak that classified against a commented-out value
 * would mislabel every failure it found — which it did, once, and the run was
 * only saved by the reader knowing better.
 */
function readWaitBudget() {
  try {
    for (const line of readFileSync(SETUP_FILE, 'utf8').split('\n')) {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*')) continue;
      const m = /asyncUtilTimeout:\s*([\d_]+)/.exec(code);
      if (m) return Number(m[1].replaceAll('_', ''));
    }
  } catch {
    /* fall through to the honest answer below */
  }
  return null;
}

/**
 * Saturate `count` cores until the returned function is called. A bare spin loop
 * is the right shape: what starves a real-clock `waitFor` is losing the CPU to
 * other runnable threads, and that is exactly what these produce.
 */
function startLoad(count) {
  const spinners = Array.from({ length: count }, () =>
    spawn(process.execPath, ['-e', 'for (;;);'], { stdio: 'ignore', detached: false }),
  );
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const s of spinners) s.kill('SIGKILL');
  };
}

function runSuite(outputFile, project) {
  // No `--` before these: pnpm forwards them to the script as-is, and passing a
  // literal `--` reaches Vitest as an argument and stops it writing any report.
  const args = ['test', '--reporter=json', `--outputFile=${outputFile}`];
  if (project) args.push(`--project=${project}`);
  const started = Date.now();
  const res = spawnSync('pnpm', args, { cwd: REPO_ROOT, stdio: 'ignore' });
  return { exitCode: res.status, wallMs: Date.now() - started };
}

/** Every failed assertion in one run, as `{ file, name, duration }`. */
function readFailures(outputFile) {
  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    // A run that dies before writing a report (an unhandled error tearing down a
    // worker, say) is a failure with no per-test detail. Say so rather than
    // silently counting it green.
    return [{ file: '(no report)', name: '(run produced no JSON report)', duration: null }];
  }
  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'failed') {
        failures.push({
          file: (file.name ?? '?').replace(`${REPO_ROOT}/`, ''),
          name: t.fullName ?? t.title ?? '?',
          duration: typeof t.duration === 'number' ? t.duration : null,
          // The first line of the assertion, which is what says WHICH wait ran
          // out — without it a full-budget failure is indistinguishable from a
          // wait whose condition simply never becomes true.
          message: (t.failureMessages?.[0] ?? '').split('\n')[0].trim() || null,
        });
      }
    }
  }
  return failures;
}

function classify(durations, budget) {
  const known = durations.filter((d) => typeof d === 'number');
  if (budget === null || known.length === 0) return '?';
  // "≈ the budget" is generous on both sides: the poll interval, the final
  // predicate evaluation and the assertion's own teardown all land after it.
  const atBudget = known.filter((d) => d >= budget * 0.8).length;
  if (atBudget === known.length) return 'B — budget exhausted';
  if (atBudget === 0) return 'A — raced, far under budget';
  return 'A+B — mixed, inspect individually';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0]);
    return;
  }

  const budget = readWaitBudget();
  const tmp = mkdtempSync(join(tmpdir(), 'salt-soak-'));
  const stopLoad = startLoad(opts.load);
  const cleanup = () => {
    stopLoad();
    rmSync(tmp, { recursive: true, force: true });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('exit', cleanup);

  console.log(
    `Soaking: ${opts.runs} run(s) of \`pnpm test\`${opts.project ? ` --project=${opts.project}` : ''}, ` +
      `${opts.load} spinner(s) on ${cpus().length} cores.`,
  );
  console.log(
    budget === null
      ? 'Could not read asyncUtilTimeout from setup.ts — durations are reported unclassified.\n'
      : `Wait budget (asyncUtilTimeout): ${budget} ms.\n`,
  );

  const seen = new Map();
  let green = 0;
  const loads = [];

  for (let i = 1; i <= opts.runs; i++) {
    const outputFile = join(tmp, `run-${i}.json`);
    const { exitCode, wallMs } = runSuite(outputFile, opts.project);
    const load1 = loadavg()[0];
    loads.push(load1);
    const failures = readFailures(outputFile);
    if (exitCode === 0 && failures.length === 0) green++;

    for (const f of failures) {
      const key = `${f.file} › ${f.name}`;
      const entry = seen.get(key) ?? { count: 0, durations: [], messages: new Set() };
      entry.count++;
      entry.durations.push(f.duration);
      if (f.message) entry.messages.add(f.message);
      seen.set(key, entry);
    }

    const verdict = failures.length === 0 ? (exitCode === 0 ? 'pass' : `exit ${exitCode}`) : 'FAIL';
    console.log(
      `  run ${String(i).padStart(3)}/${opts.runs}  ${(wallMs / 1000).toFixed(1)}s  ` +
        `load ${load1.toFixed(1)}  ${verdict}` +
        (failures.length ? `  ${failures.map((f) => f.name).join(' | ')}` : ''),
    );
  }

  const rate = ((green / opts.runs) * 100).toFixed(1);
  console.log(`\n${green}/${opts.runs} runs green (${rate}%).`);
  console.log(
    `Load average during the soak: ${Math.min(...loads).toFixed(1)}–${Math.max(...loads).toFixed(1)}.`,
  );

  if (seen.size === 0) {
    console.log('No failures.');
    return;
  }

  console.log('\nFailures, most frequent first:\n');
  const ranked = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, { count, durations, messages }] of ranked) {
    const shown = durations.map((d) => (d === null ? '?' : `${Math.round(d)}ms`)).join(', ');
    console.log(`  ${count}× ${key}`);
    console.log(`      durations: ${shown}`);
    console.log(`      class: ${classify(durations, budget)}`);
    for (const m of messages) console.log(`      ${m}`);
    console.log('');
  }
  process.exitCode = 1;
}

main();
