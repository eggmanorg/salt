#!/usr/bin/env node
/**
 * The campaign pool heartbeat's arithmetic, so the coordinator does none by hand.
 *
 *   node scripts/campaign-heartbeat.mjs [<ledger-body-file>]   # stdin when absent
 *   node scripts/campaign-heartbeat.mjs --dispatch <phases>
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
 * row whose resolved budget exceeds the 360-minute cap. Exit 2 is never an
 * empty pool — fix the row it names, by hand, then re-run.
 *
 * Dispatch mode prints the budget and the two cells to write:
 *
 *   BUDGET <minutes>
 *   WORKER HH:MM          (the Worker cell is `agent <id>, HH:MM`)
 *   NOTE <n> phases, budget to HH:MM
 *
 * It computes; it never sleeps, arms or stops anything. Network-free, so the
 * `gh` and the cloud (GitHub MCP) routes feed it the same way. Every decision
 * is in `scripts/lib/campaignHeartbeat.mjs`, which holds the clock's limits.
 */

import { readFileSync } from 'node:fs';

import { dispatchCells, heartbeat, parseStatusTable, report } from './lib/campaignHeartbeat.mjs';

const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

const args = process.argv.slice(2);
const now = new Date();

if (args[0] === '--dispatch') {
  const phases = /^\d+$/.test(args[1] ?? '') ? Number(args[1]) : NaN;
  let cells;
  try {
    cells = dispatchCells(phases, now);
  } catch (err) {
    die(`--dispatch: ${err.message}`);
  }
  console.log(`BUDGET ${cells.budget}`);
  console.log(`WORKER ${cells.worker}`);
  console.log(`NOTE ${cells.note}`);
  process.exit(0);
}

let body;
try {
  body = readFileSync(args[0] ?? 0, 'utf8');
} catch (err) {
  die(`cannot read the ledger body: ${err.message}`);
}

let lines, exitCode;
try {
  ({ lines, exitCode } = report(heartbeat(parseStatusTable(body), now)));
} catch (err) {
  die(err.message);
}
for (const line of lines) console.log(line);
process.exit(exitCode);
