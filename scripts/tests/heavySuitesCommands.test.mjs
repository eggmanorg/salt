// The three agent commands that ask "did the heavy suites run?" all ask
// `scripts/heavy-suites.mjs` (issue #1588), and none keeps a hand-typed job
// filter of its own — the copy that silently matched nothing after a `ci.yml`
// rename, and whose "held in lockstep" claim nothing held.
//
// WHAT THIS PINS AND WHAT IT DOES NOT (CLAUDE.md rule 12): that each file names
// the command, carries no old filter, and names only verdicts the script can
// print. It does not pin that each verdict maps to the right action — that is
// prose, read by review; the parity table in #1588's PR is the record.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../lib/heavySuites.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const COMMANDS = {
  '.claude/commands/salt-campaign.md': ['--pr <pr>'],
  '.claude/commands/salt-run.md': ['--branch <type>/<slug>-ISSUE_NUMBER'],
  '.claude/commands/salt-review.md': ['--branch <headRefName>'],
};
const VERDICTS = Object.keys(EXIT_CODES);
/** A backticked word shaped like a verdict: `ran-…`, `skipped-…`, `cannot-…`. */
const VERDICT_LIKE = /`((?:ran|skipped|cannot)-[a-z-]+)`/g;

describe.each(Object.entries(COMMANDS))('%s', (file, selectors) => {
  const text = read(file);

  it('asks heavy-suites.mjs, with its selector', () => {
    for (const selector of selectors) {
      expect(text).toContain(`node scripts/heavy-suites.mjs ${selector}`);
    }
  });

  it('keeps no hand-typed job filter and no lockstep claim', () => {
    expect(text).not.toContain('test("E2E|integration")');
    expect(text).not.toMatch(/lockstep/i);
  });

  it('names only verdicts the script can print', () => {
    const named = [...text.matchAll(VERDICT_LIKE)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const verdict of named) expect(VERDICTS).toContain(verdict);
  });
});

describe('the commands that route every verdict', () => {
  it.each(['.claude/commands/salt-run.md', '.claude/commands/salt-review.md'])(
    '%s names all seven',
    (file) => {
      const text = read(file);
      for (const verdict of VERDICTS) expect(text).toContain(`\`${verdict}\``);
    },
  );
});

describe('the no-gh route', () => {
  it('salt-run.md spells out the file form; salt-campaign.md and salt-review.md point at it', () => {
    expect(read('.claude/commands/salt-run.md')).toMatch(
      /node scripts\/heavy-suites\.mjs --jobs <file> --changes-log <file> --event pull_request/,
    );
    expect(read('.claude/commands/salt-campaign.md')).toContain('**Heavy-suite files**');
    expect(read('.claude/commands/salt-review.md')).toContain('**Heavy-suite files**');
  });
});

describe('allowlist and docs map', () => {
  it('allowlists the command, so an agent never stops on a permission prompt for it', () => {
    const allow = JSON.parse(read('.claude/settings.json')).permissions.allow;
    expect(allow).toContain('Bash(node scripts/heavy-suites.mjs:*)');
  });

  it("routes the script's edits to docs/ci.md", () => {
    const row = read('docs-map.md')
      .split('\n')
      .find((line) => line.startsWith('| [docs/ci.md]'));
    expect(row).toContain('`scripts/heavy-suites.mjs`');
    expect(row).toContain('`scripts/lib/heavySuites.mjs`');
  });
});
