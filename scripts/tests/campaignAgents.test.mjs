// `/salt-campaign` spawns seven helper roles, and each role's model used to be
// a row in a table the coordinator had to remember to apply at every `Agent`
// call — enforced by nothing. #1586 moved each role into a project subagent
// under `.claude/agents/`, where the model is frontmatter the harness applies.
//
// What this test pins: every role has a definition, each definition names
// itself and carries the model the Behavior Contract of #1586 fixes, and the
// coordinator names every role it is meant to spawn. What it cannot pin: that
// the coordinator actually spawns them without a `model:` override — that is
// a run-time act of an agent reading prose, so the test holds only that the
// prose forbidding the override is still there.
//
// It also caps the command's size (#1586 Phase 2). The coordinator's prompt is
// re-sent on every one of a campaign's hundred-plus turns, and it grew from
// nothing to 85 KB one justified paragraph at a time; incident history now
// lives in docs/campaign-rationale.md, and this cap is what keeps it there.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

const ROLES = {
  'campaign-extractor': 'haiku',
  'campaign-worker': 'opus',
  'campaign-reviewer': 'opus',
  'campaign-divider': 'opus',
  'campaign-fixer': 'sonnet',
  'campaign-sweeper': 'sonnet',
  'campaign-resolver': 'sonnet',
};

/** The `key: value` lines between a file's leading `---` fences. */
const frontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(
    m[1]
      .split('\n')
      .map((line) => line.match(/^(\w+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.trim()]),
  );
};

describe('campaign agent definitions', () => {
  it.each(Object.entries(ROLES))('%s exists and runs on %s', (name, model) => {
    const file = `.claude/agents/${name}.md`;
    expect(existsSync(path.join(repo, file))).toBe(true);
    const fm = frontmatter(read(file));
    expect(fm.name).toBe(name);
    expect(fm.model).toBe(model);
    expect(fm.description).toBeTruthy();
  });

  it.each(Object.keys(ROLES))('%s carries no tools restriction', (name) => {
    // A `tools:` list would drop the GitHub MCP tools a cloud session needs.
    expect(frontmatter(read(`.claude/agents/${name}.md`)).tools).toBeUndefined();
  });
});

describe('salt-campaign.md spawns them by name', () => {
  const src = read('.claude/commands/salt-campaign.md');

  it.each(Object.keys(ROLES))('names the %s subagent', (name) => {
    expect(src).toContain(`\`${name}\``);
  });

  it('forbids passing a model override on those spawns', () => {
    expect(src).toMatch(/never pass `model:`/);
    expect(src).not.toMatch(/Agent\(…, model: "(opus|sonnet)"\)/);
  });
});

describe('salt-campaign.md stays a lean coordinator prompt', () => {
  it('is at most 40,000 bytes', () => {
    const bytes = readFileSync(path.join(repo, '.claude/commands/salt-campaign.md')).length;
    expect(bytes).toBeLessThanOrEqual(40_000);
  });
});
