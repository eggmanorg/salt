// The campaign pool heartbeat's arithmetic, as pure functions over the ledger
// body and an injected clock. Issue #1587.
//
// WHY THIS EXISTS. salt-campaign.md → Dispatch had the coordinator compute, by
// hand and on every wake: each worker's budget, the dispatch and end-time cells
// to write, which live worker's end-time is earliest, how many seconds to sleep
// until it, and whether anyone is past theirs. Every one of those is a
// deterministic function of cells the coordinator already wrote plus the time.
// Done in prose it is the one heartbeat step that can be wrong silently — a
// mis-subtracted sleep wakes late and a hung worker keeps its slot; a mis-read
// row is an unwatched worker. So the arithmetic lives here, and the judgement
// that is genuinely judgement (terminate before recycling, re-arm only when the
// deadline moved) stays in the prose. This module never sleeps, arms or stops
// anything; `scripts/campaign-heartbeat.mjs` prints what it returns.
//
// THE CLOCK, AND ITS LIMIT. Ledger cells are bare local wall-clock `HH:MM` with
// no date — the template's shape, unchanged here — read in the process's local
// timezone via the Date getters. A dispatch cell resolves to its most recent
// occurrence at or before `now`; the Note's end-time to its first occurrence
// strictly after that dispatch instant. That is unambiguous only for a worker
// dispatched less than 24 hours before `now`: a row older than that resolves to
// the wrong day and its breach is under-reported by whole days. The budget cap
// is 360 minutes, so a row that old is a dead session's row, which Setup's
// resume check re-verifies by hand anyway. A DST change between dispatch and
// `now` shifts the result by the size of the change; nothing here corrects for
// it.
//
// THE ROWS. A live row is one whose State cell is `dispatched` — the only state
// in the template that holds a worker. Its Worker cell ends `, HH:MM` (the
// dispatch time) and its Note contains `budget to HH:MM` anywhere, so a retried
// row (`retried: <reason>`, #1585) or any other annotation parses unchanged. A
// live row that does not fit is an ERROR, never skipped — a skipped row is an
// unwatched worker, the exact failure the heartbeat exists to prevent. Rows in
// any other state are not read beyond their State cell.

const WORKER_TIME = /,\s*([01]\d|2[0-3]):([0-5]\d)\s*$/;
const NOTE_END = /\bbudget to ([01]\d|2[0-3]):([0-5]\d)\b/;
const COLUMNS = ['Issue', 'Worker', 'State', 'Note'];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Per-worker budget in minutes: `min(360, max(180, 90 × phases))`, `phases`
 * being what this dispatch builds. The same formula is stated in
 * salt-campaign.md → Dispatch; `campaignHeartbeat.test.mjs` reads that file's
 * `Worked values:` line and asserts this function agrees with every value on it.
 */
export function budgetMinutes(phases) {
  if (!Number.isInteger(phases) || phases < 1) {
    throw new Error(`phases must be a positive integer, got ${String(phases)}`);
  }
  return Math.min(360, Math.max(180, 90 * phases));
}

/** `HH:MM` of a Date in local time. */
export function formatHHMM(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant of `h:m` on the local calendar day of `date`. */
function atTime(date, h, m) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
}

/**
 * The cells to write at dispatch: the Worker cell's time (the coordinator
 * prefixes `agent <id>, `) and the whole Note cell.
 */
export function dispatchCells(phases, now) {
  const budget = budgetMinutes(phases);
  const end = new Date(now.getTime() + budget * MINUTE);
  const noun = phases === 1 ? 'phase' : 'phases';
  return {
    budget,
    worker: formatHHMM(now),
    note: `${phases} ${noun}, budget to ${formatHHMM(end)}`,
  };
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/**
 * The `## Status` table's rows, as `{ issue, state, worker, note }` objects
 * keyed by header name, so a column added to the template later does not
 * silently shift what is read. Throws when there is no `## Status` heading, no
 * table under it, or the header lacks a column this module reads.
 */
export function parseStatusTable(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Status\s*$/.test(l));
  if (start === -1) throw new Error('no "## Status" heading in the ledger body');

  let i = start + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const table = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) table.push(lines[i++]);
  if (table.length < 2) throw new Error('no table under "## Status"');

  const header = splitRow(table[0]);
  const col = Object.fromEntries(COLUMNS.map((name) => [name, header.indexOf(name)]));
  const missing = COLUMNS.filter((name) => col[name] === -1);
  if (missing.length) {
    throw new Error(`"## Status" table has no ${missing.map((m) => `"${m}"`).join(', ')} column`);
  }

  return table
    .slice(2) // header and the |---| separator
    .map((line) => {
      const cells = splitRow(line);
      return {
        issue: cells[col.Issue] ?? '',
        state: cells[col.State] ?? '',
        worker: cells[col.Worker] ?? '',
        note: cells[col.Note] ?? '',
        line: line.trim(),
      };
    });
}

/**
 * The heartbeat verdict at `now`.
 *
 * Returns `{ live, earliest, sleepSeconds, breached }`:
 * - `live` — the number of `dispatched` rows;
 * - `earliest` — the earliest live end-time as a Date, or null for an empty pool;
 * - `sleepSeconds` — seconds from `now` until `earliest`, rounded up; 0 when any
 *   live row is breached; null for an empty pool;
 * - `breached` — `{ issue, worker, end }` for each live row with `now >= end`.
 *
 * Throws, naming the row, on a live row whose Worker or Note cell it cannot read.
 */
export function heartbeat(rows, now) {
  const live = rows.filter((r) => r.state === 'dispatched');
  const resolved = live.map((row) => {
    const d = WORKER_TIME.exec(row.worker);
    const e = NOTE_END.exec(row.note);
    if (!d || !e) {
      const what = !d
        ? 'dispatch time ("…, HH:MM") in its Worker cell'
        : '"budget to HH:MM" in its Note cell';
      throw new Error(`dispatched row ${row.issue || '(no issue)'} has no ${what}: ${row.line}`);
    }
    let dispatched = atTime(now, Number(d[1]), Number(d[2]));
    if (dispatched > now) dispatched = new Date(dispatched.getTime() - DAY);
    let end = atTime(dispatched, Number(e[1]), Number(e[2]));
    if (end <= dispatched) end = new Date(end.getTime() + DAY);
    return { issue: row.issue, worker: row.worker, end };
  });

  if (resolved.length === 0) {
    return { live: 0, earliest: null, sleepSeconds: null, breached: [] };
  }
  const earliest = new Date(Math.min(...resolved.map((r) => r.end.getTime())));
  const breached = resolved.filter((r) => now >= r.end);
  const sleepSeconds = breached.length ? 0 : Math.ceil((earliest.getTime() - now.getTime()) / 1000);
  return { live: resolved.length, earliest, sleepSeconds, breached };
}

/**
 * What the CLI prints for a verdict, and its exit code: 0 no breach, 1 at least
 * one breach. (Exit 2 — unreadable input — is the CLI's, from a throw above.)
 */
export function report({ live, earliest, sleepSeconds, breached }) {
  const lines = [
    `LIVE ${live}`,
    `EARLIEST ${earliest ? formatHHMM(earliest) : 'none'}`,
    `SLEEP ${sleepSeconds ?? 'none'}`,
    ...breached.map((b) => `BREACHED ${b.issue} ${b.worker} ended ${formatHHMM(b.end)}`),
  ];
  return { lines, exitCode: breached.length ? 1 : 0 };
}
