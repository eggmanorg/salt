#!/usr/bin/env node
/**
 * The campaign pool heartbeat's arithmetic, so the coordinator does none by hand.
 *
 *   node scripts/campaign-heartbeat.mjs [<ledger-body-file>]   # stdin when absent
 *   node scripts/campaign-heartbeat.mjs --dispatch <k>        # k: the phase this dispatch builds
 *   node scripts/campaign-heartbeat.mjs --may-adopt <issue> [<ledger-body-file>]
 *
 * Wake mode reads the ledger body — the local file the coordinator writes for
 * `gh issue edit <ledger> --body-file`, or `gh issue view <ledger> --json body
 * -q .body` piped in on resume — and prints:
 *
 *   LIVE <n>
 *   EARLIEST HH:MM | none
 *   SLEEP <seconds> | 0 (a row is breached) | none (empty pool)
 *   BREACHED #<issue> <worker cell> ended HH:MM     (one per breach)
 *
 * Exit 0 no breach, 1 at least one breach, 2 input it cannot read: no
 * `## Status` table; a `dispatched` row without its two times; a Note with more
 * than one `budget to HH:MM` (a retry appended rather than replaced it); or a
 * row whose resolved budget exceeds the 90-minute cap. Exit 2 is never an
 * empty pool — fix the row it names, by hand, then re-run.
 *
 * Dispatch mode prints the budget and the two cells to write:
 *
 *   BUDGET 90
 *   WORKER HH:MM          (the Worker cell is `agent <id>, HH:MM`)
 *   NOTE phase <k>, budget to HH:MM
 *
 * May-adopt mode (#1614) reads the ledger body the same way and answers whether
 * a finding raised on <issue>'s PR may be adopted — the termination guard:
 *
 *   ADOPT yes — <reason>     exit 0: a run-set issue
 *   ADOPT no — <reason>      exit 1: an `adopted` row, or no row (the sweep PR's
 *                            scope is the ledger, which has none)
 *
 * Exit 2 on a body with no readable `## Status` table, or an <issue> that is not
 * `#N` / `N` — never read as either answer.
 *
 * It computes; it never sleeps, arms or stops anything. Network-free, so the
 * `gh` and the cloud (GitHub MCP) routes feed it the same way. Every decision
 * is in `scripts/lib/campaignHeartbeat.mjs`, which holds the clock's limits.
 */

import { readFileSync } from 'node:fs';

import {
  adoptionVerdict,
  dispatchCells,
  heartbeat,
  parseStatusTable,
  report,
} from './lib/campaignHeartbeat.mjs';

const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

const args = process.argv.slice(2);
const now = new Date();

if (args[0] === '--dispatch') {
  const phase = /^\d+$/.test(args[1] ?? '') ? Number(args[1]) : NaN;
  let cells;
  try {
    cells = dispatchCells(phase, now);
  } catch (err) {
    die(`--dispatch: ${err.message}`);
  }
  console.log(`BUDGET ${cells.budget}`);
  console.log(`WORKER ${cells.worker}`);
  console.log(`NOTE ${cells.note}`);
  process.exit(0);
}

const mayAdopt = args[0] === '--may-adopt';
if (mayAdopt && !/^#?\d+$/.test(args[1] ?? '')) {
  die(`--may-adopt: expected an issue number, got "${args[1] ?? ''}"`);
}
const bodyFile = mayAdopt ? args[2] : args[0];

let body;
try {
  body = readFileSync(bodyFile ?? 0, 'utf8');
} catch (err) {
  die(`cannot read the ledger body: ${err.message}`);
}

if (mayAdopt) {
  let verdict;
  try {
    verdict = adoptionVerdict(parseStatusTable(body), args[1]);
  } catch (err) {
    die(`--may-adopt: ${err.message}`);
  }
  console.log(`ADOPT ${verdict.adopt ? 'yes' : 'no'} — ${verdict.reason}`);
  process.exit(verdict.adopt ? 0 : 1);
}

let lines, exitCode;
try {
  ({ lines, exitCode } = report(heartbeat(parseStatusTable(body), now)));
} catch (err) {
  die(err.message);
}
for (const line of lines) console.log(line);
process.exit(exitCode);
