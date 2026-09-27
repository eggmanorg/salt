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

  it('defines the three should-fix marks the callers route on', () => {
    const src = read(AGENT);
    expect(src).toMatch(/\*\*`\[fold-in\]`\*\* when/);
    expect(src).toMatch(/\*\*`\[sweep\]`\*\* when/);
    expect(src).toMatch(/\*\*`\[decide\]`\*\* when/);
  });
});

// #1614. What these pin is the prose of the line between the campaign's calls
// and Daniel's: a `[decide]` line names its recommended choice, an unmarked
// line is one of Daniel's five calls or Out of scope and names which, and the
// doubt rule that sent every engineering choice to him is gone. What they
// cannot pin: that a reviewer classifies a given finding correctly, or that a
// caller adopts the choice rather than asking — those are run-time acts of a
// model reading prose, checked only against a campaign's ledger.
describe("the line between an engineering choice and a call of Daniel's (#1614)", () => {
  const agent = read(AGENT);
  const unmarked = agent.slice(agent.indexOf('**Unmarked** only when'));

  it('makes a `[decide]` line name the recommended choice', () => {
    expect(agent).toMatch(/\*\*Name your recommended choice on the line\*\*/);
    expect(agent).toMatch(/should-fix \[decide\] \| .* \| <your recommended choice/);
  });

  it('defines unmarked as the five calls or Out of scope, each named by a reason word', () => {
    expect(unmarked).toMatch(
      /^\*\*Unmarked\*\* only when the fix needs one of \*\*Daniel's five calls\*\*/,
    );
    for (const word of ['ux', 'spec-vs-clean', 'rule', 'prod-data', 'dependency', 'out-of-scope']) {
      expect(unmarked.slice(0, unmarked.indexOf('\n'))).toContain(`\`${word}\``);
    }
    expect(agent).toMatch(/should-fix \| file:line \| <reason word>:/);
  });

  it('carries no doubt rule in the reviewer or the campaign', () => {
    expect(agent).not.toMatch(/If either mark is in doubt/);
    expect(read('.claude/commands/salt-campaign.md')).not.toMatch(/If either is in doubt, list it/);
  });

  it("salt-review.md's Fix before merge takes an in-footprint `[decide]`", () => {
    const src = read('.claude/commands/salt-review.md');
    const fix = src.slice(
      src.indexOf('- **Fix before merge**'),
      src.indexOf('- **Proposed follow-up**'),
    );
    expect(fix).toMatch(/every `\[decide\]` should-fix whose file is in this PR's footprint/);
    expect(src).toMatch(/each `\[decide\]` fixed gets one plain sentence naming the choice taken/);
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

describe('round-2 verify mode keeps FIXED items out of the posted body', () => {
  it('says FIXED items are reported only in the return, and `## Blocking` reads None when all are fixed', () => {
    // A FIXED item written into `## Blocking` (instead of only the agent's
    // return) makes hasBlockingFindings() see it as an outstanding finding and
    // wrongly refuse a fully-fixed PR - see the finding this test pins.
    expect(read(AGENT)).toMatch(
      /FIXED items are reported only in the return, never in the posted body/,
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
