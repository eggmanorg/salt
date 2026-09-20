// The worker time budget is a number that lives in prose and is enforced by a
// human-shaped agent reading that prose. Nothing imports it, nothing computes
// it, and the two numbers it replaced (45 minutes / 3 hours) sat uncorrected
// from the day they were typed because no feedback path existed — which is the
// defect #1521 fixes, and exactly the class CLAUDE.md rule 12 names.
//
// So the numbers are pinned here, the same way `reviewPostingShape.test.mjs`
// pins the review-posting claims the merge gate depends on: read the command
// file, assert what it says.
//
// What this test does NOT claim: that 90 minutes is the *right* budget. No test
// can know that — it would need to time real workers. What it guarantees is
// narrower and checkable: the stated budget does not silently drift, the same
// number appears everywhere it must, and the file never again asks the harness
// to start a sleep it cannot start (a Bash `timeout` is capped at 600000 ms,
// which is why the per-worker watchdog sleep had to go).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, '.claude/commands', f), 'utf8');

/** The harness's own cap on a backgrounded Bash call, in seconds. */
const MAX_SLEEP_SECONDS = 600;

describe('salt-campaign.md — the budget the coordinator hands each worker', () => {
  const src = read('salt-campaign.md');

  it('states the per-phase budget as 90 minutes', () => {
    expect(src).toMatch(/no single phase longer than 90 minutes/);
  });

  it('states the per-worker formula with its floor and its cap', () => {
    expect(src).toMatch(/min\(360, max\(180, 90 × phases\)\)/);
  });

  it('takes the phase count from the extractor, and from PHASES_UNBUILT on a continuation', () => {
    expect(src).toMatch(/`PHASES`/);
    expect(src).toMatch(/`PHASES_UNBUILT`/);
  });

  it('carries neither of the uncalibrated numbers it replaced', () => {
    expect(src).not.toMatch(/45 minutes/);
    expect(src).not.toMatch(/\b3 hours\b/);
  });
});

describe('salt-campaign.md — the mechanism that enforces it', () => {
  const src = read('salt-campaign.md');

  // This is the pin for the fault itself: the command used to instruct a
  // `sleep <budget-seconds>` per worker, which at any budget over ten minutes
  // is a call the harness refuses. A regression would re-introduce a literal.
  it('never asks for a sleep longer than the harness allows', () => {
    const asked = [...src.matchAll(/sleep\s+(\d+)/g)].map((m) => Number(m[1]));
    expect(asked.length).toBeGreaterThan(0); // the heartbeat itself
    for (const seconds of asked) expect(seconds).toBeLessThanOrEqual(MAX_SLEEP_SECONDS);
  });

  it('describes one heartbeat for the whole pool, not one per worker', () => {
    expect(src).toMatch(/One heartbeat covers the whole pool/);
    // The per-worker mechanism is gone by name, so it cannot creep back in
    // under the old word while the new paragraph still reads correctly.
    expect(src).not.toMatch(/watchdog/i);
  });

  it('says why the long sleep is gone, so the next reader does not re-propose it', () => {
    expect(src).toMatch(/600000 ms/);
  });

  it('requires re-arming on every wake, including an agent-return wake', () => {
    expect(src).toMatch(/including a wake caused by an agent returning/);
    expect(src).toMatch(/re-arm the heartbeat before you end the turn/);
  });
});
