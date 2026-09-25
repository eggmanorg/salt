// The review a reviewer posts has to be readable by the thing that gates the
// merge. Those are two files that never import each other - a markdown agent
// brief and `lib/prEligibility.mjs` - so nothing but this test stops them
// drifting, and the drift is silent: `/salt-review` posted its findings with
// `gh pr comment` for months, which lands an *issue* comment, which never
// appears in `gh pr view --json reviews`. Every PR it reviewed therefore read
// as unreviewed and could not be merged (#1351 had to be reposted by hand).
//
// So the claims pinned here are the ones the gate depends on: the reviewer
// posts a review, and its no-findings template parses as "clear". Since #1590
// both `/salt-review` and `/salt-campaign` spawn one shared reviewer,
// `.claude/agents/pr-reviewer.md`, so the brief is pinned there and each
// command is pinned to spawning it. What this cannot pin: that a command
// actually spawns it at run time rather than improvising a review in-session -
// that is an agent reading prose, so the test holds only that the prose says so.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasBlockingFindings, reviewSections } from '../lib/prEligibility.mjs';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

const AGENT = '.claude/agents/pr-reviewer.md';
const CALLERS = ['.claude/commands/salt-review.md', '.claude/commands/salt-campaign.md'];

describe('the posting shape the shared reviewer is told to use', () => {
  it('tells the reviewer to post a review, not an issue comment', () => {
    expect(read(AGENT)).toMatch(/gh pr review <pr> --comment --body-file/);
  });

  it.each([AGENT, ...CALLERS])('%s carries no `gh pr comment` route', (file) => {
    // A fenced or inline `gh pr comment` would be a second, unreadable route.
    expect(read(file)).not.toMatch(/^\s*gh pr comment /m);
  });

  it('names the heading the gate counts blocking findings under', () => {
    expect(read(AGENT)).toMatch(/## Blocking/);
  });

  it('defines both should-fix marks the callers route on', () => {
    const src = read(AGENT);
    expect(src).toMatch(/\*\*`\[fold-in\]`\*\* when/);
    expect(src).toMatch(/\*\*`\[sweep\]`\*\* when/);
  });
});

describe('both commands spawn the shared reviewer', () => {
  it.each(CALLERS)('%s names subagent_type "pr-reviewer"', (file) => {
    expect(read(file)).toContain('subagent_type: "pr-reviewer"');
  });

  it("salt-campaign.md's sweep-PR review names the ledger as the scope issue", () => {
    expect(read('.claude/commands/salt-campaign.md')).toMatch(
      /`pr-reviewer` with the ledger for issue #N — the `## Sweep` lines are its scope/,
    );
  });
});

describe('pr-reviewer.md’s no-findings template', () => {
  /** The fenced block the agent is told to post when nothing was found. */
  const template = (() => {
    const src = read(AGENT);
    const m = src.match(/Nothing found is:\s*\n\n```\n([\s\S]*?)\n```/);
    if (!m) throw new Error('no-findings template not found in pr-reviewer.md');
    return m[1];
  })();

  it('parses into severity sections, so the gate can read it at all', () => {
    expect(reviewSections(template).length).toBeGreaterThan(0);
  });

  it('reads as no blocking findings, so a clean PR merges', () => {
    expect(hasBlockingFindings(reviewSections(template))).toBe(false);
  });

  it('carries the ## Notes heading the heavy-suite record lives under', () => {
    expect(reviewSections(template).map((s) => s.heading)).toContain('Notes');
  });
});
