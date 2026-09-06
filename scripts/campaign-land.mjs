#!/usr/bin/env node
/**
 * The one command a campaign uses to land a branch.
 *
 *   node scripts/campaign-land.mjs <pr> [--note <file>] [--adjudicated <issue>]
 *   node scripts/campaign-land.mjs <pr> --check [--json]
 *
 * WHY THIS EXISTS. salt-campaign.md's queue recipe is four steps - post the decision
 * note, remove the worktree, delete the local branch, enqueue - and the
 * coordinator composed them as a fresh shell line every time. Every line was
 * slightly different, so the `gh pr merge` PreToolUse gate could not recognise
 * it, and every one of them stopped the fleet on a human. Widening the gate's
 * vocabulary was whack-a-mole: one captured line alone introduced `set -e`, a
 * `gh pr comment` write, a `>/dev/null`, and backticks inside a quoted body.
 * That never converges, because the thing being matched is generated prose.
 *
 * So the shape is inverted. There is now exactly one sanctioned command, it
 * takes a PR number and nothing else positional, and it derives every path,
 * branch name and flag from GitHub rather than from something the coordinator
 * typed. The allowlist needs one entry; the gate needs no vocabulary at all.
 *
 * WHAT IT REFUSES. `--check` is the same judgement the merge gate applies
 * (`scripts/lib/prEligibility.mjs`, the single implementation of the rule), and
 * the landing path runs it first. A PR that is a draft, closed, failing checks,
 * unreviewed, or carrying unaddressed blocking findings does not merge, and the
 * exit code says so. `--adjudicated <issue>` is salt-campaign.md's own escape hatch
 * for a blocking finding judged shippable - it requires a real, open issue, so
 * the escape leaves an artefact instead of a prompt.
 *
 * Cleanup is bounded by construction: the worktree removed is the one git says
 * holds the PR's head branch, and it must sit under `.claude/worktrees/`; the
 * branch deleted is the PR's head branch. Neither is taken from an argument.
 *
 * ORDER: the enqueue happens FIRST and nothing local is touched until it has
 * succeeded - see `scripts/lib/landSteps.mjs`, which holds that guarantee and
 * the reasoning, and `scripts/tests/campaignLand.test.mjs`, which pins it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { land } from './lib/landSteps.mjs';
import { judgePr } from './lib/prEligibility.mjs';

const WORKTREE_DIR = '.claude/worktrees';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...opts });

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

/**
 * The main checkout, not whichever worktree this script was invoked from.
 * `git worktree remove` and `git branch -D` operate on shared state, but a
 * worktree cannot remove itself, and the coordinator may well be inside one.
 */
function mainCheckout(from) {
  const res = run('git', ['-C', from, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (res.status !== 0) die(`Not a git repository: ${from}`);
  return path.dirname(res.stdout.trim());
}

/** The worktree git says holds `branch`, or null. */
function worktreeFor(repo, branch) {
  const res = run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  if (res.status !== 0) return null;
  let current = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && line.trim() === `branch refs/heads/${branch}`)
      return current;
  }
  return null;
}

function ghJson(args) {
  const res = run('gh', args);
  if (res.status !== 0 || !res.stdout.trim()) {
    return { error: (res.stderr || 'no output').trim().slice(0, 300) };
  }
  try {
    return { data: JSON.parse(res.stdout) };
  } catch {
    return { error: 'unparseable JSON from gh' };
  }
}

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : (argv[i + 1] ?? '');
};
const has = (name) => argv.includes(name);

const pr = argv.find((a) => /^\d+$/.test(a));
if (!pr) {
  die(
    'usage: node scripts/campaign-land.mjs <pr> [--note <file>] [--adjudicated <issue>] [--check] [--json]',
  );
}

const checkOnly = has('--check');
const asJson = has('--json');
const notePath = flag('--note');
const adjudicated = flag('--adjudicated');

if (notePath && !existsSync(notePath)) die(`--note file not found: ${notePath}`);
if (adjudicated !== null && !/^\d+$/.test(adjudicated)) die('--adjudicated needs an issue number');

const repo = mainCheckout(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// --- judge -----------------------------------------------------------------

const view = ghJson([
  'pr',
  'view',
  pr,
  '--json',
  'isDraft,state,reviews,commits,statusCheckRollup,headRefName',
]);
if (view.error) {
  const reason = `could not read PR #${pr} from GitHub (${view.error})`;
  if (asJson) console.log(JSON.stringify({ verdict: 'ask', reason }));
  die(asJson ? '' : `ask: PR #${pr} — ${reason}`, 2);
}

// An adjudicated blocking finding must point at a real, open issue. salt-campaign.md
// requires the follow-up to be filed *before* the merge; this is that check.
if (adjudicated) {
  const issue = ghJson(['issue', 'view', adjudicated, '--json', 'number,state']);
  if (issue.error)
    die(`--adjudicated #${adjudicated}: could not read the issue (${issue.error})`, 2);
  if (issue.data.state !== 'OPEN') {
    die(
      `--adjudicated #${adjudicated} is ${issue.data.state}. A shipped-known-defect needs an open issue.`,
    );
  }
}

const verdict = judgePr(view.data, { adjudicated });
const line = `${verdict.verdict}: PR #${pr} ${verdict.reason}`;

if (checkOnly) {
  console.log(asJson ? JSON.stringify({ pr, ...verdict }) : line);
  process.exit(verdict.verdict === 'allow' ? 0 : verdict.verdict === 'deny' ? 1 : 2);
}
if (verdict.verdict !== 'allow') {
  die(line, verdict.verdict === 'deny' ? 1 : 2);
}

// --- land ------------------------------------------------------------------

const branch = verdict.head;

// Resolve the worktree before anything happens, and refuse anything outside the
// campaign root here rather than inside the ordering module - that check is the
// header's "bounded by construction" claim and it stays at the IO boundary.
let worktree = worktreeFor(repo, branch);
if (worktree) {
  const root = path.join(repo, WORKTREE_DIR);
  if (!worktree.startsWith(root + path.sep)) {
    die(`refusing to remove ${worktree}: it is not under ${WORKTREE_DIR}`);
  }
}

const result = land({ pr, branch, worktree, repo, notePath, run });
for (const line of result.lines) console.log(line);
if (!result.ok) die(result.error);

const after = ghJson(['pr', 'view', pr, '--json', 'state,mergeStateStatus,autoMergeRequest']);
console.log(
  after.data
    ? `landed: #${pr} state=${after.data.state} mergeState=${after.data.mergeStateStatus} auto=${after.data.autoMergeRequest !== null}`
    : `landed: #${pr} — state unreadable (${after.error})`,
);
