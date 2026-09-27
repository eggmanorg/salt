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
  // Shared with /salt-review since #1590, hence not `campaign-`-prefixed.
  'pr-reviewer': 'opus',
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
    // A `#` after whitespace opens a YAML comment, so the harness silently cuts
    // the description there — the reviewer's once ended at "under".
    expect(fm.description).not.toMatch(/\s#/);
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

// The desktop app's Code tab loads its own connectors into every helper, roughly
// doubling each one's starting context (docs/campaign-rationale.md → Models).
describe('salt-campaign.md records which session it runs in', () => {
  const src = read('.claude/commands/salt-campaign.md');

  it('checks CLAUDE_CODE_ENTRYPOINT and names the desktop value', () => {
    expect(src).toContain('printenv CLAUDE_CODE_ENTRYPOINT');
    expect(src).toContain('`claude-desktop`');
  });

  it('carries a Session: line in the ledger Plan block', () => {
    expect(src).toMatch(/^Session: /m);
  });
});

describe('salt-campaign.md stays a lean coordinator prompt', () => {
  it('is at most 40,000 bytes', () => {
    const bytes = readFileSync(path.join(repo, '.claude/commands/salt-campaign.md')).length;
    expect(bytes).toBeLessThanOrEqual(40_000);
  });
});

// Every campaign worker and every standalone /salt-run loads salt-run.md whole.
// #1589 moved its incident history to docs/campaign-rationale.md (`## salt-run.md`)
// and consolidated its cloud substitutions; this cap stops the file silently regrowing.
describe('salt-run.md stays a lean worker prompt', () => {
  it('is at most 30,000 bytes', () => {
    const bytes = readFileSync(path.join(repo, '.claude/commands/salt-run.md')).length;
    expect(bytes).toBeLessThanOrEqual(30_000);
  });
});

// #1612 Phase 1. About 70% of campaign cost is re-reading context on every call,
// and 91% of worker and fixer calls carried a single tool. These pin that each
// rule's sentence is still in the prompt that carries it. What they cannot pin:
// that an agent actually batches its reads, returns at its push, or skips the
// steward cadence — those are run-time acts of a model reading prose, checked
// only by reading a campaign's transcripts.
describe('campaign helpers batch independent reads (#1612)', () => {
  const BATCHING = /issue independent reads, searches and greps together in one message/i;

  it.each([
    '.claude/commands/salt-run.md',
    '.claude/agents/campaign-fixer.md',
    '.claude/agents/campaign-resolver.md',
    '.claude/agents/campaign-sweeper.md',
  ])('%s carries the batching sentence', (file) => {
    expect(read(file)).toMatch(BATCHING);
  });
});

describe('campaign-worker.md overrides salt-run.md step 9 item 5 (#1612)', () => {
  it('says the steward subscription does not apply to a worker', () => {
    const src = read('.claude/agents/campaign-worker.md');
    expect(src).toMatch(/step 9 item 5 does not apply to you/);
    // The reason is the backgrounded-command rule; the override must cite it.
    expect(src).toMatch(/Never end your turn with a backgrounded command still running/);
  });
});

describe('the sweeper returns at its push and the coordinator watches its CI (#1612)', () => {
  it('campaign-sweeper.md returns no CI field and does not wait', () => {
    const src = read('.claude/agents/campaign-sweeper.md');
    const ret = src.slice(src.lastIndexOf('Return:'));
    expect(ret).not.toMatch(/CI:/);
    expect(src).toMatch(/do not wait for its CI/);
  });

  it('salt-campaign.md → Sweep arms the CI watcher on the sweep PR', () => {
    const src = read('.claude/commands/salt-campaign.md');
    const sweep = src.slice(src.indexOf('\n## Sweep\n'), src.indexOf('\n## Finish\n'));
    expect(sweep).toContain('gh pr checks <pr> --watch --fail-fast');
    expect(sweep).not.toMatch(/`REJECTED`, `CI`/);
  });
});

// Decision 9 of #1612: the subagent prompt-cache TTL is deliberately left at
// 5 minutes. This pins the rationale entry and the absence of both controls in
// the repo. It cannot see a user-level `~/.claude/settings.json` or an
// environment variable set on the host — only what this repo configures.
describe('no helper prompt-cache TTL is raised (#1612)', () => {
  it('the rationale doc names both controls and the 5-minute idle condition', () => {
    const doc = read('docs/campaign-rationale.md');
    const entry = doc.slice(doc.indexOf("**Why no helper's prompt-cache TTL is raised**"));
    expect(doc).toContain("**Why no helper's prompt-cache TTL is raised**");
    expect(entry).toContain('`subagentPromptCacheTtl`');
    expect(entry).toContain('`cacheTtl`');
    expect(entry).toMatch(/idles for more than 5 minutes/);
  });

  it.each(Object.keys(ROLES))('%s sets no cacheTtl', (name) => {
    expect(read(`.claude/agents/${name}.md`)).not.toMatch(/cacheTtl/i);
  });

  it('.claude/settings.json sets no subagent prompt-cache TTL', () => {
    expect(read('.claude/settings.json')).not.toMatch(/cacheTtl/i);
  });
});
