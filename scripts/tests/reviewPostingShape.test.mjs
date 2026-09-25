// The review a reviewer posts has to be readable by the thing that gates the
// merge. Those are two files that never import each other - a markdown command
// prompt and `lib/prEligibility.mjs` - so nothing but this test stops them
// drifting, and the drift is silent: `/salt-review` posted its findings with
// `gh pr comment` for months, which lands an *issue* comment, which never
// appears in `gh pr view --json reviews`. Every PR it reviewed therefore read
// as unreviewed and could not be merged (#1351 had to be reposted by hand).
//
// So the claims pinned here are exactly the two the gate depends on: the
// command posts a review, and its no-findings template parses as "clear".

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasBlockingFindings, reviewSections } from '../lib/prEligibility.mjs';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

// `/salt-campaign`'s reviewer brief moved out of the command into its own
// agent definition (#1586), so that file is the one the reviewer actually reads.
const COMMANDS = ['.claude/commands/salt-review.md', '.claude/agents/campaign-reviewer.md'];

describe('the posting shape a reviewer is told to use', () => {
  it.each(COMMANDS)('%s tells the reviewer to post a review, not an issue comment', (file) => {
    const src = read(file);
    expect(src).toMatch(/gh pr review <pr> --comment --body-file/);
    // A fenced or inline `gh pr comment` would be a second, unreadable route.
    expect(src).not.toMatch(/^\s*gh pr comment /m);
  });

  it.each(COMMANDS)('%s names the heading the gate counts blocking findings under', (file) => {
    expect(read(file)).toMatch(/## Blocking/);
  });
});

describe('salt-review.md’s no-findings template', () => {
  /** The fenced block the command tells the reviewer to post when nothing was found. */
  const template = (() => {
    const src = read('.claude/commands/salt-review.md');
    const m = src.match(/Nothing found is:\s*\n\n```\n([\s\S]*?)\n```/);
    if (!m) throw new Error('no-findings template not found in salt-review.md');
    return m[1];
  })();

  it('parses into severity sections, so the gate can read it at all', () => {
    expect(reviewSections(template).length).toBeGreaterThan(0);
  });

  it('reads as no blocking findings, so a clean PR merges', () => {
    expect(hasBlockingFindings(reviewSections(template))).toBe(false);
  });
});
