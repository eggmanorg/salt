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
// number appears everywhere it must, and the heartbeat paragraph keeps the shape
// #1541 gave it.
//
// #1541 is also the cautionary half of this file. The version of these tests that
// shipped with #1524 pinned a harness cap that did not exist — a sentence nobody
// had run the experiment for, made mechanical, which is how a falsehood acquires
// a green tick. A test over prose can hold that a disproved sentence stays out and
// that a described mechanism stays described. It cannot make a claim true, and the
// moment it looks like it has, it is doing harm.
//
// From #1521 Phase 2 the same number lives in five files that never import each
// other — the campaign command that hands it out, the three spec commands that
// size phases against it, and `salt-run.md`'s CI figure. `guidedPlanTimeoutBudget`
// pins a three-part budget for the same reason; this is that shape at five.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, '.claude/commands', f), 'utf8');
const readDoc = (f) => readFileSync(path.join(repo, 'docs', f), 'utf8');

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

  it('describes one heartbeat for the whole pool, not one per worker', () => {
    expect(src).toMatch(/One heartbeat covers the whole pool/);
    // The per-worker mechanism is gone by name, so it cannot creep back in
    // under the old word while the new paragraph still reads correctly.
    expect(src).not.toMatch(/watchdog/i);
  });

  // The three sentences #1541 disproved. Each was in the file, each was false,
  // and a coordinator reading any of them is instructed away from the mechanism
  // that works — so absence is the property worth holding, not a paraphrase.
  it('makes no claim that the harness caps or refuses a backgrounded sleep', () => {
    expect(src).not.toMatch(/the harness cannot start one/);
    expect(src).not.toMatch(/is refused before it starts/);
    expect(src).not.toMatch(/it is not a thing this harness can run/);
  });

  it('arms the heartbeat to the earliest deadline, not to a fixed interval', () => {
    expect(src).toMatch(/Arm it to the earliest budget end-time across the live pool/);
    expect(src).toMatch(/re-arm it only when that earliest deadline actually changes/);
    // The ten-minute cycle is the cost #1541 measured; it must not return.
    expect(src).not.toMatch(/sleep 600\b/);
  });

  it('carries the observation that replaced the cap claim, with its date', () => {
    expect(src).toMatch(/`timeout` parameter does not kill a backgrounded command/);
    // The dated observation itself moved to the rationale doc (#1586); the
    // command keeps the operative sentence above and links there.
    expect(readDoc('campaign-rationale.md')).toMatch(/campaign #1495 \(2026-09-20\)/);
  });

  it('names the watchers a coordinator waits on CI and on a merge with', () => {
    expect(src).toMatch(/gh pr checks <pr> --watch --fail-fast/);
    expect(src).toMatch(/until \[ "\$\(gh pr view <pr> --json state --jq \.state\)" != "OPEN" \]/);
    // So nobody re-proposes the push tools that do not exist in this harness.
    expect(src).toMatch(/subscribe_pr_activity/);
    expect(src).toMatch(/send_later/);
  });

  it('still compares against the ledger on every wake, including an agent-return wake', () => {
    expect(src).toMatch(/including a wake caused by an agent returning/);
    expect(src).toMatch(
      /a heartbeat armed for the current earliest deadline whenever the pool is non-empty/,
    );
  });

  it('still tears the heartbeat down at Finish', () => {
    expect(src).toMatch(/`TaskStop` the pool heartbeat if it is still running/);
  });
});

describe('the spec commands size a phase against the budget', () => {
  const SPEC_COMMANDS = ['salt-spec.md', 'salt-defect.md', 'salt-refactor.md'];

  // The number is only useful to a spec author if it reaches the list they are
  // actually consulting when they draw a boundary. Pinning its presence in the
  // file is not enough — before #1521 all three files scored zero for the word
  // "minute" anywhere at all, and the failure was that the criterion did not
  // exist, not that it sat in the wrong section.
  const phasesSection = (file) => {
    const src = read(file);
    const start = src.indexOf('## Phases');
    if (start === -1) throw new Error(`no "## Phases" heading in ${file}`);
    const next = src.indexOf('\n## ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it.each(SPEC_COMMANDS)('%s states the 90-minute build budget in its Phases section', (file) => {
    expect(phasesSection(file)).toMatch(/\*\*90 minutes\*\* per phase/);
  });

  it.each(SPEC_COMMANDS)('%s names the CI wait the budget has to absorb', (file) => {
    expect(phasesSection(file)).toMatch(/about 10 of those/);
  });
});

describe('the CI wait is one number, not one per file', () => {
  // salt-run.md said "5-7 minutes" while this campaign's own calibration said
  // otherwise; two numbers for one thing, in two files an agent reads in the
  // same run. Measured p50 is 10 minutes over successful `pull_request` runs.
  it('salt-run.md carries the measured figure and not the stale one', () => {
    const src = read('salt-run.md');
    expect(src).toMatch(/A run takes about 10 minutes/);
    expect(src).not.toMatch(/5–7 minutes|5-7 minutes/);
  });
});

describe('the Finish step closes the calibration loop', () => {
  // Every spec command writes a `Size` and nothing had ever read one back, so
  // no estimate had ever been corrected. The loop closes in prose — a line in
  // the ledger's closing comment — which means it can be dropped in a rewrite
  // without anything noticing. Hence this.
  const src = read('salt-campaign.md');

  it('names both halves of the comparison in the closing template', () => {
    expect(src).toMatch(/\*\*Estimated vs actual:\*\*/);
  });

  it('says where each half comes from — the board for the estimate, the PR for the actual', () => {
    expect(src).toMatch(/board\.mjs show <issue>/);
    expect(src).toMatch(/gh pr view <pr> --json additions,deletions/);
  });

  it('keeps it a record rather than a gate', () => {
    expect(src).toMatch(/nothing gates on the gap/);
  });
});
